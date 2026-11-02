/**
 * End-to-end probe for card snapshot access via asset service in `bake_card` (report
 * `docs/archive/agent-reports/AGENT-bake-asset.md`; semantics
 * `docs/semantics/product/asset-service.md` "Prerender outputs", "Responsibilities";
 * `product/agent.md` "Assets and outputs").
 *
 *   node scripts/probes/bake-asset-probe.mjs [--port 5970] [--keep]
 *
 * Spawns its own editor dev server (`--port`, defaults to 5970; stage additionally occupies +1 and
 * +2; with PROMPTCUT_NO_PORT_FILE=1); outputs and assets are stored in a newly created temporary
 * directory (including `PROMPTCUT_ARTIFACT_DIR`: local storage for px / snap; otherwise defaults to
 * `out/asset-store/` in the repository, where chunks for P7 would already exist locally on
 * subsequent runs); then starts a counting "remote asset service" on `--port + 5` (in-memory
 * implementation of chunked uploads, reconciliation, finalization, and retrieval, accepting all
 * three namespaces), acting as the instance connected to the shared project: editor starts with
 * `PROMPTCUT_ASSET_URL=<it>` and `PROMPTCUT_PUSH=1`, where the prerender process push queue and the
 * editor process upload target both point to it (card snapshots are written to the local asset
 * service and then pushed as another copy).
 *
 *   P1 bake_card (prerender process, `/api/vision/bake`): returns `/api/asset/px/<sha256>`;
 *      retrieved via the editor, it is a PNG whose sha256 matches the address; index
 *      `<export dir>/bake-index/<key>.json` records this content hash; asset catalog contains no
 *      `bake-*.png`; counting remote asset service received chunk uploads and finalization for this
 *      chunk, and bytes retrieved from it are identical (written and read back via API);
 *   P2 Request again with identical parameters: cached, same address, no re-render;
 *   P3 3D view path (hot-standby renderer in editor process, `/api/ui-render/bake-batch`): returns
 *      px address, remote also received it; page successfully loads it as an image;
 *   P4 Prefetch path (bake-status / bake-batch / bake-evict sent from page to prerender process):
 *      batch-renders two timestamps -> inventory reports bytes and addresses; evict a key ->
 *      absent from inventory, but that chunk's bytes remain retrievable from the asset service;
 *   P5 Legacy address: place an old-format `bake-<clip>-<key>.png` (left from an earlier version)
 *      in the asset catalog; `/@media/<name>` retrievable as usual; requesting the same key again
 *      does not re-render, migrated into px via asset service (content hash is that of the old
 *      file), old file remains;
 *   P6 Texture: fill scene-3d texture with P1's px address; rendering with the export renderer
 *      differs from untextured (prerender process fetched texture via asset service);
 *   P7 Another member of the shared project: a PNG existing only on the remote asset service; after
 *      editor connects to remote (`POST /api/media/remote`), page successfully loads it via
 *      `/api/asset/px/<hash>`, and remote was requested for this chunk.
 *   (Clear error returned when asset service is unreachable, covered by unit test BKA-4: the
 *   editor process is itself the local asset service, so the probe cannot disconnect it.)
 *
 * On exit, only stops processes it started (editor process tree, counting service, probe's
 * puppeteer Chrome); `--keep` leaves them running and does not delete temporary directory.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR, and set PROMPTCUT_NO_PORT_FILE=1
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 5970);
const KEEP = args.includes('--keep');
const REMOTE_PORT = PORT + 5;
const clashes = (p) => (p >= 5190 && p <= 5192) || (p >= 5580 && p <= 5599);
if (!(PORT >= 1024 && PORT % 10 <= 4) || [PORT, PORT + 1, PORT + 2, REMOTE_PORT].some(clashes)) {
  throw new Error(`--port ${PORT} is not allowed: it uses PORT~PORT+2 and PORT+5, which must fall within the same block of 10 ports (PORT's last digit ≤ 4), and must not touch 5190~5192 or 5580~5599`);
}
const EDITOR = `http://127.0.0.1:${PORT}`;
const REMOTE = `http://127.0.0.1:${REMOTE_PORT}`;
const EXPORT_DIR = path.join(os.tmpdir(), `pc-bake-asset-probe-${Date.now().toString(36)}`);
const DATA_DIR = path.join(EXPORT_DIR, 'data');
const MEDIA_DIR = path.join(EXPORT_DIR, 'media');
const INDEX_DIR = path.join(EXPORT_DIR, 'bake-index');
const ARTIFACT_DIR = path.join(EXPORT_DIR, 'artifacts');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const passes = [];
const fails = [];
const check = (cond, label, extra) => {
  (cond ? passes : fails).push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600)));
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

/** A w×h solid-color PNG (RGBA), assembled directly without ffmpeg */
function makePng(w, h, [r, g, b, a = 255]) {
  const crc = (buf) => { const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(buf) >>> 0); return c; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); return Buffer.concat([len, td, crc(td)]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 4);
  for (let x = 0; x < w; x++) row.set([r, g, b, a], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
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
        // Local storage directory for outputs (px / snap) also resides in temporary directory: defaults to
        // `<repo>/out/asset-store/`, where chunks from previous runs persist across runs; the "remote-only"
        // PNG for P7 (fixed content, fixed hash) would already exist locally on subsequent runs, no longer
        // fetching from remote, so "remote was requested for this chunk" would definitely fail
        PROMPTCUT_ARTIFACT_DIR: ARTIFACT_DIR,
        // Asset service connected to the shared project: prerender process push queue (J.12 must be
        // explicitly enabled) and editor process upload target both point to the counting instance
        PROMPTCUT_ASSET_URL: `${REMOTE}/api/asset`, PROMPTCUT_PUSH: '1' } });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 600) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  return until('editor process is up', async () => (await fetch(EDITOR + '/api/prerender/info').then((r) => r.ok, () => false)) || null, 120000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}

