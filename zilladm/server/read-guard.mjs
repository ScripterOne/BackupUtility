// A read that never returns must not stop the estate.
//
// 2026-09-21: fingerprinting E: stalled for hours on ONE file. A 64 KB read of a single MP3 on a
// drive whose USB path was failing never came back - the OS kept retrying beneath us (event 153,
// hundreds of times, on the same LBAs) and the whole volume's pass simply stopped. Nothing was
// logged, nothing moved on, and the catalogue showed a volume "in progress" that was never going
// to finish.
//
// Two rules come out of that evening:
//
//   1. EVERY file read has a deadline. A file that blows it is recorded as `read_hung` - a real
//      finding about that file, not silence - and the pass moves to the next file.
//   2. A run of hangs means the PATH is gone, not that the files are bad. After a few in a row,
//      abandon the volume and say so. Grinding through 900,000 more files on a wedged bridge
//      produces nothing but wear and a log nobody reads.
//
// Node cannot cancel a read that the OS has swallowed: the promise below stays pending forever and
// its file handle leaks until the process exits. That is deliberate and it is the lesser evil -
// the alternative is what happened, where one file took the whole run with it. The handle is the
// price of moving on, and the process is short-lived.

export const READ_TIMEOUT_MS = Number(process.env.ZILLADM_READ_TIMEOUT_MS ?? 30_000);
export const HANG_STREAK_ABORT = Number(process.env.ZILLADM_HANG_STREAK ?? 3);

export class ReadHungError extends Error {
  constructor(path, ms) {
    super(`read did not return within ${ms} ms: ${path}`);
    this.name = "ReadHungError";
    this.code = "EREADHUNG";
    this.path = path;
    this.timeout_ms = ms;
  }
}

/**
 * Run `fn()` with a deadline. On expiry the returned promise rejects with ReadHungError; the
 * underlying operation is left to the OS (it cannot be cancelled) and is never awaited again.
 */
export async function withReadTimeout(fn, { path = "", ms = READ_TIMEOUT_MS, timer = setTimeout } = {}) {
  let handle;
  const deadline = new Promise((_, reject) => {
    handle = timer(() => reject(new ReadHungError(path, ms)), ms);
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    clearTimeout(handle);
  }
}

/**
 * What to do after a file hung. Counts consecutive hangs, because a streak is evidence about the
 * PATH and a lone hang is evidence about a file.
 */
export function createHangTracker({ streakAbort = HANG_STREAK_ABORT } = {}) {
  let streak = 0;
  let total = 0;
  return {
    /** A file read completed normally: the path is alive, so the streak resets. */
    ok() {
      streak = 0;
    },
    /** A file read hung. Returns "continue" or "abort_volume", with the reason to record. */
    hung(path) {
      streak += 1;
      total += 1;
      if (streak >= streakAbort) {
        return {
          action: "abort_volume",
          finding: "path_unreadable",
          reason: `${streak} reads in a row did not return (latest: ${path}); the volume's path is not answering - ` +
            `abandoning this volume rather than grinding through the rest of it`,
          streak,
          total,
        };
      }
      return {
        action: "continue",
        finding: "read_hung",
        reason: `read did not return: ${path}`,
        streak,
        total,
      };
    },
    get stats() {
      return { streak, total };
    },
  };
}
