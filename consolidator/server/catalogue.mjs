/**
 * Consolidator catalogue — schema and ingest.
 *
 * SQLite in WAL mode, one file, owned by this process. See ../../PLAN-consolidator.md §6.
 *
 * WHY THE SERVER IS THE ONLY WRITER
 * SQLite is single-writer, and SQLite over SMB is a known way to corrupt a database. Scanners
 * never touch the file: they emit NDJSON and this module ingests it. On one machine that looks
 * like ceremony; it is what lets a second machine's agent join later without a rewrite.
 *
 * WHY THE DATABASE LIVES OUTSIDE THE REPO
 * It will reach several GB. A catalogue committed to git by accident is worse than no catalogue.
 * Default P:\consolidator-data (NVMe, internal) — never a USB volume, whose sustained writes
 * fail on this estate, and never a volume that is itself queued for consolidation.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DB_PATH =
  process.env.CONSOLIDATOR_DB || "P:\\consolidator-data\\catalogue.db";

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

export function finishScan(scanId, status = "complete") {
  const d = open();
  d.prepare(`UPDATE scans SET finished_at = ?, status = ? WHERE id = ?`).run(now(), status, scanId);
  const s = d.prepare(`SELECT * FROM scans WHERE id = ?`).get(scanId);
  if (s?.volume_id) d.prepare(`UPDATE volumes SET last_scan = ? WHERE id = ?`).run(now(), s.volume_id);
  return s;
}

export function volumes() {
  return open().prepare(
    `SELECT v.*,
            (SELECT COUNT(*) FROM files f WHERE f.volume_id = v.id)          AS file_count,
            (SELECT COALESCE(SUM(size_bytes),0) FROM files f WHERE f.volume_id = v.id) AS bytes,
            (SELECT COUNT(*) FROM findings n WHERE n.volume_id = v.id)       AS finding_count
     FROM volumes v ORDER BY v.drive_letter, v.label`).all();
}

/** Size per top-level folder — the "where does the 9.3 TB actually sit" answer. */
export function topFolders(volumeId, limit = 40) {
  return open().prepare(
    `SELECT CASE WHEN instr(path, '\\') > 0
                 THEN substr(path, 1, instr(path, '\\') - 1) ELSE '(root)' END AS folder,
            COUNT(*) AS files, SUM(size_bytes) AS bytes
     FROM files WHERE volume_id = ?
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
