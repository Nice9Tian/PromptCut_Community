/**
 * STT smoke test.
 *
 * In two parts:
 *   A. Directly hit HTTP endpoints (/api/stt/status, install, upload+transcribe, DELETE job),
 *      verify SSE event stream.
 *   B. Open editor with puppeteer and connect to MCP bridge, issue transcribe_media /
 *      get_transcript tool calls, verify returned segments match part A.
 *
 * Usage:
 *   Start dev server first (fake interpreter can be used when built-in Python is not ready):
 *     PROMPTCUT_PYTHON=server/test/fake-python.cmd npx vite --port 5202 --strictPort --host 127.0.0.1
 *   Then run:
 *     node server/test/stt-smoke.mjs [--port 5202]
 */
import puppeteer from "puppeteer";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const portArgIdx = process.argv.indexOf("--port");
const PORT = portArgIdx !== -1 ? process.argv[portArgIdx + 1] : process.env.PROMPTCUT_PORT || "5202";
const BASE = `http://127.0.0.1:${PORT}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error("FAIL:", msg);
  process.exitCode = 1;
  throw new Error(msg);
}

/** Read an SSE stream and return parsed array of events */
async function readSse(res) {
  if (!res.body) fail("Response has no body");
  const events = [];
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() ?? "";
    for (const b of blocks) {
      const line = b.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try { events.push(JSON.parse(json)); } catch { /* Ignore */ }
    }
  }
  return events;
}

/**
 * Asset bytes for testing.
 * Use out/tts.mp4 (end-to-end asset for real interpreter) if present; otherwise fall back to
 * placeholder bytes: fake interpreter ignores input content, placeholder bytes are sufficient to
 * exercise the pipeline.
 */
async function sampleMediaBytes() {
  const real = path.join(ROOT, "out", "tts.mp4");
  try {
    const b = await fs.readFile(real);
    console.log(`Asset: out/tts.mp4 (${b.length} bytes)`);
    return b;
  } catch {
    console.log("Asset: placeholder bytes (out/tts.mp4 not found, fake interpreter mode)");
    return Buffer.from("FAKE-MEDIA-BYTES");
  }
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/api/stt/status`);
      if (res.status !== 404) return res;
    } catch { /* Not up yet */ }
    await wait(1000);
  }
  fail(`dev server is not up (${BASE}); start it first as described at the top of the file`);
}

async function partA() {
  console.log("\n===== A. HTTP API =====");

  // 1. status
  const statusRes = await waitForServer();
  if (statusRes.status === 503) {
    const body = await statusRes.json().catch(() => ({}));
    fail(`/api/stt/status returned 503: ${body.error} (built-in Python is not ready; you can run the fake interpreter with PROMPTCUT_PYTHON=server/test/fake-python.cmd)`);
  }
  if (!statusRes.ok) fail(`/api/stt/status returned ${statusRes.status}: ${await statusRes.text()}`);
  const status = await statusRes.json();
  console.log("status:", JSON.stringify(status));
  if (!status.engines) fail("status is missing the engines field");

  // 2. install(SSE): skip if already installed to avoid running real pip install under real interpreter
  if (status.engines["faster-whisper"]?.installed) {
    console.log("install: skipped (faster-whisper already installed)");
  } else {
    const installRes = await fetch(`${BASE}/api/stt/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: "faster-whisper" }),
    });
    const installEvents = await readSse(installRes);
    const installLogs = installEvents.filter((e) => e.event === "log");
    const installDone = installEvents.some((e) => e.event === "done");
    console.log(`install: ${installLogs.length} log lines, done=${installDone}`);
    if (!installDone) fail("install did not receive a done event");
  }

  // 3. upload + transcribe(SSE)
  const jobId = "smoke-" + Date.now().toString(36);
  const bytes = await sampleMediaBytes();

  const upRes = await fetch(`${BASE}/api/stt/upload/${jobId}/sample.mp4`, {
    method: "POST",
    body: bytes,
  });
  if (!upRes.ok) fail(`upload returned ${upRes.status}`);
  const up = await upRes.json();
  console.log("upload:", JSON.stringify(up));

  const trRes = await fetch(`${BASE}/api/stt/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, engine: "faster-whisper", model: "small", language: "zh" }),
  });
  const trEvents = await readSse(trRes);
  const progress = trEvents.filter((e) => e.event === "progress");
  const segEvents = trEvents.filter((e) => e.event === "segment");
  const done = trEvents.find((e) => e.event === "done");
  console.log(`transcribe: ${progress.length} progress events, ${segEvents.length} segment events, done=${!!done}`);
  if (!done) fail("transcribe did not receive a done event");
  if (!Array.isArray(done.segments) || done.segments.length === 0) fail("The done event has no segments");
  console.log("segments:");
  for (const s of done.segments) console.log(`  [${s.start}-${s.end}] ${s.text}`);

  // 4. DELETE job
  const delRes = await fetch(`${BASE}/api/stt/job/${jobId}`, { method: "DELETE" });
  if (!delRes.ok) fail(`DELETE job returned ${delRes.status}`);
  console.log("delete job:", JSON.stringify(await delRes.json()));

  return done.segments;
}

