// C6.6 两档素材与上传队列(`docs/plan/c66-design.md` 第 2、3 节,验收 T1～T3)。
// 跑:node --test server/test/media-tiers.test.mjs
//
// 素材插件是 .ts:和 asset-service.test 一样用 typescript 转译到临时目录再 import,
// 它惰性 import 的兄弟模块(media-tiers、upload-queue、bandwidth-gate、bakery/ffmpeg、asset-store/client)换成仓库里的绝对地址。
// 测试素材一律现场用 ffmpeg 生成(第 8 节「测试素材」)。
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
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-media-tiers-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

delete process.env.PROMPTCUT_EXPORT_DIR;
delete process.env.PROMPTCUT_MEDIA_DIR;
delete process.env.PROMPTCUT_EDITOR_URL;
delete process.env.PROMPTCUT_ASSET_URL;
delete process.env.PROMPTCUT_HEADLESS;

/** T3 的假客户端不读文件,resolveFile 回一个存在的路径即可 */
const HERE = fileURLToPath(import.meta.url);
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
]));
const asset = await import(compile('server/asset-service.ts', 'asset-service.mjs', [
  ['from "./http-guard.mjs"', `from "${serverUrl('http-guard.mjs')}"`],
  ['from "./vite-plugin-media"', 'from "./media.mjs"'],
  ['from "./asset-store/index.mjs"', `from "${serverUrl('asset-store/index.mjs')}"`],
]));
const tiers = await import(serverUrl('media-tiers.mjs'));
const uq = await import(serverUrl('upload-queue.mjs'));
const gateMod = await import(serverUrl('bandwidth-gate.mjs'));
const { createAssetClient } = await import(serverUrl('asset-store/client.mjs'));

/* ---------------- 环境 ---------------- */

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

/**
 * 断网注入:夹在上传方与远端素材服务之间的代理。`offline` 为真时直接掐断连接(不转发);
 * 每个请求记一行 `{ method, path, auth, dropped }`。`dropWhen(req)` 回真时从这一个请求起断网。
 */
async function flakyProxy(target) {
  const t = new URL(target);
  const state = { offline: false, log: [], dropWhen: null };
  const origin = await listen((req, res) => {
    const entry = { method: req.method, path: req.url, auth: req.headers.authorization ?? null, dropped: false };
    state.log.push(entry);
    if (!state.offline && state.dropWhen?.(req)) state.offline = true;
    if (state.offline) { entry.dropped = true; req.socket.destroy(); return; }
    const up = http.request({ hostname: t.hostname, port: t.port, method: req.method, path: req.url, headers: { ...req.headers, host: t.host } }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  return { origin, state };
}

const ff = (args) => {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-v', 'error', ...args], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 失败:${r.stderr}`);
};
const probe = (file) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true, encoding: 'utf8' });
  return JSON.parse(r.stdout);
};
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fixtures = path.join(OUT, 'fixtures');
fs.mkdirSync(fixtures, { recursive: true });
/** 1080p、带音轨、moov 在尾(ffmpeg 写 MP4 的缺省)、约 17 MB(3 片) */
const LATE_1080 = path.join(fixtures, 'late-1080.mp4');
const PRORES = path.join(fixtures, 'prores.mov');
const FASTSTART = path.join(fixtures, 'fast.mp4');
const HDR = path.join(fixtures, 'hdr-pq.mp4');
if (ffmpegOk) {
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', LATE_1080]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '2', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-an', PRORES]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', FASTSTART]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1', '-vf', 'format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv',
    '-c:v', 'libx264', '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', HDR]);
}

async function importFile(origin, file, name = path.basename(file), query = '?tiers=1') {
  const res = await fetch(`${origin}/api/media/upload/${encodeURIComponent(name)}${query}`, { method: 'POST', body: fs.readFileSync(file) });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}
const chunksOf = async (base, hash) => (await fetch(`${base}/media/${hash}/chunks`)).json();

/** 回包里只许有这些字段:同步状态(传没传完)不进回包、不进项目 */
const RESPONSE_KEYS = new Set(['ok', 'hash', 'ext', 'name', 'path', 'url', 'bytes', 'deduped', 'tiers', 'small', 'remux']);
const SYNC_WORDS = /upload|sync|complete|received|progress|queued/i;

/* ======================================================================== *
 * T1:导入 1080p 视频 → 素材小尺寸 ≤ 800×600、H.264、faststart;素材原尺寸编码不变;tiers 两个哈希
 * ======================================================================== */

const rootA = path.join(OUT, 'importer');
fs.mkdirSync(media.mediaDir(rootA), { recursive: true });
const originA = await listen(serviceHandler(rootA));

