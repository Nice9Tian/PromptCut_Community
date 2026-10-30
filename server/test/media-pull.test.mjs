// C6.6 第 4 节:本地素材服务读路由的按需拉取(边落盘边按 Range 服务)、预取队列、导出前的素材原尺寸检查。
// 实现在 server/media-pull.mjs,接在 server/vite-plugin-media.ts 的 `/@media/<hash>` 未命中那一支上。
// 跑法:node --test server/test/media-pull.test.mjs
//
// 插件是 .ts,和 asset-service.test 一样用 typescript 转译到临时目录再 import;惰性 import 的拉取模块路径改成仓库里的绝对地址。
// 「远程素材服务」是本文件里起的一台小 HTTP 服务:只实现 `GET media/<hash>`(可限速、可给错字节)与 `GET media/<hash>/chunks`。
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-media-pull-'));
delete process.env.PROMPTCUT_EXPORT_DIR;
delete process.env.PROMPTCUT_MEDIA_DIR;

const pullUrl = pathToFileURL(path.join(ROOT, 'server', 'media-pull.mjs')).href;
function compile(srcRel, outName, replaces = []) {
  let src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  for (const [a, b] of replaces) src = src.split(a).join(b);
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const file = path.join(OUT, outName);
  fs.writeFileSync(file, js);
  return pathToFileURL(file).href;
}
const media = await import(compile('server/vite-plugin-media.ts', 'media.mjs', [['"./media-pull.mjs"', `"${pullUrl}"`]]));
const pull = await import(pullUrl);

const projectRoot = path.join(OUT, 'project');
fs.mkdirSync(media.mediaDir(projectRoot), { recursive: true });
after(() => { pull.resetPullStateForTest(); fs.rmSync(OUT, { recursive: true, force: true }); });

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i + 4 <= size; i += 4) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out.writeUInt32LE(x >>> 0, i); }
  return out;
}

/* ---------------- 本地素材服务(被测) ---------------- */
const local = await listen((req, res) => {
  void media.mediaMiddleware(projectRoot)(req, res, () => { res.statusCode = 404; res.end('no route'); });
});

/* ---------------- 「远程素材服务」 ---------------- */
/** hash → { bytes, type, complete, wrong?: Buffer, throttle?: { chunk, ms } } */
const remoteFiles = new Map();
const remoteHits = [];
const remote = await listen(async (req, res) => {
  const m = /^\/api\/asset\/media\/([0-9a-f]{64})(\/chunks)?$/.exec(req.url.split('?')[0]);
  remoteHits.push({ url: req.url, range: req.headers.range ?? null, auth: req.headers.authorization ?? null });
  const f = m ? remoteFiles.get(m[1]) : null;
  if (m && m[2]) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(f ? { size: f.bytes.length, chunkSize: 8388608, received: f.complete ? [0] : [], complete: !!f.complete } : { size: null, chunkSize: 8388608, received: [], complete: false }));
  }
  if (!f || !f.complete) { res.statusCode = 404; return res.end('Not found'); }
  const body = f.wrong ?? f.bytes;
  const range = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    res.writeHead(206, { 'Content-Type': f.type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${body.length}` });
    return res.end(body.subarray(start, end + 1));
  }
  res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': body.length });
  if (!f.throttle) return res.end(body);
  for (let off = 0; off < body.length && !res.destroyed; off += f.throttle.chunk) {
    res.write(body.subarray(off, off + f.throttle.chunk));
    await new Promise((r) => setTimeout(r, f.throttle.ms));
  }
  res.end();
});
const REMOTE_BASE = `${remote}/api/asset`;

function addRemote(size, seed, extra = {}) {
  const bytes = bytesOf(size, seed);
  const hash = sha256(bytes);
  remoteFiles.set(hash, { bytes, type: 'video/mp4', complete: true, ...extra });
  return { hash, bytes };
}
const localFile = (hash) => media.resolveHashFile(projectRoot, hash);
/**
 * 等后台拉取把这个哈希收进本地内容库，按截止时间等（缺省 10 s），回文件路径；到时仍没有回 null（由调用方断言）。
 * 原来是「最多 50 / 200 次 × 20 ms」的步数上限，机器忙时（几份 npm test 并行）后台收尾可能超过 1～4 s 而误判。
 */
async function waitLocal(hash, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const f = await localFile(hash);
    if (f || Date.now() >= deadline) return f;
    await new Promise((res) => setTimeout(res, 20));
  }
}
const setRemote = (body) => fetch(`${local}/api/media/remote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { pull.resetPullStateForTest(); remoteHits.length = 0; });

test('T5-pull-1:本地内容库没有、也没连远程素材服务 → 404(和原来一样)', async () => {
  const { hash } = addRemote(1000, 1);
  const r = await fetch(`${local}/@media/${hash}`);
  assert.equal(r.status, 404);
  assert.equal(remoteHits.length, 0, '没连远程就不去问');
});

test('T5-pull-2:连了远程 → 同一次请求拿到整件字节;拉完进本地内容库,第二次是本地命中', async () => {
  const { hash, bytes } = addRemote(300_000, 2);
  assert.equal((await setRemote({ base: REMOTE_BASE, ticket: 'tkt-secret-1' })).status, 200);
  const r = await fetch(`${local}/@media/${hash}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  const got = Buffer.from(await r.arrayBuffer());
  assert.equal(sha256(got), hash);
  // 拉取在后台收尾(校验、改名):等它进库
  await waitLocal(hash);
  const file = await localFile(hash);
  assert.ok(file && file.endsWith(`${hash}.mp4`), `进了本地内容库,扩展名按远程的 Content-Type:${file}`);
  assert.equal(fs.readFileSync(file).length, bytes.length);
  assert.equal(remoteHits.filter((h) => h.url.endsWith(hash)).length, 1);
  assert.equal(remoteHits[0].auth, 'Bearer tkt-secret-1', '票据只进 Authorization 头');
  const again = await fetch(`${local}/@media/${hash}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(again.status, 206);
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), bytes.subarray(0, 10));
  assert.equal(remoteHits.filter((h) => h.url.endsWith(hash)).length, 1, '第二次不再去远程');
  assert.ok(!JSON.stringify(pull.pullLog()).includes('tkt-secret-1'), '票据不进日志');
  const tmpLeft = fs.readdirSync(media.mediaDir(projectRoot)).filter((n) => n.startsWith('.pull-'));
  assert.deepEqual(tmpLeft, [], '临时文件收干净');
});

