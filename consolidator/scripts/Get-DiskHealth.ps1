#Requires -Version 5.1
<#
.SYNOPSIS
    Disk health and SMART diagnostics, USB-bridge aware, with machine-readable output.

.DESCRIPTION
    Part of the Consolidator. Answers "which of these drives should I not trust with my only
    copy of something" before any data is moved onto or off them.

    WHY THIS IS NOT THE OBVIOUS SCRIPT
    ----------------------------------
    Almost every large drive in this estate is behind a USB-SATA bridge (ASMT ASM235CM). That
    breaks the two usual ways of asking a disk how it feels, and BOTH fail by returning nothing
    rather than by erroring:

      1. `MSStorageDriver_FailurePredictStatus` (root\wmi) does not reach USB-attached disks.
         It returns no instance, which reads exactly like "no predicted failure".

      2. `smartctl -A /dev/pdN` with no device type says "Unknown USB bridge" on ASMedia and
         exits non-zero. Its message goes to STDERR, so a pipeline that greps STDOUT sees an
         empty result and reports nothing wrong.

    An empty SMART result is NOT a healthy drive. This script therefore tries an explicit chain
    of device types, records which one worked, and reports UNKNOWN - never OK - when none did.

    Uses `smartctl --json` rather than regex over human output: the text format changes between
    versions and per vendor, and a regex that silently stops matching is the same failure again.

.PARAMETER DriveLetter
    One or more drive letters. Resolved to their physical disks.

.PARAMETER DiskNumber
    One or more physical disk numbers.

.PARAMETER All
    Every physical disk on the system.

.PARAMETER Json
    Emit JSON instead of the console report. This is what the GUI consumes.

.PARAMETER SmartCtlPath
    Override the smartctl location. Default: found on PATH, else the usual install dir.

.EXAMPLE
    .\Get-DiskHealth.ps1 -All
.EXAMPLE
    .\Get-DiskHealth.ps1 -DriveLetter L,M -Json
.NOTES
    Administrator is required for SMART. Without it the script still reports Windows-level
    health and says plainly that SMART was not attempted - it does not pretend the disk is fine.
#>
[CmdletBinding(DefaultParameterSetName = 'All')]
param(
    [Parameter(ParameterSetName = 'Letter', Mandatory)]
    [string[]] $DriveLetter,

    # STRING, not int[], on purpose: pwsh -File does not parse `-DiskNumber 9,10,4` as an
    # array - it arrives as the single token "9104". Accept text and split it ourselves so the
    # CLI and the GUI behave the same.
    [Parameter(ParameterSetName = 'Number', Mandatory)]
    [string[]] $DiskNumber,

    [Parameter(ParameterSetName = 'All')]
    [switch] $All,

    [switch] $Json,

    [string] $SmartCtlPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Never `exit` - it kills the host when dot-sourced and makes this unusable from a GUI.
# Every path returns objects instead.

function Test-IsAdministrator {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { $false }
}

function Resolve-SmartCtl {
    param([string] $Explicit)
    if ($Explicit) { return (Test-Path -LiteralPath $Explicit) ? $Explicit : $null }
    $cmd = Get-Command smartctl -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @(
            "$env:ProgramFiles\smartmontools\bin\smartctl.exe",
            "${env:ProgramFiles(x86)}\smartmontools\bin\smartctl.exe")) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $null
}

<#
    smartctl's exit code is a BITMASK, not a success/failure. Throwing away anything non-zero
    discards the actual finding: bit 3 means the disk is failing NOW.
#>
function Read-SmartExitCode {
    param([int] $Code)
    $bits = [ordered]@{
        0 = 'command line / device open error'
        1 = 'device open failed or no SMART support'
        2 = 'SMART command failed'
        3 = 'DISK FAILING NOW (SMART status returned FAILED)'
        4 = 'prefail attribute below threshold'
        5 = 'attribute was below threshold in the past'
        6 = 'error log contains errors'
        7 = 'self-test log contains errors'
    }
    $set = @()
    foreach ($b in $bits.Keys) { if ($Code -band (1 -shl $b)) { $set += $bits[$b] } }
    return $set
}

<#
    Device-type chain. `-d sat` is the one that makes ASMedia/JMicron USB bridges answer, and
    it is why the original script found nothing. Auto first (native SATA/NVMe), then the bridge
    types in order of how common they are here.
#>
$DeviceTypeChain = @('', 'sat', 'sat,12', 'usbasm1352r', 'usbjmicron', 'usbprolific', 'nvme')

