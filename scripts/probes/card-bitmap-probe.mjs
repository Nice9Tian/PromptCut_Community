/**
 * End-to-end probe verifying single-card images (`bake_card`, 3D view textures) are bitmaps
 * rendered on demand without storing the card's HTML (report:
 * `docs/archive/agent-reports/AGENT-rr-card-bitmap.md`; semantics:
 * `docs/semantics/mechanism/asset-service.md` "Single-card image without task queue",
 * `docs/semantics/glossary.md` "Snapshot").
 *
 *   node scripts/probes/card-bitmap-probe.mjs --port 26900 --save <dir>      Run before changes: save images for each case
 *   node scripts/probes/card-bitmap-probe.mjs --port 26900 --compare <dir>   Run after changes: pixel-compare with saved images and verify disk writes
 *   node scripts/probes/card-bitmap-probe.mjs --port 26900                    No image comparison, only verify disk writes and cache hits
 *   node scripts/probes/card-bitmap-probe.mjs --port 26900 --make-fixture     Regenerate fixture project (rarely needed)
 *
 * Spawns its own editor dev server (`--port`, stage takes +1 and +2; with PROMPTCUT_NO_PORT_FILE=1;
 * prerender process requests its own port from OS); export dir, data dir, output dir, and card
 * overlay layer all reside in a new temp dir; spawns a counting "remote asset service" on
 * `--port + 5` acting as the one connected to the shared project.
 * Fixture project `card-bitmap-probe.project.json`: four cards each occupy one track, all 0-4s:
 * blur-text (DOM card), punch-pill (Motion spring, DOM card), particles (canvas card), rs-bar-race
 * (user card, source from `server/test/fixtures/remotion-style/rs-bar-race.tsx`, created into
 * temporary overlay layer via `POST /api/cards/create`).
 *
 * Part 1 (without opening editor page, to prevent page's own prerendering from writing to frame
 * store, confusing who wrote what):
 *   A1 `bake_card` (`POST /api/vision/bake`, dedicated Agent instance of prerender process):
 *      request one for each of the four cards, returns `/api/asset/px/<sha256>`, fetched as PNG,
 *      hash matches address, dimensions, hint / note, and transparency ratio are all present;
 *   A2 Idle texture prefetch path for 3D view (`POST <prerender>/api/vision/bake-batch`, without
 *      priority = tail of normal prerender queue; with priority = jump queue);
 *   A3 3D view foreground path (`POST /api/ui-render/bake-batch`, editor process hot standby
 *      renderer);
 *   A4 Request the same input again: `cached: true`, same address;
 *   A5 Disk writes: frame store (`<export-dir>/frame-library`) has no newly written HTML
 *      (`html-manifest.json`, `html-cache/`, `snapshots.base64`, `*.html*`), and no entry directory
 *      created for these single-card projects; local asset service output dir only has newly
 *      written PNGs under `px`, nothing under `snap`; counting remote asset service only received
 *      PNGs for `px` (each pushed successfully), received no `snap`; each entry in index
 *      `bake-index/<key>.json` points to a PNG;
 *   A6 (`--compare`) Pixel-by-pixel comparison of each case against pre-change saved images:
 *      width and height match, 0 differing pixels.
 * Part 2 (with editor page open):
 *   B1 Load fixture project, move playhead to 2s, switch to 3D tab: textures appear for all four
 *      boards (in `bake-batch` response received by page, all four cards have px addresses, page
 *      successfully loads each address as image, width and height match card boxes);
 *   B2 (`--compare`) Pixel-by-pixel comparison of these textures by "clip + timestamp" against
 *      pre-change images.
 * During `--save`, A5 is only recorded without assertion (pre-change originally wrote HTML),
 * remainder asserted as usual.
 *
 * On exit, only stop self-spawned processes (editor process tree, counting service, probe's headless
 * Chrome); `--keep` leaves them running and does not delete the temp directory.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR, and set PROMPTCUT_NO_PORT_FILE=1
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const PORT = Number(argOf('--port') ?? 26900);
const KEEP = args.includes('--keep');
const MAKE_FIXTURE = args.includes('--make-fixture');
const SAVE_DIR = argOf('--save') ? path.resolve(argOf('--save')) : null;
const COMPARE_DIR = argOf('--compare') ? path.resolve(argOf('--compare')) : null;
const REMOTE_PORT = PORT + 5;
if (!(PORT >= 20000 && PORT % 10 <= 4)) throw new Error(`--port ${PORT} is not allowed: must be at least 20000, occupies PORT to PORT+2 and PORT+5, and the last digit of PORT must be ≤ 4`);
const EDITOR = `http://127.0.0.1:${PORT}`;
const REMOTE = `http://127.0.0.1:${REMOTE_PORT}`;
const TMP = path.join(os.tmpdir(), `pc-card-bitmap-probe-${Date.now().toString(36)}`);
const EXPORT_DIR = path.join(TMP, 'export');
const DATA_DIR = path.join(TMP, 'data');
const ARTIFACT_DIR = path.join(TMP, 'artifacts');
const OVERLAY_DIR = path.join(TMP, 'card-overrides');
const INDEX_DIR = path.join(EXPORT_DIR, 'bake-index');
const LIBRARY_DIR = path.join(EXPORT_DIR, 'frame-library');
const PRERENDER_LOG = path.join(TMP, 'prerender.log');
for (const d of [EXPORT_DIR, DATA_DIR, ARTIFACT_DIR, OVERLAY_DIR]) fs.mkdirSync(d, { recursive: true });
const FIXTURE = path.join(HERE, 'card-bitmap-probe.project.json');
const USER_CARD = path.join(ROOT, 'server', 'test', 'fixtures', 'remotion-style', 'rs-bar-race.tsx');

const passes = [];
const fails = [];
const notes = [];
const check = (cond, label, extra) => {
  (cond ? passes : fails).push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 700)));
  return cond;
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isPng = (buf) => buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

async function until(label, fn, timeoutMs = 120000, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); return null; }
    await delay(everyMs);
  }
}

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

let editor = null;
const editorLog = [];
async function startEditor() {
  editor = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PROMPTCUT_EXPORT_DIR: EXPORT_DIR, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_NO_PORT_FILE: '1',
        PROMPTCUT_ARTIFACT_DIR: ARTIFACT_DIR, PROMPTCUT_CARD_OVERRIDES: OVERLAY_DIR,
        // Save a separate copy of prerender process output: push and card bitmap storage logs only appear there
        PROMPTCUT_PRERENDER_LOG: PRERENDER_LOG,
        PROMPTCUT_ASSET_URL: `${REMOTE}/api/asset`, PROMPTCUT_PUSH: '1' } });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 800) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  return until('editor process is up', async () => (await fetch(EDITOR + '/api/prerender/info').then((r) => r.ok, () => false)) || null, 180000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}

/* ---- Counting remote asset service (same as bake-asset-probe.mjs): chunked upload, reconcile, finalize, retrieve ---- */
const CHUNK = 8 * 1024 * 1024;
const remoteBlobs = new Map(); // `${ns}/${hash}` → Buffer
const remoteParts = new Map();
const remoteLog = [];
const remote = http.createServer(async (req, res) => {
  const m = /^\/api\/asset\/(media|snap|px)\/([0-9a-f]{64})(?:\/(chunks|complete|\d+))?$/.exec(String(req.url).split('?')[0]);
  const body = [];
  for await (const c of req) body.push(c);
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (!m) { remoteLog.push({ method: req.method, url: req.url }); return json(404, { ok: false }); }
  const [, ns, hash, tail] = m;
  const id = `${ns}/${hash}`;
  remoteLog.push({ method: req.method, ns, hash, tail: tail ?? null });
  if (tail === 'chunks') {
    if (remoteBlobs.has(id)) { const size = remoteBlobs.get(id).length; return json(200, { size, chunkSize: CHUNK, received: [...Array(Math.max(1, Math.ceil(size / CHUNK))).keys()], complete: true }); }
    const p = remoteParts.get(id);
    return json(200, { size: p?.size ?? null, chunkSize: CHUNK, received: p ? [...p.parts.keys()].sort((a, b) => a - b) : [], complete: false });
  }
  if (tail === 'complete') {
    if (remoteBlobs.has(id)) return json(200, { ok: true, hash, complete: true });
    const p = remoteParts.get(id);
    if (!p) return json(404, { ok: false, error: 'unknown-hash' });
    const n = Math.max(1, Math.ceil(p.size / CHUNK));
    const bytes = Buffer.concat([...Array(n).keys()].map((i) => p.parts.get(i) ?? Buffer.alloc(0)));
    if (bytes.length !== p.size) return json(400, { ok: false, error: 'incomplete' });
    if (sha256(bytes) !== hash) { remoteParts.delete(id); return json(409, { ok: false, error: 'hash-mismatch' }); }
    remoteBlobs.set(id, bytes);
    remoteParts.delete(id);
    return json(200, { ok: true, hash, size: bytes.length, complete: true });
  }
  if (tail !== undefined) {
    if (req.method !== 'PUT') return json(405, { ok: false });
    const p = remoteParts.get(id) ?? { size: Number(req.headers['x-media-size']), parts: new Map() };
    p.parts.set(Number(tail), Buffer.concat(body));
    remoteParts.set(id, p);
    return json(200, { ok: true, hash, n: Number(tail) });
  }
  const blob = remoteBlobs.get(id);
  if (!blob) return json(404, { ok: false, error: 'not-found' });
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': blob.length });
  res.end(req.method === 'HEAD' ? undefined : blob);
});