test('T5-pull-3:边落盘边按 Range 服务 —— 远程还在慢慢传,已落盘那一段的 Range 请求先答', async () => {
  const size = 2_000_000;
  const { hash, bytes } = addRemote(size, 3, { throttle: { chunk: 64 * 1024, ms: 40 } }); // 全件约 1.3 s
  await setRemote({ base: REMOTE_BASE });
  const t0 = Date.now();
  const r = await fetch(`${local}/@media/${hash}`, { headers: { Range: 'bytes=1000-50999' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 1000-50999/${size}`);
  const got = Buffer.from(await r.arrayBuffer());
  const ms = Date.now() - t0;
  assert.deepEqual(got, bytes.subarray(1000, 51000));
  // 墙钟判据改成相对整件的：原来是 ms < 800（全件约 1.3 s，即约六成）。机器忙时两者一起变慢，按比例判；
  // 再加上「这时整件还没进库」这条不看时间的证据。真退化成「等整件下完才答」时 ms ≥ fullMs，照样拦得住。
  assert.equal(await localFile(hash), null, '这时整件还没进库');
  // 同一个哈希的第二个请求挂在同一个拉取任务上,不再开一条
  const r2 = await fetch(`${local}/@media/${hash}`, { headers: { Range: 'bytes=0-99' } });
  assert.deepEqual(Buffer.from(await r2.arrayBuffer()), bytes.subarray(0, 100));
  assert.equal(remoteHits.filter((h) => h.url.endsWith(hash) && !h.range).length, 1, '同一哈希只拉一次');
  const fullMs = (await waitLocal(hash)) ? Date.now() - t0 : Infinity;
  assert.ok(ms < fullMs * 0.6, `前 50 KB 在整件下完之前很早就答了：Range 回包 ${ms} ms，整件进库 ${fullMs} ms`);
  assert.ok(await localFile(hash), '拉完进库');
});

test('T5-pull-4:远程也没有(404)→ 404;远程还没 complete 的不算有', async () => {
  const { hash } = addRemote(1000, 4, { complete: false });
  await setRemote({ base: REMOTE_BASE });
  const r = await fetch(`${local}/@media/${hash}`);
  assert.equal(r.status, 404);
  assert.equal(await localFile(hash), null);
});

test('T5-pull-5:远程给的字节 sha256 不符 → 不进本地内容库', async () => {
  const bytes = bytesOf(200_000, 5);
  const hash = sha256(bytes);
  remoteFiles.set(hash, { bytes, wrong: bytesOf(200_000, 55), type: 'video/mp4', complete: true });
  await setRemote({ base: REMOTE_BASE });
  await fetch(`${local}/@media/${hash}`).then((r) => r.arrayBuffer()).catch(() => null);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(await localFile(hash), null, '校验不过的不入库');
  assert.ok(pull.pullLog().some((e) => e.event === 'pull.mismatch' && e.hash === hash));
  const tmpLeft = fs.readdirSync(media.mediaDir(projectRoot)).filter((n) => n.startsWith('.pull-'));
  assert.deepEqual(tmpLeft, []);
});

test('T5-pull-6:Range 起点远在已落盘位置之后(比如 moov 在尾部)→ 这一段直接从远程透传', async () => {
  const size = 12 * 1024 * 1024;
  const { hash, bytes } = addRemote(size, 6, { throttle: { chunk: 256 * 1024, ms: 50 } });
  await setRemote({ base: REMOTE_BASE });
  const head = await fetch(`${local}/@media/${hash}`, { headers: { Range: 'bytes=0-15' } });
  await head.arrayBuffer();
  const r = await fetch(`${local}/@media/${hash}`, { headers: { Range: `bytes=${size - 100}-` } });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(size - 100));
  assert.ok(remoteHits.some((h) => h.range === `bytes=${size - 100}-`), '尾部那一段带着 Range 去了远程');
  pull.setRemoteAssetService(null); // 中止慢速拉取
});

test('T5-prefetch-1:预取按给的顺序一次拉一个、本地已有的跳过;清掉远程就作废', async () => {
  const a = addRemote(50_000, 71), b = addRemote(50_000, 72), c = addRemote(50_000, 73), d = addRemote(50_000, 74);
  await setRemote({ base: REMOTE_BASE });
  // b 先按需拉进来:预取时跳过
  await (await fetch(`${local}/@media/${b.hash}`)).arrayBuffer();
  await waitLocal(b.hash);
  const r = await fetch(`${local}/api/media/prefetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ hash: c.hash }, { hash: b.hash }, { hash: a.hash }, { hash: d.hash }] }) });
  assert.deepEqual(await r.json(), { ok: true, queued: 4 });
  await waitLocal(d.hash);
  const starts = pull.pullLog().filter((e) => e.event === 'pull.start' && e.by === 'prefetch').map((e) => e.hash);
  assert.deepEqual(starts, [c.hash, a.hash, d.hash], '按清单顺序、跳过本地已有的 b');
  for (const x of [a, c, d]) assert.ok(await localFile(x.hash));
});

