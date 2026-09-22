# Export the raw material for drive-error attribution. READ-ONLY: it reads event logs and the PnP
# tree and writes one JSON file. It never touches a disk, never ejects, never formats.
#
# Feeds zilladm/server/attribution.mjs, which decides whether a fault belongs to the DRIVE or to
# the PATH it sat on. Two sources, because neither is enough alone:
#
#   Microsoft-Windows-Partition/Diagnostic 1006  - every arrival AND removal, with disk number,
#       capacity, the bridge instance and the location. A removal is logged as capacity 0. This is
#       what makes a disk number mean something: it identifies a drive only between the two.
#   System 153/129/7/51                          - the errors themselves, which name a DISK NUMBER.
#
# Disk numbers move (2026-09-21: one drive was disk 4, then 3, then 5 in an evening), so an error
# is only meaningful once it is placed on the timeline above.
[CmdletBinding()]
param(
    [int]$Days = 3,
    [string]$OutFile = "$env:TEMP\zilladm-disk-events.json"
)

$ErrorActionPreference = 'Stop'
$since = (Get-Date).AddDays(-$Days)

# --- the PnP tree: bridge instance -> enclosure hub -> controller ------------------------------
# The enclosure matters because a bay's bridge "serials" are canned per slot and REUSED across
# enclosures - C01 is "slot 1" in every bay - so the slot alone cannot tell two bays apart.
function Resolve-Path-Chain {
    param([string]$InstanceId)
    # The enclosure is the OUTERMOST usb hub below the root hub - the bay's upstream hub - not the
    # first hub above the bridge. A 5-bay enclosure has an internal hub chain, and taking the first
    # parent made one bay look like two different enclosures, which turned a path fault into a
    # false "the drive is bad" (seen on the 20 TB, 2026-09-22).
    $enclosure = $null; $controller = $null; $cur = $InstanceId
    for ($i = 0; $i -lt 8 -and $cur; $i++) {
        $parent = (Get-PnpDeviceProperty -InstanceId $cur -KeyName DEVPKEY_Device_Parent -ErrorAction SilentlyContinue).Data
        if (-not $parent) { break }
        if ($parent -match '^USB\\VID_') { $enclosure = $parent }   # keep the last one seen
        if ($parent -match 'ROOT_HUB') {
            $controller = (Get-PnpDeviceProperty -InstanceId $parent -KeyName DEVPKEY_Device_Parent -ErrorAction SilentlyContinue).Data
            break
        }
        $cur = $parent
    }
    [pscustomobject]@{ enclosure = $enclosure; controller = $controller }
}

$chains = @{}
foreach ($d in Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match '^USB\\VID_' -and $_.Class -eq 'SCSIAdapter' }) {
    $chains[$d.InstanceId] = Resolve-Path-Chain -InstanceId $d.InstanceId
}

# --- arrivals and removals ---------------------------------------------------------------------
$arrivals = @()
foreach ($e in Get-WinEvent -FilterHashtable @{LogName = 'Microsoft-Windows-Partition/Diagnostic'; Id = 1006; StartTime = $since } -ErrorAction SilentlyContinue) {
    $x = [xml]$e.ToXml()
    $h = @{}
    foreach ($d in $x.Event.EventData.Data) { $h[$d.Name] = $d.'#text' }
    $parent = [string]$h.ParentId
    $chain = $chains[$parent]
    $arrivals += [pscustomobject]@{
        at            = $e.TimeCreated.ToUniversalTime().ToString('o')
        diskNumber    = [int]$h.DiskNumber
        capacityBytes = [double]$h.Capacity
        serial        = [string]$h.SerialNumber       # the SLOT's canned id, not the drive's
        parentId      = $parent
        location      = [string]$h.Location
        enclosure     = $(if ($chain) { $chain.enclosure } else { $null })
        controller    = $(if ($chain) { $chain.controller } else { $null })
    }
}

# --- the errors --------------------------------------------------------------------------------
$errors = @()
foreach ($e in Get-WinEvent -FilterHashtable @{LogName = 'System'; Id = 153, 129, 7, 51; StartTime = $since } -ErrorAction SilentlyContinue) {
    if ($e.ProviderName -notmatch 'disk|storahci|stornvme|UASP|msahci|iaStor|Ntfs') { continue }
    $m = [regex]::Match($e.Message, 'Disk (\d+)')
    if (-not $m.Success) { continue }
    $lba = [regex]::Match($e.Message, 'address (0x[0-9a-fA-F]+)')
    $errors += [pscustomobject]@{
        at         = $e.TimeCreated.ToUniversalTime().ToString('o')
        id         = [int]$e.Id
        provider   = [string]$e.ProviderName
        diskNumber = [int]$m.Groups[1].Value
        lba        = $(if ($lba.Success) { $lba.Groups[1].Value } else { $null })
    }
}

# --- what is attached right now, so a drive can be named by more than its size ------------------
$present = @()
foreach ($d in Get-CimInstance Win32_DiskDrive -ErrorAction SilentlyContinue) {
    $present += [pscustomobject]@{
        diskNumber   = [int]$d.Index
        model        = [string]$d.Model
        bridgeSerial = [string]$d.SerialNumber       # a USB bridge reports ITS serial, not the drive's
        sizeBytes    = [double]$d.Size
        pnpDeviceId  = [string]$d.PNPDeviceID
    }
}

[pscustomobject]@{
    generated_at = (Get-Date).ToUniversalTime().ToString('o')
    window_days  = $Days
    host         = $env:COMPUTERNAME
    arrivals     = $arrivals
    errors       = $errors
    present      = $present
    note         = 'read-only export; smartSerial/partitionGuid may be added per arrival to identify drives better than capacity'
} | ConvertTo-Json -Depth 6 | Set-Content -Path $OutFile -Encoding UTF8

Write-Host "arrivals: $($arrivals.Count)  errors: $($errors.Count)  present: $($present.Count)  -> $OutFile"