/** Files recursively listed in directory (relative paths, forward slashes) */
function walk(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base)); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
/**
 * HTML-related files in frame store: whole-scene or single-card snapshot files, overflow dir,
 * old full bundles, any .html / .html.gz.
 */
const HTML_FILE = /(^|\/)(html-manifest\.json|snapshots\.base64)$|(^|\/)html-cache\/|\.html(\.gz)?$|(^|\/)snapshots?\//i;
const indexEntries = () => (fs.existsSync(INDEX_DIR) ? fs.readdirSync(INDEX_DIR) : [])
  .filter((n) => /^[0-9a-f]{12}\.json$/.test(n))
  .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(INDEX_DIR, n), 'utf8')); } catch { return null; } })
  .filter(Boolean);

async function post(url, payload, timeoutMs = 300000) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}
const getBytes = async (url) => { const r = await fetch(url); return { status: r.status, type: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) }; };

/** Compare two PNGs pixel by pixel. Returns { same, width, height, diffPixels, maxDelta } */
function comparePng(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return { same: false, size: [pa.width, pa.height, pb.width, pb.height] };
  let diffPixels = 0, maxDelta = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    const d = Math.max(Math.abs(pa.data[i] - pb.data[i]), Math.abs(pa.data[i + 1] - pb.data[i + 1]), Math.abs(pa.data[i + 2] - pb.data[i + 2]), Math.abs(pa.data[i + 3] - pb.data[i + 3]));
    if (d) { diffPixels++; if (d > maxDelta) maxDelta = d; }
  }
  return { same: diffPixels === 0, width: pa.width, height: pa.height, diffPixels, maxDelta, bytesEqual: a.equals(b) };
}

