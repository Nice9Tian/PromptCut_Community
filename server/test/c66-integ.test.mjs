// C6.6 集成补做项(`docs/plan/c66-design.md` 第 9 节「要集成方补做的」第 1～3 条)的服务端一侧。
// 跑:node --test server/test/c66-integ.test.mjs
//
//   C66-I1-*  上传队列的目标经 `POST /api/media/upload-queue/target` 换(页面一侧在 src/editor/media/uploadTarget.test.mjs)
//   C66-I2-*  打开项目时补转素材小尺寸:`POST /api/media/tiers/backfill` 与两档管理器的 `backfill`
//   C66-I3-*  预渲染进程 `/api/export` 的导出拦截:缺素材原尺寸回 409 `awaiting-uploader`
//
// 素材插件是 .ts:同 media-tiers.test.mjs,用 typescript 转译到临时目录再 import,兄弟模块换成仓库里的绝对地址。
// 导出插件用 node 的类型剥离直接 import(`src/testing/registerTs.mjs` 补无扩展名的相对 import)。
import '../../src/testing/registerTs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-c66-integ-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

delete process.env.PROMPTCUT_EXPORT_DIR;
delete process.env.PROMPTCUT_MEDIA_DIR;
delete process.env.PROMPTCUT_EDITOR_URL;
delete process.env.PROMPTCUT_ASSET_URL;
delete process.env.PROMPTCUT_HEADLESS;

const ffmpegOk = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
const serverUrl = (rel) => pathToFileURL(path.join(ROOT, 'server', rel)).href;

function compile(srcRel, outName, replaces = []) {
  let src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  for (const [a, b] of replaces) src = src.split(a).join(b);
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const file = path.join(OUT, outName);
  fs.writeFileSync(file, js);
  return pathToFileURL(file).href;
}

const media = await import(compile('server/vite-plugin-media.ts', 'media.mjs', [
  ['"./media-tiers.mjs"', `"${serverUrl('media-tiers.mjs')}"`],
  ['"./upload-queue.mjs"', `"${serverUrl('upload-queue.mjs')}"`],
  ['"./bandwidth-gate.mjs"', `"${serverUrl('bandwidth-gate.mjs')}"`],
  ['"./bakery/ffmpeg.mjs"', `"${serverUrl('bakery/ffmpeg.mjs')}"`],
  ['"./asset-store/client.mjs"', `"${serverUrl('asset-store/client.mjs')}"`],
  ['"./media-pull.mjs"', `"${serverUrl('media-pull.mjs')}"`],
]));
const asset = await import(compile('server/asset-service.ts', 'asset-service.mjs', [
  ['from "./http-guard.mjs"', `from "${serverUrl('http-guard.mjs')}"`],
  ['from "./vite-plugin-media"', 'from "./media.mjs"'],
  ['from "./asset-store/index.mjs"', `from "${serverUrl('asset-store/index.mjs')}"`],
]));
const tiers = await import(serverUrl('media-tiers.mjs'));

