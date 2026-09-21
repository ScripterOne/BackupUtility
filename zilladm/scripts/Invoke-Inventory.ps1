#Requires -Version 5.1
<#
.SYNOPSIS
    Read-only inventory of a volume. Emits NDJSON for the catalogue. No hashing, no decisions.

.DESCRIPTION
    Phase 1 of ZillaDM (see ../../PLAN-ZillaDM.md §7). Walks a volume and records
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
    [int] $Limit = 0,

    # Milliseconds to pause between directories. The drives here live behind a chained-hub USB
    # DAS that drops I/O under sustained load, and they are staying there - so being a good
    # citizen on a fragile bus matters more than finishing quickly.
    [int] $ThrottleMs = 0,

    # Raise the throttle automatically when the bus starts complaining, and lower it when it
    # stops. Without this the operator has to guess a number, and the right number changes with
    # what else is touching the enclosure.
    [switch] $Adaptive,

    [int] $MaxThrottleMs = 750,

    # Resume an interrupted walk instead of starting over. A 9 TB volume is hours; losing hour
    # eight to a dropped USB bridge, a reboot or a closed lid is the difference between a tool
    # and a product.
    [switch] $Resume
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

$buildDir = Join-Path $PSScriptRoot '..\build'
if (-not (Test-Path $buildDir)) { New-Item -ItemType Directory -Path $buildDir | Out-Null }

<#
    RESUME.

    The checkpoint is the PENDING DIRECTORY STACK, not a file offset. Directories are the unit
    of work here - the walk pops one, emits everything in it, and pushes its children - so a
    stack snapshot plus the NDJSON written so far is a complete, consistent restart point.
    Re-walking a directory that was already emitted is harmless: ingest upserts on
    (volume_id, path), so a duplicated row updates rather than doubling. That is R1 earning its
    keep in a place it was not designed for.

    Checkpoint per volume, not per run, so -Resume needs no filename.