test('T1-1 导入 1080p 晚置 moov 的 MP4:素材原尺寸按 faststart 重封装(编码不变、按输出哈希入库),素材小尺寸 800×450 H.264 faststart;连本地素材服务时队列空操作', { skip: !ffmpegOk && '没有 ffmpeg' }, async () => {
  const srcHash = sha256File(LATE_1080);
  assert.equal(await tiers.faststartState(LATE_1080), 'needs', '测试素材本身应当缺 faststart');
  const body = await importFile(originA, LATE_1080);
  assert.equal(body.remux.state, 'remuxed');
  assert.equal(body.remux.from, srcHash);
  assert.notEqual(body.hash, srcHash, '重封装的结果是新的素材原尺寸,哈希不同');
  assert.equal(body.tiers.original, body.hash);
  assert.ok(['pending', 'ready'].includes(body.small));
  for (const key of Object.keys(body)) assert.ok(RESPONSE_KEYS.has(key), `回包多了字段 ${key}`);

  const service = await media.mediaTierService(rootA);
  await service.manager.idle();
  const st = await (await fetch(`${originA}/api/media/tiers?hashes=${body.hash}`)).json();
  const rec = st.items[body.hash];
  assert.equal(rec.state, 'ready');
  assert.match(rec.small, /^[0-9a-f]{64}$/);

  // 素材原尺寸:库里的就是重封装后的,moov 在前,流的编码与源文件逐一相同
  const orig = path.join(media.mediaDir(rootA), `${body.hash}.mp4`);
  assert.equal(sha256File(orig), body.hash);
  assert.equal(await tiers.faststartState(orig), 'faststart');
  const a = probe(LATE_1080), b = probe(orig);
  assert.deepEqual(b.streams.map((s) => `${s.codec_type}:${s.codec_name}:${s.width ?? ''}x${s.height ?? ''}`), a.streams.map((s) => `${s.codec_type}:${s.codec_name}:${s.width ?? ''}x${s.height ?? ''}`));
  // 重封装前那份不留在库里
  assert.equal((await fetch(`${originA}/@media/${srcHash}`)).status, 404);

  // 素材小尺寸:≤ 800×600、H.264、faststart、AAC
  const small = path.join(media.mediaDir(rootA), `${rec.small}.mp4`);
  const sp = probe(small);
  const v = sp.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.ok(v.width <= 800 && v.height <= 600, `${v.width}x${v.height}`);
  assert.deepEqual([v.width, v.height], [800, 450]);
  assert.equal(sp.streams.find((s) => s.codec_type === 'audio')?.codec_name, 'aac');
  assert.equal(await tiers.faststartState(small), 'faststart');

  // 连本地素材服务:两档都已在本地素材服务上 complete,上传队列什么都没进
  assert.equal((await chunksOf(`${originA}/api/asset`, body.hash)).complete, true);
  assert.equal((await chunksOf(`${originA}/api/asset`, rec.small)).complete, true);
  const q = await (await fetch(`${originA}/api/media/upload-queue`)).json();
  assert.equal(q.target, null);
  assert.equal(q.queue.items.length, 0);
  assert.ok(q.queue.skippedLocal >= 1);

  // 同一个文件再导入一次:复用上次重封装的结果,哈希相同
  const again = await importFile(originA, LATE_1080, 'again.mp4');
  assert.equal(again.hash, body.hash);
  assert.equal(again.remux.reused, true);
  assert.equal(again.tiers.small, rec.small);
});

test('T1-2 ProRes MOV:素材原尺寸仍是 ProRes(只做同容器重封装),素材小尺寸是 H.264', { skip: !ffmpegOk && '没有 ffmpeg' }, async () => {
  const body = await importFile(originA, PRORES);
  assert.equal(body.ext, 'mov');
  assert.ok(['remuxed', 'faststart'].includes(body.remux.state), JSON.stringify(body.remux));
  const service = await media.mediaTierService(rootA);
  await service.manager.idle();
  const rec = service.manager.status([body.hash])[body.hash];
  assert.equal(rec.state, 'ready');
  const orig = path.join(media.mediaDir(rootA), `${body.hash}.mov`);
  assert.equal(probe(orig).streams[0].codec_name, 'prores');
  assert.equal(await tiers.faststartState(orig), 'faststart');
  const v = probe(path.join(media.mediaDir(rootA), `${rec.small}.mp4`)).streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.deepEqual([v.width, v.height], [640, 360], '不放大');
  // 没有音轨也能生成(-map 0:a:0?)
  assert.equal(probe(path.join(media.mediaDir(rootA), `${rec.small}.mp4`)).streams.some((s) => s.codec_type === 'audio'), false);
});

test('T1-3 已经 faststart 的 MP4 不重封装,哈希就是源文件的 sha256', { skip: !ffmpegOk && '没有 ffmpeg' }, async () => {
  const body = await importFile(originA, FASTSTART);
  assert.equal(body.remux.state, 'faststart');
  assert.equal(body.hash, sha256File(FASTSTART));
});

