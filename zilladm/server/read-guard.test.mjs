// node --test   (from the repo root)
//
// The case is E: on 2026-09-21: one 64 KB read never returned and the volume's pass stopped dead
// for hours with nothing recorded.
import test from "node:test";
import assert from "node:assert/strict";

import { ReadHungError, createHangTracker, withReadTimeout } from "./read-guard.mjs";

const never = () => new Promise(() => {});

test("a read that never returns becomes a ReadHungError instead of a stall", async () => {
  await assert.rejects(
    () => withReadTimeout(never, { path: "E:\\MUSIC\\track.mp3", ms: 20 }),
    (e) => {
      assert.ok(e instanceof ReadHungError);
      assert.equal(e.code, "EREADHUNG");
      assert.equal(e.path, "E:\\MUSIC\\track.mp3");
      assert.match(e.message, /did not return within 20 ms/);
      return true;
    },
  );
});

test("a read that returns in time is untouched, and its value passes through", async () => {
  const out = await withReadTimeout(async () => ({ quick: "abc", read: 131072 }), { ms: 1000 });
  assert.deepEqual(out, { quick: "abc", read: 131072 });
});

test("a real read error is reported as itself, not as a hang", async () => {
  const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
  await assert.rejects(() => withReadTimeout(() => Promise.reject(enoent), { ms: 1000 }), { code: "ENOENT" });
});

test("one hang is about the file; the pass continues", () => {
  const t = createHangTracker({ streakAbort: 3 });
  const first = t.hung("E:\\a.mp3");
  assert.equal(first.action, "continue");
  assert.equal(first.finding, "read_hung");
  assert.equal(t.stats.total, 1);
});

test("a streak of hangs is about the PATH, and the volume is abandoned with a reason", () => {
  const t = createHangTracker({ streakAbort: 3 });
  assert.equal(t.hung("a").action, "continue");
  assert.equal(t.hung("b").action, "continue");
  const third = t.hung("c");
  assert.equal(third.action, "abort_volume");
  assert.equal(third.finding, "path_unreadable");
  assert.match(third.reason, /3 reads in a row did not return/);
  assert.match(third.reason, /abandoning this volume/);
});

test("a good read breaks the streak: scattered bad files never abandon a healthy volume", () => {
  const t = createHangTracker({ streakAbort: 3 });
  t.hung("a");
  t.hung("b");
  t.ok();
  assert.equal(t.hung("c").action, "continue", "the streak restarted");
  assert.equal(t.stats.total, 3, "but every hang is still counted");
});

test("the deadline is configurable per call, so a slow spindle is not called hung", async () => {
  const slow = () => new Promise((r) => setTimeout(() => r("done"), 30));
  assert.equal(await withReadTimeout(slow, { ms: 200 }), "done");
  await assert.rejects(() => withReadTimeout(slow, { ms: 5 }), { code: "EREADHUNG" });
});