function Get-SmartReport {
    param([string] $SmartCtl, [int] $Disk)

    if (-not $SmartCtl) {
        return [pscustomobject]@{
            available = $false; device_type = $null; exit_code = $null
            findings = @(); attributes = @{}; smart_status = 'UNKNOWN'
            detail = 'smartctl not installed. winget install smartmontools'
        }
    }

    foreach ($dt in $DeviceTypeChain) {
        $args = @('--json=c', '-H', '-A', '-i')
        if ($dt) { $args += @('-d', $dt) }
        $args += "/dev/pd$Disk"

        # 2>&1 matters: smartctl writes "Unknown USB bridge" to STDERR, and a pipeline that
        # only reads STDOUT sees success-shaped emptiness.
        $raw = & $SmartCtl @args 2>&1
        $code = $LASTEXITCODE
        $text = ($raw | Out-String)

        $parsed = $null
        try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $null }
        if (-not $parsed) { continue }

        $hasData = $false
        try { $hasData = [bool]$parsed.PSObject.Properties['device'] } catch { $hasData = $false }
        if (-not $hasData) { continue }

        # Pull the attributes that actually predict trouble.
        $wanted = @{
            5   = 'Reallocated_Sector_Ct'
            9   = 'Power_On_Hours'
            187 = 'Reported_Uncorrect'
            188 = 'Command_Timeout'
            197 = 'Current_Pending_Sector'
            198 = 'Offline_Uncorrectable'
            199 = 'UDMA_CRC_Error_Count'
        }
        $attrs = [ordered]@{}
        try {
            foreach ($a in $parsed.ata_smart_attributes.table) {
                if ($wanted.ContainsKey([int]$a.id)) {
                    $attrs[$wanted[[int]$a.id]] = [int]$a.raw.value
                }
            }
        } catch { }

        $status = 'UNKNOWN'
        try {
            if ($parsed.PSObject.Properties['smart_status']) {
                $status = $parsed.smart_status.passed ? 'PASSED' : 'FAILED'
            }
        } catch { }

        $findings = Read-SmartExitCode -Code $code

        # UDMA CRC errors are the signature of a bad CABLE OR BRIDGE, not a dying platter.
        # On a USB estate that is the most likely fault and the most commonly misread one -
        # the drive is fine, the path to it is not.
        if ($attrs.Contains('UDMA_CRC_Error_Count') -and $attrs['UDMA_CRC_Error_Count'] -gt 0) {
            $findings += "UDMA CRC errors ($($attrs['UDMA_CRC_Error_Count'])) - suspect the CABLE or USB BRIDGE, not the platter"
        }
        foreach ($k in 'Reallocated_Sector_Ct', 'Current_Pending_Sector', 'Offline_Uncorrectable') {
            if ($attrs.Contains($k) -and $attrs[$k] -gt 0) {
                $findings += "$k = $($attrs[$k]) - media defects present"
            }
        }

        $model = ''
        try { $model = [string]$parsed.model_name } catch { }

        return [pscustomobject]@{
            available   = $true
            device_type = $dt ? $dt : 'auto'
            exit_code   = $code
            smart_status = $status
            attributes  = $attrs
            findings    = @($findings)
            model       = $model
            detail      = $null
        }
    }

    return [pscustomobject]@{
        available = $false; device_type = $null; exit_code = $null
        smart_status = 'UNKNOWN'; attributes = @{}; findings = @()
        model = ''
        detail = "No device type in the chain produced SMART data. Tried: auto, $($DeviceTypeChain -ne '' -join ', '). This is NOT a clean bill of health."
    }
}

function Get-WmiFailurePredict {
    param([int] $Disk, [string] $BusType)
    # Kept because it is free when it works, but it does not reach USB - and its silence has
    # been misread as health before. Say so rather than returning a bare $false.
    if ($BusType -eq 'USB') {
        return [pscustomobject]@{ supported = $false; predict_failure = $null
            detail = 'root\wmi failure prediction does not reach USB-attached disks. No signal is not a good signal.' }
    }
    try {
        $p = Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop |
            Where-Object { $_.InstanceName -like "*$Disk*" } | Select-Object -First 1
        if (-not $p) {
            return [pscustomobject]@{ supported = $false; predict_failure = $null
                detail = 'No WMI instance matched this disk.' }
        }
        return [pscustomobject]@{ supported = $true; predict_failure = [bool]$p.PredictFailure; detail = $null }
    } catch {
        return [pscustomobject]@{ supported = $false; predict_failure = $null
            detail = "WMI query failed: $($_.Exception.Message)" }
    }
}