function serviceHandler(root) {
  const a = asset.assetServiceMiddleware(root);
  const m = media.mediaMiddleware(root);
  return (req, res) => { void a(req, res, () => { void m(req, res, () => { res.statusCode = 404; res.end('no route'); }); }); };
}
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => { server.closeAllConnections?.(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ff = (args) => {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-v', 'error', ...args], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
};
/** moov 在尾的小 MP4(不重封装的话它就一直是晚置 moov) */
function lateMoov(name) {
  const file = path.join(OUT, name);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', file]);
  return file;
}
const topBoxes = (file) => {
  const buf = fs.readFileSync(file);
  const out = [];
  for (let off = 0; off + 8 <= buf.length;) {
    let size = buf.readUInt32BE(off);
    if (size === 1) size = Number(buf.readBigUInt64BE(off + 8));
    else if (size === 0) size = buf.length - off;
    out.push(buf.toString('latin1', off + 4, off + 8));
    if (size < 8) break;
    off += size;
  }
  return out;
};

/* ======================================================================== *
 * C66-I1 上传目标
 * ======================================================================== */

test('C66-I1-01 POST /api/media/upload-queue/target { base, ticket } switches the upload target; { base: null } switches back to this machine', async () => {
  const root = path.join(OUT, 'i1');
  fs.mkdirSync(media.mediaDir(root), { recursive: true });
  const origin = await listen(serviceHandler(root));
  const service = await media.mediaTierService(root);
  after(() => service.queue?.stop());
  let r = await postJson(`${origin}/api/media/upload-queue/target`, { base: 'http://10.9.8.7:5460/api/asset', ticket: 'rw-ticket-1' });
  assert.equal(r.status, 200);
  let q = await (await fetch(`${origin}/api/media/upload-queue`)).json();
  assert.deepEqual(q.target, { base: 'http://10.9.8.7:5460/api/asset' }, 'target switched to the remote asset service');
  assert.ok(!JSON.stringify(q).includes('rw-ticket-1'), 'the diagnostic response does not contain the ticket');
  r = await postJson(`${origin}/api/media/upload-queue/target`, { base: null });
  assert.equal(r.status, 200);
  q = await (await fetch(`${origin}/api/media/upload-queue`)).json();
  assert.equal(q.target, null, 'leaving the shared project: back to the local asset service (queue is a no-op)');
  r = await postJson(`${origin}/api/media/upload-queue/target`, { base: 'file:///x' });
  assert.equal(r.status, 400, 'only http(s) base URLs are accepted');
});

test('C66-I1-05 when PROMPTCUT_ASSET_URL is set: the remote target given by the page takes priority, and { base: null } returns to the target given by the environment variable (not this machine)', async () => {
  const root = path.join(OUT, 'i1-env');
  fs.mkdirSync(media.mediaDir(root), { recursive: true });
  process.env.PROMPTCUT_ASSET_URL = 'http://192.168.9.9:5460/api/asset';
  let service;
  try { service = await media.mediaTierService(root); } finally { delete process.env.PROMPTCUT_ASSET_URL; }
  after(() => service.queue?.stop());
  const origin = await listen(serviceHandler(root));
  const target = async () => (await (await fetch(`${origin}/api/media/upload-queue`)).json()).target;
  assert.deepEqual(await target(), { base: 'http://192.168.9.9:5460/api/asset' });
  await postJson(`${origin}/api/media/upload-queue/target`, { base: 'http://10.9.8.7:5460/api/asset', ticket: 't' });
  assert.deepEqual(await target(), { base: 'http://10.9.8.7:5460/api/asset' });
  await postJson(`${origin}/api/media/upload-queue/target`, { base: null });
  assert.deepEqual(await target(), { base: 'http://192.168.9.9:5460/api/asset' }, 'back to the default target');
});

/* ======================================================================== *
 * C66-I2 打开项目时补转素材小尺寸
 * ======================================================================== */

test('C66-I2-01 backfill transcode: a video ingested without tiers (same as a .procp restore) → backfill queues the small-size asset, no remux, original-size hash unchanged; once done, GET /api/media/tiers reports ready', { skip: !ffmpegOk && 'No ffmpeg', timeout: 180_000 }, async () => {
  const root = path.join(OUT, 'i2');
  fs.mkdirSync(media.mediaDir(root), { recursive: true });
  const origin = await listen(serviceHandler(root));
  const src = lateMoov('i2-late.mp4');
  // 不带 ?tiers=1:.procp 还原、配音等走的路,不做两档
  const upRes = await fetch(`${origin}/api/media/upload/i2-late.mp4`, { method: 'POST', body: fs.readFileSync(src) });
  const upText = await upRes.text();
  assert.equal(upRes.status, 200, upText.slice(0, 300));
  const up = JSON.parse(upText);
  assert.equal(up.hash, sha256File(src), 'ingest without tiers does not remux');
  assert.equal(up.tiers, undefined);
  const missing = 'f'.repeat(64);
  const res = await postJson(`${origin}/api/media/tiers/backfill`, { items: [{ hash: up.hash, name: 'i2-late.mp4' }, { hash: missing }, { hash: 'nope' }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items[up.hash]?.state, 'pending', `a video whose original-size asset exists locally is queued for background transcoding: ${JSON.stringify(body)}`);
  assert.deepEqual(body.items[missing], { state: 'absent' }, 'no local original-size asset: no transcoding (do not pull the original size just to transcode the small size)');
  assert.equal(body.items.nope, undefined, 'non-hash entries are ignored');
  const service = await media.mediaTierService(root);
  await service.manager.idle();
  const st = await (await fetch(`${origin}/api/media/tiers?hashes=${up.hash}`)).json();
  assert.equal(st.items[up.hash].state, 'ready');
  const small = st.items[up.hash].small;
  assert.match(small, /^[0-9a-f]{64}$/);
  const smallFile = path.join(media.mediaDir(root), `${small}.mp4`);
  assert.ok(fs.existsSync(smallFile), 'the small size went into the local content store');
  const lib = path.join(media.mediaDir(root), `${up.hash}.mp4`);
  assert.equal(sha256File(lib), up.hash, 'original-size asset bytes untouched (the hash is the one the project references)');
  assert.ok(topBoxes(lib).indexOf('mdat') < topBoxes(lib).indexOf('moov'), 'backfill transcode does not remux: the original-size asset still has a trailing moov');
  // 再问一次:已经有了,直接回 ready,不再转
  const again = await (await postJson(`${origin}/api/media/tiers/backfill`, { items: [{ hash: up.hash }] })).json();
  assert.deepEqual(again.items[up.hash], { state: 'ready', small });
});

test('C66-I2-02 two-tier manager backfill: image / audio extensions are skipped; files known to have no video stream are not transcoded again; ones that failed last time are retried; once transcoded, handed to the upload queue (small first, then large)', { skip: !ffmpegOk && 'No ffmpeg', timeout: 180_000 }, async () => {
  const dir = path.join(OUT, 'i2b');
  fs.mkdirSync(dir, { recursive: true });
  const enq = [];
  const fakeQueue = { enqueue: async (item) => { enq.push(item); return { queued: true }; } };
  const lib = {
    hashFile: async (p) => sha256File(p),
    writeIndex: async () => {},
    forget: async () => {},
    contentTypeForExt: () => 'video/mp4',
  };
  const m = tiers.createTierManager({ dir, lib, ffmpeg: async () => 'ffmpeg', queue: fakeQueue });
  assert.deepEqual(await m.backfill({ hash: 'a'.repeat(64), ext: 'png' }), { state: 'skipped' });
  assert.deepEqual(await m.backfill({ hash: 'a'.repeat(64), ext: 'm4a' }), { state: 'skipped' });
  // 原尺寸文件不在:转码失败(source-missing),记 failed
  const ghost = 'b'.repeat(64);
  assert.deepEqual(await m.backfill({ hash: ghost, ext: 'mp4' }), { state: 'pending' });
  await m.idle();
  assert.equal(m.status([ghost])[ghost].state, 'failed');
  // 文件补上了:下次打开再补,这回成了
  fs.copyFileSync(lateMoov('i2b-src.mp4'), path.join(dir, `${ghost}.mp4`));
  assert.deepEqual(await m.backfill({ hash: ghost, ext: 'mp4' }), { state: 'pending' }, 'the one that failed last time is retried once');
  await m.idle();
  const st = m.status([ghost])[ghost];
  assert.equal(st.state, 'ready');
  const last = enq.at(-1);
  assert.deepEqual(last.tiers.map((t) => [t.tier, t.hash]), [['small', st.small], ['original', ghost]], 'once transcoded, handed to the upload queue: small first, then large');
  // 没有视频流(纯音频的 mp4)
  const audioOnly = path.join(OUT, 'i2b-audio.mp4');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', audioOnly]);
  const ah = sha256File(audioOnly);
  fs.copyFileSync(audioOnly, path.join(dir, `${ah}.mp4`));
  await m.backfill({ hash: ah, ext: 'mp4' });
  await m.idle();
  assert.equal(m.status([ah])[ah].state, 'none');
  const n = enq.length;
  assert.deepEqual(await m.backfill({ hash: ah, ext: 'mp4' }), { state: 'none', reason: 'no-video' }, 'files known to have no video stream are not transcoded again');
  await m.idle();
  assert.equal(enq.length, n, 'and not handed to the upload queue again either');
});

/* ======================================================================== *
 * C66-I3 预渲染进程 /api/export 的导出拦截
 * ======================================================================== */

const H = (c) => c.repeat(64);
const projectOf = () => ({
  id: 'p', name: 'p', fps: 30, duration: 2,
  media: [
    { id: 'm1', kind: 'video', name: 'one.mp4', url: `/@media/${H('1')}`, hash: H('1'), tiers: { original: H('1'), small: H('2') } },
    { id: 'm2', kind: 'video', name: 'two.mov', url: `/@media/${H('3')}`, hash: H('3') },
    { id: 'm3', kind: 'video', name: 'unused.mp4', url: `/@media/${H('4')}`, hash: H('4') },
    { id: 'm4', kind: 'video', name: 'legacy.mp4', url: '/api/media/file?path=x' },
  ],
  tracks: [{ id: 'v', kind: 'video', clips: [
    { id: 'c1', mediaId: 'm1', start: 0, end: 1 },
    { id: 'c2', mediaId: 'm2', start: 1, end: 2 },
    { id: 'c4', mediaId: 'm4', start: 0, end: 1 },
  ] }],
});

/** 假的编辑器进程:只答 /api/media/originals,`incomplete` 是当前素材服务上没到齐的哈希 */
async function fakeEditor(incomplete) {
  const asked = [];
  const origin = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/media/originals') {
        const hashes = JSON.parse(body).hashes;
        asked.push(hashes);
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ ok: true, remote: null, missing: hashes.filter((h) => incomplete.includes(h)) }));
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return { origin, asked };
}

const { exportOriginalsGate } = await import(serverUrl('export-originals.ts'));

test('C66-I3-01 exportOriginalsGate: asks only for original-size assets that are referenced by clips and carry a hash; missing ones are listed with a "waiting for the uploader" notice; if it cannot ask, they count as not all arrived', async () => {
  const ed = await fakeEditor([H('3')]);
  const r = await exportOriginalsGate(projectOf(), { origin: ed.origin });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'awaiting-uploader');
  assert.match(r.message, /Waiting for uploader/);
  assert.deepEqual(r.missing.map((m) => [m.mediaId, m.hash]), [['m2', H('3')]]);
  assert.deepEqual(ed.asked, [[H('1'), H('3')]], 'ask for all of them at once; do not ask for small sizes, unused ones, or old assets without a hash');
  const ok = await exportOriginalsGate(projectOf(), { origin: (await fakeEditor([])).origin });
  assert.deepEqual(ok, { ok: true, missing: [] });
  const down = await exportOriginalsGate(projectOf(), { origin: 'http://127.0.0.1:9' , timeoutMs: 2000 });
  assert.equal(down.ok, false, 'the editor process cannot be queried: better to block');
  assert.equal(down.missing.length, 2);
  const noHash = projectOf();
  noHash.tracks[0].clips = [{ id: 'c4', mediaId: 'm4', start: 0, end: 1 }];
  const quiet = await fakeEditor([]);
  assert.deepEqual(await exportOriginalsGate(noHash, { origin: quiet.origin }), { ok: true, missing: [] });
  assert.deepEqual(quiet.asked, [], 'no hashed asset is referenced: no request is sent');
});

