// 素材服务(第 5 步):分片上传、断点续传对账、收尾校验、按哈希取回、跨源、预渲染进程的转发。
// 契约在 server/asset-service.ts 文件头。跑法:node --test server/test/asset-service.test.mjs
//
// 插件是 .ts,和 media-hash.test 一样用 typescript 转译到临时目录再 import;
// 兄弟模块之间的 import 路径改成转译产物。
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
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-asset-service-'));

delete process.env.PROMPTCUT_EXPORT_DIR;
delete process.env.PROMPTCUT_MEDIA_DIR;
delete process.env.PROMPTCUT_EDITOR_URL;

const guardUrl = pathToFileURL(path.join(ROOT, 'server', 'http-guard.mjs')).href;
function compile(srcRel, outName, replaces = []) {
  let src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  for (const [a, b] of replaces) src = src.split(a).join(b);
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const file = path.join(OUT, outName);
  fs.writeFileSync(file, js);
  return pathToFileURL(file).href;
}

const media = await import(compile('server/vite-plugin-media.ts', 'media.mjs'));
const asset = await import(compile('server/asset-service.ts', 'asset-service.mjs', [
  ['from "./http-guard.mjs"', `from "${guardUrl}"`],
  ['from "./vite-plugin-media"', 'from "./media.mjs"'],
  ['from "./asset-store/index.mjs"', `from "${pathToFileURL(path.join(ROOT, 'server', 'asset-store', 'index.mjs')).href}"`],
]));
const client = await import(compile('server/asset-client.ts', 'asset-client.mjs'));

const projectRoot = path.join(OUT, 'project');
fs.mkdirSync(media.mediaDir(projectRoot), { recursive: true });

/** 和 mediaPlugin 同样的接法:素材服务在前,老路由在后 */
function serviceHandler(root) {
  const a = asset.assetServiceMiddleware(root);
  const m = media.mediaMiddleware(root);
  return (req, res) => { void a(req, res, () => { void m(req, res, () => { res.statusCode = 404; res.end('no route'); }); }); };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const origin = await listen(serviceHandler(projectRoot));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

const CHUNK = asset.ASSET_CHUNK_SIZE;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** 确定性的伪随机字节,每个用例一份不同的内容 */
function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 4) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out.writeUInt32LE(x >>> 0, i < size - 3 ? i : size - 4); }
  return out;
}
const sliceOf = (buf, n) => buf.subarray(n * CHUNK, Math.min(buf.length, (n + 1) * CHUNK));

const base = `${origin}/api/asset`;
const put = (hash, n, body, headers = {}) => fetch(`${base}/media/${hash}/${n}`, {
  method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream', ...headers },
});
const chunks = async (hash) => (await fetch(`${base}/media/${hash}/chunks`)).json();
const complete = (hash) => fetch(`${base}/media/${hash}/complete`, { method: 'POST' });

/** 上传方的断点续传:先对账,只补 received 里缺的片,再收尾。返回实际发出去的分片号 */
async function resume(hash, buf, ext) {
  const status = await chunks(hash);
  if (status.complete) return { sent: [], status };
  const have = new Set(status.received);
  const sent = [];
  for (let n = 0; n < asset.chunkCount(buf.length); n++) {
    if (have.has(n)) continue;
    const r = await put(hash, n, sliceOf(buf, n), asset.chunkHeaders(buf.length, `x.${ext}`));
    assert.equal(r.status, 200, `补传第 ${n} 片`);
    sent.push(n);
  }
  const done = await complete(hash);
  return { sent, done, status: await chunks(hash) };
}

/** 发一片,只写一部分就掐断连接:模拟上传中途断网 */
function putAndDrop(hash, n, size, part) {
  return new Promise((resolve) => {
    const u = new URL(`${base}/media/${hash}/${n}`);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT',
      headers: { 'Content-Length': String(asset.chunkLength(size, n)), 'X-Media-Size': String(size), 'X-Media-Ext': 'mp4' },
    });
    req.on('error', () => resolve());
    req.write(part, () => setTimeout(() => { req.destroy(); setTimeout(resolve, 200); }, 50));
  });
}

