/**
 * Real-browser Chromium + WebGL end-to-end probe for Issue #12:
 * "Express a one-take shot on the timeline: 2D / 3D cuts and camera cards"
 *
 *   node scripts/probes/one-take-camera-probe.mjs [--port 5260] --out <dir> [--keep]
 *
 * Verifies end-to-end against live Vite editor + prerender/bakery + WebGL Chromium:
 *   1. 2D Cut One-Take Pan + Caption Exemption + Preview vs Export Equivalence + 2D Space View:
 *      - Two distinct cards placed horizontally apart (x = 0 and x = 1920, spaceWidth = 3840)
 *        plus a caption-track clip and a 2D camera clip panning x via "1920 * p".
 *      - At t = start, Card 1 (red) is centered; at t = end, Card 2 (blue) is centered;
 *        at BOTH timestamps, the caption-track subtitle stays screen-locked at bottom center.
 *      - Live editor preview frame matches see_frames / export output.
 *      - see_frames(view: "space") frames the full 3840x1080 space + amber camera viewport box.
 *   2. 3D Cut One-Take Dolly Walkthrough + Media Board + frameExpr + Behind-Camera Culling +
 *      Translucent Depth Sorting + Nested 3D Cut Segment + prerender_cut_to_2d:
 *      - A "3d" cut with boards at z = 0 (orange gate), z = -600 (translucent emerald + frameExpr),
 *        and z = -1200 (real uploaded PNG media board), with a 3D camera dollying z: "1500 - 2200 * p".
 *      - Passes cleanly through front boards (culling behind camera), depth-sorts translucent boards,
 *        renders real media pixels with zero proxy rectangles on export / see_frames, works inside an
 *        outer "2d" cut via @cut segment with screen-locked captions on top, and pre-renders cleanly
 *        to a new "2d" .mp4 cut via prerender_cut_to_2d while keeping the 3D cut untouched.
 *   3. see_frames(view: "camera") vs see_frames(view: "space") + Editor UI + MCP Gates:
 *      - Both views return valid, distinct PNGs (first-person camera output vs oblique whole-space
 *        overview framing all 3D boards and the camera frustum wireframe).
 *      - Timeline renders [data-pc="camera-lane"], 2D/3D cut badges, 3D track Depth badge, and
 *        Scene3DView Camera / Space mode toggle.
 *      - MCP create_card monolith gate and apply_card pre-overlay scene-host gate reject invalid calls.
 */
import '../lib/no-user-dirs.mjs';
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PNG } from "pngjs";
import puppeteer from "puppeteer";
import { PROBE_CHROME_ARGS } from "./probe-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const idx = argv.indexOf(name);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback;
};

const PORT = Number(arg("--port", "5260"));
const KEEP = argv.includes("--keep");
const OUT = path.resolve(arg("--out", path.join(os.tmpdir(), `pc-one-take-probe-${Date.now().toString(36)}`)));
const EDITOR = `http://127.0.0.1:${PORT}`;
const EXPORT_DIR = path.join(os.tmpdir(), `pc-one-take-work-${Date.now().toString(36)}`);
const DATA_DIR = path.join(EXPORT_DIR, "data");

if ([5190, 5191, 5192].some((p) => p >= PORT && p <= PORT + 2)) {
  console.error("Refusing to touch reserved resident dev server ports 5190-5192.");
  process.exit(2);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const CARD_ID = "one-take-probe-board";
const CARD_FILE = path.join(ROOT, "src", "cards", "user", `${CARD_ID}.tsx`);
const PRE_CARD_ID = "one-take-probe-preoverlay";
const PRE_CARD_FILE = path.join(ROOT, "src", "cards", "user", `${PRE_CARD_ID}.tsx`);
const MONOLITH_CARD_FILE = path.join(ROOT, "src", "cards", "user", "probe-monolith-blocked.tsx");

const PRE_CARD_SOURCE = `export const oneTakeProbePreOverlay = {
  id: "${PRE_CARD_ID}",
  name: "Probe Pre-Overlay",
  description: "Pre-overlay fixture for testing scene-host enforcement",
  overlay: "pre",
  defaults: { dolly: 120 },
  controls: [{ key: "dolly", label: "Dolly", type: "number" }],
  parts: [{ id: "rig", label: "Rig", role: "hero", params: ["dolly"] }],
  Component: () => null,
};
`;

const CARD_SOURCE = `import type { CardDef, CardProps } from "../../kernel/types";

type BoardParams = {
  bg: string;
  accent: string;
  label: string;
};

function OneTakeProbeBoard({ params }: CardProps<BoardParams>) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: params.bg,
        border: \`10px solid \${params.accent}\`,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          fontSize: 64,
          fontWeight: 900,
          letterSpacing: 2,
          padding: "16px 36px",
          borderRadius: 16,
          background: "rgba(0,0,0,0.35)",
        }}
      >
        {params.label}
      </div>
    </div>
  );
}

export const oneTakeProbeBoard: CardDef<BoardParams> = {
  id: "${CARD_ID}",
  name: "One-take probe board",
  description: "Single visual board fixture for the one-take camera probe",
  tags: ["probe"],
  frameMode: "direct",
  defaults: {
    bg: "#e11d48",
    accent: "#fda4af",
    label: "ROOM A",
  },
  controls: [
    { key: "bg", label: "Background", type: "color" },
    { key: "accent", label: "Accent", type: "color" },
    { key: "label", label: "Label", type: "text" },
  ],
  parts: [
    { id: "main", label: "Board style", role: "hero", params: ["bg", "accent", "label"] },
  ],
  Component: OneTakeProbeBoard,
};
`;

const results = {};
const fails = [];
function check(key, cond, note, extra) {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) {
    fails.push(`${key}: ${note}${extra !== undefined ? " :: " + JSON.stringify(extra).slice(0, 500) : ""}`);
  }
  console.log(`${cond ? "PASS" : "FAIL"} ${key} ${note}${extra !== undefined ? " " + JSON.stringify(extra).slice(0, 320) : ""}`);
}

