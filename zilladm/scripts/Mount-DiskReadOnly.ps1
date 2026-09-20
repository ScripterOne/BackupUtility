#Requires -RunAsAdministrator
#Requires -Version 5.1
<#
.SYNOPSIS
    Bring an offline disk online WITHOUT clearing its read-only flag, so it can be inspected
    with no possibility of writing to it. Reversible.

.DESCRIPTION
    Part of ZillaDM. Before a drive is drained, retired or trusted, you have to see
    what is on it — and some of the drives in this estate are repair candidates. This mounts
    them in the safest state Windows offers.

    WHY READ-ONLY IS KEPT
    --------------------
    A disk can be Offline AND IsReadOnly. Windows will happily bring it online while leaving
    read-only set: the volumes appear and are fully readable, and no write can reach the platter
    even by accident. For a drive that might be failing, that is exactly the state you want for
    a first look. Clearing read-only is a SEPARATE, deliberate act and this script never does it.

    WHY OfflineReason IS CHECKED FIRST
    ----------------------------------
    `OfflineReason` says why Windows offlined the disk, and one value is dangerous:

      Policy              - SAN policy or a manual offline. Onlining writes NOTHING. Safe.
      SignatureCollision  - two disks share a signature. Onlining can make Windows REWRITE
                            the disk signature, which is a write to a disk you have not yet
                            looked at. This script REFUSES that case and tells you.
      Other / Unknown     - not understood, so not assumed safe. Refused.

    A drive that is offline because it is failing to enumerate is a different problem again —
    see the estate notes on SATA pin 3 (PWDIS) and on enclosures needing a power-cycle.

.PARAMETER DiskNumber
    Disk numbers to bring online. Accepts "7,8" or "7 8".

.PARAMETER Offline
    Reverse it: put the named disks back offline. This is the rollback.

.PARAMETER Force
    Proceed even when OfflineReason is not Policy. You are then accepting a possible signature
    rewrite. Not the default for a reason.

.EXAMPLE
    .\Mount-DiskReadOnly.ps1 -DiskNumber 7,8
.EXAMPLE
    .\Mount-DiskReadOnly.ps1 -DiskNumber 7,8 -Offline      # rollback
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string[]] $DiskNumber,
    [switch] $Offline,
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$targets = foreach ($tok in ($DiskNumber -split '[,\s]+')) {
    if ($tok -match '^\d+$') { [int]$tok } elseif ($tok) { Write-Warning "Not a disk number: '$tok'" }
}

foreach ($n in $targets) {
    $d = Get-Disk -Number $n -ErrorAction SilentlyContinue
    if (-not $d) { Write-Warning "Disk $n not found."; continue }

    $label = "disk $n ($([math]::Round($d.Size/1TB,2)) TB, $($d.FriendlyName), serial $($d.SerialNumber))"

    if ($Offline) {
        try {
            Set-Disk -Number $n -IsOffline $true
            Write-Host "  $label -> OFFLINE" -ForegroundColor Yellow
        } catch { Write-Warning "$label could not be offlined: $($_.Exception.Message)" }
        continue
    }

    if (-not $d.IsOffline) {
        Write-Host "  $label already online (read-only: $($d.IsReadOnly))" -ForegroundColor DarkGray
    } else {
        $reason = "$($d.OfflineReason)"
        if ($reason -ne 'Policy' -and -not $Force) {
            Write-Host "  $label REFUSED - OfflineReason=$reason" -ForegroundColor Red
            Write-Host "     'Policy' is the safe case. Anything else may cause Windows to rewrite" -ForegroundColor DarkGray
            Write-Host "     the disk signature on the way up - a write to a disk nobody has read yet." -ForegroundColor DarkGray
            Write-Host "     Re-run with -Force only if you accept that." -ForegroundColor DarkGray
            continue
        }
        try {
            # IsReadOnly is deliberately NOT touched. Online + read-only = look, never write.
            Set-Disk -Number $n -IsOffline $false
            Write-Host "  $label -> ONLINE (read-only left as: $($d.IsReadOnly))" -ForegroundColor Green
        } catch {
            Write-Warning "$label could not be onlined: $($_.Exception.Message)"
            continue
        }
    }

    Start-Sleep -Milliseconds 800
    $parts = Get-Partition -DiskNumber $n -ErrorAction SilentlyContinue | Where-Object { $_.Size -gt 1GB }
    foreach ($p in $parts) {
        $v = Get-Volume -Partition $p -ErrorAction SilentlyContinue
        $letter = $p.DriveLetter ? "$($p.DriveLetter):" : '(no letter)'
        $used = ($v -and $v.Size) ? [math]::Round(($v.Size - $v.SizeRemaining)/1TB, 2) : $null
        Write-Host ("     part {0}  {1}  {2}  label='{3}'  used {4} TB of {5} TB" -f
            $p.PartitionNumber, $letter, ($v ? $v.FileSystem : '?'), ($v ? $v.FileSystemLabel : ''),
            $used, [math]::Round($p.Size/1TB,2)) -ForegroundColor Cyan

        if ($p.DriveLetter) {
            try {
                Get-ChildItem -LiteralPath "$($p.DriveLetter):\" -Force -ErrorAction SilentlyContinue |
                    Select-Object -First 12 |
                    ForEach-Object { Write-Host ("        {0}" -f $_.Name) -ForegroundColor DarkGray }
            } catch { }
        } else {
            Write-Host "        no drive letter - assign one to browse it" -ForegroundColor DarkYellow
        }
    }
}

Write-Host "`n  Rollback: re-run with -Offline" -ForegroundColor DarkGray
