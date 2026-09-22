// Attribute Windows disk errors to the DRIVE that was there, and to the PATH it sat on.
//
// 2026-09-21/22, the bring-up that produced this module: three drives were called failing and one
// was called "shit" and set aside. All three were fine. Every error belonged to one USB cable/port.
// It took hours by hand because Windows reports errors against a DISK NUMBER, and disk numbers move
// - the same physical drive was disk 4, then disk 3, then disk 5 inside one evening, while a
// different drive took the number it left behind. Anything counted per disk number is wrong by the
// next re-enumeration.
//
// The rules this encodes, each learned the expensive way:
//   - A disk number identifies a drive only between its arrival and its removal.
//   - The ASMedia bridge "serials" (10C000000519 ... 50C000000519) are canned PER SLOT and reused
//     across enclosures, so a serial identifies a SLOT, never a drive.
//   - Capacity is the cheapest honest drive discriminator without SMART; the caller can supply a
//     better one (SMART serial, GPT partition GUID) and it is used when present.
//   - A fault that appears on several drives sharing one path is the PATH's. A fault that follows
//     one drive onto a second path is the DRIVE's. One drive on one path proves neither.
//
// Pure: no I/O, no clock. The collector (scripts/Export-DiskEvents.ps1) gathers the raw events.

/** A removal is logged as an arrival with zero capacity (Partition/Diagnostic 1006). */
const isRemoval = (a) => !(Number(a.capacityBytes) > 0);

const asTime = (v) => (v instanceof Date ? v.getTime() : Date.parse(v));

/**
 * Build, per disk number, the ordered spans during which one drive held that number.
 * @param {Array<{at:string,diskNumber:number,capacityBytes:number,serial?:string,parentId?:string,location?:string,driveKey?:string}>} arrivals
 * @returns {Map<number, Array<{from:number,to:number,drive:object}>>}
 */
export function buildDiskTimeline(arrivals) {
  const byNumber = new Map();
  for (const a of [...arrivals].sort((x, y) => asTime(x.at) - asTime(y.at))) {
    const n = Number(a.diskNumber);
    if (!Number.isInteger(n)) continue;
    const spans = byNumber.get(n) ?? [];
    const open = spans.length ? spans[spans.length - 1] : null;
    if (open && open.to === Infinity) open.to = asTime(a.at); // this event ends the previous span
    if (!isRemoval(a)) {
      spans.push({
        from: asTime(a.at),
        to: Infinity,
        drive: {
          driveKey: a.driveKey ?? driveKeyOf(a),
          capacityBytes: Number(a.capacityBytes),
          slotSerial: a.serial ?? null,
          path: pathOf(a),
          // A path has levels, and the level decides what a shared fault proves. 2026-09-21: three
          // drives failed in three DIFFERENT slots of one enclosure. Slot-level grouping sees three
          // unrelated singletons; enclosure-level sees the bay, which was the answer.
          enclosure: a.enclosure ?? null,
          controller: a.controller ?? null,
        },
      });
    }
    byNumber.set(n, spans);
  }
  return byNumber;
}

/** Identity of the DRIVE, not of the slot: capacity unless the caller knows something better. */
export function driveKeyOf(arrival) {
  if (arrival.driveKey) return arrival.driveKey;
  if (arrival.partitionGuid) return `guid:${arrival.partitionGuid}`;
  if (arrival.smartSerial) return `smart:${arrival.smartSerial}`;
  return `cap:${Number(arrival.capacityBytes)}`;
}

/** Identity of the PATH: the enclosure slot and what it hangs off. Never the drive. */
export function pathOf(arrival) {
  if (arrival.path) return arrival.path;
  const parts = [arrival.parentId ?? "", arrival.location ?? ""].filter(Boolean);
  return parts.length ? parts.join(" | ") : "unknown";
}

/**
 * Attribute each error event to whatever held its disk number at that moment.
 * @param {Array<{at:string,id:number,diskNumber:number,pdo?:string}>} errors
 * @param {Map<number, Array<object>>} timeline
 */
export function attributeErrors(errors, timeline) {
  const attributed = [];
  const unattributed = [];
  for (const e of errors) {
    const t = asTime(e.at);
    const span = (timeline.get(Number(e.diskNumber)) ?? []).find((s) => t >= s.from && t < s.to);
    if (!span) {
      // No arrival covers this moment: the drive was there before the log window, or the number
      // was never seen. Counting it against whoever holds the number NOW is how drives get blamed
      // for each other, so it is reported as unattributed instead.
      unattributed.push(e);
      continue;
    }
    attributed.push({ ...e, driveKey: span.drive.driveKey, path: span.drive.path, drive: span.drive });
  }
  return { attributed, unattributed };
}

