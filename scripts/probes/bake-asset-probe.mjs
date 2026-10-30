/**
 * `bake_card` 的卡片快照经素材服务存取的端到端探针(报告 `docs/archive/agent-reports/AGENT-bake-asset.md`;
 * 语义 `docs/semantics/product/asset-service.md`「预渲染的产物」「职责」、`product/agent.md`「素材与产物」)。
 *
 *   node scripts/probes/bake-asset-probe.mjs [--port 5970] [--keep]
 *
 * 自己起一个编辑器 dev server(`--port`,缺省 5970,舞台另占 +1、+2;带 PROMPTCUT_NO_PORT_FILE=1),产物与素材落在新建的临时目录
 * (含 `PROMPTCUT_ARTIFACT_DIR`:px / snap 的本机存放,否则缺省落在仓库 `out/asset-store/`,第二次运行起 P7 的块本机已有);
 * 再在 `--port + 5` 上起一台计数的「远程素材服务」(内存里实现分片上传、对账、收尾、取回,三个命名空间都收),
 * 当作共享项目连着的那一台:编辑器带 `PROMPTCUT_ASSET_URL=<它>` 与 `PROMPTCUT_PUSH=1` 起,预渲染进程的推送队列、
 * 编辑器进程的上传目标都指向它(卡片快照写进本机素材服务之后再推一份过去)。
 *
 *   P1 bake_card(预渲染进程,`/api/vision/bake`):回 `/api/asset/px/<sha256>`;经编辑器取回的是 PNG、sha256 与地址一致;
 *      索引 `<导出目录>/bake-index/<键>.json` 记着这个内容哈希;素材目录里没有 `bake-*.png`;
 *      计数的远程素材服务收到了这一块的分片与收尾,从它那儿取回的字节相同(经接口写入与读回);
 *   P2 同样的参数再要一次:cached、同一个地址、不重渲;
 *   P3 3D 视图那条路(编辑器进程的热备渲染器,`/api/ui-render/bake-batch`):回 px 地址,远程也收到了;页面把它当图片加载得出来;
 *   P4 预取那条路(页面发到预渲染进程的 bake-status / bake-batch / bake-evict):批量渲两个时刻 → 盘点报字节与地址;
 *      淘汰一个键 → 盘点里没了,但那块字节在素材服务里照样取得到;
 *   P5 老地址:素材目录里放一张老格式的 `bake-<clip>-<键>.png`(以前的版本落下的),`/@media/<名>` 照常能取;
 *      同一个键再要时不重渲,经素材服务迁进 px(内容哈希就是旧文件的),旧文件还在;
 *   P6 贴图:scene-3d 的 texture 填 P1 的 px 地址,导出用的渲染器渲出来与不贴图时不同(预渲染进程经素材服务取到了贴图);
 *   P7 共享项目的另一个成员:一张只在远程素材服务上的 PNG,编辑器连上远程(`POST /api/media/remote`)后,
 *      页面按 `/api/asset/px/<hash>` 加载得出来,远程被请求过这一块。
 *   (素材服务不可达时回清楚的错,由单测 BKA-4 覆盖:编辑器进程自己就是本机素材服务,探针里断不开它。)
 *
 * 结束时只停自己起的进程(编辑器进程树、计数服务、探针的 puppeteer Chrome);`--keep` 不关、不删临时目录。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,并设 PROMPTCUT_NO_PORT_FILE=1
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
  throw new Error(`--port ${PORT} 不行:占 PORT～PORT+2 与 PORT+5,要落在同一个 10 口段里(PORT 的个位 ≤ 4),且不碰 5190～5192、5580～5599`);
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
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await delay(everyMs);
  }
}

/** 一张 w×h 的纯色 PNG(RGBA),自己拼,不要 ffmpeg */
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
        // 产物(px / snap)的本机存放目录也落在临时目录:缺省是 `<仓库>/out/asset-store/`,跨次运行会留着上一次的块,
        // P7 那张「只在远程上」的 PNG(内容固定、哈希固定)第二次起本机就有了,不再向远程取,「远程被请求过这一块」必不过
        PROMPTCUT_ARTIFACT_DIR: ARTIFACT_DIR,
        // 共享项目连着的素材服务:预渲染进程的推送队列(J.12 要显式打开)与编辑器进程的上传目标都指向计数的那一台
        PROMPTCUT_ASSET_URL: `${REMOTE}/api/asset`, PROMPTCUT_PUSH: '1' } });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 600) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  return until('编辑器进程起来', async () => (await fetch(EDITOR + '/api/prerender/info').then((r) => r.ok, () => false)) || null, 120000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}