/* ---- Counting remote asset service: <ns>/<hash>/chunks, PUT <ns>/<hash>/<n>, POST <ns>/<hash>/complete, GET/HEAD <ns>/<hash> ---- */
const CHUNK = 8 * 1024 * 1024;
const remoteBlobs = new Map(); // `${ns}/${hash}` → { bytes, type }
const remoteParts = new Map(); // `${ns}/${hash}` → { size, ext, parts: Map<n, Buffer> }
const remoteLog = [];
const TYPES = { png: 'image/png', html: 'text/html; charset=utf-8', mp4: 'video/mp4', m4s: 'video/iso.segment', webp: 'image/webp' };
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
    if (remoteBlobs.has(id)) { const n = Math.max(1, Math.ceil(remoteBlobs.get(id).bytes.length / CHUNK)); return json(200, { size: remoteBlobs.get(id).bytes.length, chunkSize: CHUNK, received: [...Array(n).keys()], complete: true }); }
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
    remoteBlobs.set(id, { bytes, type: TYPES[p.ext] || 'application/octet-stream' });
    remoteParts.delete(id);
    return json(200, { ok: true, hash, size: bytes.length, complete: true });
  }
  if (tail !== undefined) {
    if (req.method !== 'PUT') return json(405, { ok: false });
    const size = Number(req.headers['x-media-size']);
    const p = remoteParts.get(id) ?? { size, ext: String(req.headers['x-media-ext'] || ''), parts: new Map() };
    p.parts.set(Number(tail), Buffer.concat(body));
    remoteParts.set(id, p);
    return json(200, { ok: true, hash, n: Number(tail) });
  }
  const blob = remoteBlobs.get(id);
  if (!blob) return json(404, { ok: false, error: 'not-found' });
  res.writeHead(200, { 'Content-Type': blob.type, 'Content-Length': blob.bytes.length });
  res.end(req.method === 'HEAD' ? undefined : blob.bytes);
});
const remoteCount = (pred) => remoteLog.filter(pred).length;