test('T1-4 只对视频做:图片、音频导入不带 tiers,也不排素材小尺寸', { skip: !ffmpegOk && '没有 ffmpeg' }, async () => {
  const png = path.join(fixtures, 'still.png');
  const m4a = path.join(fixtures, 'tone.m4a');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1', png]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:a', 'aac', m4a]);
  for (const f of [png, m4a]) {
    const body = await importFile(originA, f);
    assert.equal('tiers' in body, false, path.basename(f));
    assert.equal(body.hash, sha256File(f));
    const service = await media.mediaTierService(rootA);
    assert.equal(service.manager.status([body.hash])[body.hash].state, 'unknown');
  }
  // 不带 tiers=1 的老调用(.procp 还原、配音)行为不变:不重封装
  const plain = await importFile(originA, LATE_1080, 'plain.mp4', '');
  assert.equal(plain.hash, sha256File(LATE_1080));
  assert.equal('tiers' in plain, false);
});

test('T1-5 HDR(BT.2020 + PQ 标签完整)走 zscale + tonemap 分支,素材小尺寸标 BT.709', { skip: !ffmpegOk && '没有 ffmpeg' }, async () => {
  const info = await tiers.probeMedia('ffprobe', HDR);
  assert.equal(tiers.isHdrPq(info.video), true);
  assert.match(tiers.smallVideoFilter({ hdr: true, video: info.video }), /zscale=tin=smpte2084:pin=bt2020.*tonemap=tonemap=hable/);
  assert.doesNotMatch(tiers.smallVideoFilter({ hdr: false }), /tonemap/);
  const out = path.join(OUT, 'hdr-small.mp4');
  const r = await tiers.makeSmallVersion({ ffmpeg: 'ffmpeg', input: HDR, output: out });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.hdr, true);
  const v = probe(out).streams[0];
  assert.deepEqual([v.codec_name, v.pix_fmt, v.color_primaries, v.color_transfer, v.width, v.height], ['h264', 'yuv420p', 'bt709', 'bt709', 800, 450]);
  // SDR 源不走这个分支
  assert.equal(tiers.isHdrPq((await tiers.probeMedia('ffprobe', FASTSTART)).video), false);
});

test('T1-6 素材小尺寸命令:VFR 保留,只丢间隔不足 1/60 s 的帧(120 fps → 60 fps,30 fps 一帧不丢)', { skip: !ffmpegOk && '没有 ffmpeg' }, async () => {
  const hi = path.join(fixtures, 'hi120.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=120', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', hi]);
  const out = path.join(OUT, 'hi-small.mp4');
  assert.equal((await tiers.makeSmallVersion({ ffmpeg: 'ffmpeg', input: hi, output: out })).ok, true);
  assert.equal(Number(probe(out).streams[0].nb_frames), 120);
  const args = tiers.smallVideoArgs('in', 'out');
  for (const want of ['-map', '0:a:0?', '-fps_mode:v', 'vfr', 'libx264', 'veryfast', '26', '64k', '+faststart']) assert.ok(args.includes(want), want);
  const out30 = path.join(OUT, 'fast-small.mp4');
  assert.equal((await tiers.makeSmallVersion({ ffmpeg: 'ffmpeg', input: FASTSTART, output: out30 })).ok, true);
  assert.equal(Number(probe(out30).streams[0].nb_frames), 30);
});

test('T1-7 ISO BMFF box 扫描:64 位长度、size=0、分片 MP4、坏长度', async () => {
  const box = (type, payload = 0, { large = false, zero = false } = {}) => {
    if (large) { const b = Buffer.alloc(16 + payload); b.writeUInt32BE(1, 0); b.write(type, 4, 'latin1'); b.writeBigUInt64BE(BigInt(16 + payload), 8); return b; }
    const b = Buffer.alloc(8 + payload); b.writeUInt32BE(zero ? 0 : 8 + payload, 0); b.write(type, 4, 'latin1'); return b;
  };
  const write = (name, parts) => { const f = path.join(OUT, name); fs.writeFileSync(f, Buffer.concat(parts)); return f; };
  assert.equal(await tiers.faststartState(write('a.mp4', [box('ftyp', 8), box('moov', 20), box('mdat', 100, { large: true })])), 'faststart');
  assert.equal(await tiers.faststartState(write('b.mp4', [box('ftyp', 8), box('mdat', 100, { large: true }), box('moov', 20)])), 'needs');
  assert.equal(await tiers.faststartState(write('c.mp4', [box('ftyp', 8), box('moov', 20), box('mdat', 50, { zero: true })])), 'faststart');
  assert.equal(await tiers.faststartState(write('d.mp4', [box('ftyp', 8), box('moov', 20), box('moof', 10), box('mdat', 30)])), 'fragmented');
  const bad = box('mdat', 10); bad.writeUInt32BE(4, 0);
  assert.equal(await tiers.faststartState(write('e.mp4', [box('ftyp', 8), bad])), 'unknown');
  assert.equal(await tiers.faststartState(write('f.mp4', [box('ftyp', 8), box('mdat', 10)])), 'unknown');
});

test('T1-8 重封装失败保留源文件当素材原尺寸,不转码', { skip: !ffmpegOk && '没有 ffmpeg' }, async () => {
  const root = path.join(OUT, 'remux-fail');
  const dir = media.mediaDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const manager = tiers.createTierManager({
    dir,
    lib: { hashFile: media.hashFile, writeIndex: (h, e) => media.writeMediaIndex(root, h, e), contentTypeForExt: media.contentTypeForExt },
    ffmpeg: async () => path.join(OUT, 'no-such-ffmpeg.exe'),
  });
  const stored = await media.storeMediaStream(root, 'x.mp4', fs.createReadStream(LATE_1080));
  const out = await manager.prepareImport(stored);
  assert.equal(out.remux.state, 'failed');
  assert.equal(out.stored.hash, stored.hash);
  assert.ok(fs.existsSync(stored.path), '源文件还在');
  assert.equal(sha256File(stored.path), stored.hash);
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('.remux-')), false, '临时文件已删');
  await manager.idle();
  assert.equal(manager.status([stored.hash])[stored.hash].state, 'failed');
});