function viteBin() {
  const local = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve("vite");
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), "bin", "vite.js");
}

const json = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
};
const postJson = (url, body) =>
  json(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const callTool = (tool, args = {}) => postJson(`${EDITOR}/api/mcp/call`, { tool, args });

async function until(label, fn, timeoutMs = 120_000, everyMs = 350) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let val = null;
    try {
      val = await fn();
    } catch {
      val = null;
    }
    if (val) return val;
    if (Date.now() > deadline) {
      fails.push(`Timeout: ${label}`);
      console.log(`FAIL timeout: ${label}`);
      return null;
    }
    await delay(everyMs);
  }
}

function createMediaBoardPng(width = 880, height = 520) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const border = x < 18 || x >= width - 18 || y < 18 || y >= height - 18;
      if (border) {
        // Vivid gold border
        png.data[idx] = 250;
        png.data[idx + 1] = 204;
        png.data[idx + 2] = 21;
        png.data[idx + 3] = 255;
      } else if (((Math.floor(x / 80) + Math.floor(y / 80)) & 1) === 0) {
        // Vivid magenta tile
        png.data[idx] = 217;
        png.data[idx + 1] = 38;
        png.data[idx + 2] = 239;
        png.data[idx + 3] = 255;
      } else {
        // Deep violet-purple tile
        png.data[idx] = 126;
        png.data[idx + 1] = 34;
        png.data[idx + 2] = 206;
        png.data[idx + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

function saveBase64Png(b64, filename) {
  if (!b64) return null;
  const buf = Buffer.from(b64, "base64");
  const file = path.join(OUT, filename);
  fs.writeFileSync(file, buf);
  return { file, png: PNG.sync.read(buf) };
}

function pixelAt(png, nx, ny) {
  const x = Math.max(0, Math.min(png.width - 1, Math.round(nx * png.width)));
  const y = Math.max(0, Math.min(png.height - 1, Math.round(ny * png.height)));
  const i = (y * png.width + x) * 4;
  return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2], a: png.data[i + 3], x, y };
}

function regionStats(png, nx0, ny0, nx1, ny1) {
  const x0 = Math.max(0, Math.floor(nx0 * png.width));
  const y0 = Math.max(0, Math.floor(ny0 * png.height));
  const x1 = Math.min(png.width, Math.ceil(nx1 * png.width));
  const y1 = Math.min(png.height, Math.ceil(ny1 * png.height));
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  let brightGreenOrWhite = 0;
  let proxyCyan = 0;
  let amberPixels = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
      if (a < 16) continue;
      sumR += r;
      sumG += g;
      sumB += b;
      count++;
      if ((g > 200 && r < 140 && b < 160) || (r > 225 && g > 225 && b > 225)) brightGreenOrWhite++;
      if (Math.abs(r - 0x38) < 18 && Math.abs(g - 0xbd) < 18 && Math.abs(b - 0xf8) < 18) proxyCyan++;
      if (r > 200 && g > 120 && g < 200 && b < 70) amberPixels++;
    }
  }
  return {
    count,
    meanR: count ? Math.round(sumR / count) : 0,
    meanG: count ? Math.round(sumG / count) : 0,
    meanB: count ? Math.round(sumB / count) : 0,
    brightGreenOrWhite,
    proxyCyan,
    amberPixels,
  };
}

function meanImageDiff(pngA, pngB) {
  const w = Math.min(pngA.width, pngB.width);
  const h = Math.min(pngA.height, pngB.height);
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * pngA.width + x) * 4;
      const ib = (y * pngB.width + x) * 4;
      sum +=
        Math.abs(pngA.data[ia] - pngB.data[ib]) +
        Math.abs(pngA.data[ia + 1] - pngB.data[ib + 1]) +
        Math.abs(pngA.data[ia + 2] - pngB.data[ib + 2]);
      n += 3;
    }
  }
  return n ? +(sum / n).toFixed(2) : 999;
}