test('契约常数:8 MiB 一片,小于 8 MiB 是 1 片,最后一片可以短', () => {
  assert.equal(CHUNK, 8 * 1024 * 1024);
  assert.equal(asset.chunkCount(1), 1);
  assert.equal(asset.chunkCount(CHUNK), 1);
  assert.equal(asset.chunkCount(CHUNK + 1), 2);
  assert.equal(asset.chunkLength(CHUNK * 2 + 5, 0), CHUNK);
  assert.equal(asset.chunkLength(CHUNK * 2 + 5, 2), 5);
});

test('断线续传:chunks 报出已收的分片,只补缺的那一片;complete 校验通过后才为真', async () => {
  const size = CHUNK * 2 + 4321; // 3 片
  const buf = bytesOf(size, 1);
  const hash = sha256(buf);

  assert.deepEqual(await chunks(hash), { size: null, chunkSize: CHUNK, received: [], complete: false });

  // 第 0、2 片传完,第 1 片传到一半断网
  const h = asset.chunkHeaders(size, 'clip.mp4');
  assert.equal((await put(hash, 0, sliceOf(buf, 0), h)).status, 200);
  assert.equal((await put(hash, 2, sliceOf(buf, 2), h)).status, 200);
  await putAndDrop(hash, 1, size, sliceOf(buf, 1).subarray(0, 1024 * 1024));

  const mid = await chunks(hash);
  assert.deepEqual(mid, { size, chunkSize: CHUNK, received: [0, 2], complete: false }, '断掉的那一片不算收到');

  // 没到齐不能收尾
  const early = await complete(hash);
  assert.equal(early.status, 400);
  assert.deepEqual((await early.json()).missing, [1]);
  assert.equal((await chunks(hash)).complete, false);

  // 恢复:只补第 1 片
  const { sent, done, status } = await resume(hash, buf, 'mp4');
  assert.deepEqual(sent, [1], '只补缺的分片');
  assert.equal(done.status, 200);
  const body = await done.json();
  assert.equal(body.complete, true);
  assert.equal(body.url, `/@media/${hash}`);
  assert.deepEqual(status, { size, chunkSize: CHUNK, received: [0, 1, 2], complete: true });

  // 入库:本地内容库里是 <hash>.mp4,暂存区清掉了
  const dir = media.mediaDir(projectRoot);
  assert.ok(fs.existsSync(path.join(dir, `${hash}.mp4`)));
  assert.equal(sha256(fs.readFileSync(path.join(dir, `${hash}.mp4`))), hash);
  assert.ok(!fs.existsSync(path.join(dir, '.chunks', hash)));

  // 已入库后再传任何一片、再收尾一次,都是幂等的 200
  assert.equal((await put(hash, 0, sliceOf(buf, 0), h)).status, 200);
  assert.equal((await complete(hash)).status, 200);
});

test('全件 sha256 不符回 409,已收分片全部丢弃,取回仍是 404', async () => {
  const buf = bytesOf(3000, 2);
  const claimed = sha256(Buffer.from('not the same bytes'));
  assert.equal((await put(claimed, 0, buf, asset.chunkHeaders(buf.length, 'a.png'))).status, 200);
  assert.deepEqual((await chunks(claimed)).received, [0]);

  const r = await complete(claimed);
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.error, 'hash-mismatch');
  assert.equal(body.actual, sha256(buf));

  assert.deepEqual(await chunks(claimed), { size: null, chunkSize: CHUNK, received: [], complete: false });
  assert.equal((await fetch(`${base}/media/${claimed}`)).status, 404);
  assert.equal((await complete(claimed)).status, 404, '丢弃之后这个哈希就是没见过的');
});