/** Test case images: name → { bytes, meta }. `--save` writes to disk, `--compare` compares */
const images = new Map();
const compared = [];
function record(name, bytes, meta = {}) {
  images.set(name, { bytes, meta });
  if (SAVE_DIR) fs.writeFileSync(path.join(SAVE_DIR, `${name}.png`), bytes);
  if (COMPARE_DIR) {
    const file = path.join(COMPARE_DIR, `${name}.png`);
    if (!fs.existsSync(file)) { notes.push(`${name} was not saved before the change, so this one was not compared`); return; }
    const r = comparePng(fs.readFileSync(file), bytes);
    compared.push({ name, ...r });
    check(r.same, `Pixel-identical to before the change: ${name}`, r);
  }
}
const safe = (s) => String(s).replace(/[^\w.-]/g, '_');

let browser = null;
const out = { port: PORT, remote: REMOTE, tmp: TMP, mode: SAVE_DIR ? 'save' : COMPARE_DIR ? 'compare' : 'check' };
if (SAVE_DIR) fs.mkdirSync(SAVE_DIR, { recursive: true });
try {
  await new Promise((resolve, reject) => { remote.once('error', reject); remote.listen(REMOTE_PORT, '127.0.0.1', resolve); });
  if (!(await startEditor())) throw new Error('The editor process did not start');
  const prerender = await until('prerender process is up', async () => {
    const info = await fetch(EDITOR + '/api/prerender/info').then((r) => r.json());
    return info?.ready && info.url ? info : null;
  }, 180000, 500);
  out.prerender = prerender?.url ?? null;
  const PRE = String(prerender?.url || EDITOR).replace(/\/+$/, '');

  // User card fixture: written into temporary overlay layer via real card creation API
  const created = await post(`${EDITOR}/api/cards/create`, { id: 'rs-bar-race', source: fs.readFileSync(USER_CARD, 'utf8'), projectId: 'card-bitmap-probe' });
  check(created.status === 200 && created.ok === true, 'User card fixture rs-bar-race created in the temporary overlay layer', { status: created.status, error: created.error, errors: created.errors });

  const launch = () => puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run'] });
  const openEditorPage = async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    await page.goto(EDITOR + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(async () => { const m = await import('/src/store/project.ts'); return !!m.getState().project; }, { timeout: 180000, polling: 500 });
    return page;
  };

  if (MAKE_FIXTURE) {
    browser = await launch();
    const page = await openEditorPage();
    const made = await page.evaluate(async () => {
      const m = await import('/src/store/project.ts');
      m.actions.newProject('card-bitmap-probe');
      for (const cardId of ['blur-text', 'punch-pill', 'particles']) m.actions.addClipOnNewTrack({ cardId, start: 0, duration: 4 });
      return JSON.parse(JSON.stringify(m.getState().project));
    });
    // Fixed id, input is verbatim identical across both runs; user card section is handwritten
    // from card defaults (page's card table may not have it yet)
    made.id = 'card-bitmap-probe';
    const names = { 'blur-text': 'blur', 'punch-pill': 'pill', particles: 'particles' };
    made.tracks = made.tracks.filter((tr) => tr.clips?.length === 1 && names[tr.clips[0].cardId]);
    if (made.tracks.length !== 3) throw new Error(`The fixture project should have three tracks, got ${made.tracks.length}`);
    for (const tr of made.tracks) { const n = names[tr.clips[0].cardId]; tr.id = `t-${n}`; tr.clips[0].id = `c-${n}`; }
    made.tracks.push({ id: 't-user', name: `Track ${made.tracks.length + 1}`, clips: [{ id: 'c-user', cardId: 'rs-bar-race', start: 0, end: 4, params: { count: 14, seed: 7, accent: '#ffffff' } }] });
    made.duration = Math.max(Number(made.duration) || 0, 4);
    fs.writeFileSync(FIXTURE, JSON.stringify(made, null, 2) + '\n');
    console.log(`Fixture project written to ${FIXTURE}`);
    throw Object.assign(new Error('made'), { made: true });
  }

  const project = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const CLIP = { blur: 'c-blur', pill: 'c-pill', particles: 'c-particles', user: 'c-user' };
  const libraryBefore = new Set(walk(LIBRARY_DIR));
  const artifactsBefore = new Set(walk(ARTIFACT_DIR));
  const ourHashes = new Set();
  /** Fetch a px address, verify it is a PNG with matching hash, record as test case image */
  const take = async (name, item, label) => {
    const okUrl = /^\/api\/asset\/px\/[0-9a-f]{64}$/.test(item?.url || '');
    if (!check(okUrl, `${label}: returns /api/asset/px/<sha256>`, item)) return null;
    const hash = item.url.split('/').pop();
    ourHashes.add(hash);
    const got = await getBytes(EDITOR + item.url);
    check(got.status === 200 && got.type === 'image/png' && isPng(got.bytes) && sha256(got.bytes) === hash, `${label}: the fetched file is a PNG and its sha256 matches the address`, { status: got.status, type: got.type, bytes: got.bytes.length });
    if (!isPng(got.bytes)) return null;
    const png = PNG.sync.read(got.bytes);
    check(png.width === item.width && png.height === item.height, `${label}: the image's width and height match the returned width / height`, { png: [png.width, png.height], said: [item.width, item.height] });
    record(name, got.bytes, { width: png.width, height: png.height });
    return { hash, bytes: got.bytes, width: png.width, height: png.height };
  };

  /* ---- A1 bake_card: four cards ---- */
  const BAKES = [
    { name: 'bake-blur', clipId: CLIP.blur, t: 2, size: 512, bg: '#0b0f17' },
    { name: 'bake-pill', clipId: CLIP.pill, t: 0.2, size: 512 }, // Transparent background; spring is still moving at 0.2s
    { name: 'bake-particles', clipId: CLIP.particles, t: 1.5, size: 512, bg: '#101418' },
    { name: 'bake-user', clipId: CLIP.user, t: 1, size: 768 },
  ];
  out.a1 = [];
  for (const b of BAKES) {
    const t0 = Date.now();
    const r = await post(`${EDITOR}/api/vision/bake`, { project, clipId: b.clipId, t: b.t, size: b.size, bg: b.bg });
    out.a1.push({ name: b.name, ok: r.ok, url: r.url, width: r.width, height: r.height, cached: r.cached, transparentRatio: r.transparentRatio, error: r.error, ms: Date.now() - t0 });
    if (!check(r.ok === true, `A1 ${b.name}: bake_card succeeded`, { status: r.status, error: r.error })) continue;
    check(r.clipId === b.clipId && r.t === b.t && r.width === b.size && r.height === b.size && r.cached === false
      && typeof r.bytes === 'number' && typeof r.transparentRatio === 'number' && typeof r.hint === 'string' && /texture/.test(r.hint) && typeof r.note === 'string' && /PNG snapshot/.test(r.note),
      `A1 ${b.name}: all returned fields present (clipId, t, square size, bytes, transparentRatio, hint, note)`, { ...r, hint: undefined, note: undefined });
    check(b.bg ? /opaque texture/.test(r.hint) : /transparent-background texture/.test(r.hint), `A1 ${b.name}: the description text follows bg`, r.hint);
    check(r.transparentRatio < 1, `A1 ${b.name}: the image is not empty`, r.transparentRatio);
    await take(b.name, r, `A1 ${b.name}`);
  }

  /* ---- A2 3D view texture prefetch path (prerender process; tail of normal prerender queue / jump queue) ---- */
  const idle = await post(`${PRE}/api/vision/bake-batch`, { project, clips: [{ clipId: CLIP.blur, t: 1 }, { clipId: CLIP.blur, t: 3 }, { clipId: CLIP.particles, t: 1 }], size: 1024 });
  out.a2idle = { ok: idle.ok, baked: idle.baked?.map((x) => ({ clipId: x.clipId, t: x.t, url: x.url, width: x.width, height: x.height, cached: x.cached })), failed: idle.failed, error: idle.error };
  check(idle.ok && idle.baked?.length === 3 && !(idle.failed || []).length, 'A2 texture prefetch (back of queue): all three rendered', out.a2idle);
  for (const x of idle.baked || []) await take(`batch-idle-${safe(x.clipId)}-${x.t}`, x, `A2 prefetch ${x.clipId}@${x.t}`);
  const front = await post(`${PRE}/api/vision/bake-batch`, { project, clips: [{ clipId: CLIP.pill, t: 0.3 }, { clipId: CLIP.user, t: 2 }], size: 1024, priority: 1 });
  out.a2front = { ok: front.ok, baked: front.baked?.map((x) => ({ clipId: x.clipId, t: x.t, url: x.url, width: x.width, height: x.height, cached: x.cached })), failed: front.failed, error: front.error };
  check(front.ok && front.baked?.length === 2 && !(front.failed || []).length, 'A2 texture prefetch (front of queue): both rendered', out.a2front);
  for (const x of front.baked || []) await take(`batch-front-${safe(x.clipId)}-${x.t}`, x, `A2 front of queue ${x.clipId}@${x.t}`);
  check([...(idle.baked || []), ...(front.baked || [])].every((x) => x.width === project.width && x.height === project.height), 'A2 textures come out at the card\'s frame (the project aspect ratio when there is no frame), with no loss of sharpness', { want: [project.width, project.height] });

  /* ---- A3 3D view foreground path (editor process hot standby renderer) ---- */
  const ui = await post(`${EDITOR}/api/ui-render/bake-batch`, { project, clips: [{ clipId: CLIP.blur, t: 2.5 }, { clipId: CLIP.particles, t: 2.5 }], size: 1024, priority: 1 });
  out.a3 = { ok: ui.ok, baked: ui.baked?.map((x) => ({ clipId: x.clipId, t: x.t, url: x.url, width: x.width, height: x.height, cached: x.cached })), failed: ui.failed, error: ui.error };
  check(ui.ok && ui.baked?.length === 2 && !(ui.failed || []).length, 'A3 hot-standby renderer: both rendered', out.a3);
  for (const x of ui.baked || []) await take(`ui-${safe(x.clipId)}-${x.t}`, x, `A3 hot standby ${x.clipId}@${x.t}`);

  /* ---- A4 Request same input again: cache hit ---- */
  const again = await post(`${EDITOR}/api/vision/bake`, { project, clipId: BAKES[0].clipId, t: BAKES[0].t, size: BAKES[0].size, bg: BAKES[0].bg });
  check(again.ok && again.cached === true && again.url === out.a1[0].url, 'A4 bake_card with the same input again: cached, same address', { cached: again.cached, url: again.url });
  const againBatch = await post(`${PRE}/api/vision/bake-batch`, { project, clips: [{ clipId: CLIP.blur, t: 1 }, { clipId: CLIP.blur, t: 3 }], size: 1024 });
  check(againBatch.ok && againBatch.baked?.length === 2 && againBatch.baked.every((x, i) => x.cached === true && x.url === idle.baked?.[i]?.url), 'A4 texture prefetch with the same input again: cached, same address', againBatch.baked?.map((x) => ({ t: x.t, cached: x.cached })));
  const status = await post(`${PRE}/api/vision/bake-status`, { project, clips: [{ clipId: CLIP.blur, t: 2.5 }], size: 1024 });
  check(status.ok && status.items?.[0]?.url === ui.baked?.[0]?.url, 'A4 the texture rendered by the hot-standby renderer counts as rendered in the inventory (both processes share the index)', status.items?.[0]);

  /* ---- A5 Disk writes: only bitmaps, no HTML ---- */
  const allPushed = () => [...ourHashes].every((h) => remoteBlobs.has(`px/${h}`));
  for (const deadline = Date.now() + 20000; !allPushed() && Date.now() < deadline;) await delay(250);
  if (!allPushed()) {
    // Prerender process push targets are registered asynchronously after startup (only upon connecting
    // to document service); bitmaps stored before registration are not pushed then, "pushed on next hit"
    // (`bake-store.mjs`).
    // Under heavy load, the first batch may precede registration: request each once more here (hit),
    // then wait
    notes.push(`${[...ourHashes].filter((h) => !remoteBlobs.has(`px/${h}`)).length} bitmaps were not pushed to the remote in the first round (the push target registered late); request each once more, then wait`);
    for (const b of BAKES) await post(`${EDITOR}/api/vision/bake`, { project, clipId: b.clipId, t: b.t, size: b.size, bg: b.bg });
    await post(`${PRE}/api/vision/bake-batch`, { project, clips: [{ clipId: CLIP.blur, t: 1 }, { clipId: CLIP.blur, t: 3 }, { clipId: CLIP.particles, t: 1 }], size: 1024 });
    await post(`${PRE}/api/vision/bake-batch`, { project, clips: [{ clipId: CLIP.pill, t: 0.3 }, { clipId: CLIP.user, t: 2 }], size: 1024, priority: 1 });
    await until('Remote asset service received all of these', async () => allPushed(), 60000, 250);
  }
  await delay(1500); // Frame store archiving is written to disk asynchronously; wait for write to finish before listing
  const libraryNew = walk(LIBRARY_DIR).filter((f) => !libraryBefore.has(f));
  const libraryHtml = libraryNew.filter((f) => HTML_FILE.test(f));
  const libraryEntries = [...new Set(libraryNew.map((f) => f.split('/')[0]).filter((d) => /^[0-9a-f]{16,}$/.test(d)))];
  const artifactsNew = walk(ARTIFACT_DIR).filter((f) => !artifactsBefore.has(f));
  const snapNew = artifactsNew.filter((f) => f.startsWith('snap/'));
  const pxNew = artifactsNew.filter((f) => f.startsWith('px/'));
  const pxNotPng = pxNew.filter((f) => { const st = fs.statSync(path.join(ARTIFACT_DIR, f)); if (st.size < 8) return false; const fd = fs.openSync(path.join(ARTIFACT_DIR, f), 'r'); const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd); return /^[0-9a-f]{64}/.test(path.basename(f)) && !isPng(head); });
  const remoteSnap = remoteLog.filter((e) => e.ns === 'snap' && e.method !== 'GET' && e.method !== 'HEAD' && e.tail !== 'chunks');
  const remotePxNotPng = [...remoteBlobs].filter(([id, bytes]) => id.startsWith('px/') && !isPng(bytes)).map(([id]) => id);
  const entries = indexEntries();
  out.a5 = { libraryNew: libraryNew.length, libraryNewSample: libraryNew.slice(0, 12), libraryHtml: libraryHtml.slice(0, 12), libraryEntries, artifactsNew: artifactsNew.length, pxNew: pxNew.length, snapNew: snapNew.slice(0, 8),
    remotePx: [...remoteBlobs.keys()].filter((id) => id.startsWith('px/')).length, remoteSnap: remoteSnap.length, indexEntries: entries.length, ourHashes: ourHashes.size };
  const storage = (cond, label, extra) => (SAVE_DIR ? (notes.push(`(before the change, record only) ${label}: ${cond ? 'holds' : 'does not hold'}${extra === undefined ? '' : ' ' + JSON.stringify(extra).slice(0, 300)}`), cond) : check(cond, label, extra));
  storage(libraryHtml.length === 0, 'A5 No newly written HTML in the frame store (html-manifest.json / html-cache / snapshots / *.html)', libraryHtml.slice(0, 8));
  storage(libraryEntries.length === 0, 'A5 No newly created entry directories in the frame store for these single-card projects', libraryEntries.slice(0, 8));
  storage(snapNew.length === 0 && pxNotPng.length === 0, 'A5 The only new files in the local asset service\'s output directory are PNGs under px, nothing under snap', { snapNew: snapNew.slice(0, 6), pxNotPng });
  storage(remoteSnap.length === 0 && remotePxNotPng.length === 0, 'A5 The remote asset service received only PNGs under px, nothing under snap', { remoteSnap: remoteSnap.slice(0, 6), remotePxNotPng });
  check([...ourHashes].every((h) => remoteBlobs.has(`px/${h}`)), 'A5 Every bitmap was pushed to the connected remote asset service', { want: ourHashes.size, got: [...ourHashes].filter((h) => remoteBlobs.has(`px/${h}`)).length });
  check(entries.length >= ourHashes.size - 1 && entries.every((e) => /^[0-9a-f]{64}$/.test(e.hash)) && [...ourHashes].every((h) => entries.some((e) => e.hash === h)), 'A5 Every bitmap in the bake-index records "input hash → content hash"', { entries: entries.length });

  /* ---- B 3D view open: textures appear ---- */
  browser = await launch();
  const page = await openEditorPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const seen = []; // Each image in the bake-batch response received by the page
  page.on('response', async (res) => {
    if (!/\/api\/(ui-render|vision)\/bake-batch$/.test(new URL(res.url()).pathname) || res.request().method() !== 'POST') return;
    try {
      const data = await res.json();
      const route = /ui-render/.test(res.url()) ? 'ui' : 'prefetch';
      for (const b of data.baked || []) seen.push({ route, clipId: b.clipId, t: b.t, url: b.url, width: b.width, height: b.height, cached: b.cached });
    } catch { /* Aborted requests have no body */ }
  });
  await page.evaluate(async (project) => {
    const m = await import('/src/store/project.ts');
    m.actions.loadProject(project);
    m.actions.seek(2);
  }, project);
  await page.evaluate(() => { [...document.querySelectorAll('[data-pc="preview-tabs"] button')].find((b) => b.textContent === '3D').click(); });
  await page.waitForSelector('.pc-3d-checker canvas', { timeout: 60000 });
  const cardClips = Object.values(CLIP);
  // Wait timeout is only to prevent hangs (warm-standby renderer takes 1-2 minutes per image
  // when the machine is busy); record elapsed time, not used as a pass condition
  const b1Started = Date.now();
  const allSeen = await until('Textures for all four boards in the 3D view arrived', async () => cardClips.every((id) => seen.some((s) => s.clipId === id && /^\/api\/asset\/px\//.test(s.url || ''))) || null, 600000, 500);
  const b1Ms = Date.now() - b1Started;
  await delay(4000); // Let idle prefetch run a few more rounds to collect a few more images (compare however many are received)
  out.b1 = { ms: b1Ms, seen: seen.length, byRoute: { ui: seen.filter((s) => s.route === 'ui').length, prefetch: seen.filter((s) => s.route === 'prefetch').length }, clips: cardClips.map((id) => ({ id, got: seen.filter((s) => s.clipId === id).length })) };
  check(!!allSeen, 'B1 3D view open: textures for all four cards came out (the page received px addresses)', out.b1);
  const uniq = new Map();
  for (const s of seen) if (s.url && !uniq.has(`${s.clipId}@${s.t}`)) uniq.set(`${s.clipId}@${s.t}`, s);
  const loaded = await page.evaluate(async (urls) => Promise.all(urls.map((url) => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.onerror = () => resolve(null); img.src = url; }))), [...uniq.values()].map((s) => s.url));
  check(loaded.length > 0 && loaded.every((sz) => Array.isArray(sz) && sz[0] === project.width && sz[1] === project.height), 'B1 The page can load every texture as an image, and its width and height equal the card\'s frame', { loaded: loaded.slice(0, 6), want: [project.width, project.height] });
  for (const [key, s] of uniq) {
    const got = await getBytes(EDITOR + s.url);
    if (check(got.status === 200 && isPng(got.bytes), `B1 texture ${key} fetched back is a PNG`, { status: got.status })) record(`view3d-${safe(key)}`, got.bytes);
  }
  out.b1.moments = [...uniq.keys()];
  const shot = path.join(SAVE_DIR || COMPARE_DIR || TMP, COMPARE_DIR ? 'view3d-after.png' : 'view3d.png');
  await page.screenshot({ path: shot });
  out.b1.screenshot = shot;
  check(pageErrors.length === 0, 'Page has no uncaught errors', pageErrors.slice(0, 5));
  if (SAVE_DIR) fs.writeFileSync(path.join(SAVE_DIR, 'manifest.json'), JSON.stringify(Object.fromEntries([...images].map(([name, v]) => [name, { sha256: sha256(v.bytes), bytes: v.bytes.length, ...v.meta }])), null, 2));
  if (COMPARE_DIR) {
    out.compared = { total: compared.length, same: compared.filter((c) => c.same).length, bytesEqual: compared.filter((c) => c.bytesEqual).length, different: compared.filter((c) => !c.same) };
    check(compared.length >= BAKES.length + 7, 'Pixel-by-pixel comparison covered every case of bake_card, the two prefetch paths and the hot-standby renderer', { compared: compared.length });
  }
} catch (e) {
  if (!e?.made) fails.push('Probe exception:' + (e?.stack || e));
} finally {
  out.editorLogTail = editorLog.join('').split(/\r?\n/).filter((l) => /error|bake-store/i.test(l)).slice(-20);
  try { out.prerenderLog = fs.readFileSync(PRERENDER_LOG, 'utf8').split(/\r?\n/).filter((l) => /\[bake-store\] bake\.(push-failed|stale)|\[artifact-push\] push\.|render timeout/.test(l)).map((l) => l.slice(0, 260)).slice(0, 40); } catch { out.prerenderLog = null; }
  if (!KEEP) {
    try { await browser?.close(); } catch { /* Closed */ }
    stopEditor();
    remote.closeAllConnections?.();
    remote.close();
    await delay(800);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Process just exited, keep it */ }
  }
}

out.notes = notes;
out.passes = passes;
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
console.log(`\nPassed ${passes.length}, failed ${fails.length}`);
process.exit(fails.length ? 1 : 0);
