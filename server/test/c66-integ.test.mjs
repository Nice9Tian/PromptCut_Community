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
  if (r.status !== 0) throw new Error(`ffmpeg 失败:${r.stderr}`);
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

test('C66-I1-01 POST /api/media/upload-queue/target { base, ticket } 换上传目标;{ base: null } 换回本机', async () => {
  const root = path.join(OUT, 'i1');
  fs.mkdirSync(media.mediaDir(root), { recursive: true });
  const origin = await listen(serviceHandler(root));
  const service = await media.mediaTierService(root);
  after(() => service.queue?.stop());
  let r = await postJson(`${origin}/api/media/upload-queue/target`, { base: 'http://10.9.8.7:5460/api/asset', ticket: 'rw-ticket-1' });
  assert.equal(r.status, 200);
  let q = await (await fetch(`${origin}/api/media/upload-queue`)).json();
  assert.deepEqual(q.target, { base: 'http://10.9.8.7:5460/api/asset' }, '目标换成远程素材服务');
  assert.ok(!JSON.stringify(q).includes('rw-ticket-1'), '诊断回包里不带票据');
  r = await postJson(`${origin}/api/media/upload-queue/target`, { base: null });
  assert.equal(r.status, 200);
  q = await (await fetch(`${origin}/api/media/upload-queue`)).json();
  assert.equal(q.target, null, '离开共享项目:回到本机素材服务(队列空操作)');
  r = await postJson(`${origin}/api/media/upload-queue/target`, { base: 'file:///x' });
  assert.equal(r.status, 400, '只收 http(s) 基址');
});

test('C66-I1-05 设了 PROMPTCUT_ASSET_URL 时:页面给的远程目标优先,{ base: null } 回到环境变量给的目标(不是本机)', async () => {
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
  assert.deepEqual(await target(), { base: 'http://192.168.9.9:5460/api/asset' }, '回到缺省目标');
});

/* ======================================================================== *
 * C66-I2 打开项目时补转素材小尺寸
 * ======================================================================== */

