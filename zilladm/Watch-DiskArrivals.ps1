<#
  Watch-DiskArrivals.ps1 - print every disk the moment Windows registers it.

  For powering drives on ONE AT A TIME and seeing exactly which physical disk arrived, where.
  Reads the Partition/Diagnostic log (event 1006), which Windows writes on every disk arrival
  with the disk's capacity, its USB parent (bay + port), and its raw partition table - so a
  drive is identified by the partition GUIDs it carries, not by a drive letter (letters move;
  disk numbers move; ASMedia bridges report canned serials like 10C000000519).

  Read-only. Never opens a volume, never reads a file, never sends a request to a device.

    powershell -ExecutionPolicy Bypass -File Watch-DiskArrivals.ps1            # watch from now
    powershell -ExecutionPolicy Bypass -File Watch-DiskArrivals.ps1 -Since 30  # replay last 30 min first
#>
param([int]$Since = 0, [int]$PollSeconds = 3)

# Partition GUIDs as they appear (mixed-endian hex) in the raw GPT - from HKLM\SYSTEM\MountedDevices.
# Add a line when a new volume is identified.
$Known = @{
  '9cb223d627e3964289f4f17a23a87cae' = 'E: Retro (Seagate IronWolf 18TB ST18000NE000, ZVT7F2MT)'
  'b7769d9bfe0ed6499a2785ef125c25e2' = 'D: (HGST Ultrastar 12TB HUH721212ALE601, 8CH9041E)'
}
# Extend $Known from MountedDevices at start, so every lettered volume is recognised.
try {
  $md = Get-ItemProperty 'HKLM:\SYSTEM\MountedDevices'
  foreach ($p in $md.PSObject.Properties | Where-Object { $_.Name -match '^\\DosDevices\\([A-Z]):$' }) {
    $letter = $p.Name.Substring(12, 1); $b = [byte[]]$p.Value   # '\DosDevices\X:' - not $Matches, which is stale here
    # Only 'DMIO:ID:' + 16-byte GPT partition GUID is a real disk partition. Other 24-byte values
    # (e.g. Google Drive's virtual N:) matched unrelated disks in testing - skip them.
    $isDmio = $b.Length -eq 24 -and ([Text.Encoding]::ASCII.GetString($b, 0, 8) -eq 'DMIO:ID:')
    $hexProbe = if ($b.Length -eq 24) { (($b[8..23] | ForEach-Object { $_.ToString('x2') }) -join '') } else { '' }
    if ($isDmio -and $hexProbe -ne '00000000000000000000000000000000') {
      $hex = (($b[8..23] | ForEach-Object { $_.ToString('x2') }) -join '')
      if (-not $Known.ContainsKey($hex)) { $Known[$hex] = "${letter}: (from MountedDevices)" }
    }
  }
} catch {}

function Show($e) {
  $x = [xml]$e.ToXml(); $d = @{}
  foreach ($n in $x.Event.EventData.Data) { $d[$n.Name] = $n.'#text' }
  $bytes = [int64]$d.Capacity
  $pt = "$($d.PartitionTable)".ToLower()
  $who = @($Known.Keys | Where-Object { $pt.Contains($_) } | ForEach-Object { $Known[$_] })
  $port = ''
  try { $port = (Get-PnpDeviceProperty -InstanceId $d.ParentId -KeyName DEVPKEY_Device_LocationInfo -ErrorAction Stop).Data } catch {}
  $state = if ($bytes -eq 0) { 'NO MEDIA (0 bytes)' } else { '{0,6:n2} TB' -f ($bytes / 1e12) }
  '{0:HH:mm:ss}  disk {1,-3} {2,-18} {3,-22} bridge {4,-14} {5}' -f $e.TimeCreated, $d.DiskNumber, $state, $port, $d.SerialNumber,
    $(if ($who.Count) { '<= ' + ($who -join ' + ') } elseif ($bytes -gt 0) { '<= unknown volume(s)' } else { '' })
}

$from = (Get-Date).AddMinutes(-$Since)
"watching disk arrivals from $($from.ToString('HH:mm:ss')) (Ctrl+C to stop)"
$seen = @{}
while ($true) {
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Partition/Diagnostic'; Id = 1006; StartTime = $from } -ErrorAction SilentlyContinue
  foreach ($e in ($ev | Sort-Object TimeCreated)) {
    $key = "$($e.RecordId)"
    if (-not $seen.ContainsKey($key)) { $seen[$key] = 1; Show $e }
  }
  Start-Sleep -Seconds $PollSeconds
}