function resizeNearest(png, targetW, targetH) {
  const out = new PNG({ width: targetW, height: targetH });
  for (let y = 0; y < targetH; y++) {
    const sy = Math.min(png.height - 1, Math.floor((y * png.height) / targetH));
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(png.width - 1, Math.floor((x * png.width) / targetW));
      const si = (sy * png.width + sx) * 4;
      const di = (y * targetW + x) * 4;
      out.data[di] = png.data[si];
      out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2];
      out.data[di + 3] = png.data[si + 3];
    }
  }
  return out;
}

let editor = null;
let browser = null;
const editorLog = [];

function cleanup() {
  for (const f of [CARD_FILE, PRE_CARD_FILE, MONOLITH_CARD_FILE]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  if (KEEP) return;
  if (editor && editor.exitCode === null && editor.pid) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(editor.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      editor.kill("SIGKILL");
    }
  }
}

setTimeout(() => {
  console.error("SCRIPT_TIMEOUT");
  cleanup();
  process.exit(124);
}, 15 * 60_000).unref();

const summary = { port: PORT, out: OUT, screenshots: [] };

try {
  if (fs.existsSync(CARD_FILE) || fs.existsSync(PRE_CARD_FILE)) {
    throw new Error(`${CARD_FILE} or ${PRE_CARD_FILE} already exists; refusing to overwrite`);
  }
  fs.mkdirSync(path.dirname(CARD_FILE), { recursive: true });
  fs.writeFileSync(CARD_FILE, CARD_SOURCE, "utf8");
  fs.writeFileSync(PRE_CARD_FILE, PRE_CARD_SOURCE, "utf8");

  editor = spawn(process.execPath, [viteBin(), "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      BROWSER: "none",
      PROMPTCUT_NO_PORT_FILE: "1",
      PROMPTCUT_EXPORT_DIR: EXPORT_DIR,
      PROMPTCUT_DATA_DIR: DATA_DIR,
      PROMPTCUT_CARD_SYNC: "0",
    },
  });
  const keepLog = (chunk) => {
    editorLog.push(chunk.toString());
    if (editorLog.length > 400) editorLog.shift();
  };
  editor.stdout.on("data", keepLog);
  editor.stderr.on("data", keepLog);

  await until(
    "editor server listening",
    async () => (await fetch(`${EDITOR}/api/prerender/info`).then((r) => r.ok, () => false)) || null,
    180_000,
  );
  const prerenderUrl = await until(
    "prerender server ready",
    async () => {
      const info = await json(`${EDITOR}/api/prerender/info`);
      return info.body?.ready && info.body.url ? info.body.url : null;
    },
    240_000,
  );
  check("S0_BOOT", !!prerenderUrl, "Editor and prerender processes started cleanly on port 5260", { prerenderUrl });
  if (!prerenderUrl) throw new Error("Prerender process did not become ready");

  // Upload real PNG media asset through the official asset service store endpoint
  const mediaPngBuf = createMediaBoardPng(880, 520);
  const uploadRes = await fetch(`${EDITOR}/api/media/upload/media-board.png?tiers=1`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: mediaPngBuf,
  });
  const uploadJson = await uploadRes.json().catch(() => null);
  check(
    "S0_MEDIA_UPLOAD",
    uploadRes.ok && uploadJson?.ok && typeof uploadJson.hash === "string",
    "Uploaded real PNG asset for 3D media board into asset service",
    uploadJson,
  );
  if (!uploadJson?.hash) throw new Error(`Media upload failed: ${JSON.stringify(uploadJson)}`);

  const mediaAsset = {
    id: "m-board-img",
    name: "media-board.png",
    kind: "image",
    hash: uploadJson.hash,
    url: uploadJson.url || `/@media/${uploadJson.hash}`,
    width: 880,
    height: 520,
    bytes: uploadJson.bytes || mediaPngBuf.length,
  };

  // Launch Chromium with WebGL enabled and open the live Editor UI
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 240_000,
    args: [...PROBE_CHROME_ARGS, "--no-first-run", "--force-device-scale-factor=1"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 920, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("dialog", (d) => {
    void d.dismiss();
  });

  await page.goto(`${EDITOR}/?editor&nosetup=1`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForFunction(() => !!window.__pcStore, { timeout: 120_000 });
  await delay(2500);

  /* =========================================================================
   * SCENARIO 1: 2D Cut One-Take Pan + Caption Exemption + Preview vs Export
   * ========================================================================= */
  const proj2DId = `one-take-2d-${Date.now().toString(36)}`;
  const project2D = {
    version: 1,
    id: proj2DId,
    name: "One-Take 2D Pan & 3D Walkthrough Probe",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 3,
    themeId: "midnight",
    media: [mediaAsset],
    filters: [],
    pixelMaps: [],
    audioFx: [],
    cardNodes: [],
    tracks: [
      {
        id: "tr-cap",
        name: "Captions",
        clips: [
          {
            id: "c-cap-2d",
            cardId: "caption-track",
            start: 0,
            end: 3,
            params: {
              position: "bottom",
              accent: "#22ff66",
              lines: "0|3|*SCREEN-LOCKED CAPTION*|Stays anchored while 2D camera pans",
              showEn: "true",
              strokeOn: "true",
              strokeW: 4,
              strokeColor: "#000000",
            },
          },
        ],
      },
      {
        id: "tr-rooms",
        name: "Rooms",
        clips: [
          {
            id: "c-room-a",
            cardId: CARD_ID,
            start: 0,
            end: 3,
            frame: { x: 0, y: 0, w: 1920, h: 1080 },
            params: { bg: "#e11d48", accent: "#fda4af", label: "ROOM A (X=0)" },
          },
          {
            id: "c-room-b",
            cardId: CARD_ID,
            start: 0,
            end: 3,
            frame: { x: 1920, y: 0, w: 1920, h: 1080 },
            params: { bg: "#2563eb", accent: "#93c5fd", label: "ROOM B (X=1920)" },
          },
        ],
      },
    ],
    activeCutId: "cut-2d",
    cuts: [
      {
        id: "cut-2d",
        name: "2D One-Take",
        kind: "2d",
        spaceWidth: 3840,
        spaceHeight: 1080,
        cameras: [
          {
            id: "cam-2d-pan",
            name: "Pan Right",
            row: 0,
            start: 0,
            end: 3,
            enabled: true,
            params: { x: "1920 * p", y: 0, zoom: 1, rotate: 0 },
          },
        ],
      },
    ],
  };

  await page.evaluate((p) => {
    window.__pcStore.actions.loadProject(p);
    window.__pcStore.actions.seek(0.15);
  }, project2D);

  const bound2D = await until(
    "editor bound 2D project replica",
    async () => {
      const s = await json(`${EDITOR}/api/agent/status`);
      return s.body?.bound && s.body.projectId === proj2DId && s.body.link?.replica?.hasBody === true ? s.body : null;
    },
    90_000,
    400,
  );
  check("S1_BOUND", !!bound2D, "Editor bound 2D one-take project to document service replica");

  // Check Timeline UI for 2D cut: camera lane, camera clip, 2D badge
  const ui2D = await page.evaluate(() => {
    const lane = document.querySelector('[data-pc="camera-lane"]');
    const camClip = document.querySelector('[data-pc-camera-clip="cam-2d-pan"]');
    const switchBtn = document.querySelector('[data-pc="cut-switch-3d"]');
    return {
      hasCameraLane: !!lane,
      hasCameraClip: !!camClip,
      hasSwitchTo3D: !!switchBtn,
    };
  });
  check(
    "S1_TIMELINE_UI",
    ui2D.hasCameraLane && ui2D.hasCameraClip && ui2D.hasSwitchTo3D,
    "Timeline displays dedicated Camera lane, camera clip, and 2D->3D cut switch action",
    ui2D,
  );

  // Capture 2D camera view at start (t=0.15) and end (t=2.85) via MCP see_frames
  const see2DStart = await callTool("see_frames", { source: "timeline", cutId: "cut-2d", t: 0.15, view: "camera" });
  const shot2DStart = saveBase64Png(see2DStart.body?.result?.__image?.base64, "2d-camera-start.png");
  if (shot2DStart) summary.screenshots.push(shot2DStart.file);

  const see2DEnd = await callTool("see_frames", { source: "timeline", cutId: "cut-2d", t: 2.85, view: "camera" });
  const shot2DEnd = saveBase64Png(see2DEnd.body?.result?.__image?.base64, "2d-camera-end.png");
  if (shot2DEnd) summary.screenshots.push(shot2DEnd.file);

  const startCenter = shot2DStart ? pixelAt(shot2DStart.png, 0.5, 0.35) : null;
  const endCenter = shot2DEnd ? pixelAt(shot2DEnd.png, 0.5, 0.35) : null;
  const startCap = shot2DStart ? regionStats(shot2DStart.png, 0.25, 0.74, 0.75, 0.92) : null;
  const endCap = shot2DEnd ? regionStats(shot2DEnd.png, 0.25, 0.74, 0.75, 0.92) : null;

  check(
    "S1_PAN_START",
    !!shot2DStart && startCenter.r > 180 && startCenter.b < 110 && startCap.brightGreenOrWhite > 40,
    "At t=0.15, 2D camera centers Card 1 (red) AND renders screen-locked caption at bottom",
    { startCenter, captionPixels: startCap?.brightGreenOrWhite },
  );
  check(
    "S1_PAN_END",
    !!shot2DEnd && endCenter.b > 180 && endCenter.r < 110 && endCap.brightGreenOrWhite > 40,
    "At t=2.85, 2D camera pans to center Card 2 (blue) AND caption remains screen-locked at bottom",
    { endCenter, captionPixels: endCap?.brightGreenOrWhite },
  );

  // Capture live preview frame in the real Editor at t=0.15 and t=2.85 and compare against export/see_frames
  await delay(1200);
  const editor2DFile = path.join(OUT, "editor-2d-ui.png");
  await page.screenshot({ path: editor2DFile });
  summary.screenshots.push(editor2DFile);

  const captureLivePreview2D = async (targetT, outName) => {
    await page.evaluate((tVal) => {
      window.__pcStore.actions.seek(tVal);
    }, targetT);
    await delay(900);
    const box = await page.evaluate(() => {
      const el = document.querySelector('[data-pc="preview-2d"] .pc-pv-frame');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    });
    if (!box || box.width < 50 || box.height < 50) return null;
    const file = path.join(OUT, outName);
    const buf = await page.screenshot({ clip: box });
    fs.writeFileSync(file, buf);
    summary.screenshots.push(file);
    return PNG.sync.read(buf);
  };

  const liveStartPng = await captureLivePreview2D(0.15, "2d-preview-start.png");
  const liveEndPng = await captureLivePreview2D(2.85, "2d-preview-end.png");
  const diffStart =
    liveStartPng && shot2DStart
      ? meanImageDiff(resizeNearest(liveStartPng, shot2DStart.png.width, shot2DStart.png.height), shot2DStart.png)
      : 999;
  const diffEnd =
    liveEndPng && shot2DEnd
      ? meanImageDiff(resizeNearest(liveEndPng, shot2DEnd.png.width, shot2DEnd.png.height), shot2DEnd.png)
      : 999;

  check(
    "S1_PREVIEW_MATCH_EXPORT",
    diffStart < 12 && diffEnd < 12,
    "2D live stage preview matches export/see_frames output at both start and end of camera pan",
    { diffStart, diffEnd },
  );

  // 2D Space View at midpoint t=1.5
  const see2DSpace = await callTool("see_frames", { source: "timeline", cutId: "cut-2d", t: 1.5, view: "space" });
  const shot2DSpace = saveBase64Png(see2DSpace.body?.result?.__image?.base64, "2d-space-mid.png");
  if (shot2DSpace) summary.screenshots.push(shot2DSpace.file);
  const space2DLeft = shot2DSpace ? pixelAt(shot2DSpace.png, 0.28, 0.5) : null;
  const space2DRight = shot2DSpace ? pixelAt(shot2DSpace.png, 0.72, 0.5) : null;
  const space2DMid = shot2DSpace ? regionStats(shot2DSpace.png, 0.2, 0.2, 0.8, 0.8) : null;
  check(
    "S1_2D_SPACE_VIEW",
    see2DSpace.body?.ok &&
      see2DSpace.body.result?.view === "space" &&
      !!shot2DSpace &&
      space2DLeft.r > 170 &&
      space2DRight.b > 170 &&
      space2DMid.amberPixels > 20,
    "see_frames(view: 'space') on 2D cut shows both Room A (left) and Room B (right) plus amber camera gizmo",
    { space2DLeft, space2DRight, amberPixels: space2DMid?.amberPixels },
  );

  /* =========================================================================
   * SCENARIO 2: 3D Cut One-Take Dolly + Media Board + frameExpr + Nested @cut
   * ========================================================================= */
  const proj3DId = `one-take-3d-${Date.now().toString(36)}`;
  const project3D = {
    version: 1,
    id: proj3DId,
    name: "One-Take 3D Walkthrough & Nested Cut",
    width: 1280,
    height: 720,
    fps: 30,
    duration: 3,
    themeId: "midnight",
    media: [mediaAsset],
    filters: [],
    pixelMaps: [],
    audioFx: [],
    cardNodes: [],
    // Active cut starts as outer 2D cut embedding the 3D walkthrough via @cut segment + screen-locked caption
    tracks: [
      {
        id: "tr-outer-cap",
        name: "Outer Captions",
        clips: [
          {
            id: "c-outer-cap",
            cardId: "caption-track",
            start: 0,
            end: 3,
            params: {
              position: "bottom",
              accent: "#22ff66",
              lines: "0|3|*OUTER 2D CAPTION*|Over nested 3D walkthrough segment",
              showEn: "true",
              strokeOn: "true",
              strokeW: 4,
              strokeColor: "#000000",
            },
          },
        ],
      },
      {
        id: "tr-outer-seg",
        name: "3D Segment",
        clips: [
          {
            id: "c-seg-3d",
            cardId: "",
            cutId: "cut-3d",
            start: 0,
            end: 3,
            params: {},
          },
        ],
      },
    ],
    activeCutId: "cut-outer-2d",
    cuts: [
      {
        id: "cut-outer-2d",
        name: "Outer 2D Cut",
        kind: "2d",
      },
      {
        id: "cut-3d",
        name: "3D Walkthrough",
        kind: "3d",
        camera3dFov: 50,
        duration: 3,
        transitions: [],
        cameras: [
          {
            id: "cam-3d-dolly",
            name: "Dolly Forward",
            row: 0,
            start: 0,
            end: 3,
            enabled: true,
            params: {
              x: 0,
              y: 0,
              z: "1500 - 2200 * p",
              rx: 0,
              ry: 0,
              rz: 0,
              fovDeg: 50,
            },
          },
        ],
        tracks: [
          {
            id: "tr-3d-front",
            name: "Front Z=0",
            clips: [
              {
                id: "b-front",
                cardId: CARD_ID,
                start: 0,
                end: 3,
                frame: { x: 200, y: 90, w: 880, h: 540, translateZ: 0 },
                params: { bg: "#ea580c", accent: "#fed7aa", label: "FRONT Z=0" },
              },
            ],
          },
          {
            id: "tr-3d-mid",
            name: "Mid Z=-600",
            clips: [
              {
                id: "b-mid",
                cardId: CARD_ID,
                start: 0,
                end: 3,
                opacity: 0.58,
                frame: { x: 220, y: 100, w: 840, h: 520, translateZ: -600 },
                frameExpr: {
                  y: "100 + 28 * sin(p * 3.14159)",
                  rotateY: "-5 + 10 * p",
                },
                params: { bg: "#10b981", accent: "#a7f3d0", label: "MID Z=-600" },
              },
            ],
          },
          {
            id: "tr-3d-media",
            name: "Back Media Z=-1200",
            clips: [
              {
                id: "b-media",
                cardId: "",
                mediaId: "m-board-img",
                start: 0,
                end: 3,
                frame: { x: 180, y: 80, w: 920, h: 560, translateZ: -1200 },
                params: {},
              },
            ],
          },
        ],
      },
    ],
  };

  await page.evaluate((p) => {
    window.__pcStore.actions.loadProject(p);
    window.__pcStore.actions.seek(0.15);
  }, project3D);

  const bound3D = await until(
    "editor bound 3D project replica",
    async () => {
      const s = await json(`${EDITOR}/api/agent/status`);
      return s.body?.bound && s.body.projectId === proj3DId && s.body.link?.replica?.hasBody === true ? s.body : null;
    },
    90_000,
    400,
  );
  check("S2_BOUND", !!bound3D, "Editor bound 3D walkthrough + nested 2D project replica");

  // 2A: Direct 3D cut dolly frames at t = 0.15 (in front of z=0), t = 2.25 (past z=0, before z=-600), t = 2.91 (past z=-600, facing media board at z=-1200)
  const dFront = await callTool("see_frames", { source: "timeline", cutId: "cut-3d", t: 0.15, view: "camera" });
  const shot3DFront = saveBase64Png(dFront.body?.result?.__image?.base64, "3d-dolly-front.png");
  if (shot3DFront) summary.screenshots.push(shot3DFront.file);

  const dMid = await callTool("see_frames", { source: "timeline", cutId: "cut-3d", t: 2.25, view: "camera" });
  const shot3DMid = saveBase64Png(dMid.body?.result?.__image?.base64, "3d-dolly-mid.png");
  if (shot3DMid) summary.screenshots.push(shot3DMid.file);

  const dMedia = await callTool("see_frames", { source: "timeline", cutId: "cut-3d", t: 2.91, view: "camera" });
  const shot3DMedia = saveBase64Png(dMedia.body?.result?.__image?.base64, "3d-dolly-media.png");
  if (shot3DMedia) summary.screenshots.push(shot3DMedia.file);

  const frontStats = shot3DFront ? regionStats(shot3DFront.png, 0.32, 0.25, 0.68, 0.45) : null;
  const midStats = shot3DMid ? regionStats(shot3DMid.png, 0.32, 0.25, 0.68, 0.45) : null;
  const mediaStats = shot3DMedia ? regionStats(shot3DMedia.png, 0.25, 0.22, 0.75, 0.78) : null;

  check(
    "S2_DOLLY_FRONT",
    !!shot3DFront && frontStats.meanR > 180 && frontStats.meanB < 90,
    "3D camera at t=0.15 (z=+1390) sees Front Z=0 orange board",
    frontStats,
  );
  check(
    "S2_DOLLY_CULL_AND_SORT",
    !!shot3DMid && midStats.meanG > 110 && midStats.meanB > 80 && midStats.meanR < 170,
    "3D camera at t=2.25 (z=-150) culls Front Z=0 behind camera and depth-blends translucent Mid emerald board over Back magenta media board",
    midStats,
  );
  check(
    "S2_DOLLY_MEDIA_BOARD",
    !!shot3DMedia && mediaStats.meanR > 130 && mediaStats.meanB > 160 && mediaStats.meanG < 90 && mediaStats.proxyCyan === 0,
    "3D camera at t=2.91 (z=-634) culls both front boards and renders real magenta/violet media board pixels with ZERO proxy rectangles",
    mediaStats,
  );

  // 2B: Nested 3D @cut segment inside outer 2D cut with screen-locked captions on top
  const nFront = await callTool("see_frames", { source: "timeline", cutId: "cut-outer-2d", t: 0.15, view: "camera" });
  const shotNestedFront = saveBase64Png(nFront.body?.result?.__image?.base64, "nested-3d-front.png");
  if (shotNestedFront) summary.screenshots.push(shotNestedFront.file);

  const nMedia = await callTool("see_frames", { source: "timeline", cutId: "cut-outer-2d", t: 2.91, view: "camera" });
  const shotNestedMedia = saveBase64Png(nMedia.body?.result?.__image?.base64, "nested-3d-media.png");
  if (shotNestedMedia) summary.screenshots.push(shotNestedMedia.file);

  const nestedFrontCenter = shotNestedFront ? regionStats(shotNestedFront.png, 0.32, 0.25, 0.68, 0.45) : null;
  const nestedMediaCenter = shotNestedMedia ? regionStats(shotNestedMedia.png, 0.28, 0.2, 0.72, 0.55) : null;
  const nestedCap = shotNestedMedia ? regionStats(shotNestedMedia.png, 0.25, 0.62, 0.75, 0.86) : null;

  check(
    "S2_NESTED_3D_SEGMENT",
    !!shotNestedFront &&
      !!shotNestedMedia &&
      nestedFrontCenter.meanR > 180 &&
      nestedMediaCenter.meanB > 150 &&
      nestedCap.brightGreenOrWhite > 35 &&
      nestedMediaCenter.proxyCyan === 0,
    "Outer 2D cut renders nested 3D @cut walkthrough across depth zones with screen-locked 2D captions on top",
    { nestedFrontCenter, nestedMediaCenter, captionPixels: nestedCap?.brightGreenOrWhite },
  );

  /* =========================================================================
   * SCENARIO 3: see_frames(view: "camera") vs see_frames(view: "space") on 3D Cut
   * ========================================================================= */
  const see3DCam = await callTool("see_frames", { source: "timeline", cutId: "cut-3d", t: 1.5, view: "camera" });
  const shot3DCam = saveBase64Png(see3DCam.body?.result?.__image?.base64, "3d-see-camera.png");
  if (shot3DCam) summary.screenshots.push(shot3DCam.file);

  const see3DSpace = await callTool("see_frames", { source: "timeline", cutId: "cut-3d", t: 1.5, view: "space" });
  const shot3DSpace = saveBase64Png(see3DSpace.body?.result?.__image?.base64, "3d-see-space.png");
  if (shot3DSpace) summary.screenshots.push(shot3DSpace.file);

  const camVsSpaceDiff = shot3DCam && shot3DSpace ? meanImageDiff(shot3DCam.png, shot3DSpace.png) : 0;
  const space3DStats = shot3DSpace ? regionStats(shot3DSpace.png, 0.05, 0.05, 0.95, 0.95) : null;

  check(
    "S3_CAMERA_VS_SPACE",
    see3DCam.body?.ok &&
      see3DSpace.body?.ok &&
      see3DCam.body.result?.view === "camera" &&
      see3DSpace.body.result?.view === "space" &&
      !!shot3DCam &&
      !!shot3DSpace &&
      camVsSpaceDiff > 15 &&
      space3DStats.count > 5000,
    "see_frames(view: 'camera') and see_frames(view: 'space') on 3D cut both return valid, distinct non-blank PNGs",
    { camVsSpaceDiff, spacePixels: space3DStats?.count, spaceAmber: space3DStats?.amberPixels },
  );

  /* =========================================================================
   * LIVE EDITOR 3D UI: Camera vs Space Mode + Depth Badge + Camera Lane
   * ========================================================================= */
  await callTool("user_interface_switch_cut", { cutId: "cut-3d" });
  await delay(1800);

  const ui3DCamera = await page.evaluate(() => ({
    mode: document.querySelector("[data-pc-3d-mode]")?.getAttribute("data-pc-3d-mode") ?? null,
    hasCameraLane: !!document.querySelector('[data-pc="camera-lane"]'),
    hasCameraClip: !!document.querySelector('[data-pc-camera-clip="cam-3d-dolly"]'),
    hasPrerenderBtn: !!document.querySelector('[data-pc="prerender-cut-2d"]'),
    depthBadges: document.querySelectorAll('[data-pc="track-depth-hint"]').length,
  }));
  const editor3DCamFile = path.join(OUT, "editor-3d-camera-ui.png");
  await page.screenshot({ path: editor3DCamFile });
  summary.screenshots.push(editor3DCamFile);

  check(
    "S4_EDITOR_3D_CAMERA_UI",
    ui3DCamera.mode === "camera" &&
      ui3DCamera.hasCameraLane &&
      ui3DCamera.hasCameraClip &&
      ui3DCamera.hasPrerenderBtn &&
      ui3DCamera.depthBadges >= 3,
    "Switching to 3D cut defaults Preview to Camera view, shows Pre-render to 2D cut action, Camera lane, and Track Depth badges",
    ui3DCamera,
  );

  await page.click('[data-pc-view="space"]');
  await delay(1000);
  const ui3DSpaceMode = await page.evaluate(
    () => document.querySelector("[data-pc-3d-mode]")?.getAttribute("data-pc-3d-mode") ?? null,
  );
  const editor3DSpaceFile = path.join(OUT, "editor-3d-space-ui.png");
  await page.screenshot({ path: editor3DSpaceFile });
  summary.screenshots.push(editor3DSpaceFile);

  check(
    "S4_EDITOR_3D_SPACE_UI",
    ui3DSpaceMode === "space",
    "Clicking Space tab in 3D cut switches Scene3DView to interactive Space overview with camera frustum",
    { mode: ui3DSpaceMode },
  );

  /* =========================================================================
   * 3D -> 2D NON-DESTRUCTIVE CONVERSION (prerender_cut_to_2d) + MCP GATES
   * ========================================================================= */
  const rejectLossy = await callTool("set_cut_kind", { cutId: "cut-3d", kind: "2d" });
  check(
    "S5_LOSSY_3D_TO_2D_REJECTED",
    rejectLossy.body?.ok === false && /prerender_cut_to_2d/i.test(rejectLossy.body?.error ?? ""),
    "set_cut_kind rejects lossy in-place 3D->2D overwrite and directs caller to prerender_cut_to_2d",
    { error: rejectLossy.body?.error },
  );

  const prerendered = await callTool("prerender_cut_to_2d", { cutId: "cut-3d", name: "Walkthrough Pre-rendered 2D" });
  const new2DCutId = prerendered.body?.result?.cut?.id;
  check(
    "S5_PRERENDER_CUT_TO_2D",
    prerendered.body?.ok &&
      prerendered.body.result?.cut?.kind === "2d" &&
      typeof new2DCutId === "string" &&
      prerendered.body.result?.cuts?.some((c) => c.id === "cut-3d" && c.kind === "3d"),
    "prerender_cut_to_2d renders 3D cut into .mp4 in a new 2D cut while preserving original 3D cut untouched",
    {
      newCut: prerendered.body?.result?.cut,
      media: prerendered.body?.result?.media,
    },
  );

  if (new2DCutId) {
    const seePre2D = await callTool("see_frames", { source: "timeline", cutId: new2DCutId, t: 2.85, view: "camera" });
    const shotPre2D = saveBase64Png(seePre2D.body?.result?.__image?.base64, "prerendered-2d-cut.png");
    if (shotPre2D) summary.screenshots.push(shotPre2D.file);
    const preStats = shotPre2D ? regionStats(shotPre2D.png, 0.25, 0.25, 0.75, 0.75) : null;
    check(
      "S5_PRERENDERED_VIDEO_PIXELS",
      !!shotPre2D && preStats.meanB > 130 && preStats.meanR > 100,
      "Pre-rendered 2D cut plays back exact rendered 3D walkthrough video frames",
      preStats,
    );
  }

  // MCP create_card monolith gate over HTTP
  const monolithRes = await callTool("create_card", {
    id: "probe-monolith-blocked",
    source: `import type { CardDef, CardProps } from "../../kernel/types";
const CAMERA_TRACK = [
  { t: 0, x: 0, y: 0, z: 1200 },
  { t: 5, x: 200, y: -40, z: 400 },
  { t: 12, x: -300, y: 80, z: -600 },
  { t: 20, x: 0, y: 0, z: -1400 },
];
const SCENES = [
  { start: 0, end: 5, title: "Intro" },
  { start: 5, end: 12, title: "Chapter 1" },
  { start: 12, end: 20, title: "Chapter 2" },
  { start: 20, end: 30, title: "Outro" },
];
function BadMonolith({ t = 0 }: CardProps<Record<string, never>>) {
  const s = SCENES.find((x) => t >= x.start && t < x.end) ?? SCENES[0];
  return <div>{s.title} {CAMERA_TRACK.length}</div>;
}
export const badMonolith: CardDef = {
  id: "probe-monolith-blocked",
  name: "Monolith Film Card",
  description: "Should be blocked by monolith gate",
  frameMode: "stateful",
  defaults: {},
  controls: [],
  Component: BadMonolith,
};`,
  });
  check(
    "S6_MONOLITH_GATE",
    monolithRes.body?.ok === false && /add_camera|timeline|parts|controls/i.test(monolithRes.body?.error ?? ""),
    "MCP create_card rejects multi-scene/camera-keyframe monolith card lacking parts and controls",
    { error: monolithRes.body?.error },
  );

  // MCP apply_card pre-overlay rejection on non-scene host
  const preOverlayRes = await callTool("apply_card", {
    cardId: PRE_CARD_ID,
    clipId: "b-mid",
  });
  check(
    "S6_PRE_OVERLAY_GATE",
    preOverlayRes.body?.ok === false && /scene-3d|3d.*cut/i.test(preOverlayRes.body?.error ?? ""),
    "MCP apply_card rejects attaching pre-overlay card to a non-scene host clip",
    { error: preOverlayRes.body?.error },
  );

  check("S7_NO_PAGE_ERRORS", pageErrors.length === 0, "Zero uncaught browser page errors during probe", {
    pageErrors: pageErrors.slice(0, 5),
  });
} catch (err) {
  fails.push(`Exception: ${err?.stack ?? err}`);
  console.error("FAIL exception", err?.stack ?? err);
  summary.editorLogTail = editorLog.slice(-30).join("").slice(-3000);
} finally {
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  cleanup();
  if (!KEEP) {
    try {
      fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const finalReport = { ok: fails.length === 0, fails, summary, results };
fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(finalReport, null, 2));
console.log(JSON.stringify(finalReport));
process.exit(fails.length === 0 ? 0 : 1);
