# Consolidator

See [`../PLAN-consolidator.md`](../PLAN-consolidator.md) for the full plan. This directory is the
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