# ---------------------------------------------------------------- resolve the target disks
$targets = @()
switch ($PSCmdlet.ParameterSetName) {
    'Letter' {
        foreach ($l in ($DriveLetter -split '[,\s]+')) {
            $clean = $l.Trim().TrimEnd(':')
            if (-not $clean) { continue }
            $part = Get-Partition -DriveLetter $clean -ErrorAction SilentlyContinue
            if (-not $part) { Write-Warning "Drive letter '$clean' not found - skipped."; continue }
            $targets += [int]$part.DiskNumber
        }
    }
    'Number' {
        $targets = foreach ($tok in ($DiskNumber -split '[,\s]+')) {
            if ($tok -match '^\d+$') { [int]$tok }
            elseif ($tok) { Write-Warning "Not a disk number: '$tok' - skipped." }
        }
    }
    default  { $targets = (Get-Disk | Sort-Object Number).Number }
}
$targets = $targets | Select-Object -Unique

$isAdmin  = Test-IsAdministrator
$smartCtl = Resolve-SmartCtl -Explicit $SmartCtlPath

$results = foreach ($n in $targets) {
    $disk = Get-Disk -Number $n -ErrorAction SilentlyContinue
    if (-not $disk) { Write-Warning "Disk $n not found - skipped."; continue }

    # Match on DeviceId as a STRING; it is not reliably an int across providers.
    $phys = Get-PhysicalDisk -ErrorAction SilentlyContinue |
        Where-Object { "$($_.DeviceId)" -eq "$n" } | Select-Object -First 1

    $letters = @(Get-Partition -DiskNumber $n -ErrorAction SilentlyContinue |
        Where-Object DriveLetter | ForEach-Object { "$($_.DriveLetter):" })

    $smart = if ($isAdmin) { Get-SmartReport -SmartCtl $smartCtl -Disk $n } else {
        [pscustomobject]@{ available = $false; device_type = $null; exit_code = $null
            smart_status = 'UNKNOWN'; attributes = @{}; findings = @(); model = ''
            detail = 'Not run: administrator rights required. This is not a clean bill of health.' }
    }

    [pscustomobject]@{
        disk_number   = $n
        friendly_name = $disk.FriendlyName
        serial        = $disk.SerialNumber
        bus_type      = "$($disk.BusType)"
        size_tb       = [math]::Round($disk.Size / 1TB, 2)
        drive_letters = $letters
        windows_health      = "$($disk.HealthStatus)"
        windows_operational = "$($disk.OperationalStatus)"
        media_type    = $phys ? "$($phys.MediaType)" : $null
        wmi_predict   = Get-WmiFailurePredict -Disk $n -BusType "$($disk.BusType)"
        smart         = $smart
        verdict       = $(
            if ($smart.smart_status -eq 'FAILED') { 'FAILING' }
            elseif ($smart.findings.Count -gt 0)  { 'ATTENTION' }
            elseif ($smart.available)             { 'OK' }
            else                                  { 'UNKNOWN' }
        )
    }
}

if ($Json) {
    [pscustomobject]@{
        generated_at  = (Get-Date).ToString('o')
        machine       = $env:COMPUTERNAME
        administrator = $isAdmin
        smartctl      = $smartCtl
        disks         = @($results)
    } | ConvertTo-Json -Depth 8
    return
}

Write-Host "`n  DISK HEALTH - $env:COMPUTERNAME" -ForegroundColor Cyan
if (-not $isAdmin)  { Write-Host "  NOT ADMINISTRATOR - SMART was not attempted." -ForegroundColor Yellow }
if (-not $smartCtl) { Write-Host "  smartctl not found: winget install smartmontools" -ForegroundColor Yellow }
Write-Host ""

foreach ($r in $results) {
    $colour = switch ($r.verdict) {
        'FAILING'   { 'Red' }
        'ATTENTION' { 'Yellow' }
        'OK'        { 'Green' }
        default     { 'DarkYellow' }
    }
    $where = $r.drive_letters.Count ? ($r.drive_letters -join ' ') : '(no letter)'
    Write-Host ("  [{0,-9}] Disk {1,-2} {2,-8} {3,6} TB  {4,-12} {5}" -f
        $r.verdict, $r.disk_number, $r.bus_type, $r.size_tb, $where, $r.friendly_name) -ForegroundColor $colour
    if ($r.smart.available) {
        $a = $r.smart.attributes
        $bits = foreach ($k in $a.Keys) { "$k=$($a[$k])" }
        Write-Host ("             smart via -d {0}: {1}" -f $r.smart.device_type, ($bits -join '  ')) -ForegroundColor DarkGray
    } else {
        Write-Host ("             SMART UNKNOWN: {0}" -f $r.smart.detail) -ForegroundColor DarkGray
    }
    foreach ($f in $r.smart.findings) { Write-Host "             ! $f" -ForegroundColor Red }
}
Write-Host ""
