/**
 * ZillaDM phase 2 — fingerprint.
 *
 *   node fingerprint.mjs               all volumes
 *   node fingerprint.mjs --volume E:   one volume
 *   node fingerprint.mjs --plan        cost only, reads nothing
 *
 * THE WHOLE POINT IS TO READ AS LITTLE AS POSSIBLE.
 *
 *   1. SIZE. A file whose size is unique across the catalogue cannot have a duplicate. It is
 *      never opened. This costs a GROUP BY and no disk I/O whatsoever.
 *   2. QUICK HASH on what survives: first 64 KB + last 64 KB + the size. For a 4 GB video that
 *      is 128 KB instead of 4 GB; for a 40 KB file it is the whole file, so we simply hash it
 *      fully and record that the two hashes are the same thing.
 *   3. FULL HASH only where the quick hash ALSO collides.
 *
 * Measured on P: 2026-09-20: 1,446,751 candidates, 44.5 GB of quick-hash reads against 301.8 GB
 * to hash them fully - 85% less. Note that P: is the WORST case for step 1: a code drive has
 * enormous numbers of identically-sized small files, and size eliminated only 10% of them. On a
 * media drive, where large files dominate, step 1 eliminates far more. Do not generalise one
 * drive's ratio to the estate - measure with --plan first.
 *
 * SHA-256, not something faster. With SHA-NI a modern CPU hashes at 1-2 GB/s, roughly ten times
 * faster than a USB spindle delivers. The disk is the constraint; a faster hash buys nothing.
 *
 * CONCURRENCY IS PER DISK, NOT PER CORE. Spinning disks are seek-bound: two readers on one
 * spindle is slower than one. Volumes on different physical disks run in parallel; volumes
 * sharing a disk are serialised.
 */
import { createHash } from "node:crypto";
import { open as openFile } from "node:fs/promises";
import * as cat from "./catalogue.mjs";

const QUICK_BYTES = 64 * 1024;          // each end
const QUICK_THRESHOLD = QUICK_BYTES * 2; // at or below this, a "quick" hash IS the whole file


/**
 * RETRY, because a failed read here is usually not a failed file.
 *
 * Measured 2026-09-20 fingerprinting H:: 1,141 of 23,399 reads failed - 4.9% - every one with
 * Node's unmapped `UNKNOWN`, and every one succeeded immediately when tried again by hand. The
 * drives sit behind a chained-hub USB DAS whose sustained WRITES were already known to fail; it
 * turns out sustained READS drop too, just rarely enough that nothing noticed.
 *
 * This matters more than it looks. Without a retry those 1,141 become BLOCKING findings, and a
 * blocking finding stops the drive being retired (plan §4, the gate is 100%). The tool would
 * have refused to retire a drive forever over files that read perfectly.
 *
 * Retries only transient-looking failures. ENOENT and EACCES are real answers and are returned
 * immediately - retrying them would just be slow and still wrong.
 */
const PERMANENT = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "ENAMETOOLONG"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return { value: await fn(), retries: i };
    } catch (e) {
      last = e;
      if (PERMANENT.has(e.code)) break;
      await sleep(40 * 2 ** i); // 40, 80, 160 ms - a USB bridge recovers in well under a second
    }
  }
  throw last;
}

const hex = (b) => createHash("sha256").update(b).digest("hex");
const gb = (n) => (Number(n) / 1024 ** 3).toFixed(1) + " GB";

/**
 * Quick fingerprint: size + both ends. Returns { quick, full } where `full` is set only when
 * the file was small enough that we read all of it - in which case the quick hash IS the full
 * hash and there is no reason to ever read the file again.
 */