/* ======================================================================== *
 * T2:断网导入再联网 —— 只补缺片;两档的 chunks 分别 complete;回包、项目记录没有同步字段
 * ======================================================================== */

test('T2-1 经插件接线:连远程素材服务,传到素材原尺寸第 2 片时断网,联网后只补缺的分片;两档 chunks 分别 complete;带票据', { skip: !ffmpegOk && '没有 ffmpeg', timeout: 60_000 }, async () => {
  const rootR = path.join(OUT, 'remote');
  fs.mkdirSync(media.mediaDir(rootR), { recursive: true });
  const remote = await listen(serviceHandler(rootR));
  const proxy = await flakyProxy(remote);
  const rootB = path.join(OUT, 'importer-b');
  fs.mkdirSync(media.mediaDir(rootB), { recursive: true });
  const originB = await listen(serviceHandler(rootB));
  const service = await media.mediaTierService(rootB);
  service.queue.start();
  after(() => service.queue.stop());
  const set = await fetch(`${originB}/api/media/upload-queue/target`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: `${proxy.origin}/api/asset`, ticket: 'test-ticket-1' }) });
  assert.equal(set.status, 200);

  const srcBytes = fs.statSync(LATE_1080).size;
  assert.ok(srcBytes > 2 * 8 * 1024 * 1024, `测试素材要超过 2 片,实际 ${srcBytes}`);
  // 素材原尺寸第 1 号分片(第 2 片)一到就断网
  let original = null;
  proxy.state.dropWhen = (req) => original && req.method === 'PUT' && req.url === `/api/asset/media/${original}/1`;
  const body = await importFile(originB, LATE_1080, 'offline.mp4');
  original = body.hash;
  await service.manager.idle();
  const small = service.manager.status([original])[original].small;
  assert.match(small, /^[0-9a-f]{64}$/);

  // 等到断网之后客户端的几次重试都失败、队列进了退避
  const t0 = Date.now();
  while (!(service.queue.stats().failures >= 1) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 50));
  assert.ok(service.queue.stats().failures >= 1, '断网应当让这一素材失败一次');
  const before = await chunksOf(`${remote}/api/asset`, original);
  assert.deepEqual(before.received, [0], '断网前只收到第 0 片');
  assert.equal(before.complete, false);
  assert.equal((await chunksOf(`${remote}/api/asset`, small)).complete, true, '素材小尺寸先传,断网前已完整');

  // 联网,等队列清空(队列退避 5 s 后重试)
  proxy.state.offline = false;
  proxy.state.dropWhen = null;
  let guard;
  await Promise.race([service.queue.drain(), new Promise((_, rej) => { guard = setTimeout(() => rej(new Error('队列 30 s 没清空')), 30_000); })])
    .finally(() => clearTimeout(guard));

  const puts = proxy.state.log.filter((e) => e.method === 'PUT' && !e.dropped).map((e) => e.path.replace('/api/asset/media/', '').replace(small, 'S').replace(original, 'O'));
  assert.deepEqual(puts, ['S/0', 'O/0', 'O/1', 'O/2'], `实际 PUT 顺序 ${JSON.stringify(puts)}`);
  const dropped = proxy.state.log.filter((e) => e.dropped).length;
  assert.ok(dropped >= 1);
  // 两档分别 complete
  const cs = await chunksOf(`${remote}/api/asset`, small);
  const co = await chunksOf(`${remote}/api/asset`, original);
  assert.equal(cs.complete, true);
  assert.equal(co.complete, true);
  assert.deepEqual(co.received, [0, 1, 2]);
  // 远端取回的字节就是本机那两份
  const got = Buffer.from(await (await fetch(`${remote}/api/asset/media/${original}`)).arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(got).digest('hex'), original);
  // 每个请求都带票据(只进 Authorization 头,不进地址)
  const sent = proxy.state.log.filter((e) => !e.dropped);
  assert.ok(sent.length > 0 && sent.every((e) => e.auth === 'Bearer test-ticket-1'), '每个请求都带 Bearer 票据');
  assert.ok(sent.every((e) => !/[?&]t=/.test(e.path)));
  // 回包与本机登记都没有同步状态
  for (const key of Object.keys(body)) assert.ok(RESPONSE_KEYS.has(key) && !SYNC_WORDS.test(key), `回包字段 ${key}`);
  const saved = JSON.parse(fs.readFileSync(path.join(media.mediaDir(rootB), 'tiers.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(saved.items[original]), SYNC_WORDS);
  // 队列文件里这一素材已出队
  const qfile = JSON.parse(fs.readFileSync(path.join(rootB, 'out', 'upload-queue.json'), 'utf8'));
  assert.deepEqual(qfile.items, []);
});

test('T2-3 连远程素材服务时新导入的图片、音频也进上传队列(只有素材原尺寸一档),远端 complete、字节一致;不登记两档状态', { timeout: 30_000 }, async () => {
  const rootR = path.join(OUT, 'remote-still');
  fs.mkdirSync(media.mediaDir(rootR), { recursive: true });
  const remote = await listen(serviceHandler(rootR));
  const rootC = path.join(OUT, 'importer-c');
  fs.mkdirSync(media.mediaDir(rootC), { recursive: true });
  const originC = await listen(serviceHandler(rootC));
  const service = await media.mediaTierService(rootC);
  service.queue.start();
  after(() => service.queue.stop());
  const set = await fetch(`${originC}/api/media/upload-queue/target`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: `${remote}/api/asset`, ticket: 'test-ticket-3' }) });
  assert.equal(set.status, 200);
  const files = [];
  for (const [name, size] of [['still.png', 40_000], ['voice.mp3', 9 * 1024 * 1024]]) {
    const f = path.join(OUT, `t23-${name}`);
    fs.writeFileSync(f, crypto.randomBytes(size));
    files.push({ name, f, hash: sha256File(f) });
  }
  for (const it of files) {
    const body = await importFile(originC, it.f, it.name);
    assert.equal(body.hash, it.hash);
    assert.equal('tiers' in body, false, '不是视频:回包照旧不带 tiers');
    assert.equal(service.manager.status([it.hash])[it.hash].state, 'unknown', '不登记两档状态');
  }
  let guard;
  await Promise.race([service.queue.drain(), new Promise((_, rej) => { guard = setTimeout(() => rej(new Error('队列 20 s 没清空')), 20_000); })])
    .finally(() => clearTimeout(guard));
  for (const it of files) {
    const c = await chunksOf(`${remote}/api/asset`, it.hash);
    assert.equal(c.complete, true, `${it.name} 在远端 complete`);
    const got = Buffer.from(await (await fetch(`${remote}/api/asset/media/${it.hash}`)).arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(got).digest('hex'), it.hash, `${it.name} 远端字节一致`);
  }
  assert.ok(service.queue.stats().done >= 2);
});

