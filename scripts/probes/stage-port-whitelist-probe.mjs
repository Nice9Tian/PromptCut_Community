/**
 * Stage port gate: probe in the **real editor and real stage window** (`server/stage-gate.mjs`:
 * requests from the stage port are rejected by default, only allowing the whitelist).
 *
 * [lead session rename, 2026-10-22] Originally named `stage-gate-probe.mjs`. The online browser part
 * of 0.7.19 **rewrote that filename in place** into a probe for "stage gate, crash records, guards,
 * tier bubbles" (similar names, verifying different things); after merging, nobody ran this
 * **security** test. The acceptance checklist rewrite discovered this gap, so this file was saved
 * under this name before merging to preserve it. Both probes must be run: this file verifies the
 * stage port allowlist, while `stage-gate-probe.mjs` verifies the stage gate among the three gates.
 *
 *   node scripts/probes/stage-port-whitelist-probe.mjs --port 29000 [--out <dir>] [--json <file>] [--shots <dir>] [--keep]
 *
 * Starts an isolated editor itself (stage ports are +1, +2; all three consecutive numbers must be
 * free; data, assets, and card overlay layers all point under `--out`), cleaned up by PID after
 * running. The editor process runs with `PROMPTCUT_STAGE_PORT_LOG`: for every request arriving at
 * the stage port, the proxy logs a line (method, path, whether allowed).
 * Do not point `--out` under `out/` of the repository: that is outside the dev server watch scope,
 * so modifying cards in step 5 will not trigger hot reload (defaults to system temporary directory).
 *
 * Flow:
 *   0. Write a user card (`probe-gate-card`) to the card overlay layer: after mounting in the stage,
 *      it calls `POST /api/agent/bind` **itself** once, and exposes a function so the probe can tell it
 *      to call a batch of endpoints one by one using `fetch` and `WebSocket` from the card module.
 *      Place a video (ffmpeg test pattern) and an audio track (sine wave) in the asset directory.
 *   1. Editor `?editor&nosetup=1&preview=stage`; load a project: this user card, a built-in card with
 *      text, a built-in card with embedded audio (`av-pulse`), video, and audio, each occupying a track.
 *      Click a few spots, play for two seconds, pause, click again.
 *      Verify: both stage windows are on stage ports; user card is drawn in the visible stage (pixels
 *      of marker color block), video area has picture and pictures at two timestamps differ; during
 *      playback the playhead moves and video in stage moves; card audio generated successfully
 *      (`generateCardAudio`).
 *   2. **Up to this point, not a single request to the stage port was rejected** (no `ok: false` in
 *      proxy trace): the whitelist did not block things legitimately needed by the stage.
 *      Requests in the trace are categorized by "method + path prefix" and written to results
 *      (the whitelist is defined based on it).
 *   3. The user card calls a batch of endpoints one by one in the visible stage (Agent binding and
 *      chat, data mirror, project write, asset write, frame and export write endpoints, MCP,
 *      filesystem, card write and sync, render node, media collection, web tools, files under project
 *      root, arbitrary files via `/@fs/`, document service WebSocket): **all rejected** (403;
 *      WebSocket cannot connect). The same batch sent from the editor port (in Node, without Origin):
 *      none is 403.
 *   4. Preview continues normally after rejection: click another spot, play for one second; user card
 *      and video still render properly.
 *   5. Modify the source code of this user card: stage updates to the new one without reloading
 *      (hot reload WebSocket and refetching source code both go through the stage port).
 *
 * Frame-by-frame verification for track stream paste and ruler scrub uses the existing
 * `scrub-stream-probe.mjs` (run under the same gate, see report).
 * Acceptance check: exit code 0, `fails: []` in results. Wait timeout is only to prevent hanging.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, REPO } from '../lib/dev-server.mjs';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
/** `--observe`: only run up to step 2 (log legitimate requests sent by stage port), without letting the user card call that batch */
const OBSERVE = args.includes('--observe');
const JSON_OUT = flagArg('json', null, args);
const SHOTS = flagArg('shots', null, args);
const RUN = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stage-gate-probe-${RUN}`));
if (!PORT) { console.error('Pass --port <port of a dev server you start yourself>'); process.exit(2); }

const WORK = path.join(OUT, 'work');
const MEDIA_DIR = path.join(WORK, 'media');
const DATA_DIR = path.join(WORK, 'data');
const OVERRIDES = path.join(WORK, 'card-overrides');
const GATE_LOG = path.join(WORK, 'stage-port.log');
const CARD_ID = 'probe-gate-card';
/** Color block drawn by the user card: pure magenta, nothing else will be this color */
const MARK = [255, 0, 255];
/** Color after card modification */
const MARK2 = [16, 32, 48];
const FPS = 30, WIDTH = 1280, HEIGHT = 720, SECONDS = 6;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 1200))); say('FAIL', { label, extra }); } return !!cond; };
async function until(label, fn, timeoutMs, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); say('TIMEOUT', { label }); return null; }
    await sleep(everyMs);
  }
}

/* ------------------------------------------------------------------ Assets and cards */

async function makeVideo(ffmpeg) {
  const tmp = path.join(WORK, 'gate-video.mp4');
  await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-crf', '18', '-movflags', '+faststart', tmp], { windowsHide: true });
  const bytes = await fs.readFile(tmp);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.rename(tmp, path.join(MEDIA_DIR, `${hash}.mp4`));
  return { id: 'm-video', kind: 'video', name: 'gate-video.mp4', url: `/@media/${hash}`, hash, duration: SECONDS, width: WIDTH, height: HEIGHT, fps: FPS, bytes: bytes.length };
}
async function makeAudio() {
  const rate = 48000, n = rate * SECONDS, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 8000), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  const bytes = Buffer.concat([head, data]);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(MEDIA_DIR, `${hash}.wav`), bytes);
  return { id: 'm-audio', kind: 'audio', name: 'gate-audio.wav', url: `/@media/${hash}`, hash, duration: SECONDS, bytes: bytes.length };
}

/** User card: draws a magenta block; calls Agent binding once itself after mounting; exposes a function for probe batch calls */
async function writeCard(color = MARK) {
  const dir = path.join(OVERRIDES, 'src', 'cards', 'user');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${CARD_ID}.tsx`), `import type { CardDef, CardProps } from "../../kernel/types";

/** For the probe (stage-gate-probe.mjs temporarily writes it into the overlay layer): a user card that tries to call the editor's local API from the stage */
const g = globalThis as any;
async function call(item: any) {
  try {
    const res = await fetch(item.path, { method: item.method, headers: item.type ? { "Content-Type": item.type } : undefined, body: item.body === undefined ? undefined : item.body, cache: "no-store" });
    return { ...item, status: res.status, body: undefined };
  } catch (e: any) { return { ...item, status: 0, error: String(e?.message ?? e), body: undefined }; }
}
function socket(item: any) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: any) => { if (!done) { done = true; resolve({ ...item, ...r }); } };
    try {
      const ws = new WebSocket(location.origin.replace(/^http/, "ws") + item.path, item.protocols);
      ws.onopen = () => { finish({ opened: true }); ws.close(); };
      ws.onerror = () => finish({ opened: false });
      ws.onclose = () => finish({ opened: false });
      setTimeout(() => finish({ opened: false, timeout: true }), 8000);
    } catch (e: any) { finish({ opened: false, error: String(e?.message ?? e) }); }
  });
}
if (typeof window !== "undefined" && !g.__gateProbe) {
  g.__gateProbe = { origin: location.origin, auto: null, run: async (list: any[]) => { const out = []; for (const item of list) out.push(item.ws ? await socket(item) : await call(item)); return out; } };
  void call({ method: "POST", path: "/api/agent/bind", type: "application/json", body: JSON.stringify({ mode: "ticket", projectId: "p", url: "ws://attacker.invalid/" }) }).then((r) => { g.__gateProbe.auto = r; });
}
function C(_: CardProps<{}>) {
  return <div data-gate-mark style={{ position: "absolute", left: 0, top: 0, width: 320, height: 240, background: "rgb(${color.join(',')})" }} />;
}
export const probeGateCard: CardDef<{}> = {
  id: "${CARD_ID}", name: "Stage port probe", description: "stage-gate-probe", source: "user",
  frameMode: "direct",
  defaults: {},
  controls: [],
  Component: C,
};
`);
}