const tally = (rows, key) => {
  const out = new Map();
  for (const r of rows) {
    const k = key === "path" ? r.path : r[key] ?? r.drive?.[key];
    if (k == null) continue;
    const cur = out.get(k) ?? { key: k, errors: 0, first: r.at, last: r.at, drives: new Set(), paths: new Set() };
    cur.errors += 1;
    if (asTime(r.at) < asTime(cur.first)) cur.first = r.at;
    if (asTime(r.at) > asTime(cur.last)) cur.last = r.at;
    cur.drives.add(r.driveKey);
    cur.paths.add(r.path);
    out.set(k, cur);
  }
  return [...out.values()]
    .map((v) => ({ ...v, drives: [...v.drives], paths: [...v.paths] }))
    .sort((a, b) => b.errors - a.errors);
};

/** Errors per drive and per path, with the cross-counts the verdict needs. */
export function summarise({ arrivals, errors }) {
  const timeline = buildDiskTimeline(arrivals);
  const { attributed, unattributed } = attributeErrors(errors, timeline);
  const seen = new Map(); // driveKey -> paths it has been seen on at all (errors or not)
  const seenEnclosures = new Map();
  for (const spans of timeline.values()) {
    for (const s of spans) {
      const paths = seen.get(s.drive.driveKey) ?? new Set();
      paths.add(s.drive.path);
      seen.set(s.drive.driveKey, paths);
      if (s.drive.enclosure) {
        const encl = seenEnclosures.get(s.drive.driveKey) ?? new Set();
        encl.add(s.drive.enclosure);
        seenEnclosures.set(s.drive.driveKey, encl);
      }
    }
  }
  return {
    byDrive: tally(attributed, "driveKey").map((d) => ({
      ...d,
      pathsSeenOn: [...(seen.get(d.key) ?? [])],
      enclosuresSeenOn: [...(seenEnclosures.get(d.key) ?? [])],
      enclosuresErroredOn: [...new Set(attributed.filter((e) => e.driveKey === d.key).map((e) => e.drive.enclosure).filter(Boolean))],
    })),
    byPath: tally(attributed, "path"),
    byEnclosure: tally(attributed, "enclosure"),
    drivesSeenOn: Object.fromEntries([...seen].map(([k, v]) => [k, [...v]])),
    enclosuresSeenOn: Object.fromEntries([...seenEnclosures].map(([k, v]) => [k, [...v]])),
    attributed: attributed.length,
    unattributed: unattributed.length,
  };
}

/**
 * Is this drive's trouble the drive's, or the path's?
 *
 * The operator's rule for ZillaDM (2026-09-22): deeming HARDWARE FAILURE takes errors that follow
 * the drive onto a second enclosure. Errors on one path prove the path, not the platter.
 */
export function verdictForDrive(driveKey, summary) {
  const drive = summary.byDrive.find((d) => d.key === driveKey);
  const seenOn = summary.drivesSeenOn[driveKey] ?? [];
  if (!drive || drive.errors === 0) {
    return { verdict: "no_errors", drive: driveKey, because: "no errors attributed to this drive in the window" };
  }
  const erroredOn = drive.paths;
  // Following the drive means following it to another ENCLOSURE where that is known; a second slot
  // of the same bay is the same suspect hardware.
  const enclosuresErrored = drive.enclosuresErroredOn ?? [];
  const followed = enclosuresErrored.length >= 2 || (enclosuresErrored.length === 0 && erroredOn.length >= 2);
  if (followed) {
    const where = enclosuresErrored.length >= 2 ? enclosuresErrored : erroredOn;
    return {
      verdict: "drive_fault",
      drive: driveKey,
      because: `errors followed the drive onto ${where.length} paths (${where.join(", ")})`,
      errors: drive.errors,
    };
  }
  const path = erroredOn[0];
  // Widest shared suspect first: an enclosure that faulted several drives is the enclosure.
  const enclosure = enclosuresErrored[0] ?? null;
  const othersOnEnclosure = enclosure
    ? (summary.byEnclosure?.find((p) => p.key === enclosure)?.drives ?? []).filter((d) => d !== driveKey)
    : [];
  if (othersOnEnclosure.length > 0) {
    return {
      verdict: "path_fault",
      drive: driveKey,
      path: enclosure,
      because: `every error is on ${enclosure}, which also faulted ${othersOnEnclosure.length} other drive(s): ${othersOnEnclosure.join(", ")}`,
      errors: drive.errors,
    };
  }
  const othersOnPath = (summary.byPath.find((p) => p.key === path)?.drives ?? []).filter((d) => d !== driveKey);
  if (othersOnPath.length > 0) {
    return {
      verdict: "path_fault",
      drive: driveKey,
      path,
      because: `every error is on ${path}, which also faulted ${othersOnPath.length} other drive(s): ${othersOnPath.join(", ")}`,
      errors: drive.errors,
    };
  }
  const cleanElsewhere = seenOn.filter((p) => p !== path);
  if (cleanElsewhere.length > 0) {
    return {
      verdict: "path_fault",
      drive: driveKey,
      path,
      because: `errors only on ${path}; the same drive ran clean on ${cleanElsewhere.join(", ")}`,
      errors: drive.errors,
    };
  }
  return {
    verdict: "insufficient_evidence",
    drive: driveKey,
    path,
    because: `${drive.errors} error(s), all on ${path}, and this drive has been seen nowhere else - move it to another enclosure before calling it a bad drive`,
    errors: drive.errors,
  };
}