test('T5-prefetch-2:没连远程素材服务时预取不做事', async () => {
  const e = addRemote(10_000, 75);
  const r = await fetch(`${local}/api/media/prefetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ hash: e.hash }] }) });
  assert.deepEqual(await r.json(), { ok: true, queued: 0 });
  assert.equal(remoteHits.length, 0);
});

test('T7-originals-1:导出前的素材原尺寸检查只问当前连接的素材服务(远程:chunks 的 complete;本机缓存不算数)', async () => {
  const ready = addRemote(10_000, 81);
  const notYet = addRemote(10_000, 82, { complete: false });
  // notYet 在本机缓存里已经有了(比如别的路径拷过来),但远程没 complete:照样算没到齐
  fs.writeFileSync(path.join(media.mediaDir(projectRoot), `${notYet.hash}.mp4`), notYet.bytes);
  await setRemote({ base: REMOTE_BASE, ticket: 'tkt-2' });
  const r = await fetch(`${local}/api/media/originals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: [ready.hash, notYet.hash] }) });
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.missing, [notYet.hash]);
  assert.ok(remoteHits.some((h) => h.url.endsWith(`${ready.hash}/chunks`) && h.auth === 'Bearer tkt-2'));
});

test('T7-originals-2:没连远程时就是本地素材服务:看本地内容库', async () => {
  const have = bytesOf(5000, 83);
  const haveHash = sha256(have);
  fs.writeFileSync(path.join(media.mediaDir(projectRoot), `${haveHash}.mp4`), have);
  const missing = sha256(bytesOf(5000, 84));
  const r = await fetch(`${local}/api/media/originals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: [haveHash, missing] }) });
  assert.deepEqual((await r.json()).missing, [missing]);
});

test('T5-remote-1:远程基址只收 http(s)、不收带用户名的;GET 看状态不回票据', async () => {
  assert.equal((await setRemote({ base: 'file:///etc' })).status, 400);
  assert.equal((await setRemote({ base: 'http://u:p@127.0.0.1:1/api/asset' })).status, 400);
  await setRemote({ base: REMOTE_BASE + '/', ticket: 'tkt-3' });
  const st = await (await fetch(`${local}/api/media/remote`)).json();
  assert.equal(st.base, REMOTE_BASE);
  assert.ok(!JSON.stringify(st).includes('tkt-3'));
  assert.equal((await fetch(`${local}/api/media/remote`, { method: 'DELETE' })).status, 200);
  assert.equal((await (await fetch(`${local}/api/media/remote`)).json()).base, null);
});