/**
 * The batch called by the user card. `type` is Content-Type; write endpoints include JSON following
 * built-in UI patterns.
 * Only endpoints where "even if allowed, consequences are confined to this probe editor's own
 * temporary directory" are listed here; several that affect other locations on this machine
 * (opening File Explorer, modifying user-level MCP config, opening web pages, downloading,
 * starting chats, starting exports) are not tested in the real stage, and are verified by unit test
 * `server/test/stage-gate.test.mjs`.
 */
const J = 'application/json';
const body = (o) => JSON.stringify(o);
const ATTACKS = [
  // Agent binding and chat
  { method: 'POST', path: '/api/agent/bind', type: J, body: body({ mode: 'ticket', projectId: 'p', url: 'ws://attacker.invalid/' }) },
  { method: 'POST', path: '/api/agent/unbind', type: J, body: '{}' },
  { method: 'POST', path: '/api/agent/ticket', type: J, body: body({ reqId: 'x', ticket: 'x' }) },
  { method: 'GET', path: '/api/agent/status' },
  { method: 'GET', path: '/api/agent/inbox' },
  { method: 'GET', path: '/api/ai/config' },
  { method: 'POST', path: '/api/ai/config', type: J, body: body({ api: { baseUrl: 'https://attacker.invalid' } }) },
  { method: 'GET', path: '/api/ai/providers' },
  { method: 'GET', path: '/api/ai/machine-code' },
  { method: 'GET', path: '/api/chats/list' },
  { method: 'POST', path: '/api/chats/save', type: J, body: body({ id: 'x', messages: [] }) },
  { method: 'POST', path: '/api/chats/attach/import', type: J, body: body({ path: 'C:/Windows/win.ini' }) },
  // Data mirror
  { method: 'GET', path: '/api/data/project' },
  { method: 'PUT', path: '/api/data/project', type: J, body: body({ project: {} }) },
  { method: 'POST', path: '/api/data/diff', type: J, body: '{}' },
  { method: 'POST', path: '/api/data/playhead', type: J, body: body({ t: 0 }) },
  { method: 'PUT', path: '/api/data/costs', type: J, body: body({ records: [] }) },
  { method: 'GET', path: '/api/data/costs' },
  // Project write
  { method: 'GET', path: '/api/projects' },
  { method: 'PUT', path: '/api/projects/gate-probe', type: J, body: body({ project: {} }) },
  { method: 'DELETE', path: '/api/projects/gate-probe' },
  { method: 'GET', path: '/api/project-backups' },
  // Asset write
  { method: 'POST', path: '/api/media/upload/gate-probe.txt', type: 'text/plain', body: 'x' },
  { method: 'POST', path: '/api/media/adopt', type: J, body: body({ path: 'C:/Windows/win.ini' }) },
  { method: 'GET', path: '/api/media/local?path=C%3A%2FWindows%2Fwin.ini' },
  { method: 'POST', path: '/api/media/upload-queue/target', type: J, body: body({ base: 'https://attacker.invalid' }) },
  { method: 'POST', path: '/api/media/prefetch', type: J, body: '{}' },
  // Frame and export write endpoints
  { method: 'POST', path: '/api/frames/preload', type: J, body: '{}' },
  { method: 'POST', path: '/api/frames/yield', type: J, body: '{}' },
  { method: 'POST', path: '/api/frames/render-node', type: J, body: '{}' },
  { method: 'POST', path: '/api/export/audio-mix/x', type: 'audio/wav', body: 'x' },
  { method: 'GET', path: '/api/exports' },
  { method: 'POST', path: '/api/storage/clear-cache', type: J, body: '{}' },
  { method: 'GET', path: '/api/storage' },
  { method: 'POST', path: '/api/vision/bake', type: J, body: '{}' },
  { method: 'POST', path: '/api/vision/snapshot', type: J, body: '{}' },
  // MCP and Skill
  { method: 'POST', path: '/api/mcp/call', type: J, body: body({ name: 'get_project', args: {} }) },
  { method: 'GET', path: '/api/mcp/status' },
  { method: 'POST', path: '/api/mcp/result', type: J, body: '{}' },
  { method: 'GET', path: '/api/skill-lock' },
  // Card write and sync, render nodes
  { method: 'POST', path: '/api/cards/create', type: J, body: body({ id: 'gate-evil', source: 'x', existingIds: [] }) },
  { method: 'POST', path: '/api/cards/edit', type: J, body: body({ id: CARD_ID, find: 'a', replace: 'b' }) },
  { method: 'GET', path: `/api/cards/source?id=${CARD_ID}` },
  { method: 'POST', path: '/api/cards/install', type: J, body: '{}' },
  { method: 'POST', path: '/api/cards/sync/bind', type: J, body: body({ mode: 'ticket', projectId: 'p', url: 'ws://attacker.invalid/' }) },
  { method: 'POST', path: '/api/cards/sync/ticket', type: J, body: body({ reqId: 'x', ticket: 'x' }) },
  { method: 'POST', path: '/api/cards/sync/unbind', type: J, body: '{}' },
  { method: 'GET', path: '/api/cards/sync/status' },
  { method: 'POST', path: '/api/render-node/bind', type: J, body: body({ url: 'ws://attacker.invalid/' }) },
  { method: 'POST', path: '/api/render-node/ticket', type: J, body: '{}' },
  // Media collection, web tools, speech-to-text, voiceover, document service
  { method: 'GET', path: '/api/collect/cookies' },
  { method: 'GET', path: '/api/stt/status' },
  { method: 'GET', path: '/api/voice/config' },
  { method: 'GET', path: '/api/docservice/device' },
  { method: 'POST', path: '/docservice/shared/create', type: J, body: '{}' },
  // Casing and repeated slashes
  { method: 'POST', path: '/aPi/agent/bind', type: J, body: '{}' },
  { method: 'POST', path: '/api//agent/bind', type: J, body: '{}' },
  // Filesystem types: files under project root, arbitrary files via /@fs/
  { method: 'GET', path: '/package.json' },
  { method: 'GET', path: '/vite.config.ts?raw' },
  { method: 'GET', path: '/scripts/test-suite.mjs?raw' },
  { method: 'GET', path: '/docs/semantics/glossary.md' },
  { method: 'GET', path: '/desktop/src-tauri/tauri.conf.json' },
  { method: 'GET', path: '/.git/config' },
  { method: 'GET', path: '/out/' },
  { method: 'GET', path: `/@fs/${REPO.replace(/\\/g, '/')}/package.json` },
  { method: 'GET', path: '/@fs/C:/Windows/win.ini' },
  // WebSocket: document service; upgrade without hot reload subprotocol
  { ws: true, path: '/docservice' },
  { ws: true, path: '/' },
];

