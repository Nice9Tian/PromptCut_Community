/**
 * 单张卡片画面(`bake_card`、3D 视图的贴图)是当场渲出的位图、不存这张卡的 HTML —— 的端到端探针
 * (报告 `docs/archive/agent-reports/AGENT-rr-card-bitmap.md`;语义 `docs/semantics/mechanism/asset-service.md`
 * 「不经任务队列的单张卡片画面」、`docs/semantics/glossary.md`「快照」)。
 *
 *   node scripts/probes/card-bitmap-probe.mjs --port 26900 --save <目录>      改之前跑:只把各用例的图存下来
 *   node scripts/probes/card-bitmap-probe.mjs --port 26900 --compare <目录>   改之后跑:和存下的图逐像素比,并核对落盘的东西
 *   node scripts/probes/card-bitmap-probe.mjs --port 26900                    不比图,只核对落盘的东西和缓存命中
 *   node scripts/probes/card-bitmap-probe.mjs --port 26900 --make-fixture     重新生成夹具项目(一般不用)
 *
 * 自己起一个编辑器 dev server(`--port`,舞台另占 +1、+2;带 PROMPTCUT_NO_PORT_FILE=1;预渲染进程的端口由它自己向系统要),
 * 导出目录、数据目录、产物目录、卡片改动层都落在新建的临时目录;在 `--port + 5` 上起一台计数的「远程素材服务」当共享项目连着的那一台。
 * 夹具项目 `card-bitmap-probe.project.json`:四张卡各占一条序列、都在 0～4 秒 ——
 * blur-text(DOM 卡)、punch-pill(Motion 弹簧,DOM 卡)、particles(画布卡)、rs-bar-race(用户卡,源码取自
 * `server/test/fixtures/remotion-style/rs-bar-race.tsx`,经 `POST /api/cards/create` 建进临时的改动层)。
 *
 * 第一段(不开编辑器页面,免得页面自己的预渲染往帧库里写东西,分不清是谁写的):
 *   A1 `bake_card`(`POST /api/vision/bake`,预渲染进程的 Agent 专用实例):四张卡各要一张,回 `/api/asset/px/<sha256>`,取回是 PNG、
 *      哈希与地址一致,尺寸、说明文字(hint / note)、透明占比都在;
 *   A2 3D 视图的空闲贴图预取那条路(`POST <预渲染>/api/vision/bake-batch`,不带 priority = 普通预渲染队尾;带 priority = 插队);
 *   A3 3D 视图前台那条路(`POST /api/ui-render/bake-batch`,编辑器进程的热备渲染器);
 *   A4 同一输入再要一次:`cached: true`、同一个地址;
 *   A5 落盘:帧库(`<导出目录>/frame-library`)里没有新写入的 HTML(`html-manifest.json`、`html-cache/`、`snapshots.base64`、`*.html*`),
 *      也没有为这些单卡项目新建的条目目录;本机素材服务的产物目录里新写入的只有 `px` 下的 PNG,`snap` 下没有东西;
 *      计数的远程素材服务只收到 `px` 的 PNG(每一张都推到了),没有收到 `snap`;索引 `bake-index/<键>.json` 每条都指向一张 PNG;
 *   A6 (`--compare`)每个用例和改之前存下的图逐像素比:宽高相同、不同的像素数为 0。
 * 第二段(开编辑器页面):
 *   B1 载入夹具项目、播放头放到 2 秒、切到 3D 页:四块板子的贴图都出得来(页面收到的 `bake-batch` 回应里四张卡都有 px 地址,
 *      页面把每个地址当图片加载得出来,宽高与卡片的框一致);
 *   B2 (`--compare`)这些贴图按「片段 + 时刻」和改之前的逐像素比。
 * `--save` 时 A5 只记录不判(改之前本来就会写 HTML),其余照判。
 *
 * 结束时只停自己起的进程(编辑器进程树、计数服务、探针的无头 Chrome);`--keep` 不关、不删临时目录。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,并设 PROMPTCUT_NO_PORT_FILE=1
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
if (!(PORT >= 20000 && PORT % 10 <= 4)) throw new Error(`--port ${PORT} 不行:要在 20000 以上,占 PORT～PORT+2 与 PORT+5,PORT 的个位 ≤ 4`);
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
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
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
        // 预渲染进程的输出另存一份:推送、卡片位图入库的日志行只在它那里
        PROMPTCUT_PRERENDER_LOG: PRERENDER_LOG,
        PROMPTCUT_ASSET_URL: `${REMOTE}/api/asset`, PROMPTCUT_PUSH: '1' } });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 800) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  return until('编辑器进程起来', async () => (await fetch(EDITOR + '/api/prerender/info').then((r) => r.ok, () => false)) || null, 180000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}

/* ---- 计数的远程素材服务(同 bake-asset-probe.mjs):分片上传、对账、收尾、取回 ---- */
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