test('分片校验:越界、长度不对、缺 size、size 前后不一、分片号格式都回 4xx;同一片重传幂等', async () => {
  const size = CHUNK + 10; // 2 片:8 MiB + 10
  const buf = bytesOf(size, 3);
  const hash = sha256(buf);
  const h = asset.chunkHeaders(size, 'b.mp4');

  assert.equal((await put(hash, 2, Buffer.alloc(10), h)).status, 416, '越界');
  assert.equal((await put(hash, 0, Buffer.alloc(10), h)).status, 400, '非最后一片只能是整 8 MiB');
  assert.equal((await put(hash, 1, Buffer.alloc(11), h)).status, 400, '最后一片长度也得对');
  assert.equal((await put(hash, 1, Buffer.alloc(10))).status, 400, '缺 X-Media-Size');
  assert.equal((await put(hash, '01', Buffer.alloc(10), h)).status, 400, '分片号不带前导零');
  assert.equal((await put(hash, 'x', Buffer.alloc(10), h)).status, 404, '不是分片号的尾巴不归素材服务');
  assert.deepEqual((await chunks(hash)).received, [], '被拒的分片都不算收到');

  assert.equal((await put(hash, 1, sliceOf(buf, 1), h)).status, 200);
  assert.equal((await put(hash, 1, sliceOf(buf, 1), h)).status, 200, '重传同一片');
  // 第 0 片在 size+1 下长度照样是整 8 MiB,过了长度这一关,撞上的是 size 不一致
  assert.equal((await put(hash, 0, sliceOf(buf, 0), { 'X-Media-Size': String(size + 1) })).status, 409, 'size 和已登记的不一致');
  assert.deepEqual((await chunks(hash)).received, [1]);

  assert.equal((await put(hash, 0, sliceOf(buf, 0), h)).status, 200);
  const r = await complete(hash);
  assert.equal(r.status, 200);
  assert.equal((await chunks(hash)).complete, true);
});