/** File names recursively listed in the directory */
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}
const indexEntries = () => (fs.existsSync(INDEX_DIR) ? fs.readdirSync(INDEX_DIR) : [])
  .filter((n) => /^[0-9a-f]{12}\.json$/.test(n))
  .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(INDEX_DIR, n), 'utf8')); } catch { return null; } })
  .filter(Boolean);

async function post(url, payload, timeoutMs = 240000) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}
const getBytes = async (url) => { const r = await fetch(url); return { status: r.status, type: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) }; };

let browser = null;
const out = { port: PORT, remote: REMOTE, exportDir: EXPORT_DIR };
try {
  await new Promise((resolve, reject) => { remote.once('error', reject); remote.listen(REMOTE_PORT, '127.0.0.1', resolve); });
  if (!(await startEditor())) throw new Error('The editor process did not start');
  const prerender = await until('prerender process is up', async () => {
    const info = await fetch(EDITOR + '/api/prerender/info').then((r) => r.json());
    return info?.ready && info.url ? info : null;
  }, 180000, 500);
  out.prerender = prerender?.url ?? null;
  const PRE = String(prerender?.url || EDITOR).replace(/\/+$/, '');

  browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(EDITOR + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => { const m = await import('/src/store/project.ts'); return !!m.getState().project; }, { timeout: 180000, polling: 500 });
  const placed = await page.evaluate(async () => {
    const m = await import('/src/store/project.ts');
    m.actions.newProject?.();
    const a = m.actions.addClipOnNewTrack({ cardId: 'blur-text', start: 0, duration: 4 });
    const b = m.actions.addClipOnNewTrack({ cardId: 'punch-pill', start: 0, duration: 4 });
    const c = m.actions.addClipOnNewTrack({ cardId: 'scene-3d', start: 0, duration: 4 });
    return { a: a?.id ?? null, b: b?.id ?? null, c: c?.id ?? null };
  });
  out.placed = placed;
  check(!!(placed.a && placed.b && placed.c), 'Three cards placed in the project (blur-text, punch-pill, scene-3d)', placed);
  const projectNow = () => page.evaluate(async () => { const m = await import('/src/store/project.ts'); return JSON.parse(JSON.stringify(m.getState().project)); });
  const project = await projectNow();
  check(fs.readdirSync(MEDIA_DIR).filter((n) => n.startsWith('bake-')).length === 0, 'No bake-*.png in the media directory at start');

  /* ---- P1 bake_card: written to px via asset service, remote received, identical when read back ---- */
  const t0 = Date.now();
  const p1 = await post(`${EDITOR}/api/vision/bake`, { project, clipId: placed.a, t: 2, size: 512, bg: '#0b0f17' });
  out.p1 = { ...p1, ms: Date.now() - t0 };
  check(p1.ok === true && /^\/api\/asset\/px\/[0-9a-f]{64}$/.test(p1.url || ''), 'P1 bake_card returns /api/asset/px/<sha256>', p1);
  const p1Hash = String(p1.url || '').split('/').pop();
  const p1Got = await getBytes(EDITOR + p1.url);
  check(p1Got.status === 200 && isPng(p1Got.bytes) && sha256(p1Got.bytes) === p1Hash, 'P1 fetched via the editor (local asset service) is a PNG, sha256 matches the address', { status: p1Got.status, type: p1Got.type, bytes: p1Got.bytes.length });
  check(p1Got.type === 'image/png', 'P1 Content-Type is image/png', p1Got.type);
  const p1Entry = indexEntries().find((e) => e.hash === p1Hash);
  check(!!p1Entry && p1Entry.clipId === placed.a, 'P1 index bake-index/<key>.json records this content hash', indexEntries());
  check(walk(MEDIA_DIR).filter((f) => /[\\/]bake-[^\\/]*$/.test(f)).length === 0, 'P1 no bake-*.png in the media directory (no longer written directly to the media directory)', walk(MEDIA_DIR).map((f) => path.basename(f)));
  const p1Pushed = await until('P1 remote received this chunk', async () => remoteBlobs.has(`px/${p1Hash}`), 30000, 250);
  check(!!p1Pushed, 'P1 counting remote asset service received this chunk in full (pushed via the API)', { puts: remoteCount((e) => e.ns === 'px' && e.hash === p1Hash && /^\d+$/.test(e.tail ?? '')), completes: remoteCount((e) => e.ns === 'px' && e.hash === p1Hash && e.tail === 'complete') });
  check(remoteCount((e) => e.ns === 'px' && e.hash === p1Hash && /^\d+$/.test(e.tail ?? '')) >= 1 && remoteCount((e) => e.ns === 'px' && e.hash === p1Hash && e.tail === 'complete') >= 1, 'P1 remote was asked for this chunk\'s parts and completion');
  const p1Remote = await getBytes(`${REMOTE}/api/asset/px/${p1Hash}`);
  check(p1Remote.status === 200 && p1Remote.bytes.equals(p1Got.bytes), 'P1 bytes read back from the remote asset service are identical');
  out.pushLog = editorLog.join('').split(/\r?\n/).filter((l) => /\[artifact-push\] push\.(started|skip|asset-base)|\[bake-store\]/.test(l)).slice(0, 12);

  /* ---- P2 Request again: hit ---- */
  const t2 = Date.now();
  const p2 = await post(`${EDITOR}/api/vision/bake`, { project, clipId: placed.a, t: 2, size: 512, bg: '#0b0f17' });
  out.p2 = { cached: p2.cached, url: p2.url, ms: Date.now() - t2 };
  check(p2.ok === true && p2.cached === true && p2.url === p1.url, 'P2 same parameters requested again: cached, same address', out.p2);

  /* ---- P3 3D view path (editor process) ---- */
  const p3 = await page.evaluate(async ({ project, clipId }) => {
    const res = await fetch('/api/ui-render/bake-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, clips: [{ clipId, t: 2 }], size: 1024, priority: 1 }) });
    const data = await res.json();
    const url = data.baked?.[0]?.url;
    const size = url ? await new Promise((resolve) => { const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.onerror = () => resolve(null); img.src = url; }) : null;
    return { ok: data.ok, url, size, failed: data.failed };
  }, { project, clipId: placed.b });
  out.p3 = p3;
  check(p3.ok && /^\/api\/asset\/px\/[0-9a-f]{64}$/.test(p3.url || '') && Array.isArray(p3.size) && p3.size[0] > 0, 'P3 3D view (ui-render/bake-batch) returns a px address, the page can load this image', p3);
  const p3Hash = String(p3.url || '').split('/').pop();
  check(!!(await until('P3 remote received', async () => remoteBlobs.has(`px/${p3Hash}`), 30000, 250)), 'P3 what the editor process rendered was also pushed to the remote asset service');

  /* ---- P4 Prefetch path (sent from page to prerender process) ---- */
  const p4 = await page.evaluate(async ({ project, a, b }) => {
    const { prerenderUrl } = await import('/src/render/prerender.ts');
    const call = async (url, payload) => { const r = await fetch(await prerenderUrl(url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return r.json(); };
    const clips = [{ clipId: a, t: 1 }, { clipId: a, t: 3 }, { clipId: b, t: 2 }];
    const before = await call('/api/vision/bake-status', { project, clips, size: 1024 });
    const batch = await call('/api/vision/bake-batch', { project, clips: clips.slice(0, 2), size: 1024 });
    const after = await call('/api/vision/bake-status', { project, clips, size: 1024 });
    const loaded = [];
    for (const it of after.items || []) {
      if (!it.url) { loaded.push(null); continue; }
      loaded.push(await new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img.naturalWidth); img.onerror = () => resolve(0); img.src = it.url; }));
    }
    const victim = after.items?.[0]?.key;
    const evict = await call('/api/vision/bake-evict', { keys: [victim] });
    const final = await call('/api/vision/bake-status', { project, clips, size: 1024 });
    return { before, batch, after, loaded, victim, victimUrl: after.items?.[0]?.url, evict, final };
  }, { project, a: placed.a, b: placed.b });
  out.p4 = { before: p4.before?.items, batch: p4.batch?.baked?.map((x) => ({ t: x.t, url: x.url, cached: x.cached })), after: p4.after?.items, loaded: p4.loaded, evict: p4.evict, final: p4.final?.items, orphans: p4.after?.orphans?.length };
  check(p4.before?.ok && (p4.before.items || []).slice(0, 2).every((i) => i.bytes === null && i.url === null), 'P4 inventory: the two moments never rendered report bytes/url as empty', p4.before?.items);
  check(p4.batch?.ok && p4.batch.baked?.length === 2 && p4.batch.baked.every((x) => /^\/api\/asset\/px\//.test(x.url)), 'P4 batch render of two moments of the same card, both return px addresses', p4.batch);
  check((p4.after?.items || []).slice(0, 2).every((i, k) => typeof i.bytes === 'number' && i.url === p4.batch.baked[k]?.url), 'P4 inventory again: the two moments report bytes and address (matching what the batch returned)', p4.after?.items);
  check(p4.after?.items?.[2]?.url === p3.url, 'P4 the one rendered by the 3D view also counts as rendered in the prefetch inventory (the editor process and the prerender process share the index)', p4.after?.items?.[2]);
  check(p4.loaded.slice(0, 3).every((w) => w > 0), 'P4 page can load the image from the address the inventory returned', p4.loaded);
  check(p4.evict?.ok && p4.evict.deleted?.length === 1 && p4.evict.deleted[0] === p4.victim, 'P4 evict one key', p4.evict);
  check(p4.final?.items?.[0]?.bytes === null && typeof p4.final?.items?.[1]?.bytes === 'number', 'P4 after eviction the inventory no longer has it, the other is still there', p4.final?.items);
  check((await getBytes(EDITOR + p4.victimUrl)).status === 200, 'P4 only the index entry was evicted, the bytes can still be fetched from the asset service');

  /* ---- P5 Legacy address ---- */
  const st5 = await post(`${PRE}/api/vision/bake-status`, { project, clips: [{ clipId: placed.b, t: 1 }], size: 1024 });
  const it5 = st5.items?.[0] ?? {};
  const legacyBytes = makePng(64, 36, [200, 40, 90]);
  const legacyOk = check(/^bake-.*-[0-9a-f]{12}\.png$/.test(it5.name || '') && it5.bytes === null, 'P5 inventory gives this key\'s file name in the old format, and it is not rendered yet', it5);
  if (legacyOk) {
    fs.writeFileSync(path.join(MEDIA_DIR, it5.name), legacyBytes); // Simulates an old file left in the asset catalog by an earlier version
    const old = await getBytes(`${EDITOR}/@media/${encodeURIComponent(it5.name)}`);
    check(old.status === 200 && old.bytes.equals(legacyBytes), 'P5 old address /@media/bake-….png can still be fetched as usual', { status: old.status });
    const t5 = Date.now();
    const b5 = await post(`${PRE}/api/vision/bake-batch`, { project, clips: [{ clipId: placed.b, t: 1 }], size: 1024 });
    out.p5 = { name: it5.name, baked: b5.baked, ms: Date.now() - t5 };
    check(b5.ok && b5.baked?.[0]?.cached === true && b5.baked[0].url === `/api/asset/px/${sha256(legacyBytes)}`, 'P5 same key requested again: no re-render, migrated into px via the asset service (the content hash is the old file\'s)', out.p5);
    check(fs.existsSync(path.join(MEDIA_DIR, it5.name)), 'P5 old file is still there (not deleted)');
    const old2 = await getBytes(`${EDITOR}/@media/${encodeURIComponent(it5.name)}`);
    check(old2.status === 200, 'P5 old address can still be fetched after migration');
  }

  /* ---- P6 Texture: scene-3d texture uses px address, retrievable by export renderer ---- */
  await page.evaluate(async ({ c, url }) => { const m = await import('/src/store/project.ts'); m.actions.setClipParams(c, { texture: url, shape: 'cube' }); }, { c: placed.c, url: p1.url });
  const projCube = await projectNow();
  const cubePlain = JSON.parse(JSON.stringify(projCube));
  for (const tr of cubePlain.tracks) for (const cl of tr.clips) if (cl.id === placed.c) cl.params = { ...cl.params, texture: '' };
  const noTex = await post(`${EDITOR}/api/vision/bake`, { project: cubePlain, clipId: placed.c, t: 2, size: 512, bg: '#101010' });
  const withTex = await post(`${EDITOR}/api/vision/bake`, { project: projCube, clipId: placed.c, t: 2, size: 512, bg: '#101010' });
  out.p6 = { noTex: noTex.url, withTex: withTex.url, errors: [noTex.error, withTex.error].filter(Boolean) };
  check(noTex.ok && withTex.ok && noTex.url !== withTex.url, 'P6 scene-3d render with a px-address texture applied differs from the render without it (the renderer fetched the texture via the asset service)', out.p6);
  const texLog = editorLog.join('');
  check(!/texture[^\n]*(404|failed)/i.test(texLog), 'P6 no texture fetch errors in the log');

  /* ---- P7 Another member of the shared project: px existing only on remote ---- */
  const only = makePng(40, 30, [20, 180, 60]);
  const onlyHash = sha256(only);
  remoteBlobs.set(`px/${onlyHash}`, { bytes: only, type: 'image/png' });
  const before7 = remoteCount((e) => e.ns === 'px' && e.hash === onlyHash && e.tail === null);
  const set7 = await post(`${EDITOR}/api/media/remote`, { base: `${REMOTE}/api/asset` });
  check(set7.ok === true, 'P7 editor connects to the remote asset service', set7);
  const size7 = await page.evaluate(async (url) => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.onerror = () => resolve(null); img.src = url; }), `/api/asset/px/${onlyHash}`);
  check(Array.isArray(size7) && size7[0] === 40 && size7[1] === 30, 'P7 page loading /api/asset/px/<hash> gets the image that exists only on the remote (40×30)', size7);
  check(remoteCount((e) => e.ns === 'px' && e.hash === onlyHash && e.tail === null) > before7, 'P7 remote asset service was asked for this chunk');
  const again7 = remoteCount((e) => e.ns === 'px' && e.hash === onlyHash && e.tail === null);
  const local7 = await getBytes(`${EDITOR}/api/asset/px/${onlyHash}`);
  check(local7.status === 200 && local7.bytes.equals(only) && remoteCount((e) => e.ns === 'px' && e.hash === onlyHash && e.tail === null) === again7, 'P7 second request is a local hit, no longer asks the remote');
  await fetch(`${EDITOR}/api/media/remote`, { method: 'DELETE' }).catch(() => {});

  check(pageErrors.length === 0, 'Page has no uncaught errors', pageErrors.slice(0, 5));
} catch (e) {
  fails.push('Probe exception:' + (e?.stack || e));
} finally {
  out.editorLogTail = editorLog.join('').split(/\r?\n/).filter((l) => /error|bake-store|artifact-push/i.test(l)).slice(-25);
  if (!KEEP) {
    try { await browser?.close(); } catch { /* Closed */ }
    stopEditor();
    remote.closeAllConnections?.();
    remote.close();
    await delay(500);
    try { fs.rmSync(EXPORT_DIR, { recursive: true, force: true }); } catch { /* Process just exited, keep it */ }
  }
}

out.passes = passes;
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
console.log(`\nPassed ${passes.length}, failed ${fails.length}`);
process.exit(fails.length ? 1 : 0);