/* ---- 计数的远程素材服务:<ns>/<hash>/chunks、PUT <ns>/<hash>/<n>、POST <ns>/<hash>/complete、GET/HEAD <ns>/<hash> ---- */
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

/** 目录里递归列出的文件名 */
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
  if (!(await startEditor())) throw new Error('编辑器进程没起来');
  const prerender = await until('预渲染进程起来', async () => {
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
  check(!!(placed.a && placed.b && placed.c), '项目里放了三张卡(blur-text、punch-pill、scene-3d)', placed);
  const projectNow = () => page.evaluate(async () => { const m = await import('/src/store/project.ts'); return JSON.parse(JSON.stringify(m.getState().project)); });
  const project = await projectNow();
  check(fs.readdirSync(MEDIA_DIR).filter((n) => n.startsWith('bake-')).length === 0, '开始时素材目录里没有 bake-*.png');

  /* ---- P1 bake_card:经素材服务写进 px,远程收到、读回相同 ---- */
  const t0 = Date.now();
  const p1 = await post(`${EDITOR}/api/vision/bake`, { project, clipId: placed.a, t: 2, size: 512, bg: '#0b0f17' });
  out.p1 = { ...p1, ms: Date.now() - t0 };
  check(p1.ok === true && /^\/api\/asset\/px\/[0-9a-f]{64}$/.test(p1.url || ''), 'P1 bake_card 回 /api/asset/px/<sha256>', p1);
  const p1Hash = String(p1.url || '').split('/').pop();
  const p1Got = await getBytes(EDITOR + p1.url);
  check(p1Got.status === 200 && isPng(p1Got.bytes) && sha256(p1Got.bytes) === p1Hash, 'P1 经编辑器(本机素材服务)取回的是 PNG,sha256 与地址一致', { status: p1Got.status, type: p1Got.type, bytes: p1Got.bytes.length });
  check(p1Got.type === 'image/png', 'P1 Content-Type 是 image/png', p1Got.type);
  const p1Entry = indexEntries().find((e) => e.hash === p1Hash);
  check(!!p1Entry && p1Entry.clipId === placed.a, 'P1 索引 bake-index/<键>.json 记着这个内容哈希', indexEntries());
  check(walk(MEDIA_DIR).filter((f) => /[\\/]bake-[^\\/]*$/.test(f)).length === 0, 'P1 素材目录里没有 bake-*.png(不再直接写素材目录)', walk(MEDIA_DIR).map((f) => path.basename(f)));
  const p1Pushed = await until('P1 远程收到这一块', async () => remoteBlobs.has(`px/${p1Hash}`), 30000, 250);
  check(!!p1Pushed, 'P1 计数的远程素材服务收全了这一块(经接口推送)', { puts: remoteCount((e) => e.ns === 'px' && e.hash === p1Hash && /^\d+$/.test(e.tail ?? '')), completes: remoteCount((e) => e.ns === 'px' && e.hash === p1Hash && e.tail === 'complete') });
  check(remoteCount((e) => e.ns === 'px' && e.hash === p1Hash && /^\d+$/.test(e.tail ?? '')) >= 1 && remoteCount((e) => e.ns === 'px' && e.hash === p1Hash && e.tail === 'complete') >= 1, 'P1 远程被请求过这一块的分片与收尾');
  const p1Remote = await getBytes(`${REMOTE}/api/asset/px/${p1Hash}`);
  check(p1Remote.status === 200 && p1Remote.bytes.equals(p1Got.bytes), 'P1 从远程素材服务读回的字节相同');
  out.pushLog = editorLog.join('').split(/\r?\n/).filter((l) => /\[artifact-push\] push\.(started|skip|asset-base)|\[bake-store\]/.test(l)).slice(0, 12);

  /* ---- P2 再要一次:命中 ---- */
  const t2 = Date.now();
  const p2 = await post(`${EDITOR}/api/vision/bake`, { project, clipId: placed.a, t: 2, size: 512, bg: '#0b0f17' });
  out.p2 = { cached: p2.cached, url: p2.url, ms: Date.now() - t2 };
  check(p2.ok === true && p2.cached === true && p2.url === p1.url, 'P2 同样的参数再要:cached、同一个地址', out.p2);

  /* ---- P3 3D 视图那条路(编辑器进程) ---- */
  const p3 = await page.evaluate(async ({ project, clipId }) => {
    const res = await fetch('/api/ui-render/bake-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, clips: [{ clipId, t: 2 }], size: 1024, priority: 1 }) });
    const data = await res.json();
    const url = data.baked?.[0]?.url;
    const size = url ? await new Promise((resolve) => { const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.onerror = () => resolve(null); img.src = url; }) : null;
    return { ok: data.ok, url, size, failed: data.failed };
  }, { project, clipId: placed.b });
  out.p3 = p3;
  check(p3.ok && /^\/api\/asset\/px\/[0-9a-f]{64}$/.test(p3.url || '') && Array.isArray(p3.size) && p3.size[0] > 0, 'P3 3D 视图(ui-render/bake-batch)回 px 地址,页面加载得出这张图', p3);
  const p3Hash = String(p3.url || '').split('/').pop();
  check(!!(await until('P3 远程收到', async () => remoteBlobs.has(`px/${p3Hash}`), 30000, 250)), 'P3 编辑器进程渲的也推到了远程素材服务');

  /* ---- P4 预取那条路(页面发到预渲染进程) ---- */
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
  check(p4.before?.ok && (p4.before.items || []).slice(0, 2).every((i) => i.bytes === null && i.url === null), 'P4 盘点:没渲过的两个时刻报 bytes/url 为空', p4.before?.items);
  check(p4.batch?.ok && p4.batch.baked?.length === 2 && p4.batch.baked.every((x) => /^\/api\/asset\/px\//.test(x.url)), 'P4 批量渲同一张卡的两个时刻,都回 px 地址', p4.batch);
  check((p4.after?.items || []).slice(0, 2).every((i, k) => typeof i.bytes === 'number' && i.url === p4.batch.baked[k]?.url), 'P4 再盘点:两个时刻报字节与地址(与批量回的一致)', p4.after?.items);
  check(p4.after?.items?.[2]?.url === p3.url, 'P4 3D 视图渲过的那张在预取的盘点里也算渲好了(编辑器进程与预渲染进程共用索引)', p4.after?.items?.[2]);
  check(p4.loaded.slice(0, 3).every((w) => w > 0), 'P4 页面按盘点回的地址加载得出图', p4.loaded);
  check(p4.evict?.ok && p4.evict.deleted?.length === 1 && p4.evict.deleted[0] === p4.victim, 'P4 淘汰一个键', p4.evict);
  check(p4.final?.items?.[0]?.bytes === null && typeof p4.final?.items?.[1]?.bytes === 'number', 'P4 淘汰后盘点里没了它,另一个还在', p4.final?.items);
  check((await getBytes(EDITOR + p4.victimUrl)).status === 200, 'P4 淘汰的只是索引条目,那块字节在素材服务里照样取得到');

  /* ---- P5 老地址 ---- */
  const st5 = await post(`${PRE}/api/vision/bake-status`, { project, clips: [{ clipId: placed.b, t: 1 }], size: 1024 });
  const it5 = st5.items?.[0] ?? {};
  const legacyBytes = makePng(64, 36, [200, 40, 90]);
  const legacyOk = check(/^bake-.*-[0-9a-f]{12}\.png$/.test(it5.name || '') && it5.bytes === null, 'P5 盘点给出这个键在老格式下的文件名,且还没渲过', it5);
  if (legacyOk) {
    fs.writeFileSync(path.join(MEDIA_DIR, it5.name), legacyBytes); // 模拟以前的版本落在素材目录里的旧文件
    const old = await getBytes(`${EDITOR}/@media/${encodeURIComponent(it5.name)}`);
    check(old.status === 200 && old.bytes.equals(legacyBytes), 'P5 老地址 /@media/bake-….png 照常能取', { status: old.status });
    const t5 = Date.now();
    const b5 = await post(`${PRE}/api/vision/bake-batch`, { project, clips: [{ clipId: placed.b, t: 1 }], size: 1024 });
    out.p5 = { name: it5.name, baked: b5.baked, ms: Date.now() - t5 };
    check(b5.ok && b5.baked?.[0]?.cached === true && b5.baked[0].url === `/api/asset/px/${sha256(legacyBytes)}`, 'P5 同一个键再要:不重渲,经素材服务迁进 px(内容哈希就是旧文件的)', out.p5);
    check(fs.existsSync(path.join(MEDIA_DIR, it5.name)), 'P5 旧文件还在(不删)');
    const old2 = await getBytes(`${EDITOR}/@media/${encodeURIComponent(it5.name)}`);
    check(old2.status === 200, 'P5 迁移之后老地址照样能取');
  }

  /* ---- P6 贴图:scene-3d 的 texture 用 px 地址,导出用的渲染器取得到 ---- */
  await page.evaluate(async ({ c, url }) => { const m = await import('/src/store/project.ts'); m.actions.setClipParams(c, { texture: url, shape: 'cube' }); }, { c: placed.c, url: p1.url });
  const projCube = await projectNow();
  const cubePlain = JSON.parse(JSON.stringify(projCube));
  for (const tr of cubePlain.tracks) for (const cl of tr.clips) if (cl.id === placed.c) cl.params = { ...cl.params, texture: '' };
  const noTex = await post(`${EDITOR}/api/vision/bake`, { project: cubePlain, clipId: placed.c, t: 2, size: 512, bg: '#101010' });
  const withTex = await post(`${EDITOR}/api/vision/bake`, { project: projCube, clipId: placed.c, t: 2, size: 512, bg: '#101010' });
  out.p6 = { noTex: noTex.url, withTex: withTex.url, errors: [noTex.error, withTex.error].filter(Boolean) };
  check(noTex.ok && withTex.ok && noTex.url !== withTex.url, 'P6 scene-3d 贴上 px 地址的贴图后渲出来与不贴时不同(渲染器经素材服务取到了贴图)', out.p6);
  const texLog = editorLog.join('');
  check(!/texture[^\n]*(404|failed)/i.test(texLog), 'P6 日志里没有贴图取不到的报错');

  /* ---- P7 共享项目的另一个成员:只在远程上的 px ---- */
  const only = makePng(40, 30, [20, 180, 60]);
  const onlyHash = sha256(only);
  remoteBlobs.set(`px/${onlyHash}`, { bytes: only, type: 'image/png' });
  const before7 = remoteCount((e) => e.ns === 'px' && e.hash === onlyHash && e.tail === null);
  const set7 = await post(`${EDITOR}/api/media/remote`, { base: `${REMOTE}/api/asset` });
  check(set7.ok === true, 'P7 编辑器连上远程素材服务', set7);
  const size7 = await page.evaluate(async (url) => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.onerror = () => resolve(null); img.src = url; }), `/api/asset/px/${onlyHash}`);
  check(Array.isArray(size7) && size7[0] === 40 && size7[1] === 30, 'P7 页面按 /api/asset/px/<hash> 加载得出只在远程上的那张图(40×30)', size7);
  check(remoteCount((e) => e.ns === 'px' && e.hash === onlyHash && e.tail === null) > before7, 'P7 远程素材服务被请求过这一块');
  const again7 = remoteCount((e) => e.ns === 'px' && e.hash === onlyHash && e.tail === null);
  const local7 = await getBytes(`${EDITOR}/api/asset/px/${onlyHash}`);
  check(local7.status === 200 && local7.bytes.equals(only) && remoteCount((e) => e.ns === 'px' && e.hash === onlyHash && e.tail === null) === again7, 'P7 第二次是本机命中,不再问远程');
  await fetch(`${EDITOR}/api/media/remote`, { method: 'DELETE' }).catch(() => {});

  check(pageErrors.length === 0, '页面没有未捕获的错误', pageErrors.slice(0, 5));
} catch (e) {
  fails.push('探针异常:' + (e?.stack || e));
} finally {
  out.editorLogTail = editorLog.join('').split(/\r?\n/).filter((l) => /error|错误|bake-store|artifact-push/i.test(l)).slice(-25);
  if (!KEEP) {
    try { await browser?.close(); } catch { /* 已关 */ }
    stopEditor();
    remote.closeAllConnections?.();
    remote.close();
    await delay(500);
    try { fs.rmSync(EXPORT_DIR, { recursive: true, force: true }); } catch { /* 进程刚退,留着 */ }
  }
}

out.passes = passes;
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
console.log(`\n通过 ${passes.length},失败 ${fails.length}`);
process.exit(fails.length ? 1 : 0);