test('T2-2 重启续传:断网时停掉队列(留在 upload-queue.json 里),新建的队列读回来接着传,只补缺片', { timeout: 30_000 }, async () => {
  const rootR = path.join(OUT, 'remote-2');
  fs.mkdirSync(media.mediaDir(rootR), { recursive: true });
  const remote = await listen(serviceHandler(rootR));
  const proxy = await flakyProxy(remote);
  const lib = path.join(OUT, 'lib-2');
  fs.mkdirSync(lib, { recursive: true });
  const bytes = crypto.randomBytes(8 * 1024 * 1024 * 2 + 1234);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(lib, `${hash}.mp4`), bytes);
  const smallBytes = crypto.randomBytes(5000);
  const smallHash = crypto.createHash('sha256').update(smallBytes).digest('hex');
  fs.writeFileSync(path.join(lib, `${smallHash}.mp4`), smallBytes);
  const file = path.join(OUT, 'q2', 'upload-queue.json');
  const client = createAssetClient({ base: `${proxy.origin}/api/asset`, retries: 0 });
  const events = [];
  const make = () => uq.createUploadQueue({
    file, target: () => ({ client }), resolveFile: (h) => path.join(lib, `${h}.mp4`), backoff: [30],
    log: (e, f) => events.push({ e, ...f }),
  });
  proxy.state.dropWhen = (req) => req.method === 'PUT' && req.url === `/api/asset/media/${hash}/2`;
  const q1 = make();
  q1.start();
  await q1.enqueue({ name: 'r.mp4', tiers: [{ tier: 'original', hash, ext: 'mp4' }, { tier: 'small', hash: smallHash, ext: 'mp4' }] });
  const t0 = Date.now();
  while (!events.some((e) => e.e === 'upload.retry') && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
  await q1.stop();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 1, '停下时这一素材留在文件里');
  assert.deepEqual((await chunksOf(`${remote}/api/asset`, hash)).received, [0, 1]);

  proxy.state.offline = false;
  proxy.state.dropWhen = null;
  const q2 = make();
  assert.equal(q2.stats().restored, 1);
  const logMark = proxy.state.log.length;
  const eventMark = events.length;
  q2.start();
  await q2.drain();
  await q2.stop();
  // 「重启后只补缺片」看 q2 整个过程发出的全部分片，而不只看最后一次 tier-done：客户端 retries 为 0，
  // 机器忙时 q2 可能撞上一次连接抖动（代理刚销毁过套接字）而整项重试，第二遍素材原尺寸已齐、tier-done 的 sent 是 []。
  // 判据没放宽：q2 只要重发了第 0、1 片（或根本没发第 2 片），下面两条都会挂。
  const tierDone = events.slice(eventMark).filter((e) => e.e === 'upload.tier-done' && e.hash === hash);
  assert.ok(tierDone.length >= 1, '重启后素材原尺寸传完');
  assert.deepEqual([...new Set(tierDone.flatMap((e) => e.sent))].sort(), [2], `重启后只补第 2 片：${JSON.stringify(tierDone.map((e) => e.sent))}`);
  const puts = proxy.state.log.slice(logMark)
    .filter((x) => x.method === 'PUT' && x.path.startsWith(`/api/asset/media/${hash}/`))
    .map((x) => Number(x.path.split('/').at(-1)));
  assert.deepEqual([...new Set(puts)].sort(), [2], `重启后发往素材服务的素材原尺寸分片只有第 2 片：${JSON.stringify(puts)}`);
  assert.equal((await chunksOf(`${remote}/api/asset`, hash)).complete, true);
  assert.equal((await chunksOf(`${remote}/api/asset`, smallHash)).complete, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items, []);
});

