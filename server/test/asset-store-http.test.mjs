/**
 * 素材服务 HTTP 层接数据层之后的用例（契约 `docs/plan/asset-store-contract.md` 第 3、4 节，用例 H1～H6）。
 * 跑：node --test server/test/asset-store-http.test.mjs
 *
 * 只照契约写，不看实现。`asset-service.ts` 照 `asset-service.test.mjs` 的办法用 typescript 转译到临时目录再 import；
 * 转译前把源码里所有相对路径的 import（静态与动态）改成绝对地址：`.ts` 模块递归转译，`.mjs` / `.js` 直接指向仓库里的文件。
 * 这样实现方新加的 `./asset-store/index.mjs` 之类的引用不需要在这里逐条登记。
 *
 * 数据层（`server/asset-store/index.mjs`）和带选项的 `assetServiceMiddleware` 载不进来 / 不认选项时，
 * 每条用例各自失败、报原因。
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-asset-http-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

delete process.env.PROMPTCUT_EXPORT_DIR;
delete process.env.PROMPTCUT_MEDIA_DIR;
delete process.env.PROMPTCUT_EDITOR_URL;
delete process.env.PROMPTCUT_CLUSTER_TOKEN;

/* ------------------------------------------------------------------ *
 * 转译
 * ------------------------------------------------------------------ */