/* ------------------------------------------------------------------ Trace */

const readLog = () => { try { return fsSync.readFileSync(GATE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
/** Normalize a request into "method + path pattern": dynamic segments like hashes, numbers, filenames become placeholders */
function shapeOf(row) {
  const p = row.u.split('?')[0];
  let shape = p;
  if (/^\/@fs\//.test(p)) shape = /\/node_modules\//.test(p) ? '/@fs/…/node_modules/…' : `/@fs/…/${p.split('/').slice(-1)[0]}`;
  else if (/^\/(src|server|node_modules|@id|@vite)\//.test(p)) shape = `/${p.split('/')[1]}/…`;
  else shape = p.replace(/[0-9a-f]{32,}/gi, '<hash>').replace(/\/\d+(?=\/|$)/g, '/<n>');
  return `${row.ws ? 'WS' : row.m} ${shape}`;
}
const shapes = (rows) => { const m = new Map(); for (const r of rows) { const k = shapeOf(r); m.set(k, (m.get(k) ?? 0) + 1); } return Object.fromEntries([...m].sort()); };

/* ------------------------------------------------------------------ Main flow */

const out = { out: OUT, port: PORT };
let dev = null, browser = null;
const started = Date.now();
try {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (SHOTS) await fs.mkdir(SHOTS, { recursive: true });
  const env = { PROMPTCUT_EXPORT_DIR: WORK, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_CARD_OVERRIDES: OVERRIDES, PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_STAGE_PORT_LOG: GATE_LOG,
    PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: `gateprobe-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'gate-probe' };
  Object.assign(process.env, env);
  const { findFfmpeg } = await import('../../server/bakery/ffmpeg.mjs');
  await writeCard();
  const media = { video: await makeVideo(await findFfmpeg()), audio: await makeAudio() };
  dev = await startDevServer({ env, port: PORT, logFile: path.join(WORK, 'vite.log'), log: (m) => say('dev', { m }) });
  const origin = dev.origin;
  out.origin = origin; out.stagePorts = dev.stagePorts;
  say('spawn', { pid: dev.pid, port: PORT, stagePorts: dev.stagePorts });

  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1200 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  const stagePorts = dev.stagePorts.map(String);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
  const frontId = () => page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
  const frontFrame = async () => { const id = await frontId(); return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null; };
  check(stageFrames().length === 2, 'both stage windows are open on the stage port', page.frames().map((f) => f.url().slice(0, 80)));

  /* ---------------------------------------------------------------- 1. Project */
  // Directly load the entire project (clip timings and track assignments are hardcoded; using
  // "add a card" actions would push clips backward if they don't fit on the same track)
  const clips = { user: 'clip-user', pill: 'clip-pill', pulse: 'clip-pulse', video: 'clip-video', audio: 'clip-audio' };
  const PROJECT = { id: `stage-gate-${RUN}`, name: 'Stage port probe', width: WIDTH, height: HEIGHT, fps: FPS, duration: SECONDS, themeId: 'dark', filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    media: [media.video, media.audio],
    tracks: [
      { id: 'tr-user', name: 'user', hidden: false, clips: [{ id: clips.user, kind: 'card', cardId: CARD_ID, start: 0, end: SECONDS, params: {} }] },
      { id: 'tr-pill', name: 'pill', hidden: false, clips: [{ id: clips.pill, kind: 'card', cardId: 'punch-pill', start: 0, end: SECONDS, params: { text: '舞台端口探针 Stage Gate 123' } }] },
      { id: 'tr-pulse', name: 'pulse', hidden: false, clips: [{ id: clips.pulse, kind: 'card', cardId: 'av-pulse', embeddedAudio: true, start: 0.5, end: 2.5, params: { color: '#60a5fa', frequency: 880, gain: 0.3, duration: 0.3 } }] },
      { id: 'tr-video', name: 'video', hidden: false, clips: [{ id: clips.video, mediaId: media.video.id, cardId: '', mediaOffset: 0, start: 0, end: SECONDS, params: {}, label: media.video.name }] },
      { id: 'tr-audio', name: 'audio', hidden: false, clips: [{ id: clips.audio, mediaId: media.audio.id, cardId: '', mediaOffset: 0, start: 0, end: SECONDS, params: {}, label: media.audio.name }] },
    ] };
  const loaded = await page.evaluate(async (project) => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.loadProject(project);
    actions.seek(1);
    const p = getState().project;
    return { size: [p.width, p.height], clips: p.tracks.map((t) => t.clips.map((c) => `${c.cardId || c.mediaId}@${c.start}-${c.end}`)) };
  }, PROJECT);
  out.loaded = loaded;
  check(loaded.clips.length === 5 && loaded.clips.every((c) => c.length === 1), 'the project contains a user card, a text card, an audio card, a video and a sound (each on its own track, all starting at the beginning)', loaded);
  out.clips = clips;

  const stageBox = () => page.evaluate(() => {
    const f = [...document.querySelectorAll('iframe')].filter((el) => /stage=1/.test(el.src) && getComputedStyle(el).opacity !== '0')
      .map((el) => el.getBoundingClientRect()).find((r) => r.width > 100);
    return f ? { x: Math.round(f.left), y: Math.round(f.top), width: Math.round(f.width), height: Math.round(f.height) } : null;
  });
  const shoot = async (name) => {
    const f = await frontFrame();
    await f?.evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r())))).catch(() => {});
    const box = await stageBox();
    if (!box) return null;
    const buf = await page.screenshot({ clip: box });
    if (SHOTS && name) await fs.writeFile(path.join(SHOTS, `${name}.png`), buf);
    return PNG.sync.read(buf);
  };
  /** In screenshot: how many pixels of magenta marker; average color and variance of lower-right quadrant (video area) */
  const measure = (png) => {
    if (!png) return null;
    let mark = 0, sum = 0, sq = 0, n = 0; const sig = [];
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4, r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (r > 240 && g < 16 && b > 240) mark++;
      if (x > png.width * 0.55 && y > png.height * 0.6) { const l = (r + g + b) / 3; sum += l; sq += l * l; n++; if ((x + y * 7) % 97 === 0) sig.push(r >> 3, g >> 3, b >> 3); }
    }
    const mean = sum / n;
    return { size: [png.width, png.height], mark, markShare: +(mark / (png.width * png.height)).toFixed(4), videoMean: +mean.toFixed(1), videoStd: +Math.sqrt(Math.max(0, sq / n - mean * mean)).toFixed(1), sig: crypto.createHash('sha1').update(Buffer.from(sig)).digest('hex').slice(0, 12) };
  };
  const stageState = async () => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate((ids) => {
      const d = window.__pcStageDiag?.();
      const v = document.querySelector('video');
      return { origin: location.origin, t: d?.t ?? null, role: d?.role ?? null, mark: !!document.querySelector('[data-gate-mark]'), probe: !!globalThis.__gateProbe,
        video: v ? { readyState: v.readyState, currentTime: +v.currentTime.toFixed(3), src: (v.currentSrc || v.src).replace(/[0-9a-f]{40,}/, '<hash>'), w: v.videoWidth } : null,
        user: !!document.querySelector(`[data-pc-clip="${ids.user}"]`), pill: !!document.querySelector(`[data-pc-clip="${ids.pill}"]`), fontsReady: document.fonts.status, fonts: [...document.fonts].filter((x) => x.status === 'loaded').length };
    }, clips).catch((e) => ({ error: String(e).slice(0, 200) }));
  };
  const seek = (t) => page.evaluate(async (t) => (await import('/src/store/project.ts')).actions.seek(t), t);
  const storeT = () => page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);

  // When a new card enters the stage for the first time, its cost must be measured first; after
  // measuring, it waits for the playhead to move before mounting: shift by one frame near 1s every few seconds
  let nudge = 0;
  const first = await until('in the visible stage the user card is mounted and the video decodes a picture', async () => {
    const s = await stageState();
    if (s?.mark && s?.video?.readyState >= 2) return s;
    if (++nudge % 6 === 0) await seek(nudge % 12 === 0 ? 1 : 1 + 1 / FPS);
    return null;
  }, 240000, 500);
  await seek(1);
  await until('the video in the stage returns to second 1', async () => { const s = await stageState(); return s?.video && Math.abs(s.video.currentTime - 1) < 0.05 ? s : null; }, 60000);
  out.stageAt1 = first ?? await stageState();
  check(!!first && new URL(first.origin).port !== String(PORT), 'the visible stage is on the stage port, the user card is mounted and the video decoded a picture', out.stageAt1);
  await sleep(800);
  const shot1 = measure(await shoot('1-seek-1s'));
  await seek(3.2);
  await until('the video in the stage reaches second 3.2', async () => { const s = await stageState(); return s?.video && Math.abs(s.video.currentTime - 3.2) < 0.1 ? s : null; }, 60000);
  await sleep(800);
  const shot2 = measure(await shoot('2-seek-3s'));
  out.shots = { at1: shot1, at3: shot2 };
  check(shot1 && shot1.mark > 2000 && shot2 && shot2.mark > 2000, 'the screenshot shows the user card\'s color block (at both times)', out.shots);
  check(shot1 && shot2 && shot1.videoStd > 8 && shot2.videoStd > 8 && shot1.sig !== shot2.sig, 'the video area in the screenshot has a picture, and the pictures at the two times differ', out.shots);

  // Play for two seconds
  await seek(0.5);
  await sleep(500);
  const before = { t: await storeT(), stage: await stageState() };
  await page.evaluate(async () => (await import('/src/store/project.ts')).actions.play());
  await sleep(2000);
  const during = { t: await storeT(), stage: await stageState() };
  await page.evaluate(async () => (await import('/src/store/project.ts')).actions.pause());
  await sleep(600);
  const after = { t: await storeT(), stage: await stageState() };
  out.play = { before: { t: before.t, video: before.stage?.video?.currentTime }, during: { t: during.t, video: during.stage?.video?.currentTime }, after: { t: after.t, video: after.stage?.video?.currentTime } };
  check(during.t - before.t > 1 && (during.stage?.video?.currentTime ?? 0) - (before.stage?.video?.currentTime ?? 0) > 0.8, 'playback: the playhead moves and the video in the stage moves too', out.play);
  check(Math.abs(after.t - (after.stage?.video?.currentTime ?? -9)) < 0.2, 'after pausing, the video in the stage stays at the playhead', out.play);
  const shot3 = measure(await shoot('3-after-play'));
  out.shots.afterPlay = shot3;
  check(shot3 && shot3.mark > 2000 && shot3.videoStd > 8, 'after playback, the screenshot still has both the user card and the video', shot3);
  out.fonts = { status: after.stage?.fontsReady, loaded: after.stage?.fonts };

  // Card audio (audio() of audio card is evaluated on editor page and stored)
  const audio = await page.evaluate(async (clipId) => {
    const G = await import('/src/editor/io/cardAudioGeneration.ts');
    const S = await import('/src/store/project.ts');
    try {
      const r = await G.generateCardAudio(clipId);
      const m = S.getState().project.media.find((x) => x.id === r.mediaId);
      return { ok: r.ok, hash: m?.hash ?? null, duration: m?.duration ?? null };
    } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  }, clips.pulse);
  out.cardAudio = audio;
  check(audio.ok === true && /^[a-f0-9]{64}$/.test(audio.hash ?? ''), 'card sound generated successfully', audio);
  // Play for another second with audio (both asset audio and card audio are on track)
  await seek(0.6);
  await page.evaluate(async () => (await import('/src/store/project.ts')).actions.play());
  await sleep(1200);
  const sound = await page.evaluate(async () => {
    const t = (await import('/src/store/project.ts')).getState().t;
    const els = [...document.querySelectorAll('audio, video')].map((el) => ({ tag: el.tagName, paused: el.paused, t: +el.currentTime.toFixed(2), ready: el.readyState }));
    return { t, els };
  });
  await page.evaluate(async () => (await import('/src/store/project.ts')).actions.pause());
  out.sound = sound;
  check(sound.t > 1.2, 'playing with media sound and card sound, the playhead keeps moving', sound);

  /* ---------------------------------------------------------------- 2. No requests rejected up to this point */
  await sleep(500);
  const logBefore = readLog();
  const deniedBefore = logBefore.filter((r) => !r.ok);
  // The Agent binding sent by user card upon mounting is expected to be rejected, not counted among "legitimate requests"
  const unexpected = deniedBefore.filter((r) => !(r.m === 'POST' && r.u === '/api/agent/bind'));
  out.observed = { total: logBefore.length, shapes: shapes(logBefore.filter((r) => r.ok)), deniedBeforeAttack: shapes(deniedBefore) };
  check(logBefore.length > 50, 'the stage port\'s request log was recorded', logBefore.length);
  check(unexpected.length === 0, 'along the whole path of creating a project, clicking, playing and card sound, not a single legitimate request to the stage port was rejected', shapes(unexpected));

  if (OBSERVE) throw new Error('observe');
  /* ---------------------------------------------------------------- 3. User card calls one by one */
  const front = await frontFrame();
  const auto = await until('the request the user card sent by itself when mounted has a result', () => front.evaluate(() => globalThis.__gateProbe?.auto ?? null), 30000);
  out.auto = auto;
  check(auto?.status === 403, 'the user card calling POST /api/agent/bind by itself when mounted: 403', auto);
  const fromStage = await front.evaluate((list) => globalThis.__gateProbe.run(list), ATTACKS);
  const http = fromStage.filter((r) => !r.ws), sockets = fromStage.filter((r) => r.ws);
  out.attack = { origin: await front.evaluate(() => globalThis.__gateProbe.origin), count: fromStage.length,
    statuses: http.reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {}),
    notDenied: http.filter((r) => r.status !== 403).map((r) => `${r.method} ${r.path} → ${r.status}`), sockets: sockets.map((r) => `${r.path} opened=${r.opened}`) };
  check(new URL(out.attack.origin).port !== String(PORT), 'this batch was sent from the origin of the stage port', out.attack.origin);
  check(out.attack.notDenied.length === 0, `the user card calls ${http.length} endpoints from the stage, all 403`, out.attack.notDenied);
  check(sockets.every((r) => r.opened === false), 'the user card connecting from the stage to the document service\'s WebSocket, an upgrade without the hot-update subprotocol: cannot connect', out.attack.sockets);
  // Same batch sent from editor port (Node, without Origin): none is 403 (what each endpoint returns remains as usual)
  const fromEditor = [];
  for (const a of ATTACKS.filter((x) => !x.ws)) {
    const status = await fetch(origin + a.path, { method: a.method, headers: a.type ? { 'Content-Type': a.type } : undefined, body: a.body, signal: AbortSignal.timeout(20000) }).then((r) => r.status, (e) => `Error: ${e.message}`);
    fromEditor.push({ method: a.method, path: a.path, status });
  }
  out.editorPort = { count: fromEditor.length, statuses: fromEditor.reduce((m, r) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {}), list: fromEditor.map((r) => `${r.method} ${r.path} → ${r.status}`) };
  const editorDenied = fromEditor.filter((r) => r.status === 403 && !/^\/(\.git|@fs\/c:\/windows)/i.test(r.path));
  check(editorDenied.length === 0, 'the same batch of endpoints sent from the editor port were not rejected by this gate (.git and /@fs/ outside the workspace are the dev server\'s own file system restrictions and do not count)', editorDenied);
  const logAfter = readLog().slice(logBefore.length);
  out.deniedInAttack = logAfter.filter((r) => !r.ok).length;

  /* ---------------------------------------------------------------- 4. Preview continues normally afterwards */
  await seek(2);
  await until('the video in the stage reaches second 2', async () => { const s = await stageState(); return s?.video && Math.abs(s.video.currentTime - 2) < 0.1 ? s : null; }, 60000);
  await sleep(800);
  const shot4 = measure(await shoot('4-after-attack'));
  await page.evaluate(async () => (await import('/src/store/project.ts')).actions.play());
  await sleep(1000);
  const t5 = await storeT();
  await page.evaluate(async () => (await import('/src/store/project.ts')).actions.pause());
  out.afterAttack = { shot: shot4, t: t5, stage: await stageState() };
  check(shot4 && shot4.mark > 2000 && shot4.videoStd > 8 && t5 > 2.5, 'after the rejection the preview works as usual: the user card and the video both draw and playback works', out.afterAttack);

  /* ---------------------------------------------------------------- 5. Modify card: stage hot-reloads accordingly (hot reload WebSocket and refetching source code both go through stage port) */
  for (const f of stageFrames()) await f.evaluate(() => { globalThis.__gateStay = 1; }).catch(() => {});
  await writeCard(MARK2);
  const colorNow = async () => (await frontFrame())?.evaluate(() => { const el = document.querySelector('[data-gate-mark]'); return el ? { color: getComputedStyle(el).backgroundColor, stayed: globalThis.__gateStay === 1 } : null; }).catch(() => null);
  const hot = await until('the user card in the stage switches to the changed color', async () => { const c = await colorNow(); return c?.color === `rgb(${MARK2.join(', ')})` ? c : null; }, 60000);
  await sleep(500);
  const shot5 = await shoot('5-after-card-edit');
  const px = shot5 ? [0, 1, 2].map((k) => shot5.data[(Math.round(shot5.height * 0.15) * shot5.width + Math.round(shot5.width * 0.1)) * 4 + k]) : null;
  out.hotUpdate = { dom: hot ?? await colorNow(), pixel: px };
  check(!!hot && hot.stayed, 'after the user card\'s source is changed, the stage switches to the new one without reloading (hot update works as usual through the stage port)', out.hotUpdate);
  check(px && px.every((v, k) => Math.abs(v - MARK2[k]) <= 6), 'that block in the screenshot has the changed color', out.hotUpdate);
  const tail = readLog().slice(logBefore.length + logAfter.length).filter((r) => !r.ok);
  check(tail.length === 0, 'after that, no new legitimate request to the stage port was rejected', shapes(tail));
  out.pageErrors = pageErrors.slice(0, 10);
} catch (e) {
  if (e?.message !== 'observe') fails.push(`Exception: ${e?.stack ?? e}`);
} finally {
  try { await browser?.close(); } catch {}
  try { dev?.stop(); } catch {}
  out.ms = Date.now() - started;
  out.fails = fails;
  if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2)).catch(() => {});
  if (!KEEP && !fails.length) await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(fails.length ? 1 : 0);
}