async function quickHash(absPath, size) {
  const fh = await openFile(absPath, "r");
  try {
    if (size <= QUICK_THRESHOLD) {
      const buf = Buffer.alloc(Number(size));
      await fh.read(buf, 0, Number(size), 0);
      const h = hex(buf);
      return { quick: h, full: h, read: Number(size) };
    }
    const head = Buffer.alloc(QUICK_BYTES);
    const tail = Buffer.alloc(QUICK_BYTES);
    await fh.read(head, 0, QUICK_BYTES, 0);
    await fh.read(tail, 0, QUICK_BYTES, Number(size) - QUICK_BYTES);
    const h = createHash("sha256");
    h.update(String(size));
    h.update(head);
    h.update(tail);
    return { quick: h.digest("hex"), full: null, read: QUICK_BYTES * 2 };
  } finally {
    await fh.close();
  }
}

async function fullHash(absPath) {
  const fh = await openFile(absPath, "r");
  try {
    const h = createHash("sha256");
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return { hash: h.digest("hex"), read: pos };
  } finally {
    await fh.close();
  }
}

/** What phase 2 would cost, without opening a single file. */
export function plan(volumeId = null) {
  const d = cat.open();
  const where = volumeId ? "AND volume_id = ?" : "";
  const args = volumeId ? [volumeId] : [];
  const dup = `size_bytes IN (SELECT size_bytes FROM files WHERE size_bytes > 0
               GROUP BY size_bytes HAVING COUNT(*) > 1)`;
  const total = d.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(size_bytes),0) b FROM files WHERE 1=1 ${where}`).get(...args);
  const cand = d.prepare(
    `SELECT COUNT(*) n,
            COALESCE(SUM(MIN(size_bytes, ${QUICK_THRESHOLD})),0) quick_io,
            COALESCE(SUM(size_bytes),0) b
     FROM files WHERE size_bytes > 0 AND ${dup} ${where}`).get(...args);
  const done = d.prepare(
    `SELECT COUNT(*) n FROM files WHERE quick_hash IS NOT NULL ${where}`).get(...args);
  return {
    files: total.n, bytes: total.b,
    candidates: cand.n, quick_io: cand.quick_io, candidate_bytes: cand.b,
    eliminated_by_size: total.n - cand.n,
    already_fingerprinted: done.n,
  };
}

/** Volumes grouped by physical disk, so one spindle is never read by two workers at once. */
function volumeGroups(filter) {
  const rows = cat.open().prepare(
    `SELECT id, drive_letter, label, disk_number FROM volumes ORDER BY disk_number, drive_letter`).all();
  const wanted = filter
    ? rows.filter((r) => (r.drive_letter || "").toUpperCase().startsWith(filter.toUpperCase().replace(/:$/, "")))
    : rows;
  const byDisk = new Map();
  for (const r of wanted) {
    const k = r.disk_number ?? `v${r.id}`;
    if (!byDisk.has(k)) byDisk.set(k, []);
    byDisk.get(k).push(r);
  }
  return [...byDisk.values()];
}

async function fingerprintVolume(vol, onTick) {
  const d = cat.open();
  const scanId = cat.startScan(vol.id, "fingerprint");
  const setQuick = d.prepare(`UPDATE files SET quick_hash = ?, sha256 = COALESCE(?, sha256) WHERE id = ?`);
  const setFull = d.prepare(`UPDATE files SET sha256 = ? WHERE id = ?`);
  const stats = { quick: 0, full: 0, read: 0, errors: 0, retried: 0 };
  const findings = [];

  const candidates = d.prepare(
    `SELECT id, path, size_bytes FROM files
     WHERE volume_id = ? AND quick_hash IS NULL AND size_bytes > 0
       AND size_bytes IN (SELECT size_bytes FROM files WHERE size_bytes > 0
                          GROUP BY size_bytes HAVING COUNT(*) > 1)
     ORDER BY path`).all(vol.id);

  for (const f of candidates) {
    const abs = `${vol.drive_letter}\\${f.path}`;
    try {
      const { value: r, retries } = await withRetry(() => quickHash(abs, f.size_bytes));
      setQuick.run(r.quick, r.full, f.id);
      stats.quick++;
      stats.read += r.read;
      stats.retried += retries ? 1 : 0;
    } catch (e) {
      // R6: a skip is a finding. An unhashable file cannot be proven duplicate, so it BLOCKS
      // its drive from being retired - the correct and conservative outcome. Record the code AND
      // the message: `UNKNOWN` alone told us nothing and cost a diagnostic round trip.
      findings.push({ path: f.path, kind: "hash_failed",
                      detail: `${e.code || "?"}: ${String(e.message).slice(0, 160)}` });
      stats.errors++;
    }
    if (stats.quick % 2000 === 0) onTick?.(vol, stats);
  }

  // Full hash only where the quick hash collides AND we have not already read the whole file.
  const collisions = d.prepare(
    `SELECT id, path, size_bytes FROM files
     WHERE volume_id = ? AND sha256 IS NULL AND quick_hash IS NOT NULL
       AND quick_hash IN (SELECT quick_hash FROM files WHERE quick_hash IS NOT NULL
                          GROUP BY quick_hash HAVING COUNT(*) > 1)
     ORDER BY size_bytes`).all(vol.id);

  for (const f of collisions) {
    try {
      const { value: r, retries } = await withRetry(() => fullHash(`${vol.drive_letter}\\${f.path}`));
      setFull.run(r.hash, f.id);
      stats.full++;
      stats.read += r.read;
      stats.retried += retries ? 1 : 0;
    } catch (e) {
      findings.push({ path: f.path, kind: "hash_failed",
                      detail: `${e.code || "?"}: ${String(e.message).slice(0, 160)}` });
      stats.errors++;
    }
    if (stats.full % 200 === 0) onTick?.(vol, stats);
  }

  if (findings.length) cat.ingestFindings(vol.id, scanId, findings);
  cat.finishScan(scanId, stats.errors ? "complete_with_findings" : "complete");
  return stats;
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const volFilter = args.includes("--volume") ? args[args.indexOf("--volume") + 1] : null;
  const planOnly = args.includes("--plan");

  const groups = volumeGroups(volFilter);
  if (!groups.length) {
    console.error("No matching volumes in the catalogue. Run the inventory first.");
    process.exit(1);
  }

  if (planOnly) {
    for (const g of groups) for (const v of g) {
      const p = plan(v.id);
      console.log(`${v.drive_letter} ${v.label || ""}`);
      console.log(`   ${p.files.toLocaleString()} files, ${gb(p.bytes)}`);
      console.log(`   ${p.eliminated_by_size.toLocaleString()} eliminated by size alone (never opened)`);
      console.log(`   ${p.candidates.toLocaleString()} candidates -> ${gb(p.quick_io)} to quick-hash` +
                  ` (vs ${gb(p.candidate_bytes)} to hash them fully)`);
      if (p.already_fingerprinted) console.log(`   ${p.already_fingerprinted.toLocaleString()} already fingerprinted - resumable`);
    }
    process.exit(0);
  }

  const tick = (v, s) => process.stdout.write(
    `\r  ${v.drive_letter} quick ${s.quick.toLocaleString()}  full ${s.full.toLocaleString()}  read ${gb(s.read)}  retried ${s.retried}  err ${s.errors}   `);

  // One worker per physical disk; volumes on the same disk run in sequence behind it.
  const t0 = Date.now();
  const results = await Promise.all(groups.map(async (group) => {
    const out = [];
    for (const v of group) out.push([v, await fingerprintVolume(v, tick)]);
    return out;
  }));

  console.log("");
  let read = 0, errors = 0;
  for (const [v, s] of results.flat()) {
    console.log(`  ${v.drive_letter} ${String(v.label || "").padEnd(16)} quick ${s.quick.toLocaleString().padStart(9)}  ` +
                `full ${s.full.toLocaleString().padStart(7)}  read ${gb(s.read).padStart(9)}  retried ${s.retried}  errors ${s.errors}`);
    read += s.read; errors += s.errors;
  }
  console.log(`\n  ${gb(read)} read in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${errors} error(s)`);
  if (errors) console.log("  Files that could not be hashed BLOCK their drive from retirement. See findings.");
}
