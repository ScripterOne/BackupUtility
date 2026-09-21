/**
 * ZillaDM — local web GUI.
 *
 * Deliberately dependency-free Node. ZillaDM will grow a real catalogue and a real
 * front end (see ../../PLAN-ZillaDM.md), but the first thing the operator needs is to run
 * the disk-health check from a browser and read the result. That does not justify a build step.
 *
 * Binds to 127.0.0.1 only. This reports the contents and health of local storage; it has no
 * business listening on a LAN interface, and the agent<->server protocol that WILL need auth is
 * a later phase (see plan §11).
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as cat from "./catalogue.mjs";
import * as jobs from "./jobs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "Get-DiskHealth.ps1");
const PORT = Number(process.env.ZILLADM_PORT || 7420);

/** Run the health script and return its JSON. Never throws; failures come back as data. */
function diskHealth() {
  return new Promise((resolve) => {
    const args = [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", SCRIPT,
      "-All",
      "-Json",
    ];
    const ps = spawn("pwsh", args, { windowsHide: true });
    let out = "";
    let err = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.stderr.on("data", (d) => (err += d));
    ps.on("error", (e) =>
      resolve({ error: `could not start pwsh: ${e.message}`, disks: [] }));
    ps.on("close", (code) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        // A parse failure is reported as itself. An empty disk list rendered as "all clear"
        // is the exact defect this tool exists to avoid.
        resolve({
          error: `health script returned no parsable JSON (exit ${code})`,
          stderr: err.slice(0, 2000),
          stdout: out.slice(0, 2000),
          disks: [],
        });
      }
    });
  });
}

const json = (res, body, code = 200) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  // --- catalogue ------------------------------------------------------------------------
  if (url.pathname === "/api/volumes") {
    try { return json(res, { volumes: cat.volumes(), db: cat.DB_PATH }); }
    catch (e) { return json(res, { error: e.message, volumes: [] }, 500); }
  }
  if (url.pathname === "/api/folders") {
    const id = Number(url.searchParams.get("volume"));
    if (!id) return json(res, { error: "volume required", folders: [] }, 400);
    try { return json(res, { folders: cat.topFolders(id) }); }
    catch (e) { return json(res, { error: e.message, folders: [] }, 500); }
  }
  if (url.pathname === "/api/search") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json(res, { hits: [] });
    try { return json(res, { hits: cat.search(q) }); }
    catch (e) { return json(res, { error: e.message, hits: [] }, 500); }
  }

  // --- duplicates, findings, jobs --------------------------------------------------------
  if (url.pathname === "/api/duplicates") {
    const vol = Number(url.searchParams.get("volume")) || null;
    const minMb = Number(url.searchParams.get("minMb") ?? 1);
    try {
      return json(res, {
        groups: cat.duplicates(vol, 300, Math.round(minMb * 1024 * 1024)),
        summary: cat.duplicateSummary(vol), min_mb: minMb,
      });
    }
    catch (e) { return json(res, { error: e.message, groups: [] }, 500); }
  }
  if (url.pathname === "/api/findings") {
    const vol = Number(url.searchParams.get("volume")) || null;
    try { return json(res, { findings: cat.findings(vol) }); }
    catch (e) { return json(res, { error: e.message, findings: [] }, 500); }
  }
  if (url.pathname === "/api/jobs") {
    return json(res, { jobs: jobs.list(), running: jobs.running() });
  }
  if (url.pathname.startsWith("/api/jobs/") && req.method === "GET") {
    const d = jobs.detail(url.pathname.slice("/api/jobs/".length));
    return d ? json(res, d) : json(res, { error: "no such job" }, 404);
  }
  if (url.pathname === "/api/run" && req.method === "POST") {
    // Long work is started here and watched via /api/jobs. It must not run inside the request:
    // a million-file inventory is ten minutes and a browser tab closing must not kill it.
    const kind = url.searchParams.get("kind");
    const drive = url.searchParams.get("drive");
    const excludeOs = url.searchParams.get("excludeOs") === "1";
    try {
      let j;
      if (kind === "inventory") j = jobs.startInventory(drive, { excludeOs });
      else if (kind === "ingest") j = jobs.startIngest(drive);
      else if (kind === "fingerprint") j = jobs.startFingerprint(drive);
      else return json(res, { error: `unknown kind '${kind}'` }, 400);
      return json(res, { job: { id: j.id, label: j.label, status: j.status } });
    } catch (e) {
      // A refusal the operator can see beats a queue they cannot.
      return json(res, { error: e.message }, 409);
    }
  }

  if (req.url === "/api/disk-health") {
    const body = JSON.stringify(await diskHealth());
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(body);
  }
  if (req.url === "/" || req.url === "/index.html") {
    const html = await readFile(join(HERE, "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`ZillaDM GUI  ->  http://127.0.0.1:${PORT}`);
  console.log(`script: ${SCRIPT}`);
  console.log(`NOTE: start this from an ADMINISTRATOR shell or SMART cannot be read.`);
});
