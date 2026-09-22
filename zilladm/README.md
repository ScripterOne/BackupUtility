# ZillaDM — data management

See [`../PLAN-ZillaDM.md`](../PLAN-ZillaDM.md) for the full plan. This directory is the
build, starting with the piece needed before any data moves: **which drives can be trusted.**

## Disk health

```powershell
# prerequisites (both, or SMART cannot be read)
winget install smartmontools        # once
#   ...and run the shell AS ADMINISTRATOR

# console
pwsh -File .\scripts\Get-DiskHealth.ps1 -All
pwsh -File .\scripts\Get-DiskHealth.ps1 -DriveLetter L,M

# GUI  ->  http://127.0.0.1:7420
node .\server\server.mjs
```

**UNKNOWN is not OK.** Most large drives in this estate sit behind a USB-SATA bridge
(`ASMT ASM235CM`), and both usual SMART paths return *nothing* rather than an error on USB —
which reads like good news. The script tries an explicit device-type chain (`-d sat`,
`usbasm1352r`, `usbjmicron`…), records which one answered, and reports UNKNOWN when none did.

**UDMA CRC errors mean the cable or the bridge**, not the platter. On this estate that is the
likeliest fault, and it is the one most often misread as a dying disk.

The GUI binds to `127.0.0.1` only. It reports the contents and health of local storage and has no
business on a LAN interface; the agent↔server protocol that will need auth is a later phase.

## Is it the drive, or the thing it is plugged into?

```powershell
pwsh -File .\zilladm\scripts\Export-DiskEvents.ps1 -Days 3     # READ-ONLY: event logs + PnP tree
node .\zilladm\server\diagnose.mjs $env:TEMP\zilladm-disk-events.json
node --test                                                    # from the repo root (a path arg is run as a module, not discovered)
```

Windows reports disk errors against a **disk number**, and disk numbers move: on 2026-09-21 one
drive was disk 4, then disk 3, then disk 5 within an evening, while another drive took the number it
left behind. Anything counted per disk number is wrong by the next re-enumeration, and that is how
three healthy drives were called failing - one of them written off outright.

`attribution.mjs` places every error on the arrival/removal timeline (Partition/Diagnostic 1006), so
an error is attributed to whichever drive held that number **at that moment**, and to the **path**
it sat on. Then:

- a fault shared by several drives in one enclosure is the **enclosure's** (`path_fault`);
- a fault that follows one drive into a **second enclosure** is the **drive's** (`drive_fault`);
- one drive, one enclosure, nothing else seen is **`insufficient_evidence`** - move it and re-test
  before calling a drive bad.

Two identity traps it encodes: the ASMedia bridge "serials" (`10C000000519`…) are canned **per slot**
and reused across enclosures, so a serial names a slot, never a drive; and a 5-bay enclosure has an
internal hub chain, so the enclosure is the **outermost** hub below the root hub - taking the first
parent hub made one bay look like two and turned a path fault into a false "bad drive".

Run on the real 3-day window on 2026-09-22: 15,838 errors attributed, **14,789 of them across four
drives on one enclosure - all five drives `path_fault`, none blamed.**

### Drives move between machines

Letters and disk numbers do not survive a move to another computer; the SMART serial does, so the
ledger (`server/disposition.mjs`) keys on it and records the HOST each change happened on. A drive
carries one history across machines, and `hostsSeen()` reads it back - a fault seen on two different
hosts is the strongest evidence there is that the drive itself is the problem, stronger than two
enclosures on one machine, which can share a controller.

Retiring a drive as a hardware failure is refused unless the errors followed it (another enclosure,
or another host) or SMART shows pending/offline-uncorrectable sectors or reallocations that grew. A
UDMA CRC count is the cable or the bridge and never retires a drive.
