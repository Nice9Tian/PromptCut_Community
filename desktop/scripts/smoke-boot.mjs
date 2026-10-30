/**
 * PromptCut smoke test — boot verification.
 *
 * Usage: node scripts/smoke-boot.mjs [exe-image-name]
 *   Default exe name: promptcut.exe
 *
 * Prerequisite: the exe must already be running (this script does not start it).
 * Waits up to 90 seconds for the process to appear, the window title to contain
 * "PromptCut", the dev server at 127.0.0.1:5210 to respond, and both stage
 * ports (5211 / 5212) to answer 200 with `Origin-Agent-Cluster: ?1`.
 */
import { execSync } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { procList, findByName, descendants } from "./smoke-procs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, "..", ".smoke-state.json");

const exeName = process.argv[2] || "promptcut.exe";
const TIMEOUT_MS = 90_000;

/** Editor port, and the two stage ports the editor reverse-proxies (+1 / +2). */
const EDITOR_PORT = 5210;
const STAGE_PORT_A = EDITOR_PORT + 1;
const STAGE_PORT_B = EDITOR_PORT + 2;

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function getWindowTitle(exe) {
  try {
    const csv = execSync(
      `tasklist /V /FO CSV /NH /FI "IMAGENAME eq ${exe}"`,
      { windowsHide: true, encoding: "utf-8", timeout: 10_000 }
    );
    // Fields: Image Name, PID, Session Name, Session#, Mem Usage, Status, User Name, CPU Time, Window Title
    for (const line of csv.trim().split(/\r?\n/)) {
      const parts = line.split('","').map((s) => s.replace(/^"|"$/g, ""));
      if (parts.length >= 9) {
        return parts[8];
      }
    }
  } catch { /* ignore */ }
  return "";
}

async function main() {
  const t0 = Date.now();
  console.log(`[smoke-boot] Waiting for ${exeName} (timeout ${TIMEOUT_MS / 1000}s)…`);

  // Step 1: Find the process
  let mainPids = [];
  while (Date.now() - t0 < TIMEOUT_MS) {
    const procs = findByName(exeName);
    if (procs.length > 0) {
      mainPids = procs.map((p) => p.pid);
      console.log(`  Found ${exeName} PID(s): ${mainPids.join(", ")}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (mainPids.length === 0) {
    console.error(`[FAIL] ${exeName} not found within timeout.`);
    process.exit(1);
  }

  // Step 1b: Wait for window title containing "PromptCut"
  let windowTitle = "";
  const titleDeadline = Date.now() + 30_000;
  while (Date.now() < titleDeadline) {
    windowTitle = getWindowTitle(exeName);
    if (windowTitle.includes("PromptCut")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!windowTitle.includes("PromptCut")) {
    console.warn(`  [WARN] Window title does not contain "PromptCut": "${windowTitle}"`);
  } else {
    console.log(`  Window title: "${windowTitle}"`);
  }

  // Step 2: GET http://127.0.0.1:5210/
  let htmlBytes = 0;
  let readySec = 0;
  while (Date.now() - t0 < TIMEOUT_MS) {
    try {
      const { status, body } = await httpGet("http://127.0.0.1:5210/");
      if (status === 200 && body.includes("PromptCut")) {
        readySec = ((Date.now() - t0) / 1000).toFixed(1);
        htmlBytes = Buffer.byteLength(body, "utf-8");
        console.log(`  Server ready in ${readySec}s (${htmlBytes} bytes)`);
        break;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (htmlBytes === 0) {
    console.error("[FAIL] GET / did not return 200 with PromptCut within timeout.");
    process.exit(1);
  }

  /*
   * Step 2b: the two stage ports (editor port +1 / +2).
   *
   * R7 makes the cross-origin dual stage the default, so a desktop boot is only
   * healthy when both proxies are up AND each one answers with
   * `Origin-Agent-Cluster: ?1`.  That header is what actually buys the process
   * isolation (same host, different port is NOT isolated on its own — measured
   * on Chrome 152); without it both stage iframes land back in the editor's
   * renderer process and a busy stage freezes the whole UI.  It has to be on the
   * very first response: the browser latches the origin's cluster policy then.
   */
  const stagePorts = [STAGE_PORT_A, STAGE_PORT_B];
  const stageResults = [];
  for (const port of stagePorts) {
    let ok = false;
    let oac = "";
    let status = 0;
    while (Date.now() - t0 < TIMEOUT_MS) {
      try {
        const res = await httpGet(`http://127.0.0.1:${port}/`);
        status = res.status;
        oac = String(res.headers["origin-agent-cluster"] || "");
        if (status === 200 && oac === "?1") { ok = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    stageResults.push({ port, ok, status, originAgentCluster: oac });
    if (ok) console.log(`  Stage port ${port} ready (200, origin-agent-cluster: ?1)`);
  }
  const badStage = stageResults.filter((s) => !s.ok);
  if (badStage.length > 0) {
    for (const s of badStage) {
      console.error(
        `[FAIL] Stage port ${s.port}: status=${s.status || "no response"}, ` +
        `origin-agent-cluster=${s.originAgentCluster || "(absent)"} (want 200 + "?1").`
      );
    }
    process.exit(1);
  }

  // Step 3: GET /api/stt/status (record only, not a pass/fail condition)
  let sttStatus = 0;
  let sttBody = "";
  try {
    const { status, body } = await httpGet("http://127.0.0.1:5210/api/stt/status");
    sttStatus = status;
    sttBody = body.slice(0, 500);
    console.log(`  /api/stt/status → ${status}: ${sttBody.slice(0, 120)}…`);
  } catch (e) {
    console.log(`  /api/stt/status → error: ${e.message}`);
  }

  // Step 4: Descendant processes — require at least one node.exe
  const list = procList();
  const desc = descendants(mainPids, list);
  const sidecarPids = desc.filter((p) => p.name.toLowerCase() === "node.exe").map((p) => p.pid);

  // Count by image name for informational output
  const counts = {};
  for (const p of desc) {
    counts[p.name] = (counts[p.name] || 0) + 1;
  }
  console.log(`  Descendant processes: ${JSON.stringify(counts)}`);

  if (sidecarPids.length === 0) {
    console.error("[FAIL] No node.exe found among descendants — sidecar did not start.");
    process.exit(1);
  }
  console.log(`  Sidecar node.exe PID(s): ${sidecarPids.join(", ")}`);

  // Step 5: Write state for smoke-shutdown
  const state = {
    capturedAt: new Date().toISOString(),
    exe: exeName,
    mainPids,
    windowTitle,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`  State written to ${STATE_FILE}`);

  // Step 6: Result
  const result = {
    ok: true,
    readySec: parseFloat(readySec),
    windowTitle,
    mainPids,
    sidecarPids,
    htmlBytes,
    sttStatus,
    sttBody,
    stagePorts: stageResults,
  };
  console.log(`BOOT_RESULT_JSON ${JSON.stringify(result)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
