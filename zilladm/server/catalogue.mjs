/**
 * ZillaDM catalogue — schema and ingest.
 *
 * SQLite in WAL mode, one file, owned by this process. See ../../PLAN-ZillaDM.md §6.
 *
 * WHY THE SERVER IS THE ONLY WRITER
 * SQLite is single-writer, and SQLite over SMB is a known way to corrupt a database. Scanners
 * never touch the file: they emit NDJSON and this module ingests it. On one machine that looks
 * like ceremony; it is what lets a second machine's agent join later without a rewrite.
 *
 * WHY THE DATABASE LIVES OUTSIDE THE REPO
 * It will reach several GB. A catalogue committed to git by accident is worse than no catalogue.
 * Default P:\zilladm-data (NVMe, internal) — never a USB volume, whose sustained writes
 * fail on this estate, and never a volume that is itself queued for consolidation.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DB_PATH =
  process.env.ZILLADM_DB || "P:\\zilladm-data\\catalogue.db";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- IDENTITY IS THE NTFS VOLUME SERIAL.
-- Not the drive letter: letters move. Not the DISK serial either - measured 2026-09-20, ten USB
-- disks on LabZilla report only five distinct disk serials, because the ASMedia bridges report
-- their own canned per-bay id rather than the drive's. Keying on that would merge a personal
-- drive with an arcade one. The volume serial lives on the platter and travels with the disk.
CREATE TABLE IF NOT EXISTS volumes (
  id            INTEGER PRIMARY KEY,
  volume_serial TEXT NOT NULL UNIQUE,
  volume_guid   TEXT,
  machine       TEXT NOT NULL,
  label         TEXT,
  drive_letter  TEXT,
  filesystem    TEXT,
  size_bytes    INTEGER,
  free_bytes    INTEGER,
  -- Recorded for diagnostics, explicitly NOT the identity. See above.
  disk_number   INTEGER,
  bus_type      TEXT,
  disk_serial   TEXT,
  state         TEXT NOT NULL DEFAULT 'discovered',
  first_seen    TEXT NOT NULL,
  last_scan     TEXT
);

-- A files row is a SIGHTING. The same content in nine places is nine rows, and that is how
-- provenance becomes a property of the schema rather than a promise in a document (plan R4).
CREATE TABLE IF NOT EXISTS files (
  id         INTEGER PRIMARY KEY,
  volume_id  INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  name       TEXT NOT NULL,
  ext        TEXT,
  size_bytes INTEGER NOT NULL,
  mtime      TEXT,
  attributes TEXT,
  quick_hash TEXT,
  sha256     TEXT,
  archive_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  scan_id    INTEGER,
  UNIQUE (volume_id, path)
);

-- R6: a skip is a finding. Permission denied, path too long, unreadable - each recorded and
-- surfaced. Silent skips are how an incomplete inventory passes for a complete one, and the
-- retirement gate (plan §4) is 100%, so every one of these blocks a drive from being retired.
CREATE TABLE IF NOT EXISTS findings (
  id        INTEGER PRIMARY KEY,
  volume_id INTEGER REFERENCES volumes(id) ON DELETE CASCADE,
  scan_id   INTEGER,
  path      TEXT,
  kind      TEXT NOT NULL,
  detail    TEXT,
  at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id           INTEGER PRIMARY KEY,
  volume_id    INTEGER REFERENCES volumes(id) ON DELETE CASCADE,
  phase        TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  files_seen   INTEGER NOT NULL DEFAULT 0,
  bytes_seen   INTEGER NOT NULL DEFAULT 0,
  findings     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'running'
);

CREATE INDEX IF NOT EXISTS ix_files_size   ON files(size_bytes);
CREATE INDEX IF NOT EXISTS ix_files_sha    ON files(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_files_quick  ON files(quick_hash) WHERE quick_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_files_volume ON files(volume_id);
CREATE INDEX IF NOT EXISTS ix_find_volume  ON findings(volume_id);
`;

/**
 * FTS5 is the operator's "fast lookup source" - a searchable index of everything he owns, which
 * outlives the consolidation. Created separately because an FTS build failure must not take the
 * whole schema with it.
 */
