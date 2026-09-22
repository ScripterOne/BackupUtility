// node --test zilladm/server/
//
// The fixtures are the real 2026-09-21/22 bring-up: the 4 TB WD and the 18 TB IronWolf swapping
// disk numbers mid-evening, hundreds of errors in bay 1, and the same drives silent in bay 2.
import test from "node:test";
import assert from "node:assert/strict";

import { attributeErrors, buildDiskTimeline, summarise, verdictForDrive } from "./attribution.mjs";

const TB = 1024 ** 4;
// The bridge serial repeats across enclosures (C01 is "slot 1" in BOTH bays), which is why the
// enclosure has to be carried separately - it is the level at which today's fault was visible.
const BAY1_S2 = { parentId: "USB\\VID_174C&PID_55AA\\MSFT30915000000C02", location: "bay1 slot2", enclosure: "bay1", controller: "xhci-bus17" };
const BAY1_S1 = { parentId: "USB\\VID_174C&PID_55AA\\MSFT30915000000C01", location: "bay1 slot1", enclosure: "bay1", controller: "xhci-bus17" };
const BAY2_S1 = { parentId: "USB\\VID_174C&PID_55AA\\MSFT30915000000C01", location: "bay2 slot1", enclosure: "bay2", controller: "xhci-bus8" };

const WD4 = 3.64 * TB;
const IRONWOLF18 = 16.37 * TB;

// 19:45 the 4 TB is disk 4; 20:50 both re-enumerate and it becomes disk 3 while the IronWolf takes 4.
const arrivals = [
  { at: "2026-09-21T19:41:00Z", diskNumber: 3, capacityBytes: IRONWOLF18, ...BAY1_S1 },
  { at: "2026-09-21T19:45:00Z", diskNumber: 4, capacityBytes: WD4, ...BAY1_S2 },
  { at: "2026-09-21T20:50:39Z", diskNumber: 3, capacityBytes: 0, ...BAY1_S1 },
  { at: "2026-09-21T20:50:40Z", diskNumber: 4, capacityBytes: 0, ...BAY1_S2 },
  { at: "2026-09-21T20:50:47Z", diskNumber: 3, capacityBytes: WD4, ...BAY1_S2 },
  { at: "2026-09-21T20:50:47Z", diskNumber: 4, capacityBytes: IRONWOLF18, ...BAY1_S1 },
];

const err = (at, diskNumber, id = 153) => ({ at, id, diskNumber });
const errors = [
  err("2026-09-21T19:54:00Z", 4), err("2026-09-21T19:56:00Z", 4), err("2026-09-21T20:01:00Z", 4),
  err("2026-09-21T20:51:40Z", 3), err("2026-09-21T20:55:10Z", 3),
  err("2026-09-21T21:05:59Z", 4), // after the swap this is the IRONWOLF, not the 4 TB
];

test("a disk number identifies a drive only between arrival and removal", () => {
  const timeline = buildDiskTimeline(arrivals);
  const { attributed } = attributeErrors(errors, timeline);
  const wd = `cap:${WD4}`;
  const iron = `cap:${IRONWOLF18}`;
  // Five of the six belong to the 4 TB even though they are logged against two different numbers.
  assert.equal(attributed.filter((e) => e.driveKey === wd).length, 5);
  assert.equal(attributed.filter((e) => e.driveKey === iron).length, 1);
  // Counting by disk number would have said disk 4 had four errors and disk 3 two. It had five.
});

test("an error outside any known span is reported, never pinned on whoever holds the number now", () => {
  const timeline = buildDiskTimeline(arrivals);
  const { attributed, unattributed } = attributeErrors([err("2026-09-21T10:00:00Z", 4)], timeline);
  assert.equal(attributed.length, 0);
  assert.equal(unattributed.length, 1);
});

test("the slot serial is a slot, not a drive: two drives share one bridge serial", () => {
  const timeline = buildDiskTimeline(arrivals);
  const drives = new Set();
  for (const spans of timeline.values()) for (const s of spans) drives.add(s.drive.driveKey);
  assert.equal(drives.size, 2, "capacity separates them even though the bridge serial repeats");
  const slot1Spans = [...timeline.values()].flat().filter((s) => s.drive.path.includes("slot1"));
  assert.ok(slot1Spans.length >= 1);
});

test("several drives faulting in one ENCLOSURE is the enclosure's fault, even in different slots", () => {
  // 2026-09-21: the 4 TB failed in bay 1 slot 2 and the IronWolf in bay 1 slot 1. Grouped by slot
  // those are two unrelated singletons; grouped by enclosure they are one bay - the real answer.
  const summary = summarise({ arrivals, errors });
  const v = verdictForDrive(`cap:${WD4}`, summary);
  assert.equal(v.verdict, "path_fault");
  assert.equal(v.path, "bay1");
  assert.match(v.because, /also faulted 1 other drive/);
});

test("one drive, one path, nothing else seen: insufficient evidence, not a bad drive", () => {
  const only = [{ at: "2026-09-21T19:45:00Z", diskNumber: 4, capacityBytes: WD4, ...BAY1_S2 }];
  const summary = summarise({ arrivals: only, errors: errors.filter((e) => e.diskNumber === 4 && e.at < "2026-09-21T20:50:00Z") });
  const v = verdictForDrive(`cap:${WD4}`, summary);
  assert.equal(v.verdict, "insufficient_evidence");
  assert.match(v.because, /move it to another enclosure/);
});

test("clean on a second path clears the drive and blames the first path", () => {
  // The real 9/21 sequence: the 4 TB failed in bay 1, then formatted clean in bay 2.
  const withBay2 = [...arrivals, { at: "2026-09-21T21:52:34Z", diskNumber: 5, capacityBytes: WD4, ...BAY2_S1 }];
  const summary = summarise({ arrivals: withBay2, errors });
  const v = verdictForDrive(`cap:${WD4}`, summary);
  assert.equal(v.verdict, "path_fault");
  assert.equal(summary.drivesSeenOn[`cap:${WD4}`].length, 2);
});

test("errors that follow the drive into a second ENCLOSURE are the DRIVE's fault", () => {
  const withBay2 = [...arrivals, { at: "2026-09-21T21:52:34Z", diskNumber: 5, capacityBytes: WD4, ...BAY2_S1 }];
  const followed = [...errors, err("2026-09-21T22:00:00Z", 5), err("2026-09-21T22:01:00Z", 5)];
  const v = verdictForDrive(`cap:${WD4}`, summarise({ arrivals: withBay2, errors: followed }));
  assert.equal(v.verdict, "drive_fault");
  assert.match(v.because, /followed the drive onto 2 paths/);
});

test("a drive with no attributed errors is not given a verdict it did not earn", () => {
  const summary = summarise({ arrivals, errors: [] });
  assert.equal(verdictForDrive(`cap:${WD4}`, summary).verdict, "no_errors");
});

test("a better identity than capacity is used when the collector knows one", () => {
  const withSmart = arrivals.map((a) => (a.capacityBytes === WD4 ? { ...a, smartSerial: "K7JY5UAL" } : a));
  const summary = summarise({ arrivals: withSmart, errors });
  assert.ok(summary.byDrive.some((d) => d.key === "smart:K7JY5UAL"));
});