test('按哈希取回:Content-Type 按扩展名,Range 回 206,越界 416;/@media/<hash> 等价', async () => {
  const buf = bytesOf(5000, 4);
  const hash = sha256(buf);
  await put(hash, 0, buf, { 'X-Media-Size': String(buf.length), 'X-Media-Type': 'video/webm' });
  assert.equal((await complete(hash)).status, 200);

  for (const url of [`${base}/media/${hash}`, `${origin}/@media/${hash}`]) {
    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'video/webm', 'X-Media-Type 反查到 webm');
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(sha256(Buffer.from(await whole.arrayBuffer())), hash);

    const part = await fetch(url, { headers: { Range: 'bytes=100-199' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 100-199/${buf.length}`);
    assert.equal(part.headers.get('content-length'), '100');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), buf.subarray(100, 200));

    const tail = await fetch(url, { headers: { Range: 'bytes=-10' } });
    assert.equal(tail.status, 206);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), buf.subarray(buf.length - 10));

    const open = await fetch(url, { headers: { Range: 'bytes=4990-' } });
    assert.equal(open.status, 206);
    assert.equal(open.headers.get('content-range'), `bytes 4990-4999/${buf.length}`);
    await open.arrayBuffer();

    const bad = await fetch(url, { headers: { Range: 'bytes=9000-9001' } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), `bytes */${buf.length}`);

    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(buf.length));
  }
});

test('老的整件导入(/api/media/upload)照常可用,进来的素材在对账接口里就是 complete', async () => {
  const buf = bytesOf(2048, 5);
  const r = await fetch(`${origin}/api/media/upload/whole.mp4`, { method: 'POST', body: buf, headers: { 'Content-Type': 'video/mp4' } });
  assert.equal(r.status, 200);
  const stored = await r.json();
  assert.equal(stored.hash, sha256(buf));
  assert.deepEqual(await chunks(stored.hash), { size: 2048, chunkSize: CHUNK, received: [0], complete: true });
  assert.equal((await fetch(`${base}/media/${stored.hash}`)).headers.get('content-type'), 'video/mp4');
});

test('跨源:另一个源(模拟局域网设备)的预检和实际请求都拿到 CORS 头', async () => {
  const buf = bytesOf(1234, 6);
  const hash = sha256(buf);
  const LAN = 'http://192.168.1.50:8080';

  for (const url of [`${base}/media/${hash}/0`, `${base}/media/${hash}/chunks`, `${origin}/@media/${hash}`]) {
    const pre = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: LAN, 'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'x-media-size, x-media-ext, content-type, range',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(pre.status, 204, url);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    for (const m of ['GET', 'HEAD', 'PUT', 'POST', 'OPTIONS']) assert.ok(pre.headers.get('access-control-allow-methods').includes(m), m);
    for (const k of ['X-Media-Size', 'X-Media-Ext', 'Content-Type', 'Range']) assert.ok(pre.headers.get('access-control-allow-headers').includes(k), k);
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  }

  // 公网网页的预检:照样回 CORS 头,但不给私有网络访问(只放给回环和局域网来源)
  const pub = await fetch(`${base}/media/${hash}/chunks`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' },
  });
  assert.equal(pub.status, 204);
  assert.equal(pub.headers.get('access-control-allow-private-network'), null);

  const up = await put(hash, 0, buf, { Origin: LAN, 'X-Media-Size': String(buf.length), 'X-Media-Ext': 'jpg' });
  assert.equal(up.status, 200);
  assert.equal(up.headers.get('access-control-allow-origin'), '*');
  const fin = await fetch(`${base}/media/${hash}/complete`, { method: 'POST', headers: { Origin: LAN } });
  assert.equal(fin.status, 200);
  const got = await fetch(`${origin}/@media/${hash}`, { headers: { Origin: LAN, Range: 'bytes=0-9' } });
  assert.equal(got.status, 206);
  assert.equal(got.headers.get('access-control-allow-origin'), '*');
  const expose = got.headers.get('access-control-expose-headers');
  for (const k of ['Content-Range', 'Accept-Ranges', 'Content-Length']) assert.ok(expose.includes(k), k);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  await got.arrayBuffer();

  // 素材服务以外的路由不带 CORS 头
  const other = await fetch(`${origin}/api/media/local?hashes=${hash}`, { headers: { Origin: LAN } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  await other.arrayBuffer();
});

test('客户端:素材记录 → 素材服务上的 HTTP 地址;基址按 PROMPTCUT_EDITOR_URL → 本进程监听地址', async () => {
  const h = 'a'.repeat(64);
  const o = 'http://127.0.0.1:9';
  assert.equal(client.mediaHttpUrl({ hash: h.toUpperCase(), url: '/@media/whatever' }, o), `${o}/@media/${h}`);
  assert.equal(client.mediaHttpUrl({ url: `/@media/${h}` }, o), `${o}/@media/${h}`);
  assert.equal(client.mediaHttpUrl({ url: '/@media/%E7%B4%A0%E6%9D%90.mp4' }, o), `${o}/@media/${encodeURIComponent('素材.mp4')}`);
  // 外面递进来的 path 只取最后一段文件名,指不到库外
  assert.equal(client.mediaHttpUrl({ path: 'C:\\Windows\\win.ini' }, o), `${o}/@media/win.ini`);
  assert.equal(client.mediaHttpUrl({ url: 'a%2F..%2F..%2Fx' }, o), `${o}/@media/x`);
  assert.equal(client.mediaHttpUrl({ url: 'blob:http://x/1' }, o), null);
  assert.equal(client.mediaHttpUrl({ hash: h }, null), null, '素材服务不可达');

  // 单进程形态:媒体插件记下本进程的监听地址
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  client.rememberLocalAssetOrigin(s);
  assert.equal(client.assetServiceOrigin(), `http://127.0.0.1:${s.address().port}`);
  s.close();
  // 预渲染进程:编辑器那一端的地址优先
  process.env.PROMPTCUT_EDITOR_URL = 'http://127.0.0.1:5220/';
  try { assert.equal(client.assetServiceOrigin(), 'http://127.0.0.1:5220'); }
  finally { delete process.env.PROMPTCUT_EDITOR_URL; }
});

test('预渲染进程的转发:/@media 和 /api/asset 原样转给素材服务,Range 透传,字节不变', async () => {
  let fn;
  client.assetProxyPlugin(origin).configureServer({ middlewares: { use(f) { fn = f; } } });
  const proxy = await listen((req, res) => fn(req, res, () => { res.statusCode = 404; res.end('not media'); }));

  const buf = bytesOf(4096, 7);
  const hash = sha256(buf);
  const via = `${proxy}/api/asset`;
  const up = await fetch(`${via}/media/${hash}/0`, { method: 'PUT', body: buf, headers: { 'X-Media-Size': String(buf.length), 'X-Media-Ext': 'mp4' } });
  assert.equal(up.status, 200);
  assert.equal((await fetch(`${via}/media/${hash}/complete`, { method: 'POST' })).status, 200);
  assert.equal((await (await fetch(`${via}/media/${hash}/chunks`)).json()).complete, true);

  const part = await fetch(`${proxy}/@media/${hash}`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${buf.length}`);
  assert.equal(part.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), buf.subarray(10, 20));
  const whole = await fetch(`${proxy}/@media/${hash}`);
  assert.equal(sha256(Buffer.from(await whole.arrayBuffer())), hash);

  assert.equal((await fetch(`${proxy}/src/main.tsx`)).status, 404, '别的路径不转发');
});

/** ffmpeg 在哪(和 server/vision/ffmpeg-frames.ts 同一套候选),找不到就跳过 ffmpeg 那一条 */
function findFfmpeg() {
  const candidates = [process.env.PROMPTCUT_FFMPEG, 'ffmpeg',
    path.join(process.env.LOCALAPPDATA || os.homedir(), 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin', 'ffmpeg.exe')].filter(Boolean);
  for (const c of candidates) {
    try { if (spawnSync(c, ['-version'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }).status === 0) return c; } catch { /* 下一个 */ }
  }
  return null;
}
const ffmpeg = findFfmpeg();

test('ffmpeg 经素材服务的 HTTP 地址抽帧(素材层的读法),和直接读文件的像素一致', { skip: !ffmpeg && '这台机器上没有 ffmpeg' }, async () => {
  const { extractArgs } = await import(pathToFileURL(path.join(ROOT, 'server', 'vision-compose.mjs')).href);
  const src = path.join(OUT, 'src.mp4');
  const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2', '-pix_fmt', 'yuv420p', src], { windowsHide: true });
  assert.equal(made.status, 0, String(made.stderr));
  const buf = fs.readFileSync(src);
  const hash = sha256(buf);
  // 走分片上传入库(小于 8 MiB,一片)
  assert.equal((await put(hash, 0, buf, asset.chunkHeaders(buf.length, 'src.mp4'))).status, 200);
  assert.equal((await complete(hash)).status, 200);

  const url = client.mediaHttpUrl({ hash }, origin);
  const outHttp = path.join(OUT, 'via-http.png');
  const outFile = path.join(OUT, 'via-file.png');
  const opts = { kind: 'video', seconds: 1.2, width: 160, height: 90, opacity: 1 };
  // ffmpeg 自己会发请求,主线程得空着答它 —— 用异步 spawn
  const run = (args) => new Promise((resolve) => {
    const child = require_('node:child_process').spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = ''; child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, err }));
  });
  const a = await run(extractArgs({ ...opts, file: url, out: outHttp }));
  assert.equal(a.code, 0, a.err);
  const b = await run(extractArgs({ ...opts, file: src, out: outFile }));
  assert.equal(b.code, 0, b.err);
  assert.equal(sha256(fs.readFileSync(outHttp)), sha256(fs.readFileSync(outFile)), '经 HTTP 抽出的帧和直接读文件的逐字节相同');
});

test('预检中间件:只答素材服务路由的 OPTIONS(媒体插件把它插到 vite 自带 cors 前面),别的放过', async () => {
  const fn = asset.assetPreflightMiddleware();
  const run = (method, url) => new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end() { resolve({ status: this.statusCode, headers: this.headers }); } };
    fn({ method, url, headers: { origin: 'http://192.168.1.50:8080' } }, res, () => resolve('next'));
  });
  const h = 'cd'.repeat(32);
  const pre = await run('OPTIONS', `/api/asset/media/${h}/0`);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], '*');
  assert.equal((await run('OPTIONS', `/@media/${h}`)).status, 204);
  assert.equal(await run('OPTIONS', '/api/ai/config'), 'next');
  assert.equal(await run('GET', `/api/asset/media/${h}`), 'next');
});

test('预留的合并分发(C10 契约第 11 节):POST merge/<projectId>/<共享键> 回 501,只占位、不碰数据层', async () => {
  const before = fs.readdirSync(media.mediaDir(projectRoot)).sort();
  const r = await fetch(`${base}/merge/proj-1/${'ab'.repeat(32)}`, { method: 'POST', body: '{"any":"thing"}', headers: { 'Content-Type': 'application/json', Origin: 'http://192.168.1.50:8080' } });
  assert.equal(r.status, 501);
  assert.deepEqual(await r.json(), { ok: false, error: 'not-implemented' });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  // projectId、共享键都不解析:任意形状照样 501
  assert.equal((await fetch(`${base}/merge/${encodeURIComponent('不是项目')}/x`, { method: 'POST' })).status, 501);
  // 别的方法 405;少一段不是这条路由
  const g = await fetch(`${base}/merge/proj-1/k`);
  assert.equal(g.status, 405);
  assert.equal(g.headers.get('allow'), 'POST');
  assert.notEqual((await fetch(`${base}/merge/proj-1`, { method: 'POST' })).status, 501);
  assert.deepEqual(fs.readdirSync(media.mediaDir(projectRoot)).sort(), before, '没有写进内容库');
});
