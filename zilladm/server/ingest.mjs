/**
 * Ingest an NDJSON inventory into the catalogue.
 *
 *   node ingest.mjs ..\build\inventory-E-20260920-173915.ndjson
 *   node ingest.mjs ..\build\*.ndjson          (shell-expanded, or pass several paths)
 *
 * WHY A FILE IN THE MIDDLE
 * The scanner could POST rows directly. It writes NDJSON instead because a 20 TB walk is a
 * long-running thing that WILL be interrupted - a closed laptop, a bumped cable, a drive that
 * drops off the USB chain. A file on disk survives all of that, can be re-ingested, and is a
 * durable artifact independent of whether the database was healthy at the time. The scanner's
 * job is to observe; ingest's job is to record; neither should be able to ruin the other.
 *
 * WHY LINE-BY-LINE AND NOT JSON.parse(readFileSync(...))
 * These files reach gigabytes. Reading one into a string to parse it is how you discover Node's
 * string length limit at 2 AM, six drives into a scan.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as cat from "./catalogue.mjs";

const BATCH = 5000;

export async function ingestFile(path, onProgress) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let volumeId = null;
  let scanId = null;
  let files = [];
  let findings = [];
  let counts = { files: 0, findings: 0, bytes: 0, bad: 0 };
  let summary = null;

  const flush = () => {
    if (files.length) {
      const r = cat.ingestFiles(volumeId, scanId, files);
      counts.files += r.rows;
      counts.bytes += r.bytes;
      files = [];
    }
    if (findings.length) {
      counts.findings += cat.ingestFindings(volumeId, scanId, findings);
      findings = [];
    }
  };

  for await (const line of rl) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      // A malformed line is itself a finding, not a reason to abandon the file. One bad row in
      // two million should cost one row.
      counts.bad++;
      continue;
    }

    if (row.type === "volume") {
      if (!row.volume_serial) {
        throw new Error(
          `${basename(path)}: no volume_serial in the header. The catalogue keys on the NTFS ` +
          `volume serial and will not guess an identity.`);
      }
      volumeId = cat.upsertVolume(row);
      scanId = cat.startScan(volumeId, "inventory");
      continue;
    }

    if (volumeId === null) {
      throw new Error(`${basename(path)}: a row appeared before the volume header.`);
    }

    if (row.type === "file") {
      files.push(row);
      if (files.length >= BATCH) {
        flush();
        onProgress?.(counts);
      }
    } else if (row.type === "finding") {
      findings.push(row);
      if (findings.length >= BATCH) flush();
    } else if (row.type === "summary") {
      summary = row;
    }
  }

  flush();

  // The scanner's own tally versus what actually landed. If they disagree, the ingest is
  // incomplete and must not be recorded as a clean scan - that is precisely the "delivered means
  // the file exists" failure this whole project exists to avoid.
  let status = "complete";
  if (summary && summary.files !== counts.files) {
    status = "mismatch";
    console.warn(
      `  MISMATCH: scanner counted ${summary.files.toLocaleString()} files, ` +
      `catalogue recorded ${counts.files.toLocaleString()}.`);
  }
  if (counts.bad) {
    status = status === "complete" ? "complete_with_bad_rows" : status;
    console.warn(`  ${counts.bad} unparsable line(s) skipped.`);
  }
  // Carry the scanner's own verdict through. reconcile() refuses a limited walk, and it can
  // only do that if the limitation survives the trip into the catalogue.
  cat.finishScan(scanId, status, { limited: Boolean(summary?.limited || summary?.complete === false) });
  return { ...counts, status, volumeId, summary };
}

// pathToFileURL, not string-building. On Windows import.meta.url is file:///P:/...
// with THREE slashes; hand-assembling "file://" + path yields two, the comparison
// fails, and the CLI silently does nothing at all - no error, no output.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  let paths = argv.filter((a) => !a.startsWith("--") && !/^[A-Z]$/i.test(a) || a.includes("."));

  // --latest <LETTER> --dir <path>: pick the newest inventory for that drive. The GUI uses this
  // so the operator never has to paste a timestamped filename, and so "ingest what I just
  // scanned" cannot pick up a stale file by mistake.
  if (argv.includes("--latest")) {
    const letter = (argv[argv.indexOf("--latest") + 1] || "").replace(/:$/, "").toUpperCase();
    const dir = argv.includes("--dir") ? argv[argv.indexOf("--dir") + 1] : ".";
    const match = readdirSync(dir)
      .filter((f) => f.startsWith(`inventory-${letter}-`) && f.endsWith(".ndjson"))
      .sort();
    if (!match.length) {
      console.error(`no inventory-${letter}-*.ndjson in ${dir}`);
      process.exit(1);
    }
    paths = [join(dir, match[match.length - 1])];
    console.log(`latest for ${letter}: ${basename(paths[0])}`);
  }

  if (!paths.length) {
    console.error("usage: node ingest.mjs <inventory.ndjson> [...]");
    process.exit(1);
  }
  console.log(`catalogue: ${cat.DB_PATH}`);
  for (const p of paths) {
    const t = Date.now();
    process.stdout.write(`${basename(p)} ... `);
    try {
      const r = await ingestFile(p, (c) =>
        process.stdout.write(`\r${basename(p)} ... ${c.files.toLocaleString()} files`));
      const secs = (Date.now() - t) / 1000;
      console.log(
        `\r${basename(p)}: ${r.files.toLocaleString()} files, ` +
        `${(r.bytes / 1024 ** 4).toFixed(2)} TB, ${r.findings.toLocaleString()} findings ` +
        `in ${secs.toFixed(1)}s [${r.status}]`);
    } catch (e) {
      console.log(`\r${basename(p)}: FAILED - ${e.message}`);
    }
  }
}