/* ======================================================================== *
 * T3:队列顺序 —— 逐个素材、先小后大;素材排在产物后面
 * ======================================================================== */

/** 内存里的素材服务客户端:记下每一片;`failOnce` 里的哈希第一次 PUT 抛网络错误 */
function memoryClient({ failOnce = new Set(), delayMs = 5 } = {}) {
  const store = new Map();
  const calls = [];
  return {
    calls,
    async putFile(ns, file, { hash, beforeChunk }) {
      const st = store.get(hash) ?? { received: new Set(), complete: false };
      store.set(hash, st);
      if (st.complete) return { hash, size: 1, uploaded: false, sent: [] };
      const release = await beforeChunk?.(0);
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        if (failOnce.has(hash)) { failOnce.delete(hash); throw Object.assign(new Error('network'), { code: 'network' }); }
        calls.push(hash);
        st.received.add(0);
      } finally { release?.(); }
      st.complete = true;
      return { hash, size: 1, uploaded: true, sent: [0] };
    },
    async chunks(ns, hash) { const st = store.get(hash); return { complete: !!st?.complete, received: [...(st?.received ?? [])] }; },
  };
}
const H = (c) => c.repeat(64);

test('T3-1 所有素材小尺寸先传、再按进队先后传素材原尺寸;轮到的那一档失败时后面的等着(日志顺序核对)', async () => {
  const client = memoryClient({ failOnce: new Set([H('b')]) });
  const log = [];
  const q = uq.createUploadQueue({ file: null, target: () => ({ client }), resolveFile: () => HERE, backoff: [20], log: (e, f) => log.push(`${e}:${f.id?.[0] ?? ''}:${f.tier ?? ''}`) });
  // 进队顺序 A、B、C;tiers 故意把素材原尺寸写在前面,队列要自己把素材小尺寸排到前面
  await q.enqueue({ name: 'A', tiers: [{ tier: 'original', hash: H('b') }, { tier: 'small', hash: H('a') }] });
  await q.enqueue({ name: 'B', tiers: [{ tier: 'original', hash: H('d') }, { tier: 'small', hash: H('c') }] });
  await q.enqueue({ name: 'C', tiers: [{ tier: 'original', hash: H('e') }] });
  q.start();
  await q.drain();
  await q.stop();
  const order = log.filter((l) => /tier-start|tier-done|item-done|retry/.test(l));
  assert.deepEqual(order, [
    'upload.tier-start:b:small', 'upload.tier-done:b:small', 'upload.tier-start:d:small', 'upload.tier-done:d:small',
    'upload.tier-start:b:original', 'upload.retry:b:',
    'upload.tier-start:b:original', 'upload.tier-done:b:original', 'upload.item-done:b:',
    'upload.tier-start:d:original', 'upload.tier-done:d:original', 'upload.item-done:d:',
    'upload.tier-start:e:original', 'upload.tier-done:e:original', 'upload.item-done:e:',
  ]);
  // 实际落到素材服务的顺序:小 A、小 B、原 A、原 B、原 C
  assert.deepEqual(client.calls, [H('a'), H('c'), H('b'), H('d'), H('e')]);
});

