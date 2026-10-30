/**
 * STT 烟测。
 *
 * 分两段:
 *   A. 直接打 HTTP 接口(/api/stt/status、install、upload+transcribe、DELETE job),校验 SSE 事件流。
 *   B. 用 puppeteer 打开编辑台连上 MCP 桥,发 transcribe_media / get_transcript 工具调用,
 *      核对拿到的 segments 和 A 段一致。
 *
 * 用法:
 *   先起 dev server(内置 Python 未就绪时可以用假解释器):
 *     PROMPTCUT_PYTHON=server/test/fake-python.cmd npx vite --port 5202 --strictPort --host 127.0.0.1
 *   再跑:
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

/** 读一条 SSE 流,返回解析后的事件数组 */
async function readSse(res) {
  if (!res.body) fail("响应没有 body");
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
      try { events.push(JSON.parse(json)); } catch { /* 忽略 */ }
    }
  }
  return events;
}

/**
 * 测试用的素材字节。
 * 有 out/tts.mp4(真解释器的端到端素材)就用它;没有就退回几个占位字节 ——
 * 假解释器不看输入内容,占位字节足够跑通链路。
 */
async function sampleMediaBytes() {
  const real = path.join(ROOT, "out", "tts.mp4");
  try {
    const b = await fs.readFile(real);
    console.log(`素材:out/tts.mp4 (${b.length} 字节)`);
    return b;
  } catch {
    console.log("素材:占位字节(没找到 out/tts.mp4,假解释器模式)");
    return Buffer.from("FAKE-MEDIA-BYTES");
  }
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/api/stt/status`);
      if (res.status !== 404) return res;
    } catch { /* 还没起来 */ }
    await wait(1000);
  }
  fail(`dev server 没起来(${BASE});请先按文件头的说明启动`);
}

async function partA() {
  console.log("\n===== A. HTTP 接口 =====");

  // 1. status
  const statusRes = await waitForServer();
  if (statusRes.status === 503) {
    const body = await statusRes.json().catch(() => ({}));
    fail(`/api/stt/status 返回 503:${body.error}(内置 Python 未就绪,可用 PROMPTCUT_PYTHON=server/test/fake-python.cmd 跑假解释器)`);
  }
  if (!statusRes.ok) fail(`/api/stt/status 返回 ${statusRes.status}: ${await statusRes.text()}`);
  const status = await statusRes.json();
  console.log("status:", JSON.stringify(status));
  if (!status.engines) fail("status 缺 engines 字段");

  // 2. install(SSE)—— 已经装好就跳过,免得真解释器下跑一次真 pip 安装
  if (status.engines["faster-whisper"]?.installed) {
    console.log("install: 跳过(faster-whisper 已安装)");
  } else {
    const installRes = await fetch(`${BASE}/api/stt/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: "faster-whisper" }),
    });
    const installEvents = await readSse(installRes);
    const installLogs = installEvents.filter((e) => e.event === "log");
    const installDone = installEvents.some((e) => e.event === "done");
    console.log(`install: ${installLogs.length} 条日志, done=${installDone}`);
    if (!installDone) fail("install 没收到 done 事件");
  }

  // 3. upload + transcribe(SSE)
  const jobId = "smoke-" + Date.now().toString(36);
  const bytes = await sampleMediaBytes();

  const upRes = await fetch(`${BASE}/api/stt/upload/${jobId}/sample.mp4`, {
    method: "POST",
    body: bytes,
  });
  if (!upRes.ok) fail(`upload 返回 ${upRes.status}`);
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
  console.log(`transcribe: ${progress.length} 条 progress, ${segEvents.length} 条 segment, done=${!!done}`);
  if (!done) fail("transcribe 没收到 done 事件");
  if (!Array.isArray(done.segments) || done.segments.length === 0) fail("done 事件里没有 segments");
  console.log("segments:");
  for (const s of done.segments) console.log(`  [${s.start}-${s.end}] ${s.text}`);

  // 4. DELETE job
  const delRes = await fetch(`${BASE}/api/stt/job/${jobId}`, { method: "DELETE" });
  if (!delRes.ok) fail(`DELETE job 返回 ${delRes.status}`);
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
  if (!data.ok) fail(`MCP ${tool} 出错: ${data.error}`);
  return data.result;
}

async function partB(expectedSegments) {
  console.log("\n===== B. MCP 工具 =====");

  // 放一份素材到 public/,让页面能 fetch 到再包成 File
  const publicDir = path.join(ROOT, "public");
  await fs.mkdir(publicDir, { recursive: true });
  const mediaName = "_stt-smoke.mp4";
  await fs.writeFile(path.join(publicDir, mediaName), await sampleMediaBytes());

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log("  [page error]", m.text()); });
    await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });

    // 等编辑台连上 MCP 桥
    let connected = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`${BASE}/api/mcp/status`);
        if (res.ok && (await res.json()).editorConnected) { connected = true; break; }
      } catch { /* 重试 */ }
      await wait(1000);
    }
    if (!connected) fail("编辑台没连上 MCP 桥");
    console.log("编辑台已连上 MCP 桥");

    // 导入素材,拿 mediaId
    const mediaId = await page.evaluate(async (name) => {
      const blob = await fetch("/" + name).then((r) => r.blob());
      const file = new File([blob], name, { type: "video/mp4" });
      const ids = await window.__pcIo.importVideoFiles([file]);
      return ids[0];
    }, mediaName);
    if (!mediaId) fail("importVideoFiles 没返回 mediaId");
    console.log("导入素材 mediaId =", mediaId);

    // stt_status
    const st = await callMcp("stt_status", {});
    console.log("stt_status:", JSON.stringify(st));

    // transcribe_media —— 立即返回 jobId,结果靠 get_transcript 轮询
    const started = await callMcp("transcribe_media", { mediaId, engine: "faster-whisper", model: "small", language: "zh" });
    console.log("transcribe_media:", JSON.stringify(started));
    if (!started.jobId) fail("transcribe_media 没返回 jobId");

    let transcript = null;
    for (let i = 0; i < 30; i++) {
      transcript = await callMcp("get_transcript", { mediaId });
      if (transcript && Array.isArray(transcript.segments) && transcript.segments.length > 0) break;
      await wait(1000);
    }
    if (!transcript || !transcript.segments?.length) fail("get_transcript 轮询超时,没拿到 segments");

    console.log(`get_transcript: engine=${transcript.engine} model=${transcript.model} language=${transcript.language} total=${transcript.total}`);
    for (const s of transcript.segments) console.log(`  [${s.start}-${s.end}] ${s.text}`);

    // 和 A 段结果比对
    if (transcript.segments.length !== expectedSegments.length) {
      fail(`段数不一致:HTTP 拿到 ${expectedSegments.length},MCP 拿到 ${transcript.segments.length}`);
    }
    for (let i = 0; i < expectedSegments.length; i++) {
      if (transcript.segments[i].text !== expectedSegments[i].text) {
        fail(`第 ${i} 段文本不一致:"${expectedSegments[i].text}" vs "${transcript.segments[i].text}"`);
      }
    }
    console.log("A / B 两段结果一致");

    // store 里也确认一遍
    const inStore = await page.evaluate((id) => {
      const el = document.querySelector("[data-pc-media]");
      return { hasMediaEl: !!el, mediaId: id };
    }, mediaId);
    console.log("页面素材条目存在:", inStore.hasMediaEl);
  } finally {
    await browser.close();
    // 清掉临时素材,别留在 public/ 里
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
