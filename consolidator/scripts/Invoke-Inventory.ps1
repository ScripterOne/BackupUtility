#Requires -Version 5.1
<#
.SYNOPSIS
    Read-only inventory of a volume. Emits NDJSON for the catalogue. No hashing, no decisions.

.DESCRIPTION
    Phase 1 of the Consolidator (see ../../PLAN-consolidator.md §7). Walks a volume and records
    path, size, mtime and attributes for every file. It cannot modify anything.

    TWO THINGS THAT MAKE THIS FAST
    ------------------------------
    1. `EnumerateFileSystemInfos()` per directory, NOT `EnumerateFiles(path)` + a stat per file.
       On NTFS the directory entry already carries length and timestamps, so the FileInfo objects
       come back populated. Enumerating paths and then stat-ing each one doubles the I/O for
       information you were already handed - and on a USB spindle, I/O is the entire budget.

    2. Manual stack recursion instead of SearchOption.AllDirectories. Measured on E: 2026-09-20,
       the framework's recursive enumerator threw on the first inaccessible directory and the
       whole walk stopped after 17 files. A walk that aborts on `$RECYCLE.BIN` is not an
       inventory. Every directory is tried independently and every failure is RECORDED (R6),
       because the retirement gate is 100% and a silent skip is what makes an incomplete
       inventory look complete.

    WHY NO HASHING HERE
    Hashing 20 TB over USB is ~30 hours. Hashing is phase 2, and phase 2 only hashes files whose
    SIZE collides with another file - a file with a unique size cannot have a duplicate. Most
    files are eliminated by a SQL GROUP BY costing no I/O at all. Measure first, hash second.

.PARAMETER DriveLetter
    Volume to inventory, e.g. E

.PARAMETER Out
    NDJSON output path. Default: .\build\inventory-<letter>-<timestamp>.ndjson

.PARAMETER ExcludeOsFiles
    Skip Windows/Program Files/AppData and the usual regenerable caches. The operator's
    "option to ignore Operating System files".

.PARAMETER Limit
    Stop after N files. For benchmarking a volume before committing to a full run.

.EXAMPLE
    .\Invoke-Inventory.ps1 -DriveLetter E -ExcludeOsFiles
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $DriveLetter,
    [string] $Out,
    [switch] $ExcludeOsFiles,
    [int] $Limit = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$letter = $DriveLetter.Trim().TrimEnd(':')
$root = "${letter}:\"
if (-not (Test-Path -LiteralPath $root)) { throw "Volume $root not found." }

# Always skipped: filesystem plumbing that is not data and cannot be read anyway.
$alwaysSkip = @('$RECYCLE.BIN', 'System Volume Information', '$Extend', 'lost+found')

# Regenerable or OS-owned. Skipped only with -ExcludeOsFiles, because on a personal drive some
# of these (Program Files) may hold installers the operator actually wants.
$osSkip = @('Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'AppData',
            'node_modules', '.git', '.pnpm-store', 'Steam', 'SteamLibrary',
            '$WinREAgent', 'Recovery', 'PerfLogs')

if (-not $Out) {
    $buildDir = Join-Path $PSScriptRoot '..\build'
    if (-not (Test-Path $buildDir)) { New-Item -ItemType Directory -Path $buildDir | Out-Null }
    $Out = Join-Path $buildDir ("inventory-{0}-{1}.ndjson" -f $letter, (Get-Date -Format 'yyyyMMdd-HHmmss'))
}

# ------------------------------------------------------------------ volume identity (plan §6)
# The NTFS VOLUME serial, not the drive letter and not the DISK serial. Measured 2026-09-20:
# ten USB disks here report only five distinct disk serials, because the ASMedia bridges report
# their own canned per-bay id. Keying on that would merge a personal drive with an arcade one.
$vol = Get-Volume -DriveLetter $letter -ErrorAction Stop
$part = Get-Partition -DriveLetter $letter -ErrorAction SilentlyContinue
$disk = $part ? (Get-Disk -Number $part.DiskNumber -ErrorAction SilentlyContinue) : $null
$wmiVol = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='${letter}:'" -ErrorAction SilentlyContinue

$header = [ordered]@{
    type          = 'volume'
    machine       = $env:COMPUTERNAME
    volume_serial = $wmiVol ? "$($wmiVol.VolumeSerialNumber)" : $null
    volume_guid   = "$($vol.UniqueId)"
    drive_letter  = "${letter}:"
    label         = "$($vol.FileSystemLabel)"
    filesystem    = "$($vol.FileSystem)"
    size_bytes    = [int64]$vol.Size
    free_bytes    = [int64]$vol.SizeRemaining
    disk_number   = $disk ? [int]$disk.Number : $null
    bus_type      = $disk ? "$($disk.BusType)" : $null
    disk_serial   = $disk ? "$($disk.SerialNumber)" : $null
    scanned_at    = (Get-Date).ToString('o')
    exclude_os    = [bool]$ExcludeOsFiles
}
if (-not $header.volume_serial) {
    Write-Warning "No NTFS volume serial for ${letter}: - the catalogue cannot key this volume reliably."
}


<#
    MANUAL JSON, NOT ConvertTo-Json.

    Measured 2026-09-20 on E:: ConvertTo-Json called once per row held the walk to ~316 files/sec,
    far below what the spindle delivers. The cmdlet is a heavy call and we make one per file.
    Hand-building the string puts the cost back on the disk, where it belongs.

    The escaping is not optional: Windows paths are full of backslashes, and a single unescaped
    one produces NDJSON that parses fine for a million rows and then fails, which is the worst
    possible failure mode for a two-hour scan.