#>
$checkpoint = Join-Path $buildDir ("checkpoint-{0}.json" -f $letter)
$resuming = $false
if ($Resume -and (Test-Path -LiteralPath $checkpoint)) {
    try {
        $cp = Get-Content -Raw -LiteralPath $checkpoint | ConvertFrom-Json
        if ($cp.volume_serial -eq $header.volume_serial -and (Test-Path -LiteralPath $cp.out)) {
            $Out = $cp.out
            $resuming = $true
            Write-Host ("  resuming: {0:N0} files already recorded, {1:N0} directories pending" -f
                $cp.files, $cp.pending.Count) -ForegroundColor Cyan
        } else {
            # A checkpoint for a DIFFERENT volume that happens to share this letter is the exact
            # trap drive letters exist to create. Refuse it rather than merge two drives.
            Write-Warning "Checkpoint is for volume $($cp.volume_serial), this is $($header.volume_serial). Starting fresh."
        }
    } catch { Write-Warning "Checkpoint unreadable, starting fresh: $($_.Exception.Message)" }
}
if (-not $Out) {
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

<#
    R11c - A VANISHED VOLUME IS NOT AN EMPTY ONE.

    If a drive drops off the USB bus mid-walk - and these enclosures do, one of them needs a
    power-cycle to re-enumerate - every directory still on the stack becomes unreachable. The
    walk would then end early and write a `complete` summary, and reconciliation would read that
    as "everything not seen has been deleted". On a large volume that is a catastrophe shaped
    exactly like success.

    So the volume is re-checked at every checkpoint AND immediately before the summary is
    written. It must still be mounted and must still carry the SAME NTFS volume serial - a
    re-enumerated drive can come back on the same letter as a different volume, which is the
    worst case of all because nothing looks wrong.
#>
function Test-VolumeStillPresent {
    param([string] $Letter, [string] $ExpectedSerial)
    try {
        $v = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='${Letter}:'" -ErrorAction Stop
        if (-not $v) { return @{ ok = $false; reason = 'volume is no longer mounted' } }
        if ($ExpectedSerial -and "$($v.VolumeSerialNumber)" -ne $ExpectedSerial) {
            return @{ ok = $false; reason = "volume serial changed: expected $ExpectedSerial, found $($v.VolumeSerialNumber)" }
        }
        return @{ ok = $true; reason = $null }
    } catch {
        return @{ ok = $false; reason = "volume check failed: $($_.Exception.Message)" }
    }
}

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

$writer = [System.IO.StreamWriter]::new($Out, $resuming, [System.Text.UTF8Encoding]::new($false), 1048576)
if (-not $resuming) { $writer.WriteLine(($header | ConvertTo-Json -Compress -Depth 5)) }

<#
    CONNECTION PACING.

    Measured 2026-09-20: E: threw 'The request could not be performed because of an I/O device
    error' on a cold walk, and H: failed 1,141 of 23,399 cold reads. Both sit on the same
    chained-hub USB DAS whose sustained WRITES were already known to fail. These drives are not
    moving to internal SATA, so the tool adapts to the bus rather than the other way round.

    The adaptive rule is deliberately asymmetric: back off FAST on trouble, recover SLOWLY.
    A bus that has just errored is more likely to error again, and a scan that speeds up
    immediately after a fault simply reproduces it.
#>
$sw = [Diagnostics.Stopwatch]::StartNew()
$files = 0; [int64]$bytes = 0; $findings = 0; $dirs = 0
$throttle = $ThrottleMs
$volumeLost = $null
$ioErrors = 0          # blocking I/O failures this run - the connection health signal
$ioErrorsAtLastCheck = 0
$cleanDirs = 0
$rootLen = $root.Length

# Explicit stack, so one unreadable directory costs that directory and nothing else.
$stack = [System.Collections.Generic.Stack[string]]::new()
if ($resuming) {
    # Push in reverse so the stack pops in the order it was saved - otherwise a resumed walk
    # visits the tree backwards, which still works but makes two runs impossible to compare.
    for ($i = $cp.pending.Count - 1; $i -ge 0; $i--) { $stack.Push([string]$cp.pending[$i]) }
    $files = [int]$cp.files; [int64]$bytes = [int64]$cp.bytes
    $findings = [int]$cp.findings; $dirs = [int]$cp.dirs
} else {
    $stack.Push($root)
}

while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    $dirs++
    $entries = $null
    for ($try = 0; $try -lt 3; $try++) {
        try { $entries = ([System.IO.DirectoryInfo]$dir).EnumerateFileSystemInfos(); break }
        catch { Start-Sleep -Milliseconds (50 * [Math]::Pow(2, $try)) }
    }
    if ($null -eq $entries) {
        try { throw "directory could not be opened after 3 attempts" } catch {
        # R6: a skip is a finding, never a silence.
        $writer.WriteLine(
            '{"type":"finding","severity":"blocking","kind":"directory_unreadable","path":' +
            (ConvertTo-JsonString $dir.Substring([Math]::Min($rootLen, $dir.Length))) +
            ',"detail":' + (ConvertTo-JsonString $_.Exception.GetType().Name) + '}')
        $findings++
        }
        continue
    }

    <#
        MANUAL ENUMERATOR, not `foreach ($e in $entries)`.

        .NET directory enumeration is LAZY: EnumerateFileSystemInfos() returns immediately and
        the I/O happens inside MoveNext(). A try/catch around the CALL therefore catches almost
        nothing, and an exception thrown mid-iteration escapes the loop entirely.

        Measured 2026-09-20: the E: scan died at 42,063 files on
        'The request could not be performed because of an I/O device error' inside a __pycache__
        directory. With $ErrorActionPreference = 'Stop' that terminated the whole script. A
        nine-hour walk would have been lost at hour eight to one bad directory on a USB bridge
        that is known to drop I/O under load.

        So MoveNext() is stepped by hand. A failure costs the REST OF THAT DIRECTORY, is recorded
        as a blocking finding, and the walk continues with the rest of the stack.
    #>
    $en = $entries.GetEnumerator()
    while ($true) {
        try {
            if (-not $en.MoveNext()) { break }
            $e = $en.Current
        } catch {
            $writer.WriteLine(
                '{"type":"finding","severity":"blocking","kind":"enumeration_failed","path":' +
                (ConvertTo-JsonString $dir.Substring([Math]::Min($rootLen, $dir.Length))) +
                ',"detail":' + (ConvertTo-JsonString $_.Exception.Message) + '}')
            $findings++
            $ioErrors++
            break
        }
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

    # ---- pacing -------------------------------------------------------------------------
    if ($Adaptive -and ($dirs % 25) -eq 0) {
        if ($ioErrors -gt $ioErrorsAtLastCheck) {
            # Trouble: double the pause immediately, from a 25 ms floor so the first step is real.
            $throttle = [Math]::Min($MaxThrottleMs, [Math]::Max(25, $throttle * 2))
            $ioErrorsAtLastCheck = $ioErrors
            $cleanDirs = 0
        } else {
            $cleanDirs += 25
            # Recover only after a long clean stretch, and only one step at a time.
            if ($cleanDirs -ge 500 -and $throttle -gt $ThrottleMs) {
                $throttle = [Math]::Max($ThrottleMs, [int]($throttle / 2))
                $cleanDirs = 0
            }
        }
    }
    if ($throttle -gt 0) { Start-Sleep -Milliseconds $throttle }

    # Checkpoint every 250 directories. Flush FIRST: a checkpoint claiming rows that are still
    # in the write buffer would resume past data that never reached disk.
    if (($dirs % 250) -eq 0) {
        try {
            $writer.Flush()
            @{ volume_serial = $header.volume_serial; out = $Out; files = $files
               bytes = $bytes; findings = $findings; dirs = $dirs
               pending = @($stack.ToArray()); at = (Get-Date).ToString('o')
            } | ConvertTo-Json -Compress -Depth 4 | Set-Content -LiteralPath $checkpoint -Encoding utf8
        } catch { }   # a checkpoint that cannot be written must not stop the walk

        $present = Test-VolumeStillPresent -Letter $letter -ExpectedSerial $header.volume_serial
        if (-not $present.ok) {
            $writer.WriteLine(
                '{"type":"finding","severity":"blocking","kind":"volume_vanished","path":null,"detail":' +
                (ConvertTo-JsonString $present.reason) + '}')
            $findings++
            $volumeLost = $present.reason
            $stack.Clear()
            break
        }
    }

    if (($dirs % 500) -eq 0) {
        Write-Host ("  {0,10:N0} files  {1,8:N1} GB  {2,6:N0} dirs  {3,6:N0} f/s  throttle {4,4}ms  io-err {5}" -f
            $files, ($bytes / 1GB), $dirs, ($files / [Math]::Max($sw.Elapsed.TotalSeconds, 0.001)),
            $throttle, $ioErrors) -NoNewline
        Write-Host "`r" -NoNewline
    }
}

$sw.Stop()
$final = Test-VolumeStillPresent -Letter $letter -ExpectedSerial $header.volume_serial
if (-not $final.ok -and $null -eq $volumeLost) { $volumeLost = $final.reason }
$writer.WriteLine(([ordered]@{
    type = 'summary'; files = $files; bytes = $bytes; findings = $findings; directories = $dirs
    seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    io_errors = $ioErrors; final_throttle_ms = $throttle; adaptive = [bool]$Adaptive
    # COMPLETE means the stack emptied on its own. A -Limit run stopped early and must never be
    # used to decide that unseen files were deleted - it would condemn everything not reached.
    complete = (($Limit -le 0 -or $files -lt $Limit) -and $null -eq $volumeLost)
    limited = ($Limit -gt 0)
    volume_lost = $volumeLost
} | ConvertTo-Json -Compress))
$writer.Flush(); $writer.Close()
# A completed walk leaves no checkpoint - otherwise -Resume would restart a finished scan.
# A walk that lost its volume KEEPS its checkpoint: it is interrupted, not finished, and
# deleting it would throw away hours of work over a cable.
if ($null -eq $volumeLost -and (Test-Path -LiteralPath $checkpoint)) {
    Remove-Item -LiteralPath $checkpoint -Force -EA SilentlyContinue
}

Write-Host ""
Write-Host ("  {0}: {1:N0} files, {2:N1} GB, {3:N0} dirs, {4:N0} findings in {5:N1}s ({6:N0} files/sec)" -f
    $root, $files, ($bytes / 1GB), $dirs, $findings, $sw.Elapsed.TotalSeconds,
    ($files / [Math]::Max($sw.Elapsed.TotalSeconds, 0.001))) -ForegroundColor Green
if ($volumeLost) {
    Write-Host ("  VOLUME LOST: {0}" -f $volumeLost) -ForegroundColor Red
    Write-Host "  This scan is INCOMPLETE and is marked so. Checkpoint kept - rerun with -Resume." -ForegroundColor Red
}
if ($ioErrors -gt 0) {
    Write-Host ("  CONNECTION: {0} I/O error(s); throttle ended at {1} ms. This bus is struggling." -f
        $ioErrors, $throttle) -ForegroundColor Yellow
}
Write-Host "  -> $Out" -ForegroundColor DarkGray