test('C66-I3-02 prerender process POST /api/export: if the original-size assets have not all arrived, replies 409 awaiting-uploader and lists the missing assets, creates no export directory and starts no export process', async () => {
  const ed = await fakeEditor([H('1'), H('3')]);
  const exportDir = path.join(OUT, 'i3-export');
  process.env.PROMPTCUT_EDITOR_URL = ed.origin;
  process.env.PROMPTCUT_EXPORT_DIR = exportDir;
  after(() => { delete process.env.PROMPTCUT_EDITOR_URL; delete process.env.PROMPTCUT_EXPORT_DIR; });
  const { exportPlugin } = await import(serverUrl('vite-plugin-export.ts'));
  let handler = null;
  exportPlugin().configureServer({ config: { root: OUT, server: { port: 1 } }, middlewares: { use: (fn) => { handler = fn; } }, httpServer: null });
  assert.equal(typeof handler, 'function');
  const origin = await listen((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  const res = await postJson(`${origin}/api/export`, { project: projectOf(), frames: '0-1' });
  const text = await res.text();
  assert.equal(res.status, 409, `response: ${text.slice(0, 300)}; editor process was asked: ${JSON.stringify(ed.asked)}`);
  const body = JSON.parse(text);
  assert.equal(body.code, 'awaiting-uploader');
  assert.match(body.message, /Waiting for uploader/);
  assert.deepEqual(body.missing.map((m) => m.mediaId), ['m1', 'm2']);
  assert.ok(!fs.existsSync(exportDir), 'the export directory is not created when blocked');
});
