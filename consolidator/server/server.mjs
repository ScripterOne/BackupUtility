/**
 * Consolidator — local web GUI.
 *
 * Deliberately dependency-free Node. The Consolidator will grow a real catalogue and a real
 * front end (see ../../PLAN-consolidator.md), but the first thing the operator needs is to run
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

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "Get-DiskHealth.ps1");
const PORT = Number(process.env.CONSOLIDATOR_PORT || 7420);

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

createServer(async (req, res) => {
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
  console.log(`Consolidator GUI  ->  http://127.0.0.1:${PORT}`);
  console.log(`script: ${SCRIPT}`);
  console.log(`NOTE: start this from an ADMINISTRATOR shell or SMART cannot be read.`);
});