/** 目录里递归列出的文件(相对路径,正斜杠) */
function walk(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base)); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
/** 帧库里和 HTML 有关的文件:整场景或单卡的快照档、溢出目录、老的整包、任何 .html / .html.gz */
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

/** 逐像素比两张 PNG。回 { same, width, height, diffPixels, maxDelta } */
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

/** 用例的图:名字 → { bytes, meta }。`--save` 写盘,`--compare` 对照 */
const images = new Map();
const compared = [];
function record(name, bytes, meta = {}) {
  images.set(name, { bytes, meta });
  if (SAVE_DIR) fs.writeFileSync(path.join(SAVE_DIR, `${name}.png`), bytes);
  if (COMPARE_DIR) {
    const file = path.join(COMPARE_DIR, `${name}.png`);
    if (!fs.existsSync(file)) { notes.push(`改之前没有存 ${name},这一张没比`); return; }
    const r = comparePng(fs.readFileSync(file), bytes);
    compared.push({ name, ...r });
    check(r.same, `和改之前逐像素相同:${name}`, r);
  }
}
const safe = (s) => String(s).replace(/[^\w.-]/g, '_');

let browser = null;
const out = { port: PORT, remote: REMOTE, tmp: TMP, mode: SAVE_DIR ? 'save' : COMPARE_DIR ? 'compare' : 'check' };
if (SAVE_DIR) fs.mkdirSync(SAVE_DIR, { recursive: true });
try {
  await new Promise((resolve, reject) => { remote.once('error', reject); remote.listen(REMOTE_PORT, '127.0.0.1', resolve); });
  if (!(await startEditor())) throw new Error('编辑器进程没起来');
  const prerender = await until('预渲染进程起来', async () => {
    const info = await fetch(EDITOR + '/api/prerender/info').then((r) => r.json());
    return info?.ready && info.url ? info : null;
  }, 180000, 500);
  out.prerender = prerender?.url ?? null;
  const PRE = String(prerender?.url || EDITOR).replace(/\/+$/, '');

  // 用户卡夹具:经真的建卡接口落进临时的改动层
  const created = await post(`${EDITOR}/api/cards/create`, { id: 'rs-bar-race', source: fs.readFileSync(USER_CARD, 'utf8'), projectId: 'card-bitmap-probe' });
  check(created.status === 200 && created.ok === true, '用户卡夹具 rs-bar-race 建进了临时的改动层', { status: created.status, error: created.error, errors: created.errors });

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
    // 固定的 id,两次跑的输入逐字相同;用户卡那一段照卡片的 defaults 手写(页面的卡片表里不一定已经有它)
    made.id = 'card-bitmap-probe';
    const names = { 'blur-text': 'blur', 'punch-pill': 'pill', particles: 'particles' };
    made.tracks = made.tracks.filter((tr) => tr.clips?.length === 1 && names[tr.clips[0].cardId]);
    if (made.tracks.length !== 3) throw new Error(`夹具项目该有三条序列,实际 ${made.tracks.length}`);
    for (const tr of made.tracks) { const n = names[tr.clips[0].cardId]; tr.id = `t-${n}`; tr.clips[0].id = `c-${n}`; }
    made.tracks.push({ id: 't-user', name: `序列 ${made.tracks.length + 1}`, clips: [{ id: 'c-user', cardId: 'rs-bar-race', start: 0, end: 4, params: { count: 14, seed: 7, accent: '#ffffff' } }] });
    made.duration = Math.max(Number(made.duration) || 0, 4);
    fs.writeFileSync(FIXTURE, JSON.stringify(made, null, 2) + '\n');
    console.log(`夹具项目写到 ${FIXTURE}`);
    throw Object.assign(new Error('made'), { made: true });
  }

  const project = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const CLIP = { blur: 'c-blur', pill: 'c-pill', particles: 'c-particles', user: 'c-user' };
  const libraryBefore = new Set(walk(LIBRARY_DIR));
  const artifactsBefore = new Set(walk(ARTIFACT_DIR));
  const ourHashes = new Set();
  /** 取回一个 px 地址,核对是 PNG、哈希对得上,记成用例的图 */
  const take = async (name, item, label) => {
    const okUrl = /^\/api\/asset\/px\/[0-9a-f]{64}$/.test(item?.url || '');
    if (!check(okUrl, `${label}:回 /api/asset/px/<sha256>`, item)) return null;
    const hash = item.url.split('/').pop();
    ourHashes.add(hash);
    const got = await getBytes(EDITOR + item.url);
    check(got.status === 200 && got.type === 'image/png' && isPng(got.bytes) && sha256(got.bytes) === hash, `${label}:取回的是 PNG,sha256 与地址一致`, { status: got.status, type: got.type, bytes: got.bytes.length });
    if (!isPng(got.bytes)) return null;
    const png = PNG.sync.read(got.bytes);
    check(png.width === item.width && png.height === item.height, `${label}:图的宽高与返回的 width / height 一致`, { png: [png.width, png.height], said: [item.width, item.height] });
    record(name, got.bytes, { width: png.width, height: png.height });
    return { hash, bytes: got.bytes, width: png.width, height: png.height };
  };

  /* ---- A1 bake_card:四张卡 ---- */
  const BAKES = [
    { name: 'bake-blur', clipId: CLIP.blur, t: 2, size: 512, bg: '#0b0f17' },
    { name: 'bake-pill', clipId: CLIP.pill, t: 0.2, size: 512 }, // 透明底;0.2 秒时弹簧还在动
    { name: 'bake-particles', clipId: CLIP.particles, t: 1.5, size: 512, bg: '#101418' },
    { name: 'bake-user', clipId: CLIP.user, t: 1, size: 768 },
  ];
  out.a1 = [];
  for (const b of BAKES) {
    const t0 = Date.now();
    const r = await post(`${EDITOR}/api/vision/bake`, { project, clipId: b.clipId, t: b.t, size: b.size, bg: b.bg });
    out.a1.push({ name: b.name, ok: r.ok, url: r.url, width: r.width, height: r.height, cached: r.cached, transparentRatio: r.transparentRatio, error: r.error, ms: Date.now() - t0 });
    if (!check(r.ok === true, `A1 ${b.name}:bake_card 成功`, { status: r.status, error: r.error })) continue;
    check(r.clipId === b.clipId && r.t === b.t && r.width === b.size && r.height === b.size && r.cached === false
      && typeof r.bytes === 'number' && typeof r.transparentRatio === 'number' && typeof r.hint === 'string' && /贴图/.test(r.hint) && typeof r.note === 'string' && /PNG 快照/.test(r.note),
      `A1 ${b.name}:返回的字段齐全(clipId、t、正方形尺寸、bytes、transparentRatio、hint、note)`, { ...r, hint: undefined, note: undefined });
    check(b.bg ? /不透明贴图/.test(r.hint) : /透明底贴图/.test(r.hint), `A1 ${b.name}:说明文字跟着 bg 走`, r.hint);
    check(r.transparentRatio < 1, `A1 ${b.name}:画面不是空的`, r.transparentRatio);
    await take(b.name, r, `A1 ${b.name}`);
  }

  /* ---- A2 3D 视图的贴图预取那条路(预渲染进程;普通预渲染队尾 / 插队) ---- */
  const idle = await post(`${PRE}/api/vision/bake-batch`, { project, clips: [{ clipId: CLIP.blur, t: 1 }, { clipId: CLIP.blur, t: 3 }, { clipId: CLIP.particles, t: 1 }], size: 1024 });
  out.a2idle = { ok: idle.ok, baked: idle.baked?.map((x) => ({ clipId: x.clipId, t: x.t, url: x.url, width: x.width, height: x.height, cached: x.cached })), failed: idle.failed, error: idle.error };
  check(idle.ok && idle.baked?.length === 3 && !(idle.failed || []).length, 'A2 贴图预取(队尾):三张都渲出来了', out.a2idle);
  for (const x of idle.baked || []) await take(`batch-idle-${safe(x.clipId)}-${x.t}`, x, `A2 预取 ${x.clipId}@${x.t}`);
  const front = await post(`${PRE}/api/vision/bake-batch`, { project, clips: [{ clipId: CLIP.pill, t: 0.3 }, { clipId: CLIP.user, t: 2 }], size: 1024, priority: 1 });
  out.a2front = { ok: front.ok, baked: front.baked?.map((x) => ({ clipId: x.clipId, t: x.t, url: x.url, width: x.width, height: x.height, cached: x.cached })), failed: front.failed, error: front.error };
  check(front.ok && front.baked?.length === 2 && !(front.failed || []).length, 'A2 贴图预取(插队):两张都渲出来了', out.a2front);
  for (const x of front.baked || []) await take(`batch-front-${safe(x.clipId)}-${x.t}`, x, `A2 插队 ${x.clipId}@${x.t}`);
  check([...(idle.baked || []), ...(front.baked || [])].every((x) => x.width === project.width && x.height === project.height), 'A2 贴图按卡片的框(没有 frame 就是项目画幅)出,清晰度不降', { want: [project.width, project.height] });

  /* ---- A3 3D 视图前台那条路(编辑器进程的热备渲染器) ---- */
  const ui = await post(`${EDITOR}/api/ui-render/bake-batch`, { project, clips: [{ clipId: CLIP.blur, t: 2.5 }, { clipId: CLIP.particles, t: 2.5 }], size: 1024, priority: 1 });
  out.a3 = { ok: ui.ok, baked: ui.baked?.map((x) => ({ clipId: x.clipId, t: x.t, url: x.url, width: x.width, height: x.height, cached: x.cached })), failed: ui.failed, error: ui.error };
  check(ui.ok && ui.baked?.length === 2 && !(ui.failed || []).length, 'A3 热备渲染器:两张都渲出来了', out.a3);
  for (const x of ui.baked || []) await take(`ui-${safe(x.clipId)}-${x.t}`, x, `A3 热备 ${x.clipId}@${x.t}`);

  /* ---- A4 同一输入再要一次:命中 ---- */
  const again = await post(`${EDITOR}/api/vision/bake`, { project, clipId: BAKES[0].clipId, t: BAKES[0].t, size: BAKES[0].size, bg: BAKES[0].bg });
  check(again.ok && again.cached === true && again.url === out.a1[0].url, 'A4 bake_card 同一输入再要:cached、同一个地址', { cached: again.cached, url: again.url });
  const againBatch = await post(`${PRE}/api/vision/bake-batch`, { project, clips: [{ clipId: CLIP.blur, t: 1 }, { clipId: CLIP.blur, t: 3 }], size: 1024 });
  check(againBatch.ok && againBatch.baked?.length === 2 && againBatch.baked.every((x, i) => x.cached === true && x.url === idle.baked?.[i]?.url), 'A4 贴图预取同一输入再要:cached、同一个地址', againBatch.baked?.map((x) => ({ t: x.t, cached: x.cached })));
  const status = await post(`${PRE}/api/vision/bake-status`, { project, clips: [{ clipId: CLIP.blur, t: 2.5 }], size: 1024 });
  check(status.ok && status.items?.[0]?.url === ui.baked?.[0]?.url, 'A4 热备渲染器渲的那张在盘点里算渲好了(两个进程共用索引)', status.items?.[0]);

  /* ---- A5 落盘:只有位图,没有 HTML ---- */
  const allPushed = () => [...ourHashes].every((h) => remoteBlobs.has(`px/${h}`));
  for (const deadline = Date.now() + 20000; !allPushed() && Date.now() < deadline;) await delay(250);
  if (!allPushed()) {
    // 预渲染进程的推送目标是它起来之后异步登记的(连上文档服务才登记);登记之前入库的位图当时不推,「下次命中时再推」(`bake-store.mjs`)。
    // 机器忙的时候第一批会赶在登记之前:这里各再要一次(命中),再等
    notes.push(`第一轮有 ${[...ourHashes].filter((h) => !remoteBlobs.has(`px/${h}`)).length} 张没推到远程(推送目标登记得晚),各再要一次后再等`);
    for (const b of BAKES) await post(`${EDITOR}/api/vision/bake`, { project, clipId: b.clipId, t: b.t, size: b.size, bg: b.bg });
    await post(`${PRE}/api/vision/bake-batch`, { project, clips: [{ clipId: CLIP.blur, t: 1 }, { clipId: CLIP.blur, t: 3 }, { clipId: CLIP.particles, t: 1 }], size: 1024 });
    await post(`${PRE}/api/vision/bake-batch`, { project, clips: [{ clipId: CLIP.pill, t: 0.3 }, { clipId: CLIP.user, t: 2 }], size: 1024, priority: 1 });
    await until('远程素材服务收全这几张', async () => allPushed(), 60000, 250);
  }
  await delay(1500); // 帧库的存档是异步落盘的,等它写完再列
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
  const storage = (cond, label, extra) => (SAVE_DIR ? (notes.push(`(改之前,只记录)${label}:${cond ? '成立' : '不成立'}${extra === undefined ? '' : ' ' + JSON.stringify(extra).slice(0, 300)}`), cond) : check(cond, label, extra));
  storage(libraryHtml.length === 0, 'A5 帧库里没有新写入的 HTML(html-manifest.json / html-cache / snapshots / *.html)', libraryHtml.slice(0, 8));
  storage(libraryEntries.length === 0, 'A5 帧库里没有为这些单卡项目新建的条目目录', libraryEntries.slice(0, 8));
  storage(snapNew.length === 0 && pxNotPng.length === 0, 'A5 本机素材服务的产物目录里新写入的只有 px 下的 PNG,snap 下没有东西', { snapNew: snapNew.slice(0, 6), pxNotPng });
  storage(remoteSnap.length === 0 && remotePxNotPng.length === 0, 'A5 远程素材服务只收到 px 的 PNG,没有收到 snap', { remoteSnap: remoteSnap.slice(0, 6), remotePxNotPng });
  check([...ourHashes].every((h) => remoteBlobs.has(`px/${h}`)), 'A5 每一张位图都推到了连着的远程素材服务', { want: ourHashes.size, got: [...ourHashes].filter((h) => remoteBlobs.has(`px/${h}`)).length });
  check(entries.length >= ourHashes.size - 1 && entries.every((e) => /^[0-9a-f]{64}$/.test(e.hash)) && [...ourHashes].every((h) => entries.some((e) => e.hash === h)), 'A5 索引 bake-index 里每一张都记着「输入哈希 → 内容哈希」', { entries: entries.length });

  /* ---- B 3D 视图开着:贴图出得来 ---- */
  browser = await launch();
  const page = await openEditorPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const seen = []; // 页面收到的 bake-batch 回应里的每一张
  page.on('response', async (res) => {
    if (!/\/api\/(ui-render|vision)\/bake-batch$/.test(new URL(res.url()).pathname) || res.request().method() !== 'POST') return;
    try {
      const data = await res.json();
      const route = /ui-render/.test(res.url()) ? 'ui' : 'prefetch';
      for (const b of data.baked || []) seen.push({ route, clipId: b.clipId, t: b.t, url: b.url, width: b.width, height: b.height, cached: b.cached });
    } catch { /* 被掐掉的请求没有正文 */ }
  });
  await page.evaluate(async (project) => {
    const m = await import('/src/store/project.ts');
    m.actions.loadProject(project);
    m.actions.seek(2);
  }, project);
  await page.evaluate(() => { [...document.querySelectorAll('[data-pc="preview-tabs"] button')].find((b) => b.textContent === '3D').click(); });
  await page.waitForSelector('.pc-3d-checker canvas', { timeout: 60000 });
  const cardClips = Object.values(CLIP);
  // 等待时限只为防卡死(机器忙时热备渲染器一张要一两分钟);用了多久记下来,不当通过条件
  const b1Started = Date.now();
  const allSeen = await until('3D 视图四块板子的贴图都到了', async () => cardClips.every((id) => seen.some((s) => s.clipId === id && /^\/api\/asset\/px\//.test(s.url || ''))) || null, 600000, 500);
  const b1Ms = Date.now() - b1Started;
  await delay(4000); // 让空闲预取再走几轮,多收几张(收到多少比多少)
  out.b1 = { ms: b1Ms, seen: seen.length, byRoute: { ui: seen.filter((s) => s.route === 'ui').length, prefetch: seen.filter((s) => s.route === 'prefetch').length }, clips: cardClips.map((id) => ({ id, got: seen.filter((s) => s.clipId === id).length })) };
  check(!!allSeen, 'B1 3D 视图开着:四张卡的贴图都出来了(页面收到 px 地址)', out.b1);
  const uniq = new Map();
  for (const s of seen) if (s.url && !uniq.has(`${s.clipId}@${s.t}`)) uniq.set(`${s.clipId}@${s.t}`, s);
  const loaded = await page.evaluate(async (urls) => Promise.all(urls.map((url) => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.onerror = () => resolve(null); img.src = url; }))), [...uniq.values()].map((s) => s.url));
  check(loaded.length > 0 && loaded.every((sz) => Array.isArray(sz) && sz[0] === project.width && sz[1] === project.height), 'B1 页面把每张贴图当图片加载得出来,宽高等于卡片的框', { loaded: loaded.slice(0, 6), want: [project.width, project.height] });
  for (const [key, s] of uniq) {
    const got = await getBytes(EDITOR + s.url);
    if (check(got.status === 200 && isPng(got.bytes), `B1 贴图 ${key} 取回是 PNG`, { status: got.status })) record(`view3d-${safe(key)}`, got.bytes);
  }
  out.b1.moments = [...uniq.keys()];
  const shot = path.join(SAVE_DIR || COMPARE_DIR || TMP, COMPARE_DIR ? 'view3d-after.png' : 'view3d.png');
  await page.screenshot({ path: shot });
  out.b1.screenshot = shot;
  check(pageErrors.length === 0, '页面没有未捕获的错误', pageErrors.slice(0, 5));
  if (SAVE_DIR) fs.writeFileSync(path.join(SAVE_DIR, 'manifest.json'), JSON.stringify(Object.fromEntries([...images].map(([name, v]) => [name, { sha256: sha256(v.bytes), bytes: v.bytes.length, ...v.meta }])), null, 2));
  if (COMPARE_DIR) {
    out.compared = { total: compared.length, same: compared.filter((c) => c.same).length, bytesEqual: compared.filter((c) => c.bytesEqual).length, different: compared.filter((c) => !c.same) };
    check(compared.length >= BAKES.length + 7, '逐像素比对覆盖了 bake_card、两条预取、热备渲染器各用例', { compared: compared.length });
  }
} catch (e) {
  if (!e?.made) fails.push('探针异常:' + (e?.stack || e));
} finally {
  out.editorLogTail = editorLog.join('').split(/\r?\n/).filter((l) => /error|错误|bake-store/i.test(l)).slice(-20);
  try { out.prerenderLog = fs.readFileSync(PRERENDER_LOG, 'utf8').split(/\r?\n/).filter((l) => /\[bake-store\] bake\.(push-failed|stale)|\[artifact-push\] push\.|渲染超时/.test(l)).map((l) => l.slice(0, 260)).slice(0, 40); } catch { out.prerenderLog = null; }
  if (!KEEP) {
    try { await browser?.close(); } catch { /* 已关 */ }
    stopEditor();
    remote.closeAllConnections?.();
    remote.close();
    await delay(800);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 进程刚退,留着 */ }
  }
}

out.notes = notes;
out.passes = passes;
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
console.log(`\n通过 ${passes.length},失败 ${fails.length}`);
process.exit(fails.length ? 1 : 0);
