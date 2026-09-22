// Turn an Export-DiskEvents.ps1 dump into per-drive verdicts.
//
//   pwsh -File zilladm/scripts/Export-DiskEvents.ps1 -Days 3
//   node zilladm/server/diagnose.mjs %TEMP%\zilladm-disk-events.json
//
// It answers the question that cost a whole evening on 2026-09-21: is this drive bad, or is the
// thing it is plugged into bad? It never writes to a disk and never changes a drive's state.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { summarise, verdictForDrive } from "./attribution.mjs";

const TB = 1024 ** 4;
const short = (p) => (p ?? "unknown").replace(/USB\\VID_[0-9A-F]+&PID_[0-9A-F]+\\/gi, "").slice(-44);
const size = (b) => (b >= TB / 2 ? `${(b / TB).toFixed(2)} TB` : `${Math.round(b / 1024 ** 3)} GB`);

export function report(dump) {
  const summary = summarise({ arrivals: dump.arrivals ?? [], errors: dump.errors ?? [] });
  const lines = [];
  lines.push(`window: ${dump.window_days ?? "?"} day(s) to ${dump.generated_at ?? "?"}  on ${dump.host ?? "?"}`);
  lines.push(`errors attributed: ${summary.attributed}   unattributed: ${summary.unattributed}` +
    (summary.unattributed ? "   (before the first arrival in the window - not pinned on anyone)" : ""));
  lines.push("");
  lines.push("BY DRIVE");
  for (const d of summary.byDrive) {
    const v = verdictForDrive(d.key, summary);
    const cap = d.key.startsWith("cap:") ? size(Number(d.key.slice(4))) : d.key;
    lines.push(`  ${cap.padEnd(10)} ${String(d.errors).padStart(6)} errors  ${v.verdict.toUpperCase()}`);
    lines.push(`             ${v.because}`);
    if (d.enclosuresSeenOn?.length) lines.push(`             seen in: ${d.enclosuresSeenOn.map(short).join(", ")}`);
  }
  lines.push("");
  lines.push("BY ENCLOSURE (a fault shared by several drives belongs here, not to a drive)");
  for (const p of summary.byEnclosure ?? []) {
    lines.push(`  ${short(p.key).padEnd(46)} ${String(p.errors).padStart(6)} errors across ${p.drives.length} drive(s)`);
  }
  return { summary, text: lines.join("\n") };
}

// pathToFileURL, not string-building: on Windows argv[1] is "P:\..." and hand-made file:// URLs
// miss a slash, so the CLI silently did nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node diagnose.mjs <export.json>");
    process.exit(2);
  }
  console.log(report(JSON.parse(readFileSync(path, "utf8"))).text);
}