async function callMcp(tool, args) {
  const res = await fetch(`${BASE}/api/mcp/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok) fail(`MCP ${tool} HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.ok) fail(`MCP ${tool} error: ${data.error}`);
  return data.result;
}

async function partB(expectedSegments) {
  console.log("\n===== B. MCP tools =====");

  // Put a copy of asset into public/ so the page can fetch it and wrap into a File
  const publicDir = path.join(ROOT, "public");
  await fs.mkdir(publicDir, { recursive: true });
  const mediaName = "_stt-smoke.mp4";
  await fs.writeFile(path.join(publicDir, mediaName), await sampleMediaBytes());

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log("  [page error]", m.text()); });
    await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });

    // Wait for editor to connect to MCP bridge
    let connected = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`${BASE}/api/mcp/status`);
        if (res.ok && (await res.json()).editorConnected) { connected = true; break; }
      } catch { /* Retry */ }
      await wait(1000);
    }
    if (!connected) fail("The editor is not connected to the MCP bridge");
    console.log("The editor is connected to the MCP bridge");

    // Import media, get mediaId
    const mediaId = await page.evaluate(async (name) => {
      const blob = await fetch("/" + name).then((r) => r.blob());
      const file = new File([blob], name, { type: "video/mp4" });
      const ids = await window.__pcIo.importVideoFiles([file]);
      return ids[0];
    }, mediaName);
    if (!mediaId) fail("importVideoFiles did not return a mediaId");
    console.log("Imported asset mediaId =", mediaId);

    // stt_status
    const st = await callMcp("stt_status", {});
    console.log("stt_status:", JSON.stringify(st));

    // transcribe_media: returns jobId immediately, result polled via get_transcript
    const started = await callMcp("transcribe_media", { mediaId, engine: "faster-whisper", model: "small", language: "zh" });
    console.log("transcribe_media:", JSON.stringify(started));
    if (!started.jobId) fail("transcribe_media did not return a jobId");

    let transcript = null;
    for (let i = 0; i < 30; i++) {
      transcript = await callMcp("get_transcript", { mediaId });
      if (transcript && Array.isArray(transcript.segments) && transcript.segments.length > 0) break;
      await wait(1000);
    }
    if (!transcript || !transcript.segments?.length) fail("get_transcript polling timed out, no segments received");

    console.log(`get_transcript: engine=${transcript.engine} model=${transcript.model} language=${transcript.language} total=${transcript.total}`);
    for (const s of transcript.segments) console.log(`  [${s.start}-${s.end}] ${s.text}`);

    // Compare with part A results
    if (transcript.segments.length !== expectedSegments.length) {
      fail(`Segment count mismatch: HTTP got ${expectedSegments.length}, MCP got ${transcript.segments.length}`);
    }
    for (let i = 0; i < expectedSegments.length; i++) {
      if (transcript.segments[i].text !== expectedSegments[i].text) {
        fail(`Segment ${i} text mismatch: "${expectedSegments[i].text}" vs "${transcript.segments[i].text}"`);
      }
    }
    console.log("A / B results match");

    // Confirm once in store as well
    const inStore = await page.evaluate((id) => {
      const el = document.querySelector("[data-pc-media]");
      return { hasMediaEl: !!el, mediaId: id };
    }, mediaId);
    console.log("Page asset entry exists:", inStore.hasMediaEl);
  } finally {
    await browser.close();
    // Clean up temporary asset, do not leave in public/
    await fs.rm(path.join(publicDir, mediaName), { force: true });
  }
}

async function main() {
  const segments = await partA();
  await partB(segments);
  console.log("\nALL PASS");
}

main().catch((e) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(e.message);
  setTimeout(() => process.exit(process.exitCode || 1), 300);
});
