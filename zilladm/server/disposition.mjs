// The drive disposition ledger: what a drive's status is, who changed it, and on what evidence.
//
// Operator's scope for ZillaDM (2026-09-22): "We want full control over drives, ability to
// disposition, investigate, recover, and deem Hardware Failure!" This module owns the last two
// words. Calling a drive dead is the one drive decision that cannot be undone by re-plugging it,
// and on 2026-09-21 it was nearly made four times on healthy hardware - the fault was a USB path.
//
// So: a status change is always recorded with its evidence, and RETIRED-as-hardware-failure is
// refused unless the evidence actually supports it. Two things support it, and nothing else does:
//
//   1. the errors FOLLOWED the drive onto a second enclosure (attribution.mjs -> drive_fault), or
//   2. SMART says the platters are losing sectors: pending or offline-uncorrectable above zero, or
//      reallocated sectors that have grown since an earlier reading.
//
// A drive that only ever failed in one enclosure has not earned the verdict - it has earned a
// quarantine and a re-test somewhere else. UDMA CRC errors are explicitly NOT platter evidence:
// they are the cable or the bridge, which is exactly the mistake this module exists to prevent.
//
// Pure except for the database handle the caller passes in.

export const STATUSES = ["in_service", "suspect", "quarantined", "recovering", "retired"];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS drive_disposition (
  id           INTEGER PRIMARY KEY,
  at           TEXT NOT NULL,
  drive_key    TEXT NOT NULL,      -- SMART serial where known; never a drive letter or disk number
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  cause        TEXT,               -- e.g. hardware_failure, path_fault, operator_request
  actor        TEXT NOT NULL,
  reason       TEXT NOT NULL,
  evidence     TEXT                -- JSON: the verdict and the numbers behind it
);
CREATE INDEX IF NOT EXISTS ix_disposition_drive ON drive_disposition(drive_key, at);
`;

export function ensure(db) {
  db.exec(SCHEMA);
  return db;
}

export function currentStatus(db, driveKey) {
  ensure(db);
  const row = db
    .prepare(`SELECT to_status FROM drive_disposition WHERE drive_key = ? ORDER BY at DESC, id DESC LIMIT 1`)
    .get(driveKey);
  return row?.to_status ?? "in_service";
}

export function history(db, driveKey) {
  ensure(db);
  return db
    .prepare(`SELECT * FROM drive_disposition WHERE drive_key = ? ORDER BY at ASC, id ASC`)
    .all(driveKey)
    .map((r) => ({ ...r, evidence: r.evidence ? JSON.parse(r.evidence) : null }));
}

/**
 * Does this evidence support "the hardware has failed"?
 * @param {{verdict?:string, smart?:{pending?:number, offline_uncorrectable?:number,
 *          reallocated?:number, reallocated_previous?:number, udma_crc?:number}}} evidence
 */
export function supportsHardwareFailure(evidence = {}) {
  const smart = evidence.smart ?? {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const pending = num(smart.pending);
  const uncorrectable = num(smart.offline_uncorrectable);
  const realloc = num(smart.reallocated);
  const reallocBefore = num(smart.reallocated_previous);

  if (evidence.verdict === "drive_fault") {
    return { ok: true, because: "errors followed the drive onto a second enclosure" };
  }
  if (pending > 0 || uncorrectable > 0) {
    return { ok: true, because: `SMART pending=${pending ?? 0}, offline_uncorrectable=${uncorrectable ?? 0}` };
  }
  if (realloc !== null && reallocBefore !== null && realloc > reallocBefore) {
    return { ok: true, because: `reallocated sectors grew ${reallocBefore} -> ${realloc}` };
  }
  const why = [];
  if (evidence.verdict === "path_fault") why.push("the errors belong to the path, not the drive");
  if (evidence.verdict === "insufficient_evidence") why.push("the drive has only ever failed in one enclosure");
  if (!evidence.verdict) why.push("no attribution verdict was supplied");
  if (num(smart.udma_crc) > 0) why.push(`UDMA CRC ${smart.udma_crc} is the cable or the bridge, not the platters`);
  if (pending === 0 && uncorrectable === 0) why.push("SMART pending and offline-uncorrectable are both 0");
  return {
    ok: false,
    because: why.join("; "),
    next: "quarantine it and re-test in a different enclosure; retire it only if the errors follow",
  };
}

/**
 * Record a status change. Refuses a hardware-failure retirement the evidence does not support.
 */
export function setStatus(db, { driveKey, to, actor, reason, cause = null, evidence = null, at = new Date().toISOString() }) {
  ensure(db);
  if (!driveKey) throw new Error("driveKey is required: identify a drive by its SMART serial, never by letter or disk number");
  if (!STATUSES.includes(to)) throw new Error(`unknown status '${to}'; one of ${STATUSES.join(", ")}`);
  if (!actor || !reason) throw new Error("every disposition records who changed it and why");

  const from = currentStatus(db, driveKey);
  if (to === "retired" && cause === "hardware_failure") {
    const check = supportsHardwareFailure(evidence ?? {});
    if (!check.ok) {
      const err = new Error(`refusing to deem hardware failure: ${check.because}. ${check.next}`);
      err.code = "EVIDENCE_INSUFFICIENT";
      err.check = check;
      throw err;
    }
    reason = `${reason} [evidence: ${check.because}]`;
  }
  db.prepare(
    `INSERT INTO drive_disposition (at, drive_key, from_status, to_status, cause, actor, reason, evidence)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(at, driveKey, from, to, cause, actor, reason, evidence ? JSON.stringify(evidence) : null);
  return { driveKey, from, to, at, cause, reason };
}

/** Every drive the ledger knows, with its current status and when it last changed. */
export function roster(db) {
  ensure(db);
  return db
    .prepare(
      `SELECT d.drive_key, d.to_status AS status, d.at, d.cause, d.reason
         FROM drive_disposition d
         JOIN (SELECT drive_key, MAX(id) AS id FROM drive_disposition GROUP BY drive_key) last
           ON last.id = d.id
        ORDER BY d.drive_key`,
    )
    .all();
}