test('T3-2 连本地素材服务(target 回 null)时进队是空操作;队里已有的暂停,换回远程接着传', async () => {
  const client = memoryClient();
  let where = null;
  const q = uq.createUploadQueue({ file: null, target: () => where, resolveFile: () => HERE, backoff: [10] });
  assert.deepEqual(await q.enqueue({ tiers: [{ tier: 'original', hash: H('1') }] }), { queued: false, reason: 'local' });
  assert.equal(q.stats().items.length, 0);
  where = { client };
  await q.enqueue({ tiers: [{ tier: 'original', hash: H('2') }] });
  where = null;
  q.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(client.calls.length, 0, '换回本机期间不传');
  where = { client };
  q.poke();
  await q.drain();
  await q.stop();
  assert.deepEqual(client.calls, [H('2')]);
});

test('T3-3 带宽闸:产物在推或还有等着推的段时,素材的分片等着;产物推完才放行', async () => {
  const gate = gateMod.createBandwidthGate({ pollMs: 10 });
  let pendingArtifacts = 2;
  const unregister = gate.artifactDemand(() => pendingArtifacts);
  const order = [];
  const client = memoryClient({ delayMs: 1 });
  const q = uq.createUploadQueue({ file: null, target: () => ({ client }), resolveFile: () => HERE, gate, log: (e) => { if (e === 'upload.tier-done') order.push('media'); } });
  await q.enqueue({ tiers: [{ tier: 'small', hash: H('5') }, { tier: 'original', hash: H('6') }] });
  q.start();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(client.calls.length, 0, '产物还有 2 段没推,素材一片都不发');
  const end = gate.beginArtifact();
  pendingArtifacts = 0;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(client.calls.length, 0, '产物在推,素材等着');
  order.push('artifact');
  end();
  await q.drain();
  await q.stop();
  unregister();
  assert.deepEqual(order, ['artifact', 'media', 'media']);
  assert.deepEqual(client.calls, [H('5'), H('6')]);
});