const compiled = new Map();
function resolveRel(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.mjs')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}
/** 转译一个 .ts 源文件，返回产物的 file:// 地址。相对 import 全部改成绝对地址 */
function compileTs(absFile) {
  if (compiled.has(absFile)) return compiled.get(absFile);
  const rel = path.relative(ROOT, absFile).replace(/[\\/]/g, '__').replace(/\.ts$/, '');
  const outFile = path.join(OUT, `${rel}.mjs`);
  const url = pathToFileURL(outFile).href;
  compiled.set(absFile, url); // 先登记，循环引用不会死循环
  let src = fs.readFileSync(absFile, 'utf8');
  const rewrite = (spec) => {
    const hit = resolveRel(absFile, spec);
    if (!hit) return spec;
    return hit.endsWith('.ts') ? compileTs(hit) : pathToFileURL(hit).href;
  };
  src = src.replace(/(\bfrom\s*)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
  src = src.replace(/(\bimport\s*\(\s*)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
  src = src.replace(/(\bimport\s+)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  fs.writeFileSync(outFile, js);
  return url;
}

const ASSET_SRC = path.join(ROOT, 'server', 'asset-service.ts');
const media = await import(compileTs(path.join(ROOT, 'server', 'vite-plugin-media.ts')));
const asset = await import(compileTs(ASSET_SRC));

let storeMod = null;
let storeError = null;
try { storeMod = await import('../asset-store/index.mjs'); } catch (err) { storeError = err; }
function needStore() {
  if (storeError) throw new Error(`cannot load server/asset-store/index.mjs: ${storeError.message}`);
  return storeMod;
}
const CHUNK = 8 * 1024 * 1024;
const memoryStore = () => needStore().createBlobStore({ kind: 'memory', chunkSize: CHUNK });

/* ------------------------------------------------------------------ *
 * 服务与请求
 * ------------------------------------------------------------------ */

let rootSeq = 0;
function freshRoot() {
  const root = path.join(OUT, `project-${++rootSeq}`);
  fs.mkdirSync(media.mediaDir(root), { recursive: true });
  return root;
}

/**
 * 起一台服务：素材服务在前、老路由在后（和 mediaPlugin 同样的接法）。
 * `remote` 给了就把每个请求的 socket.remoteAddress 改成它，模拟局域网来的请求（不用真的绑到局域网网卡上）。
 */
async function serve({ opts, remote } = {}) {
  const root = freshRoot();
  const a = opts === undefined ? asset.assetServiceMiddleware(root) : asset.assetServiceMiddleware(root, opts);
  const m = media.mediaMiddleware(root);
  const server = http.createServer((req, res) => {
    if (remote) Object.defineProperty(req.socket, 'remoteAddress', { value: remote, configurable: true });
    void a(req, res, () => { void m(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { root, origin, base: `${origin}/api/asset` };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 4) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out.writeUInt32LE(x >>> 0, i < size - 3 ? i : size - 4); }
  return out;
}
const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK));
const sliceOf = (buf, n) => buf.subarray(n * CHUNK, Math.min(buf.length, (n + 1) * CHUNK));
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const { assetTicketKit } = await import('./fake-shared-env.mjs');

const put = (base, hash, n, body, headers = {}) => fetch(`${base}/media/${hash}/${n}`, {
  method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream', ...headers },
});
const complete = (base, hash, headers = {}) => fetch(`${base}/media/${hash}/complete`, { method: 'POST', headers });
const chunks = async (base, hash, headers = {}) => (await fetch(`${base}/media/${hash}/chunks`, { headers })).json();

/** 发一片，只写一部分就掐断连接：模拟上传中途断网 */
function putAndDrop(base, hash, n, size, part) {
  return new Promise((resolve) => {
    const u = new URL(`${base}/media/${hash}/${n}`);
    const len = n < chunkCount(size) - 1 ? CHUNK : size - CHUNK * (chunkCount(size) - 1);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT',
      headers: { 'Content-Length': String(len), 'X-Media-Size': String(size), 'X-Media-Ext': 'mp4' },
    });
    req.on('error', () => resolve());
    req.write(part, () => setTimeout(() => { req.destroy(); setTimeout(resolve, 250); }, 50));
  });
}

/** 比较用的回包快照：状态码、一组响应头、回包体（JSON 解析；二进制取 sha256 和长度） */
const HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control',
  'access-control-allow-origin', 'access-control-expose-headers', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-allow-private-network', 'access-control-max-age',
];
async function snap(resPromise) {
  const r = await resPromise;
  const headers = {};
  for (const k of HEADERS) headers[k] = r.headers.get(k);
  headers['last-modified?'] = r.headers.get('last-modified') !== null;
  const buf = Buffer.from(await r.arrayBuffer());
  let body;
  if (String(r.headers.get('content-type') || '').startsWith('application/json')) {
    try { body = JSON.parse(buf.toString('utf8')); } catch { body = buf.toString('utf8'); }
  } else {
    body = { bytes: buf.length, sha256: buf.length ? sha256(buf) : null };
  }
  return { status: r.status, headers, body };
}

/**
 * H1 的剧本：断点续传、409 校验、Range 206 / 416、HEAD、跨源头。对 fs 与 memory 各跑一遍，
 * 返回 [步骤名, 快照] 列表，逐个字段比较。
 */
async function script(base) {
  const LAN = 'http://192.168.1.50:8080';
  const out = [];
  const step = async (name, p) => { out.push([name, await snap(p)]); };

  const size = CHUNK * 2 + 4321; // 3 片
  const buf = bytesOf(size, 101);
  const hash = sha256(buf);
  const h = { 'X-Media-Size': String(size), 'X-Media-Ext': 'mp4' };

  await step('preflight (LAN origin)', fetch(`${base}/media/${hash}/0`, {
    method: 'OPTIONS',
    headers: { Origin: LAN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-media-size, authorization', 'Access-Control-Request-Private-Network': 'true' },
  }));
  await step('preflight (public network origin)', fetch(`${base}/media/${hash}/chunks`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' },
  }));
  await step('reconcile: never seen', fetch(`${base}/media/${hash}/chunks`, { headers: { Origin: LAN } }));
  await step('PUT chunk 0', put(base, hash, 0, sliceOf(buf, 0), { ...h, Origin: LAN }));
  await step('PUT chunk 2', put(base, hash, 2, sliceOf(buf, 2), h));
  await putAndDrop(base, hash, 1, size, sliceOf(buf, 1).subarray(0, 1024 * 1024));
  await step('reconcile: the chunk that was cut off does not count', fetch(`${base}/media/${hash}/chunks`));
  await step('finalize: missing chunk', complete(base, hash, { Origin: LAN }));
  await step('re-upload chunk 1', put(base, hash, 1, sliceOf(buf, 1), h));
  await step('finalize: all chunks present', complete(base, hash, { Origin: LAN }));
  await step('reconcile: already stored', fetch(`${base}/media/${hash}/chunks`));
  await step('re-upload after storing', put(base, hash, 0, sliceOf(buf, 0), h));
  await step('finalize again after storing', complete(base, hash));

  await step('GET whole file', fetch(`${base}/media/${hash}`, { headers: { Origin: LAN } }));
  await step('GET uppercase hash', fetch(`${base}/media/${hash.toUpperCase()}`));
  await step('Range 100-199', fetch(`${base}/media/${hash}`, { headers: { Range: 'bytes=100-199', Origin: LAN } }));
  await step('Range across chunks', fetch(`${base}/media/${hash}`, { headers: { Range: `bytes=${CHUNK - 10}-${CHUNK + 9}` } }));
  await step('Range last 10', fetch(`${base}/media/${hash}`, { headers: { Range: 'bytes=-10' } }));
  await step('Range open-ended', fetch(`${base}/media/${hash}`, { headers: { Range: `bytes=${size - 5}-` } }));
  await step('Range out of bounds 416', fetch(`${base}/media/${hash}`, { headers: { Range: `bytes=${size + 10}-${size + 20}` } }));
  await step('HEAD', fetch(`${base}/media/${hash}`, { method: 'HEAD' }));
  await step('HEAD with Range', fetch(`${base}/media/${hash}`, { method: 'HEAD', headers: { Range: 'bytes=0-9' } }));

  // 409：全件哈希不符
  const small = bytesOf(3000, 102);
  const claimed = sha256(Buffer.from('not the same bytes'));
  await step('PUT (content that does not match the hash)', put(base, claimed, 0, small, { 'X-Media-Size': '3000', 'X-Media-Type': 'image/png' }));
  await step('finalize: hash-mismatch', complete(base, claimed));
  await step('reconcile: after discard', fetch(`${base}/media/${claimed}/chunks`));
  await step('finalize: after discard it is never seen', complete(base, claimed));
  await step('GET not stored', fetch(`${base}/media/${claimed}`));

  // 分片校验
  const s2 = CHUNK + 10;
  const b2 = bytesOf(s2, 103);
  const h2 = sha256(b2);
  const hh = { 'X-Media-Size': String(s2), 'X-Media-Ext': 'mp4' };
  await step('out of range 416', put(base, h2, 2, Buffer.alloc(10), hh));
  await step('wrong length 400', put(base, h2, 1, Buffer.alloc(11), hh));
  await step('missing size 400', put(base, h2, 1, Buffer.alloc(10)));
  await step('chunk number with leading zero 400', put(base, h2, '01', Buffer.alloc(10), hh));
  await step('PUT chunk 1', put(base, h2, 1, sliceOf(b2, 1), hh));
  await step('size mismatch 409', put(base, h2, 0, sliceOf(b2, 0), { 'X-Media-Size': String(s2 + 1) }));
  await step('reconcile: after validation', fetch(`${base}/media/${h2}/chunks`));
  await step('bad hash 400', fetch(`${base}/media/xyz/chunks`));
  await step('wrong method 405 (chunks)', fetch(`${base}/media/${h2}/chunks`, { method: 'POST' }));
  await step('wrong method 405 (complete)', fetch(`${base}/media/${h2}/complete`));
  await step('wrong method 405 (whole file)', fetch(`${base}/media/${h2}`, { method: 'DELETE' }));

  // 小文件：扩展名由 X-Media-Type 反查
  const b3 = bytesOf(777, 104);
  const h3 = sha256(b3);
  await step('PUT (X-Media-Type reverse lookup)', put(base, h3, 0, b3, { 'X-Media-Size': '777', 'X-Media-Type': 'video/webm' }));
  await step('finalize (webm)', complete(base, h3));
  await step('GET (webm)', fetch(`${base}/media/${h3}`));
  return out;
}

/* ------------------------------------------------------------------ *
 * H1
 * ------------------------------------------------------------------ */

test('H1 with the memory implementation injected: resumable upload, 409 validation, Range 206 / 416, HEAD and CORS headers are identical to the fs implementation field by field', async () => {
  const fsSrv = await serve();
  const memSrv = await serve({ opts: { store: memoryStore() } });
  const a = await script(fsSrv.base);
  const b = await script(memSrv.base);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(b[i][0], a[i][0]);
    assert.deepEqual(b[i][1], a[i][1], `step ${i + 1} "${a[i][0]}": response bodies differ between memory and fs`);
  }

  // 两边一样还不够：几处关键回包按第 5 步契约核对，免得两边一起错
  const get = (name) => b.find(([n]) => n === name)[1];
  assert.deepEqual(get('reconcile: never seen').body, { size: null, chunkSize: CHUNK, received: [], complete: false });
  assert.deepEqual(get('reconcile: the chunk that was cut off does not count').body.received, [0, 2]);
  assert.deepEqual([get('finalize: missing chunk').status, get('finalize: missing chunk').body.missing], [400, [1]]);
  assert.equal(get('finalize: all chunks present').status, 200);
  assert.equal(get('finalize: all chunks present').body.url.startsWith('/@media/'), true);
  assert.equal(get('re-upload after storing').body.complete, true);
  assert.equal(get('GET whole file').status, 200);
  assert.equal(get('GET whole file').headers['content-type'], 'video/mp4');
  assert.equal(get('GET whole file').headers['access-control-allow-origin'], '*');
  assert.equal(get('GET whole file').headers['last-modified?'], true, 'memory\'s mtimeMs is the time it was stored, and Last-Modified must be sent');
  assert.equal(get('Range 100-199').status, 206);
  assert.equal(get('Range 100-199').headers['content-range'], `bytes 100-199/${CHUNK * 2 + 4321}`);
  assert.equal(get('Range out of bounds 416').status, 416);
  assert.equal(get('HEAD').headers['content-length'], String(CHUNK * 2 + 4321));
  assert.deepEqual([get('finalize: hash-mismatch').status, get('finalize: hash-mismatch').body.error], [409, 'hash-mismatch']);
  assert.equal(get('finalize: after discard it is never seen').status, 404);
  assert.deepEqual([get('GET not stored').status, get('GET not stored').body], [404, { ok: false, error: 'not-found' }]);
  assert.deepEqual([get('size mismatch 409').status, get('size mismatch 409').body], [409, { ok: false, error: 'size-mismatch', size: CHUNK + 10 }]);
  assert.deepEqual(get('reconcile: after validation').body.received, [1]);
  assert.equal(get('GET (webm)').headers['content-type'], 'video/webm');
  assert.equal(get('preflight (LAN origin)').headers['access-control-allow-private-network'], 'true');
  assert.equal(get('preflight (public network origin)').headers['access-control-allow-private-network'], null);
});

/* ------------------------------------------------------------------ *
 * H2
 * ------------------------------------------------------------------ */

test('H2 gatekeeper: asset-service.ts source has no file system references and no .chunks directory name', () => {
  const src = fs.readFileSync(ASSET_SRC, 'utf8');
  const banned = ['from "fs"', 'from "fs/promises"', 'from "node:fs"', 'createReadStream', 'createWriteStream'];
  for (const s of banned) assert.ok(!src.includes(s), `${s} must not appear`);
  // 目录名 .chunks：只拦字符串里的目录名（契约第 8 节第 2 条）：'.chunks'、".chunks"、`.chunks`、路径片段 /.chunks、\\.chunks；
  // 方法调用 store.chunks(...) 不算
  const dirName = src.split(/\r?\n/).filter((line) => /['"`]\.chunks['"`]|[/\\]\.chunks\b/.test(line));
  assert.deepEqual(dirName, [], '.chunks directory name must not appear');
  // 换个引号、换个写法也不行
  assert.doesNotMatch(src, /\bfrom\s*["'](node:)?fs(\/promises)?["']/, 'static import of fs');
  assert.doesNotMatch(src, /\bimport\s*\(\s*["'](node:)?fs(\/promises)?["']\s*\)/, 'dynamic import of fs');
  assert.doesNotMatch(src, /\brequire\s*\(\s*["'](node:)?fs(\/promises)?["']\s*\)/, 'require fs');
});

/* ------------------------------------------------------------------ *
 * H3～H6：写入鉴权
 * ------------------------------------------------------------------ */

/** 一片的小素材 */
function smallAsset(seed, size = 1500) {
  const buf = bytesOf(size, seed);
  return { buf, hash: sha256(buf), h: { 'X-Media-Size': String(size), 'X-Media-Ext': 'png' } };
}

async function expect401(p, what) {
  const r = await p;
  assert.equal(r.status, 401, what);
  assert.deepEqual(await r.json(), { ok: false, error: 'unauthorized' }, what);
  assert.equal(r.headers.get('access-control-allow-origin'), '*', `${what}: 401 also carries CORS headers`);
}

// M6a（`docs/plan/auth-contract.md` 第 8 节）：集群令牌退役，非回环来源读写都凭素材票据。原来的 H3 / H4 测
// 「写要令牌、读不要」，现在测「写要 rw 票据、读要票据（Bearer 或查询串只读票据）」，断言的形状（401 回包、跨源头、
// 先鉴权后校验、被拒不落盘）不变；令牌换成票据。
test('H3 isTrusted is false: no ticket or a bad ticket → 401; writes with an rw ticket work as usual; reads also need a ticket (Bearer or a query-string read-only ticket); OPTIONS does not need one', async () => {
  const kit = await assetTicketKit();
  const ticket = kit.issue('rw');
  const srv = await serve({ opts: { store: memoryStore(), tickets: kit.tickets, isTrusted: () => false } });
  const { base } = srv;
  const { buf, hash, h } = smallAsset(301);

  await expect401(put(base, hash, 0, buf, h), 'PUT without ticket');
  const wrongs = [
    ['a garbage ticket', bearer(randomToken())],
    ['ticket with one extra character', bearer(`${ticket}x`)],
    ['ticket with one character missing', bearer(ticket.slice(0, -1))],
    ['without Bearer', { Authorization: ticket }],
    ['Basic', { Authorization: `Basic ${Buffer.from(`u:${ticket}`).toString('base64')}` }],
    ['empty Bearer', { Authorization: 'Bearer ' }],
    ['ticket placed in another header', { 'X-Cluster-Token': ticket }],
  ];
  for (const [what, hdr] of wrongs) await expect401(put(base, hash, 0, buf, { ...h, ...hdr }), `PUT ${what}`);
  assert.deepEqual((await chunks(base, hash, bearer(ticket))).received, [], 'rejected writes do not count as received');
  assert.deepEqual(await chunks(base, hash, bearer(ticket)), { size: null, chunkSize: CHUNK, received: [], complete: false }, 'rejected writes do not register a size either');

  await expect401(complete(base, hash), 'POST complete without ticket');
  for (const [what, hdr] of wrongs) await expect401(complete(base, hash, hdr), `POST complete ${what}`);

  // 票据区分大小写（签名是按原始字节验的）
  const flipped = ticket.replace(/\.([^.]*)$/, (m, sig) => `.${sig.replace(/[a-zA-Z]/, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))}`);
  assert.notEqual(flipped, ticket);
  await expect401(put(base, hash, 0, buf, { ...h, ...bearer(flipped) }), 'ticket with different letter case');

  // scheme 不区分大小写
  for (const scheme of ['bearer', 'BEARER']) {
    const r2 = await put(base, hash, 0, buf, { ...h, Authorization: `${scheme} ${ticket}` });
    assert.equal(r2.status, 200, `scheme written as ${scheme}`);
    await r2.arrayBuffer();
  }

  // 票据对：照常
  const ok = await put(base, hash, 0, buf, { ...h, ...bearer(ticket) });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, hash, n: 0, bytes: buf.length });
  await expect401(complete(base, hash), 'the chunk was received, but finalize still needs a ticket');
  const fin = await complete(base, hash, bearer(ticket));
  assert.equal(fin.status, 200);
  assert.deepEqual(await fin.json(), { ok: true, hash, size: buf.length, complete: true, url: `/@media/${hash}` });

  // 读：不带票据 401；Bearer 票据、查询串只读票据照常（M6a；原来是「读不要令牌」）
  await expect401(fetch(`${base}/media/${hash}`), 'GET without ticket');
  await expect401(fetch(`${base}/media/${hash}`, { method: 'HEAD' }).then((r) => ({ status: r.status, headers: r.headers, json: async () => ({ ok: false, error: 'unauthorized' }) })), 'HEAD without ticket');
  await expect401(fetch(`${base}/media/${hash}/chunks`), 'chunks without ticket');
  await expect401(fetch(`${srv.origin}/@media/${hash}`), 'legacy route without ticket');
  const got = await fetch(`${base}/media/${hash}`, { headers: { Origin: 'http://192.168.1.50:8080', ...bearer(ticket) } });
  assert.equal(got.status, 200);
  assert.equal(sha256(Buffer.from(await got.arrayBuffer())), hash);
  assert.equal((await fetch(`${base}/media/${hash}`, { method: 'HEAD', headers: bearer(ticket) })).status, 200);
  const part = await fetch(`${base}/media/${hash}`, { headers: { Range: 'bytes=0-9', ...bearer(ticket) } });
  assert.equal(part.status, 206);
  await part.arrayBuffer();
  const readOnly = kit.issue('r');
  const q = await fetch(`${base}/media/${hash}?t=${encodeURIComponent(readOnly)}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(q.status, 206, 'query-string read-only ticket');
  assert.equal(q.headers.get('cache-control'), 'no-store');
  assert.equal(q.headers.get('referrer-policy'), 'no-referrer');
  await q.arrayBuffer();
  await expect401(fetch(`${base}/media/${hash}?t=${encodeURIComponent(ticket)}`), 'the query string accepts only a read-only ticket');
  const st = await fetch(`${base}/media/${hash}/chunks`, { headers: bearer(readOnly) });
  assert.equal(st.status, 200);
  assert.equal((await st.json()).complete, true);
  const pre = await fetch(`${base}/media/${hash}/0`, { method: 'OPTIONS', headers: { Origin: 'http://192.168.1.50:8080', 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(pre.status, 204);

  // 只读票据写入 403；查询串用于写入 401
  const r403 = await put(base, hash, 0, buf, { ...h, ...bearer(readOnly) });
  assert.equal(r403.status, 403);
  assert.deepEqual(await r403.json(), { ok: false, error: 'forbidden' });
  await expect401(fetch(`${base}/media/${hash}/complete?t=${encodeURIComponent(readOnly)}`, { method: 'POST' }), 'query string used for writing');

  // 入库后的幂等重传也是写：照样要票据
  await expect401(put(base, hash, 0, buf, h), 'PUT without ticket after storing');
  await expect401(complete(base, hash), 'complete without ticket after storing');
  assert.equal((await put(base, hash, 0, buf, { ...h, ...bearer(ticket) })).status, 200);

  // 先鉴权：长度、分片号、size 都不对的未授权写也回 401，不看其它校验
  await expect401(put(base, hash, 0, buf.subarray(1), h), 'unauthorized write with wrong length');
  await expect401(put(base, hash, 9, buf, h), 'unauthorized write out of range');
  await expect401(put(base, hash, '01', buf, h), 'unauthorized write with a malformed chunk number');
  await expect401(put(base, hash, 0, buf, { 'X-Media-Ext': 'png' }), 'unauthorized write missing size');

  // 请求体比一片还大的未授权写：连接被掐断或回 401，都不能落进存储
  const big = bytesOf(CHUNK + 5, 302);
  const bh = sha256(big);
  const r = await put(base, bh, 0, big, { 'X-Media-Size': String(big.length) }).catch((e) => e);
  if (!(r instanceof Error)) { assert.equal(r.status, 401); await r.arrayBuffer().catch(() => {}); }
  assert.deepEqual((await chunks(base, bh, bearer(ticket))).received, []);
});

test('H4 tickets is null and not local: reads and writes are all 401; local works as usual; the default isTrusted accepts loopback only; the cluster token is no longer accepted; the default verifier uses <root>/out/docservice/auth', async () => {
  const store = memoryStore();
  const { buf, hash, h } = smallAsset(401);

  const kit = await assetTicketKit();
  const remote = await serve({ opts: { store, tickets: null, isTrusted: () => false } });
  for (const hdr of [{}, bearer(randomToken()), bearer(kit.issue('rw')), { Authorization: 'Bearer null' }, { Authorization: 'Bearer ' }, { Authorization: 'Bearer undefined' }]) {
    await expect401(put(remote.base, hash, 0, buf, { ...h, ...hdr }), `non-local PUT ${JSON.stringify(hdr).slice(0, 40)}`);
    await expect401(complete(remote.base, hash, hdr), `non-local complete ${JSON.stringify(hdr).slice(0, 40)}`);
  }
  await expect401(fetch(`${remote.base}/media/${hash}/chunks`), 'no verifier: reads are also 401 (M6a; reads used to work as usual)');

  // 本机（isTrusted 为真）：不带票据照常
  const local = await serve({ opts: { store, tickets: null, isTrusted: () => true } });
  assert.equal((await put(local.base, hash, 0, buf, h)).status, 200);
  assert.equal((await complete(local.base, hash)).status, 200);
  // 两台服务共用一个数据层：本机能读到
  assert.equal((await fetch(`${local.base}/media/${hash}`)).status, 200);

  // 缺省 isTrusted：按 socket.remoteAddress 判回环
  const cases = [
    ['127.0.0.1', true], ['127.8.9.10', true], ['::1', true], ['::ffff:127.0.0.1', true],
    ['192.168.1.50', false], ['10.0.0.7', false], ['::ffff:192.168.1.50', false], ['fe80::1', false], ['8.8.8.8', false],
  ];
  for (const [addr, trusted] of cases) {
    const s = await serve({ opts: { store: memoryStore(), tickets: null }, remote: addr });
    const x = smallAsset(410, 64);
    const r = await put(s.base, x.hash, 0, x.buf, x.h);
    assert.equal(r.status, trusted ? 200 : 401, `remoteAddress ${addr}`);
    await r.arrayBuffer();
  }

  // 集群令牌不再用于素材服务（C5 的做法退役）：环境变量设了、Bearer 带了也 401（原来这里测「缺省 token 取环境变量」）
  const envToken = randomToken();
  process.env.PROMPTCUT_CLUSTER_TOKEN = envToken;
  let s;
  try { s = await serve({ opts: { store: memoryStore(), tickets: null, token: envToken, isTrusted: () => false } }); } finally { delete process.env.PROMPTCUT_CLUSTER_TOKEN; }
  const y = smallAsset(420, 80);
  await expect401(put(s.base, y.hash, 0, y.buf, { ...y.h, ...bearer(envToken) }), 'cluster token write');
  await expect401(fetch(`${s.base}/media/${y.hash}/chunks`, { headers: bearer(envToken) }), 'cluster token read');

  // 缺省核对器：按 <root>/out/docservice/auth 取进程内的凭证存储（与同进程的文档服务共用）
  const { credentialStoreFor, forgetCredentialStore } = await import('../auth/store.mjs');
  const d = await serve({ opts: { store: memoryStore(), isTrusted: () => false } });
  const authDir = path.join(d.root, 'out', 'docservice', 'auth');
  const shared = credentialStoreFor(authDir);
  try {
    const dk = await assetTicketKit({ store: shared });
    const z = smallAsset(430, 96);
    await expect401(put(d.base, z.hash, 0, z.buf, z.h), 'default verifier: no ticket');
    assert.equal((await put(d.base, z.hash, 0, z.buf, { ...z.h, ...bearer(dk.issue('rw')) })).status, 200, 'the default verifier accepts tickets signed by the credential store in the same directory');
    await expect401(put(d.base, z.hash, 0, z.buf, { ...z.h, ...bearer(kit.issue('rw')) }), 'tickets signed by another credential store are not accepted');
  } finally { forgetCredentialStore(authDir); }
});

test('H5 the Access-Control-Allow-Headers returned by preflight includes Authorization (both middlewares and the constant do)', async () => {
  const names = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase());
  assert.ok(names(asset.ASSET_ALLOW_HEADERS).includes('authorization'), `ASSET_ALLOW_HEADERS: ${asset.ASSET_ALLOW_HEADERS}`);
  for (const k of ['content-type', 'range', 'x-media-size', 'x-media-ext', 'x-media-type']) assert.ok(names(asset.ASSET_ALLOW_HEADERS).includes(k), k);

  const srv = await serve({ opts: { store: memoryStore(), tickets: null, isTrusted: () => false } });
  const h = 'ab'.repeat(32);
  for (const url of [`${srv.base}/media/${h}/0`, `${srv.base}/media/${h}/complete`, `${srv.base}/media/${h}/chunks`, `${srv.origin}/@media/${h}`]) {
    const pre = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: 'http://192.168.1.50:8080', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization, x-media-size' },
    });
    assert.equal(pre.status, 204, url);
    assert.ok(names(pre.headers.get('access-control-allow-headers')).includes('authorization'), `${url}: ${pre.headers.get('access-control-allow-headers')}`);
  }

  // 排在 vite cors 前面的那个预检中间件
  const fn = asset.assetPreflightMiddleware();
  const res = await new Promise((resolve) => {
    const r = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end() { resolve(this); } };
    fn({ method: 'OPTIONS', url: `/api/asset/media/${h}/0`, headers: { origin: 'http://192.168.1.50:8080' } }, r, () => resolve('next'));
  });
  assert.notEqual(res, 'next');
  assert.equal(res.statusCode, 204);
  assert.ok(names(res.headers['access-control-allow-headers']).includes('authorization'));
});

// M6a：令牌换成素材票据，断言不变（日志与回包里都没有票据原文）
test('H6 after several rejected and accepted attempts each: neither the logs nor the response bodies contain the raw ticket', async () => {
  const kit = await assetTicketKit();
  const token = kit.issue('rw');
  const seen = [];
  const orig = {
    log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug,
    out: process.stdout.write, err: process.stderr.write,
  };
  const capture = (...args) => { seen.push(args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ')); };
  console.log = console.info = console.warn = console.error = console.debug = capture;
  process.stdout.write = function (chunk, ...rest) { seen.push(String(chunk)); return orig.out.call(this, chunk, ...rest); };
  process.stderr.write = function (chunk, ...rest) { seen.push(String(chunk)); return orig.err.call(this, chunk, ...rest); };
  const bodies = [];
  const record = async (p) => {
    const r = await p;
    const text = Buffer.from(await r.arrayBuffer()).toString('latin1');
    bodies.push(`${r.status} ${JSON.stringify([...r.headers])} ${text}`);
    return r;
  };
  try {
    const srv = await serve({ opts: { store: memoryStore(), tickets: kit.tickets, isTrusted: () => false } });
    const { base } = srv;
    for (let i = 0; i < 3; i++) {
      const { buf, hash, h } = smallAsset(600 + i, 900 + i);
      await record(put(base, hash, 0, buf, h));
      await record(put(base, hash, 0, buf, { ...h, ...bearer(`${token}${i}`) }));
      await record(put(base, hash, 0, buf, { ...h, Authorization: token }));
      await record(complete(base, hash, bearer(token.slice(1))));
      assert.equal((await record(put(base, hash, 0, buf, { ...h, ...bearer(token) }))).status, 200);
      assert.equal((await record(complete(base, hash, bearer(token)))).status, 200);
      await record(complete(base, hash, bearer(token)));
      await record(put(base, hash, 5, buf, { ...h, ...bearer(token) }));
      await record(put(base, hash, 0, buf.subarray(1), { ...h, ...bearer(token), 'X-Media-Size': String(buf.length + 1) }));
      await record(fetch(`${base}/media/${hash}`, { headers: bearer(token) }));
      await record(fetch(`${base}/media/${hash}/chunks`, { headers: bearer(token) }));
      await record(fetch(`${base}/media/${hash}?t=${encodeURIComponent(kit.issue('r'))}`));
      await record(fetch(`${base}/media/${hash}?t=${encodeURIComponent(token)}`));
    }
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    Object.assign(console, { log: orig.log, info: orig.info, warn: orig.warn, error: orig.error, debug: orig.debug });
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
  }
  assert.ok(bodies.length >= 30);
  for (const b of bodies) assert.ok(!b.includes(token), `the raw ticket appeared in a response body: ${b.slice(0, 200)}`);
  for (const line of seen) assert.ok(!line.includes(token), `the raw ticket appeared in the logs: ${line.slice(0, 200)}`);
});