const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  name, path, content='files', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, name, path) VALUES (new.id, new.name, new.path);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name, path) VALUES ('delete', old.id, old.name, old.path);
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name, path) VALUES ('delete', old.id, old.name, old.path);
  INSERT INTO files_fts(rowid, name, path) VALUES (new.id, new.name, new.path);
END;
`;

let db = null;

export function open() {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  migrate(db);
  try {
    db.exec(FTS);
  } catch (e) {
    // Search is a feature; the catalogue is the asset. Losing FTS must not lose the inventory.
    console.warn(`FTS5 unavailable, search disabled: ${e.message}`);
  }
  return db;
}

const now = () => new Date().toISOString();

/** Upsert a volume by its NTFS volume serial and return its id. */
export function upsertVolume(v) {
  const d = open();
  d.prepare(
    `INSERT INTO volumes (volume_serial, volume_guid, machine, label, drive_letter, filesystem,
                          size_bytes, free_bytes, disk_number, bus_type, disk_serial, first_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(volume_serial) DO UPDATE SET
       volume_guid=excluded.volume_guid, machine=excluded.machine, label=excluded.label,
       drive_letter=excluded.drive_letter, filesystem=excluded.filesystem,
       size_bytes=excluded.size_bytes, free_bytes=excluded.free_bytes,
       disk_number=excluded.disk_number, bus_type=excluded.bus_type,
       disk_serial=excluded.disk_serial`
  ).run(
    v.volume_serial, v.volume_guid ?? null, v.machine, v.label ?? null,
    v.drive_letter ?? null, v.filesystem ?? null,
    v.size_bytes ?? null, v.free_bytes ?? null,
    v.disk_number ?? null, v.bus_type ?? null, v.disk_serial ?? null, now()
  );
  return d.prepare(`SELECT id FROM volumes WHERE volume_serial = ?`).get(v.volume_serial).id;
}

export function startScan(volumeId, phase = "inventory") {
  const d = open();
  d.prepare(`INSERT INTO scans (volume_id, phase, started_at) VALUES (?,?,?)`)
    .run(volumeId, phase, now());
  return d.prepare(`SELECT last_insert_rowid() AS id`).get().id;
}

/**
 * Ingest a batch of file rows.
 *
 * R1 (idempotent): UNIQUE(volume_id, path) plus ON CONFLICT DO UPDATE, so re-scanning a volume
 * refreshes rows rather than duplicating them. This is the property the old BackupUtility lacked
 * - it resolved a collision by keeping BOTH copies, which is why there are duplicates in hundreds
 * of thousands of places.
 */
export function ingestFiles(volumeId, scanId, rows) {
  const d = open();
  const stmt = d.prepare(
    `INSERT INTO files (volume_id, path, name, ext, size_bytes, mtime, attributes, scan_id)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(volume_id, path) DO UPDATE SET
       size_bytes=excluded.size_bytes, mtime=excluded.mtime,
       attributes=excluded.attributes, scan_id=excluded.scan_id`
  );
  let bytes = 0;
  d.exec("BEGIN");
  try {
    for (const r of rows) {
      stmt.run(volumeId, r.path, r.name, r.ext ?? null, r.size ?? 0,
        r.mtime ?? null, r.attributes ?? null, scanId);
      bytes += Number(r.size ?? 0);
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  d.prepare(`UPDATE scans SET files_seen = files_seen + ?, bytes_seen = bytes_seen + ?
             WHERE id = ?`).run(rows.length, bytes, scanId);
  return { rows: rows.length, bytes };
}

export function ingestFindings(volumeId, scanId, rows) {
  if (!rows?.length) return 0;
  const d = open();
  const stmt = d.prepare(
    `INSERT INTO findings (volume_id, scan_id, path, kind, detail, at) VALUES (?,?,?,?,?,?)`);
  d.exec("BEGIN");
  try {
    for (const r of rows) stmt.run(volumeId, scanId, r.path ?? null, r.kind, r.detail ?? null, now());
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
  d.prepare(`UPDATE scans SET findings = findings + ? WHERE id = ?`).run(rows.length, scanId);
  return rows.length;
}

export function finishScan(scanId, status = "complete", { limited = false, ioErrors = 0, retries = 0 } = {}) {
  const d = open();
  d.prepare(`UPDATE scans SET finished_at = ?, status = ?, limited = ?, io_errors = ?, retries = ? WHERE id = ?`)
    .run(now(), status, limited ? 1 : 0, ioErrors, retries, scanId);
  const s = d.prepare(`SELECT * FROM scans WHERE id = ?`).get(scanId);
  if (s?.volume_id) d.prepare(`UPDATE volumes SET last_scan = ? WHERE id = ?`).run(now(), s.volume_id);
  return s;
}

export function volumes() {
  return open().prepare(
    `SELECT v.*,
            (SELECT COUNT(*) FROM files f WHERE f.volume_id = v.id AND f.deleted_at IS NULL) AS file_count,
            (SELECT COALESCE(SUM(size_bytes),0) FROM files f WHERE f.volume_id = v.id AND f.deleted_at IS NULL) AS bytes,
            (SELECT COUNT(*) FROM files f WHERE f.volume_id = v.id AND f.deleted_at IS NOT NULL) AS gone_count,
            (SELECT COUNT(*) FROM findings n WHERE n.volume_id = v.id)       AS finding_count
     FROM volumes v ORDER BY v.drive_letter, v.label`).all();
}

/** Size per top-level folder — the "where does the 9.3 TB actually sit" answer. */
export function topFolders(volumeId, limit = 40) {
  return open().prepare(
    `SELECT CASE WHEN instr(path, '\\') > 0
                 THEN substr(path, 1, instr(path, '\\') - 1) ELSE '(root)' END AS folder,
            COUNT(*) AS files, SUM(size_bytes) AS bytes
     FROM files WHERE volume_id = ? AND deleted_at IS NULL
     GROUP BY folder ORDER BY bytes DESC LIMIT ?`).all(volumeId, limit);
}

export function search(q, limit = 200) {
  const d = open();
  try {
    return d.prepare(
      `SELECT f.id, f.name, f.path, f.size_bytes, v.drive_letter, v.label
       FROM files_fts JOIN files f ON f.id = files_fts.rowid
       JOIN volumes v ON v.id = f.volume_id
       WHERE files_fts MATCH ? LIMIT ?`).all(q, limit);
  } catch {
    return d.prepare(
      `SELECT f.id, f.name, f.path, f.size_bytes, v.drive_letter, v.label
       FROM files f JOIN volumes v ON v.id = f.volume_id
       WHERE f.name LIKE ? LIMIT ?`).all(`%${q}%`, limit);
  }
}

/**
 * Duplicate groups by content hash. This is the payoff: one row per group of byte-identical
 * files, ordered by what dropping the redundant copies would recover.
 *
 * `waste` is size x (copies - 1) — the space freed by keeping ONE. It is deliberately not
 * "total size of the group", which would overstate the recovery by the copy you keep.
 */
export function duplicates(volumeId = null, limit = 300, minWaste = 1024 * 1024) {
  // A threshold, because without one this is 300 rows of 1 KB files and the 120 MB one is
  // below the fold. The count of what is hidden is returned alongside so the filter cannot
  // quietly hide the tail - see duplicateSummary().
  const where = (volumeId ? "AND f.volume_id = ?" : "");
  const args = volumeId ? [volumeId, minWaste, limit] : [minWaste, limit];
  return open().prepare(
    `SELECT f.sha256, COUNT(*) copies, MAX(f.size_bytes) size_bytes,
            MAX(f.size_bytes) * (COUNT(*) - 1) AS waste,
            MIN(f.name) AS name,
            GROUP_CONCAT(DISTINCT v.drive_letter) AS drives
     FROM files f JOIN volumes v ON v.id = f.volume_id
     WHERE f.sha256 IS NOT NULL AND f.deleted_at IS NULL ${where}
     GROUP BY f.sha256 HAVING COUNT(*) > 1 AND waste >= ?
     ORDER BY waste DESC LIMIT ?`).all(...args);
}

export function duplicateSummary(volumeId = null) {
  const where = volumeId ? "AND volume_id = ?" : "";
  const args = volumeId ? [volumeId] : [];
  const r = open().prepare(
    `SELECT COUNT(*) groups, COALESCE(SUM(copies - 1),0) redundant,
            COALESCE(SUM(sz * (copies - 1)),0) recoverable
     FROM (SELECT sha256, COUNT(*) copies, MAX(size_bytes) sz FROM files
           WHERE sha256 IS NOT NULL AND deleted_at IS NULL ${where} GROUP BY sha256 HAVING COUNT(*) > 1)`).get(...args);
  const hashed = open().prepare(
    `SELECT COUNT(*) n FROM files WHERE sha256 IS NOT NULL ${where}`).get(...args);
  return { ...r, hashed: hashed.n };
}

/**
 * Findings, worst first. `blocking` stops a drive being retired (plan §4 — the gate is 100%);
 * `info` does not. Without that split, 3,168 benign pnpm symlinks would block a drive forever.
 */
export function findings(volumeId = null, limit = 400) {
  const where = volumeId ? "WHERE n.volume_id = ?" : "";
  const args = volumeId ? [volumeId, limit] : [limit];
  return open().prepare(
    `SELECT n.kind, n.detail, COUNT(*) count, MIN(n.path) example,
            COALESCE(v.drive_letter,'?') drive,
            CASE WHEN n.kind IN ('reparse_point_skipped') THEN 'info' ELSE 'blocking' END severity
     FROM findings n LEFT JOIN volumes v ON v.id = n.volume_id ${where}
     GROUP BY n.kind, n.detail, v.drive_letter
     ORDER BY severity, count DESC LIMIT ?`).all(...args);
}

/**
 * Migration: files.deleted_at, added 2026-09-20.
 *
 * SQLite has no "ADD COLUMN IF NOT EXISTS", and the schema above uses CREATE TABLE IF NOT
 * EXISTS, so an existing catalogue never gets new columns from it. Check and add.
 */
function migrate(d) {
  const scanCols = d.prepare(`PRAGMA table_info(scans)`).all().map((c) => c.name);
  if (!scanCols.includes("limited")) {
    d.exec(`ALTER TABLE scans ADD COLUMN limited INTEGER NOT NULL DEFAULT 0`);
  }
  if (!scanCols.includes("io_errors")) {
    d.exec(`ALTER TABLE scans ADD COLUMN io_errors INTEGER NOT NULL DEFAULT 0`);
    d.exec(`ALTER TABLE scans ADD COLUMN retries INTEGER NOT NULL DEFAULT 0`);
  }
  const cols = d.prepare(`PRAGMA table_info(files)`).all().map((c) => c.name);
  if (!cols.includes("deleted_at")) {
    d.exec(`ALTER TABLE files ADD COLUMN deleted_at TEXT`);
    d.exec(`CREATE INDEX IF NOT EXISTS ix_files_live ON files(volume_id) WHERE deleted_at IS NULL`);
  }
}

/**
 * Reconcile a volume against its latest COMPLETE scan: anything not seen is marked gone.
 *
 * WHY MARKED AND NOT DELETED. The catalogue's value is partly historical - after Eidolon was
 * deleted from P:, its 317,264 rows were the only remaining record of which model weights had
 * been there. That record is worth keeping (plan R4, provenance). So `deleted_at` is set and
 * every live query filters on it; nothing is destroyed.
 *
 * WHY IT REFUSES A PARTIAL SCAN. This decides that files are gone because a scan did not see
 * them. Run it against a -Limit run, or an interrupted one, and it condemns everything the walk
 * never reached - which on a 1.6 million file volume is a catastrophe that looks like success.
 * So: only a scan whose status is 'complete' AND which was not limited.
 */
export function reconcile(volumeId, { dryRun = false } = {}) {
  const d = open();
  const scan = d.prepare(
    `SELECT * FROM scans WHERE volume_id = ? AND phase = 'inventory' AND status = 'complete'
     ORDER BY id DESC LIMIT 1`).get(volumeId);
  if (!scan) {
    return { refused: "no completed inventory scan for this volume - nothing may be marked gone" };
  }
  if (scan.limited) {
    return { refused: `scan ${scan.id} was limited; a partial walk cannot decide what is missing` };
  }

  const stale = d.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(size_bytes),0) b FROM files
     WHERE volume_id = ? AND deleted_at IS NULL AND (scan_id IS NULL OR scan_id <> ?)`)
    .get(volumeId, scan.id);

  /*
    R11b - A MOVED TREE IS NOT A DELETED ONE.

    Reorganising 40,000 photos into new folders looks, to a naive reconcile, exactly like 40,000
    deletions and 40,000 creations. Content hashes tell them apart: same sha256, same volume,
    seen in THIS scan at a different path, is a MOVE.

    Reported separately rather than suppressed, because a move is still worth knowing about -
    and because a large move count next to a large delete count is usually the same event,
    which is precisely what the operator needs to see to trust the delete number.

    The honest limit: a file with no sha256 cannot be classified at all. Without a hash a move
    and a delete are indistinguishable, so those are counted apart rather than guessed at. An
    unhashed disappearance is 'unknown', not 'deleted'.
  */
  const moved = d.prepare(
    `SELECT COUNT(*) n FROM files old
     WHERE old.volume_id = ? AND old.deleted_at IS NULL
       AND (old.scan_id IS NULL OR old.scan_id <> ?)
       AND old.sha256 IS NOT NULL
       AND EXISTS (SELECT 1 FROM files cur
                   WHERE cur.volume_id = old.volume_id AND cur.scan_id = ?
                     AND cur.sha256 = old.sha256 AND cur.path <> old.path)`)
    .get(volumeId, scan.id, scan.id);

  const unhashed = d.prepare(
    `SELECT COUNT(*) n FROM files
     WHERE volume_id = ? AND deleted_at IS NULL AND (scan_id IS NULL OR scan_id <> ?)
       AND sha256 IS NULL`).get(volumeId, scan.id);

  const detail = {
    scan_id: scan.id,
    gone: stale.n, bytes: stale.b,
    moved: moved.n,
    unclassifiable: unhashed.n,
    truly_gone: stale.n - moved.n,
  };

  if (dryRun) return { ...detail, would_mark: stale.n };

  d.prepare(
    `UPDATE files SET deleted_at = ?
     WHERE volume_id = ? AND deleted_at IS NULL AND (scan_id IS NULL OR scan_id <> ?)`)
    .run(new Date().toISOString(), volumeId, scan.id);
  return { ...detail, marked: stale.n };
}