test('T3-4 推送队列接在带宽闸上:登记需求、推的时候占着;跨进程探针读 push-queue.json', async () => {
  const { createPushQueue } = await import(serverUrl('artifact-push.mjs'));
  const calls = [];
  let provider = null;
  const fakeGate = {
    beginArtifact() { calls.push('begin'); return () => calls.push('end'); },
    artifactDemand(fn) { provider = fn; calls.push('demand'); return () => { provider = null; calls.push('undemand'); }; },
  };
  const pipeline = { root: null, snapshots() { throw new Error('单测没有帧库'); } };
  const pq = createPushQueue({ pipeline, client: { put() {} }, gate: fakeGate, attach: false, backoff: [60_000] });
  await pq.enqueue({ kind: 'stream', resultKey: 'f'.repeat(64), range: { from: 0, to: 14 } });
  pq.start();
  assert.equal(provider(), 1, '一段等着推');
  const t0 = Date.now();
  while (!calls.includes('end') && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.includes('begin') && calls.includes('end'));
  assert.equal(provider(), 0, '失败进了退避的段不挡素材');
  await pq.stop();
  assert.ok(calls.includes('undemand'));

  // 跨进程探针
  const f = path.join(OUT, 'fl', 'push-queue.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ v: 1, items: [{ unit: {}, priority: 0, attempts: 0 }] }));
  assert.equal(gateMod.pushQueueFileProbe(f, { cacheMs: 0 })(), true);
  fs.writeFileSync(f, JSON.stringify({ v: 1, items: [{ unit: {}, priority: 0, attempts: 2 }] }));
  assert.equal(gateMod.pushQueueFileProbe(f, { cacheMs: 0 })(), false, '都在退避:不算忙');
  fs.writeFileSync(f, JSON.stringify({ v: 1, items: [{ unit: {}, priority: 0, attempts: 0 }] }));
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(f, old, old);
  assert.equal(gateMod.pushQueueFileProbe(f, { cacheMs: 0 })(), false, '久未更新的旧文件不算忙');
  assert.equal(gateMod.pushQueueFileProbe(path.join(OUT, 'none.json'), { cacheMs: 0 })(), false);
});


/* ---- 素材小尺寸全部先传(用户 2026-10-13:「强制先上传小尺寸,然后上传大尺寸」) ---- */

const three = async (q) => {
  await q.enqueue({ name: 'A', tiers: [{ tier: 'small', hash: H('a') }, { tier: 'original', hash: H('b') }] });
  await q.enqueue({ name: 'B', tiers: [{ tier: 'small', hash: H('c') }, { tier: 'original', hash: H('d') }] });
  await q.enqueue({ name: 'C', tiers: [{ tier: 'small', hash: H('7') }, { tier: 'original', hash: H('8') }] });
};

test('T3-5 三个素材一起进队:三份素材小尺寸都先于任何一份素材原尺寸到素材服务', async () => {
  const client = memoryClient();
  const q = uq.createUploadQueue({ file: null, target: () => ({ client }), resolveFile: () => HERE, backoff: [10] });
  await three(q);
  q.start();
  await q.drain();
  await q.stop();
  assert.deepEqual(client.calls, [H('a'), H('c'), H('7'), H('b'), H('d'), H('8')]);
  assert.equal(q.stats().done, 3);
});

test('T3-6 某份素材小尺寸传失败在退避:任何素材原尺寸都不传,等它重试成功', async () => {
  const client = memoryClient({ failOnce: new Set([H('c')]) });
  const log = [];
  const q = uq.createUploadQueue({ file: null, target: () => ({ client }), resolveFile: () => HERE, backoff: [40], log: (e, f) => log.push(`${e}:${f.tier ?? ''}`) });
  await three(q);
  q.start();
  await q.drain();
  await q.stop();
  assert.deepEqual(client.calls, [H('a'), H('c'), H('7'), H('b'), H('d'), H('8')]);
  const firstOriginal = log.indexOf('upload.tier-start:original');
  assert.ok(log.indexOf('upload.retry:') >= 0 && log.indexOf('upload.retry:') < firstOriginal, '重试发生在第一份素材原尺寸之前');
  assert.equal(log.slice(0, firstOriginal).filter((l) => l === 'upload.tier-done:small').length, 3, '第一份素材原尺寸开传前三份素材小尺寸都已传完');
});

test('T3-7 正在传素材原尺寸时新进队的素材:它的素材小尺寸排在剩下的素材原尺寸前面;后补上的素材小尺寸也一样', async () => {
  const client = memoryClient({ delayMs: 20 });
  let q = null;
  let added = false;
  const log = (e, f) => {
    if (e !== 'upload.tier-start' || f.tier !== 'original' || added) return;
    added = true; // 第一份素材原尺寸开传的那一刻:给只有素材原尺寸的 C 补上素材小尺寸,再进一个新素材 D
    void q.enqueue({ name: 'C', tiers: [{ tier: 'small', hash: H('7') }, { tier: 'original', hash: H('8') }] });
    void q.enqueue({ name: 'D', tiers: [{ tier: 'small', hash: H('1') }, { tier: 'original', hash: H('2') }] });
  };
  q = uq.createUploadQueue({ file: null, target: () => ({ client }), resolveFile: () => HERE, backoff: [10], log });
  await q.enqueue({ name: 'A', tiers: [{ tier: 'small', hash: H('a') }, { tier: 'original', hash: H('b') }] });
  await q.enqueue({ name: 'B', tiers: [{ tier: 'small', hash: H('c') }, { tier: 'original', hash: H('d') }] });
  await q.enqueue({ name: 'C', tiers: [{ tier: 'original', hash: H('8') }] });
  q.start();
  await q.drain();
  await q.stop();
  // 小 A、小 B、原 A(正在传的这一档传完才让)、小 C(先进队)、小 D、原 B、原 C、原 D
  assert.deepEqual(client.calls, [H('a'), H('c'), H('b'), H('7'), H('1'), H('d'), H('8'), H('2')]);
});

test('T3-8 应用重启后队列恢复:先把没传完的素材小尺寸传完,再传素材原尺寸;已传完的档不重传', async () => {
  const file = path.join(os.tmpdir(), `pc-upload-order-${process.pid}-${Date.now()}.json`);
  const client = memoryClient({ failOnce: new Set([H('c')]) });
  // 第一个实例:小 A 传完、小 B 失败后退避很久(模拟这时应用被关掉)
  const q1 = uq.createUploadQueue({ file, target: () => ({ client }), resolveFile: () => HERE, backoff: [600_000] });
  await three(q1);
  q1.start();
  for (let i = 0; i < 200 && !q1.stats().failures; i++) await new Promise((r) => setTimeout(r, 10));
  await q1.stop();
  assert.deepEqual(client.calls, [H('a')], '重启前只传完了 A 的素材小尺寸');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 3, '三个素材都还在队列文件里');
  // 第二个实例:同一个队列文件
  const log = [];
  const q2 = uq.createUploadQueue({ file, target: () => ({ client }), resolveFile: () => HERE, backoff: [10], log: (e, f) => { if (e === 'upload.tier-start') log.push(f.tier); } });
  assert.equal(q2.stats().restored, 3);
  q2.start();
  await q2.drain();
  await q2.stop();
  assert.deepEqual(client.calls, [H('a'), H('c'), H('7'), H('b'), H('d'), H('8')], 'A 的素材小尺寸没有重传;剩下两份素材小尺寸先于任何素材原尺寸');
  assert.deepEqual(log, ['small', 'small', 'small', 'original', 'original', 'original'], '恢复后的派活顺序');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items, []);
  fs.rmSync(file, { force: true });
});
