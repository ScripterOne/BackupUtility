/**
 * ZillaDM job runner — lets the GUI start long work and watch it.
 *
 * An inventory of a million-file volume is ten minutes; a fingerprint pass is longer. Neither
 * can run inside an HTTP request, and neither should die because a browser tab closed.
 *
 * So jobs are detached child processes owned by the server, with their output tailed into a
 * ring buffer the GUI polls. The server is single-user on 127.0.0.1, so an in-memory registry
 * is honest - there is no cluster to coordinate with and pretending otherwise would be
 * ceremony. What it must NOT do is lose the fact that a job failed, which is why exit codes and
 * the last lines of output are kept after completion rather than discarded.
 *
 * ONE JOB PER PHYSICAL DISK. Two readers on one spindle is slower than one (seek-bound), and
 * two inventories of the same volume would race in the catalogue. The runner refuses rather
 * than queueing silently - a refusal you can see beats a queue you cannot.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as cat from "./catalogue.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "scripts");
const BUILD = join(HERE, "..", "build");
const MAX_LINES = 400;

/** id -> job */
const jobs = new Map();
let seq = 0;

const nowIso = () => new Date().toISOString();

function diskOf(driveLetter) {
  const v = cat.open().prepare(
    `SELECT disk_number FROM volumes WHERE UPPER(drive_letter) = UPPER(?)`).get(driveLetter);
  return v?.disk_number ?? null;
}

/** A job already running against the same physical disk, if any. */
function busyDisk(disk) {
  if (disk === null) return null;
  for (const j of jobs.values()) {
    if (j.status === "running" && j.disk === disk) return j;
  }
  return null;
}

function record(job, line) {
  job.lines.push(line);
  if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
  // The scripts report progress with \r; keep only the latest state of a carriage-returned line
  // so the GUI shows a live counter rather than ten thousand near-identical rows.
  job.last = line;
}

function launch({ kind, label, cmd, args, disk }) {
  const id = `${kind}-${++seq}`;
  const job = {
    id, kind, label, disk, status: "running",
    started_at: nowIso(), finished_at: null, exit_code: null,
    lines: [], last: "",
  };
  jobs.set(id, job);

  const child = spawn(cmd, args, { cwd: HERE, windowsHide: true });
  job.pid = child.pid;

  const onData = (buf) => {
    for (const raw of String(buf).split(/\r?\n|\r/)) {
      const line = raw.trimEnd();
      if (line) record(job, line);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  child.on("error", (e) => {
    job.status = "failed";
    job.finished_at = nowIso();
    record(job, `could not start: ${e.message}`);
  });
  child.on("close", (code) => {
    job.exit_code = code;
    // A non-zero exit is kept as a failure. A job that failed quietly and showed "done" is the
    // "delivered means the file exists" defect wearing different clothes.
    job.status = code === 0 ? "complete" : "failed";
    job.finished_at = nowIso();
  });

  return job;
}

export function startInventory(driveLetter, { excludeOs = false } = {}) {
  const letter = String(driveLetter).replace(/:$/, "").toUpperCase();
  if (!/^[A-Z]$/.test(letter)) throw new Error(`bad drive letter: ${driveLetter}`);
  const disk = diskOf(`${letter}:`);
  const busy = busyDisk(disk);
  if (busy) throw new Error(`disk ${disk} is busy with ${busy.id} (${busy.label})`);

  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", join(SCRIPTS, "Invoke-Inventory.ps1"), "-DriveLetter", letter];
  if (excludeOs) args.push("-ExcludeOsFiles");
  return launch({ kind: "inventory", label: `${letter}: inventory`, cmd: "pwsh", args, disk });
}

export function startFingerprint(driveLetter) {
  const letter = String(driveLetter).replace(/:$/, "").toUpperCase();
  if (!/^[A-Z]$/.test(letter)) throw new Error(`bad drive letter: ${driveLetter}`);
  const disk = diskOf(`${letter}:`);
  const busy = busyDisk(disk);
  if (busy) throw new Error(`disk ${disk} is busy with ${busy.id} (${busy.label})`);

  return launch({
    kind: "fingerprint", label: `${letter}: fingerprint`, disk,
    cmd: process.execPath,
    args: ["--no-warnings", join(HERE, "fingerprint.mjs"), "--volume", letter],
  });
}

/**
 * Ingest the newest inventory NDJSON for a drive. Separate from the scan on purpose: the scan
 * can succeed and the ingest still needs to happen, and coupling them would hide which half
 * failed.
 */
export function startIngest(driveLetter) {
  const letter = String(driveLetter).replace(/:$/, "").toUpperCase();
  if (!/^[A-Z]$/.test(letter)) throw new Error(`bad drive letter: ${driveLetter}`);
  return launch({
    kind: "ingest", label: `${letter}: ingest`, disk: null,
    cmd: process.execPath,
    args: ["--no-warnings", join(HERE, "ingest.mjs"), "--latest", letter, "--dir", BUILD],
  });
}

export function list() {
  return [...jobs.values()]
    .sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""))
    .map(({ lines, ...j }) => ({ ...j, line_count: lines.length }));
}

export function detail(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { ...j, lines: j.lines.slice(-120) };
}

export function running() {
  return [...jobs.values()].filter((j) => j.status === "running").length;
}