export function deletedSummary(volumeId = null) {
  const where = volumeId ? "AND volume_id = ?" : "";
  const args = volumeId ? [volumeId] : [];
  return open().prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(size_bytes),0) b FROM files
     WHERE deleted_at IS NOT NULL ${where}`).get(...args);
}

/**
 * READ HEALTH — what actually happened when we read this drive.
 *
 * SMART says what the drive believes about itself, and needs administrator rights. This says
 * what happened when every file on it was opened, and needs nothing. For the question that
 * matters here - "can I move 13 TB off this drive?" - the second is the more direct answer.
 *
 * It is also the only signal that caught anything real: Windows reported every drive on this
 * machine as Healthy while E: threw an I/O device error mid-walk and H: failed 1,141 of 23,399
 * cold reads.
 *
 * VERDICTS
 *   unread     never scanned. Not healthy - unmeasured. (Same rule as the SMART panel.)
 *   clean      scanned with no I/O errors, no retries, no hash failures.
 *   flaky      errors or retries occurred but the reads eventually succeeded.
 *   failing    reads that never succeeded. Do not plan a migration off this drive as-is.
 */
export function readHealth() {
  const d = open();
  return d.prepare(
    `SELECT v.id, v.drive_letter, v.label, v.bus_type, v.disk_number, v.volume_serial,
            (SELECT COUNT(*) FROM files f WHERE f.volume_id = v.id AND f.deleted_at IS NULL) AS files,
            (SELECT COALESCE(SUM(io_errors),0) FROM scans s WHERE s.volume_id = v.id) AS io_errors,
            (SELECT COALESCE(SUM(retries),0)   FROM scans s WHERE s.volume_id = v.id) AS retries,
            (SELECT COUNT(*) FROM findings n WHERE n.volume_id = v.id
                AND n.kind IN ('hash_failed','directory_unreadable','entry_unreadable',
                               'enumeration_failed','volume_vanished')) AS read_failures,
            (SELECT COUNT(*) FROM scans s WHERE s.volume_id = v.id) AS scans
     FROM volumes v ORDER BY v.drive_letter`).all().map((r) => ({
      ...r,
      verdict: r.scans === 0 ? "unread"
             : r.read_failures > 0 ? "failing"
             : (r.io_errors > 0 || r.retries > 0) ? "flaky"
             : "clean",
    }));
}

/**
 * DISK HEALTH HISTORY.
 *
 * Keyed on the DRIVE'S OWN SERIAL, read by smartctl through the bridge. Nothing else here is a
 * stable identity:
 *   - drive letters move,
 *   - the NTFS volume serial identifies a VOLUME, not the disk under it,
 *   - Get-Disk's SerialNumber is the ASMedia bridge's canned per-bay id - disks 3 and 5 both
 *     report 10C000000519 and are different drives,
 *   - and disk NUMBERS move: H: was disk 6 this afternoon and disk 7 this evening.
 *
 * A snapshot per scan, never overwritten. The point is the TREND: one reallocated sector is
 * noise, three more next month is a dying drive. A single current reading cannot tell you which
 * you are looking at, and the earlier read-health verdict was wrong for exactly this reason -
 * H: showed 'clean' because its failure history had been cleared.
 */
export function recordHealth(report) {
  const d = open();
  d.exec(`CREATE TABLE IF NOT EXISTS disk_health (
    id           INTEGER PRIMARY KEY,
    at           TEXT NOT NULL,
    drive_serial TEXT,
    model        TEXT,
    firmware     TEXT,
    bus_type     TEXT,
    size_tb      REAL,
    disk_number  INTEGER,
    drive_letters TEXT,
    verdict      TEXT,
    smart_status TEXT,
    device_type  TEXT,
    power_on_hours     INTEGER,
    reallocated        INTEGER,
    pending            INTEGER,
    offline_uncorrect  INTEGER,
    udma_crc           INTEGER,
    findings     TEXT,
    attributes   TEXT
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS ix_health_serial ON disk_health(drive_serial, at)`);

  const st = d.prepare(
    `INSERT INTO disk_health (at, drive_serial, model, firmware, bus_type, size_tb, disk_number,
       drive_letters, verdict, smart_status, device_type, power_on_hours, reallocated, pending,
       offline_uncorrect, udma_crc, findings, attributes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const at = now();
  let n = 0;
  d.exec("BEGIN");
  try {
    for (const x of report.disks || []) {
      const a = x.smart?.attributes || {};
      st.run(at, x.smart?.serial || null, x.smart?.model || null, x.smart?.firmware || null,
        x.bus_type || null, x.size_tb ?? null, x.disk_number ?? null,
        (x.drive_letters || []).join(",") || null,
        x.verdict || null, x.smart?.smart_status || null, x.smart?.device_type || null,
        a.Power_On_Hours ?? null, a.Reallocated_Sector_Ct ?? null,
        a.Current_Pending_Sector ?? null, a.Offline_Uncorrectable ?? null,
        a.UDMA_CRC_Error_Count ?? null,
        JSON.stringify(x.smart?.findings || []), JSON.stringify(a));
      n++;
    }
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
  return { recorded: n, at };
}

/** Latest reading per physical drive, with the change since the previous one. */
export function healthHistory() {
  const d = open();
  try {
    return d.prepare(
      `WITH latest AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY drive_serial ORDER BY at DESC) rn
         FROM disk_health WHERE drive_serial IS NOT NULL)
       SELECT cur.drive_serial, cur.model, cur.drive_letters, cur.bus_type, cur.size_tb,
              cur.verdict, cur.smart_status, cur.at,
              cur.power_on_hours, cur.reallocated, cur.pending, cur.udma_crc,
              prev.at AS prev_at,
              cur.reallocated - COALESCE(prev.reallocated, cur.reallocated) AS d_reallocated,
              cur.pending     - COALESCE(prev.pending, cur.pending)         AS d_pending,
              cur.udma_crc    - COALESCE(prev.udma_crc, cur.udma_crc)       AS d_udma_crc,
              (SELECT COUNT(*) FROM disk_health h WHERE h.drive_serial = cur.drive_serial) AS readings
       FROM latest cur
       LEFT JOIN latest prev ON prev.drive_serial = cur.drive_serial AND prev.rn = 2
       WHERE cur.rn = 1 ORDER BY cur.drive_letters`).all();
  } catch { return []; }
}
