// node --test zilladm/server/
//
// The cases are the 2026-09-21 drives. K7JY5UAL (the 4 TB) was called "shit" and set aside after
// ~470 errors - all of them on one enclosure, and it formatted clean in another. ZVT7F2MT (the
// 18 TB with the tax data) hung the OS on a read in the same enclosure and read the same file in
// 43 ms in another. Neither had earned a retirement, and this ledger must refuse to record one.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { currentStatus, history, roster, setStatus, supportsHardwareFailure } from "./disposition.mjs";

const db = () => new DatabaseSync(":memory:");

test("a drive starts in service and remembers every change with who and why", () => {
  const d = db();
  assert.equal(currentStatus(d, "K7JY5UAL"), "in_service");
  setStatus(d, { driveKey: "K7JY5UAL", to: "suspect", actor: "claude", reason: "470 I/O retries in bay 1" });
  setStatus(d, { driveKey: "K7JY5UAL", to: "quarantined", actor: "operator", reason: "pulled from the bay" });
  assert.equal(currentStatus(d, "K7JY5UAL"), "quarantined");
  const h = history(d, "K7JY5UAL");
  assert.deepEqual(h.map((r) => [r.from_status, r.to_status]), [["in_service", "suspect"], ["suspect", "quarantined"]]);
  assert.equal(h[0].actor, "claude");
});

test("hardware failure is REFUSED when the errors belong to the path", () => {
  const d = db();
  const evidence = { verdict: "path_fault", smart: { pending: 0, offline_uncorrectable: 0, udma_crc: 47 } };
  assert.throws(
    () => setStatus(d, { driveKey: "K7JY5UAL", to: "retired", cause: "hardware_failure", actor: "claude", reason: "looks dead", evidence }),
    (e) => {
      assert.equal(e.code, "EVIDENCE_INSUFFICIENT");
      assert.match(e.message, /belong to the path/);
      assert.match(e.message, /UDMA CRC 47 is the cable or the bridge/);
      assert.match(e.message, /re-test in a different enclosure/);
      return true;
    },
  );
  assert.equal(currentStatus(d, "K7JY5UAL"), "in_service", "a refused retirement changes nothing");
});

test("hardware failure is REFUSED when the drive has only ever failed in one enclosure", () => {
  const d = db();
  assert.throws(
    () => setStatus(d, { driveKey: "ZVT7F2MT", to: "retired", cause: "hardware_failure", actor: "claude",
                        reason: "a read hung the OS", evidence: { verdict: "insufficient_evidence" } }),
    /only ever failed in one enclosure/,
  );
});

test("hardware failure is ALLOWED when the errors followed the drive to another enclosure", () => {
  const d = db();
  const out = setStatus(d, { driveKey: "BAD1", to: "retired", cause: "hardware_failure", actor: "claude",
                             reason: "retired", evidence: { verdict: "drive_fault" } });
  assert.equal(out.to, "retired");
  assert.match(history(d, "BAD1")[0].reason, /followed the drive onto a second enclosure/);
});

test("hardware failure is ALLOWED when SMART says the platters are losing sectors", () => {
  assert.equal(supportsHardwareFailure({ smart: { pending: 8, offline_uncorrectable: 0 } }).ok, true);
  assert.equal(supportsHardwareFailure({ smart: { pending: 0, offline_uncorrectable: 3 } }).ok, true);
  assert.equal(supportsHardwareFailure({ smart: { reallocated: 24, reallocated_previous: 8, pending: 0, offline_uncorrectable: 0 } }).ok, true);
  // Steady reallocations that are not growing are history, not a failing drive.
  assert.equal(supportsHardwareFailure({ smart: { reallocated: 24, reallocated_previous: 24, pending: 0, offline_uncorrectable: 0 } }).ok, false);
});

test("a UDMA CRC count alone never retires a drive", () => {
  const check = supportsHardwareFailure({ verdict: "path_fault", smart: { udma_crc: 4000, pending: 0, offline_uncorrectable: 0 } });
  assert.equal(check.ok, false);
  assert.match(check.because, /cable or the bridge/);
});

test("quarantine and recovery need no such proof - only retirement does", () => {
  const d = db();
  setStatus(d, { driveKey: "ZVT7F2MT", to: "quarantined", actor: "operator", reason: "holds the tax data; not trusted yet" });
  setStatus(d, { driveKey: "ZVT7F2MT", to: "recovering", actor: "claude", reason: "copying 2025Tax off it" });
  setStatus(d, { driveKey: "ZVT7F2MT", to: "in_service", actor: "operator", reason: "clean in bay 2, file read in 43 ms" });
  assert.equal(currentStatus(d, "ZVT7F2MT"), "in_service");
  assert.equal(history(d, "ZVT7F2MT").length, 3);
});

test("a drive is identified by its serial, never by a letter or a disk number", () => {
  const d = db();
  assert.throws(() => setStatus(d, { driveKey: "", to: "suspect", actor: "a", reason: "b" }), /SMART serial/);
  assert.throws(() => setStatus(d, { driveKey: "X", to: "melted", actor: "a", reason: "b" }), /unknown status/);
  assert.throws(() => setStatus(d, { driveKey: "X", to: "suspect", actor: "", reason: "" }), /who changed it and why/);
});

test("the roster shows each drive once, at its latest status", () => {
  const d = db();
  setStatus(d, { driveKey: "A", to: "suspect", actor: "x", reason: "r" });
  setStatus(d, { driveKey: "A", to: "in_service", actor: "x", reason: "cleared" });
  setStatus(d, { driveKey: "B", to: "quarantined", actor: "x", reason: "r" });
  const rows = roster(d);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.drive_key, r.status]), [["A", "in_service"], ["B", "quarantined"]]);
});