#>
function ConvertTo-JsonString {
    param([string] $s)
    if ($null -eq $s) { return 'null' }
    $sb = [System.Text.StringBuilder]::new($s.Length + 8)
    [void]$sb.Append([char]34)
    foreach ($ch in $s.ToCharArray()) {
        $code = [int]$ch
        if ($ch -eq [char]34)      { [void]$sb.Append('\"') }
        elseif ($ch -eq [char]92)  { [void]$sb.Append('\\') }
        elseif ($code -eq 10)      { [void]$sb.Append('\n') }
        elseif ($code -eq 13)      { [void]$sb.Append('\r') }
        elseif ($code -eq 9)       { [void]$sb.Append('\t') }
        elseif ($code -lt 32)      { [void]$sb.Append(('\u{0:x4}' -f $code)) }
        else                       { [void]$sb.Append($ch) }
    }
    [void]$sb.Append([char]34)
    return $sb.ToString()
}

$writer = [System.IO.StreamWriter]::new($Out, $false, [System.Text.UTF8Encoding]::new($false), 1048576)
$writer.WriteLine(($header | ConvertTo-Json -Compress -Depth 5))

$sw = [Diagnostics.Stopwatch]::StartNew()
$files = 0; [int64]$bytes = 0; $findings = 0; $dirs = 0
$rootLen = $root.Length

# Explicit stack, so one unreadable directory costs that directory and nothing else.
$stack = [System.Collections.Generic.Stack[string]]::new()
$stack.Push($root)

while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    $dirs++
    try {
        $entries = ([System.IO.DirectoryInfo]$dir).EnumerateFileSystemInfos()
    } catch {
        # R6: a skip is a finding, never a silence.
        $writer.WriteLine(
            '{"type":"finding","severity":"blocking","kind":"directory_unreadable","path":' +
            (ConvertTo-JsonString $dir.Substring([Math]::Min($rootLen, $dir.Length))) +
            ',"detail":' + (ConvertTo-JsonString $_.Exception.GetType().Name) + '}')
        $findings++
        continue
    }

    foreach ($e in $entries) {
        try {
            $name = $e.Name
            if ($e -is [System.IO.DirectoryInfo]) {
                if ($alwaysSkip -contains $name) { continue }
                if ($ExcludeOsFiles -and ($osSkip -contains $name)) { continue }
                # Reparse points: a junction loop walks forever.
                if ($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                    $writer.WriteLine(
                        '{"type":"finding","severity":"info","kind":"reparse_point_skipped","path":' +
                        (ConvertTo-JsonString $e.FullName.Substring([Math]::Min($rootLen, $e.FullName.Length))) +
                        ',"detail":' + (ConvertTo-JsonString "$($e.Attributes)") + '}')
                    $findings++
                    continue
                }
                $stack.Push($e.FullName)
            } else {
                # Length and LastWriteTime come from the directory entry already read - no stat.
                $rel = $e.FullName.Substring([Math]::Min($rootLen, $e.FullName.Length))
                $ext = $e.Extension ? $e.Extension.TrimStart('.').ToLowerInvariant() : ''
                $writer.WriteLine(
                    '{"type":"file","path":' + (ConvertTo-JsonString $rel) +
                    ',"name":' + (ConvertTo-JsonString $name) +
                    ',"ext":' + $(if ($ext) { ConvertTo-JsonString $ext } else { 'null' }) +
                    ',"size":' + ([int64]$e.Length).ToString() +
                    ',"mtime":' + (ConvertTo-JsonString $e.LastWriteTimeUtc.ToString('o')) +
                    ',"attributes":' + (ConvertTo-JsonString "$($e.Attributes)") + '}')
                $files++
                $bytes += [int64]$e.Length
                if ($Limit -gt 0 -and $files -ge $Limit) { $stack.Clear(); break }
            }
        } catch {
            $writer.WriteLine(
                '{"type":"finding","severity":"blocking","kind":"entry_unreadable","path":' +
                (ConvertTo-JsonString $name) +
                ',"detail":' + (ConvertTo-JsonString $_.Exception.GetType().Name) + '}')
            $findings++
        }
    }

    if (($dirs % 500) -eq 0) {
        Write-Host ("  {0,10:N0} files  {1,8:N1} GB  {2,6:N0} dirs  {3,7:N0} files/sec" -f
            $files, ($bytes / 1GB), $dirs, ($files / [Math]::Max($sw.Elapsed.TotalSeconds, 0.001))) -NoNewline
        Write-Host "`r" -NoNewline
    }
}

$sw.Stop()
$writer.WriteLine(([ordered]@{
    type = 'summary'; files = $files; bytes = $bytes; findings = $findings; directories = $dirs
    seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
} | ConvertTo-Json -Compress))
$writer.Flush(); $writer.Close()

Write-Host ""
Write-Host ("  {0}: {1:N0} files, {2:N1} GB, {3:N0} dirs, {4:N0} findings in {5:N1}s ({6:N0} files/sec)" -f
    $root, $files, ($bytes / 1GB), $dirs, $findings, $sw.Elapsed.TotalSeconds,
    ($files / [Math]::Max($sw.Elapsed.TotalSeconds, 0.001))) -ForegroundColor Green
Write-Host "  -> $Out" -ForegroundColor DarkGray