test('C66-I2-01 补转:不带 tiers 入库的视频(同 .procp 还原)→ backfill 排素材小尺寸,不重封装、原尺寸哈希不变;好了 GET /api/media/tiers 报 ready', { skip: !ffmpegOk && '没有 ffmpeg', timeout: 180_000 }, async () => {
  const root = path.join(OUT, 'i2');
  fs.mkdirSync(media.mediaDir(root), { recursive: true });
  const origin = await listen(serviceHandler(root));
  const src = lateMoov('i2-late.mp4');
  // 不带 ?tiers=1:.procp 还原、配音等走的路,不做两档
  const upRes = await fetch(`${origin}/api/media/upload/i2-late.mp4`, { method: 'POST', body: fs.readFileSync(src) });
  const upText = await upRes.text();
  assert.equal(upRes.status, 200, upText.slice(0, 300));
  const up = JSON.parse(upText);
  assert.equal(up.hash, sha256File(src), '不带 tiers 的入库不重封装');
  assert.equal(up.tiers, undefined);
  const missing = 'f'.repeat(64);
  const res = await postJson(`${origin}/api/media/tiers/backfill`, { items: [{ hash: up.hash, name: 'i2-late.mp4' }, { hash: missing }, { hash: 'nope' }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items[up.hash]?.state, 'pending', `本地有素材原尺寸的视频:排进后台转码 —— ${JSON.stringify(body)}`);
  assert.deepEqual(body.items[missing], { state: 'absent' }, '本地没有素材原尺寸:不转(不为了转小尺寸去拉原尺寸)');
  assert.equal(body.items.nope, undefined, '不是哈希的忽略');
  const service = await media.mediaTierService(root);
  await service.manager.idle();
  const st = await (await fetch(`${origin}/api/media/tiers?hashes=${up.hash}`)).json();
  assert.equal(st.items[up.hash].state, 'ready');
  const small = st.items[up.hash].small;
  assert.match(small, /^[0-9a-f]{64}$/);
  const smallFile = path.join(media.mediaDir(root), `${small}.mp4`);
  assert.ok(fs.existsSync(smallFile), '小尺寸进了本地内容库');
  const lib = path.join(media.mediaDir(root), `${up.hash}.mp4`);
  assert.equal(sha256File(lib), up.hash, '素材原尺寸字节不动(哈希就是项目引用的那个)');
  assert.ok(topBoxes(lib).indexOf('mdat') < topBoxes(lib).indexOf('moov'), '补转不重封装:素材原尺寸仍是晚置 moov');
  // 再问一次:已经有了,直接回 ready,不再转
  const again = await (await postJson(`${origin}/api/media/tiers/backfill`, { items: [{ hash: up.hash }] })).json();
  assert.deepEqual(again.items[up.hash], { state: 'ready', small });
});

test('C66-I2-02 两档管理器 backfill:图片 / 音频扩展名跳过;确定没有视频流的不再转;上次失败的再试;转好交给上传队列(先小后大)', { skip: !ffmpegOk && '没有 ffmpeg', timeout: 180_000 }, async () => {
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
  assert.deepEqual(await m.backfill({ hash: ghost, ext: 'mp4' }), { state: 'pending' }, '上次失败的再试一次');
  await m.idle();
  const st = m.status([ghost])[ghost];
  assert.equal(st.state, 'ready');
  const last = enq.at(-1);
  assert.deepEqual(last.tiers.map((t) => [t.tier, t.hash]), [['small', st.small], ['original', ghost]], '转好交给上传队列:先小后大');
  // 没有视频流(纯音频的 mp4)
  const audioOnly = path.join(OUT, 'i2b-audio.mp4');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', audioOnly]);
  const ah = sha256File(audioOnly);
  fs.copyFileSync(audioOnly, path.join(dir, `${ah}.mp4`));
  await m.backfill({ hash: ah, ext: 'mp4' });
  await m.idle();
  assert.equal(m.status([ah])[ah].state, 'none');
  const n = enq.length;
  assert.deepEqual(await m.backfill({ hash: ah, ext: 'mp4' }), { state: 'none', reason: 'no-video' }, '确定没有视频流的不再转');
  await m.idle();
  assert.equal(enq.length, n, '也不重复交给上传队列');
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

test('C66-I3-01 exportOriginalsGate:只问被片段引用、带哈希的素材原尺寸;缺的列出来并提示「等待上传方」;问不到按没到齐算', async () => {
  const ed = await fakeEditor([H('3')]);
  const r = await exportOriginalsGate(projectOf(), { origin: ed.origin });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'awaiting-uploader');
  assert.match(r.message, /等待上传方/);
  assert.deepEqual(r.missing.map((m) => [m.mediaId, m.hash]), [['m2', H('3')]]);
  assert.deepEqual(ed.asked, [[H('1'), H('3')]], '一次问齐;不问小尺寸、不问没用到的、不问没有哈希的老素材');
  const ok = await exportOriginalsGate(projectOf(), { origin: (await fakeEditor([])).origin });
  assert.deepEqual(ok, { ok: true, missing: [] });
  const down = await exportOriginalsGate(projectOf(), { origin: 'http://127.0.0.1:9' , timeoutMs: 2000 });
  assert.equal(down.ok, false, '编辑器进程问不到:宁可拦下');
  assert.equal(down.missing.length, 2);
  const noHash = projectOf();
  noHash.tracks[0].clips = [{ id: 'c4', mediaId: 'm4', start: 0, end: 1 }];
  const quiet = await fakeEditor([]);
  assert.deepEqual(await exportOriginalsGate(noHash, { origin: quiet.origin }), { ok: true, missing: [] });
  assert.deepEqual(quiet.asked, [], '没有带哈希的素材被引用:不发请求');
});

test('C66-I3-02 预渲染进程 POST /api/export:素材原尺寸没到齐回 409 awaiting-uploader 并列出缺的素材,不建导出目录、不起导出进程', async () => {
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
  assert.equal(res.status, 409, `回包:${text.slice(0, 300)};编辑器进程被问过:${JSON.stringify(ed.asked)}`);
  const body = JSON.parse(text);
  assert.equal(body.code, 'awaiting-uploader');
  assert.match(body.message, /等待上传方/);
  assert.deepEqual(body.missing.map((m) => m.mediaId), ['m1', 'm2']);
  assert.ok(!fs.existsSync(exportDir), '拦下时不建导出目录');
});
