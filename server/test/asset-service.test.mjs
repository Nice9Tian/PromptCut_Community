// Asset service (step 5): chunked upload, resumable upload reconciliation, finalize validation,
// retrieval by hash, cross-origin, and prerender process forwarding.
// Contract is in the header of server/asset-service.ts. Run: node --test server/test/asset-service.test.mjs
//
// The plugin is .ts; like media-hash.test, transpile to a temp directory with typescript before importing;
// change import paths between sibling modules to transpiled outputs.
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
  // server/i18n.mjs is not copied into the scratch folder: point the import back at the real file
  src = src.replace(/from (['"])(?:\.\.?\/)+i18n\.mjs\1/g, (_m, q) => `from ${q}${pathToFileURL(path.join(ROOT, 'server', 'i18n.mjs')).href}${q}`);
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

/** Same wiring as mediaPlugin: asset service first, old routes after */
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
/** Deterministic pseudorandom bytes, different content for each test case */
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

/** Uploader resumable upload: first reconcile, only resend missing chunks in received, then finalize. Return chunk numbers actually sent */
async function resume(hash, buf, ext) {
  const status = await chunks(hash);
  if (status.complete) return { sent: [], status };
  const have = new Set(status.received);
  const sent = [];
  for (let n = 0; n < asset.chunkCount(buf.length); n++) {
    if (have.has(n)) continue;
    const r = await put(hash, n, sliceOf(buf, n), asset.chunkHeaders(buf.length, `x.${ext}`));
    assert.equal(r.status, 200, `re-upload chunk ${n}`);
    sent.push(n);
  }
  const done = await complete(hash);
  return { sent, done, status: await chunks(hash) };
}

/** Send a chunk, abort connection after writing only a part: simulate network disconnection mid-upload */
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

test('contract constants: 8 MiB per chunk, anything under 8 MiB is 1 chunk, the last chunk may be short', () => {
  assert.equal(CHUNK, 8 * 1024 * 1024);
  assert.equal(asset.chunkCount(1), 1);
  assert.equal(asset.chunkCount(CHUNK), 1);
  assert.equal(asset.chunkCount(CHUNK + 1), 2);
  assert.equal(asset.chunkLength(CHUNK * 2 + 5, 0), CHUNK);
  assert.equal(asset.chunkLength(CHUNK * 2 + 5, 2), 5);
});

test('resume after disconnect: chunks reports the received chunks and only the missing chunk is re-uploaded; complete becomes true only after validation passes', async () => {
  const size = CHUNK * 2 + 4321; // 3 chunks
  const buf = bytesOf(size, 1);
  const hash = sha256(buf);

  assert.deepEqual(await chunks(hash), { size: null, chunkSize: CHUNK, received: [], complete: false });

  // Chunks 0 and 2 uploaded, network disconnected halfway through chunk 1
  const h = asset.chunkHeaders(size, 'clip.mp4');
  assert.equal((await put(hash, 0, sliceOf(buf, 0), h)).status, 200);
  assert.equal((await put(hash, 2, sliceOf(buf, 2), h)).status, 200);
  await putAndDrop(hash, 1, size, sliceOf(buf, 1).subarray(0, 1024 * 1024));

  const mid = await chunks(hash);
  assert.deepEqual(mid, { size, chunkSize: CHUNK, received: [0, 2], complete: false }, 'the chunk that was cut off does not count as received');

  // Cannot finalize until all chunks have arrived
  const early = await complete(hash);
  assert.equal(early.status, 400);
  assert.deepEqual((await early.json()).missing, [1]);
  assert.equal((await chunks(hash)).complete, false);

  // Resume: only backfill chunk 1
  const { sent, done, status } = await resume(hash, buf, 'mp4');
  assert.deepEqual(sent, [1], 're-upload only the missing chunks');
  assert.equal(done.status, 200);
  const body = await done.json();
  assert.equal(body.complete, true);
  assert.equal(body.url, `/@media/${hash}`);
  assert.deepEqual(status, { size, chunkSize: CHUNK, received: [0, 1, 2], complete: true });

  // Stored: local content store has <hash>.mp4, staging area is cleared
  const dir = media.mediaDir(projectRoot);
  assert.ok(fs.existsSync(path.join(dir, `${hash}.mp4`)));
  assert.equal(sha256(fs.readFileSync(path.join(dir, `${hash}.mp4`))), hash);
  assert.ok(!fs.existsSync(path.join(dir, '.chunks', hash)));

  // Once stored, re-uploading any chunk or finalizing again is an idempotent 200
  assert.equal((await put(hash, 0, sliceOf(buf, 0), h)).status, 200);
  assert.equal((await complete(hash)).status, 200);
});

test('whole-file sha256 mismatch returns 409, all received chunks are discarded, and retrieval is still 404', async () => {
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
  assert.equal((await complete(claimed)).status, 404, 'after the discard this hash is one never seen before');
});

test('chunk validation: out of range, wrong length, missing size, inconsistent size between requests, and chunk number format all return 4xx; re-sending the same chunk is idempotent', async () => {
  const size = CHUNK + 10; // 2 chunks: 8 MiB + 10
  const buf = bytesOf(size, 3);
  const hash = sha256(buf);
  const h = asset.chunkHeaders(size, 'b.mp4');

  assert.equal((await put(hash, 2, Buffer.alloc(10), h)).status, 416, 'out of range');
  assert.equal((await put(hash, 0, Buffer.alloc(10), h)).status, 400, 'a non-last chunk must be exactly 8 MiB');
  assert.equal((await put(hash, 1, Buffer.alloc(11), h)).status, 400, 'the last chunk must also have the right length');
  assert.equal((await put(hash, 1, Buffer.alloc(10))).status, 400, 'missing X-Media-Size');
  assert.equal((await put(hash, '01', Buffer.alloc(10), h)).status, 400, 'chunk number has no leading zero');
  assert.equal((await put(hash, 'x', Buffer.alloc(10), h)).status, 404, 'a tail that is not a chunk number is not handled by the asset service');
  assert.deepEqual((await chunks(hash)).received, [], 'rejected chunks do not count as received');

  assert.equal((await put(hash, 1, sliceOf(buf, 1), h)).status, 200);
  assert.equal((await put(hash, 1, sliceOf(buf, 1), h)).status, 200, 're-send the same chunk');
  // Chunk 0 length is still exactly 8 MiB under size+1; passing the length check, it hits size mismatch
  assert.equal((await put(hash, 0, sliceOf(buf, 0), { 'X-Media-Size': String(size + 1) })).status, 409, 'size does not match the registered one');
  assert.deepEqual((await chunks(hash)).received, [1]);

  assert.equal((await put(hash, 0, sliceOf(buf, 0), h)).status, 200);
  const r = await complete(hash);
  assert.equal(r.status, 200);
  assert.equal((await chunks(hash)).complete, true);
});

test('retrieve by hash: Content-Type follows the extension, Range returns 206, out of range returns 416; /@media/<hash> is equivalent', async () => {
  const buf = bytesOf(5000, 4);
  const hash = sha256(buf);
  await put(hash, 0, buf, { 'X-Media-Size': String(buf.length), 'X-Media-Type': 'video/webm' });
  assert.equal((await complete(hash)).status, 200);

  for (const url of [`${base}/media/${hash}`, `${origin}/@media/${hash}`]) {
    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'video/webm', 'X-Media-Type reverse-maps to webm');
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

test('the old whole-file import (/api/media/upload) still works, and the imported media is complete in the reconcile endpoint', async () => {
  const buf = bytesOf(2048, 5);
  const r = await fetch(`${origin}/api/media/upload/whole.mp4`, { method: 'POST', body: buf, headers: { 'Content-Type': 'video/mp4' } });
  assert.equal(r.status, 200);
  const stored = await r.json();
  assert.equal(stored.hash, sha256(buf));
  assert.deepEqual(await chunks(stored.hash), { size: 2048, chunkSize: CHUNK, received: [0], complete: true });
  assert.equal((await fetch(`${base}/media/${stored.hash}`)).headers.get('content-type'), 'video/mp4');
});

test('cross-origin: both the preflight and the actual request from another origin (simulating a LAN device) get CORS headers', async () => {
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

  // Public web page preflight: returns CORS headers as usual, but denies private network access
  // (only allowed for loopback and LAN origins)
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

  // Routes outside asset service do not include CORS headers
  const other = await fetch(`${origin}/api/media/local?hashes=${hash}`, { headers: { Origin: LAN } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  await other.arrayBuffer();
});

test('client: media record → HTTP URL on the asset service; the base URL follows PROMPTCUT_EDITOR_URL → this process\'s listening address', async () => {
  const h = 'a'.repeat(64);
  const o = 'http://127.0.0.1:9';
  assert.equal(client.mediaHttpUrl({ hash: h.toUpperCase(), url: '/@media/whatever' }, o), `${o}/@media/${h}`);
  assert.equal(client.mediaHttpUrl({ url: `/@media/${h}` }, o), `${o}/@media/${h}`);
  assert.equal(client.mediaHttpUrl({ url: '/@media/%E7%B4%A0%E6%9D%90.mp4' }, o), `${o}/@media/${encodeURIComponent('素材.mp4')}`);
  // The path passed in from outside only takes the trailing filename, cannot point outside the store
  assert.equal(client.mediaHttpUrl({ path: 'C:\\Windows\\win.ini' }, o), `${o}/@media/win.ini`);
  assert.equal(client.mediaHttpUrl({ url: 'a%2F..%2F..%2Fx' }, o), `${o}/@media/x`);
  assert.equal(client.mediaHttpUrl({ url: 'blob:http://x/1' }, o), null);
  assert.equal(client.mediaHttpUrl({ hash: h }, null), null, 'asset service unreachable');

  // Single-process mode: media plugin records this process's listen address
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  client.rememberLocalAssetOrigin(s);
  assert.equal(client.assetServiceOrigin(), `http://127.0.0.1:${s.address().port}`);
  s.close();
  // Prerender process: editor-side address takes precedence
  process.env.PROMPTCUT_EDITOR_URL = 'http://127.0.0.1:5220/';
  try { assert.equal(client.assetServiceOrigin(), 'http://127.0.0.1:5220'); }
  finally { delete process.env.PROMPTCUT_EDITOR_URL; }
});

test('prerender process forwarding: /@media and /api/asset are forwarded to the asset service as is, Range is passed through, bytes unchanged', async () => {
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

  assert.equal((await fetch(`${proxy}/src/main.tsx`)).status, 404, 'other paths are not forwarded');
});

/** Where ffmpeg is located (same candidates as server/vision/ffmpeg-frames.ts); if not found, skip the ffmpeg test */
function findFfmpeg() {
  const candidates = [process.env.PROMPTCUT_FFMPEG, 'ffmpeg',
    path.join(process.env.LOCALAPPDATA || os.homedir(), 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin', 'ffmpeg.exe')].filter(Boolean);
  for (const c of candidates) {
    try { if (spawnSync(c, ['-version'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }).status === 0) return c; } catch { /* Next */ }
  }
  return null;
}
const ffmpeg = findFfmpeg();

test('ffmpeg extracts frames through the asset service\'s HTTP URL (the way the media layer reads), with pixels identical to reading the file directly', { skip: !ffmpeg && 'ffmpeg is not available on this machine' }, async () => {
  const { extractArgs } = await import(pathToFileURL(path.join(ROOT, 'server', 'vision-compose.mjs')).href);
  const src = path.join(OUT, 'src.mp4');
  const made = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2', '-pix_fmt', 'yuv420p', src], { windowsHide: true });
  assert.equal(made.status, 0, String(made.stderr));
  const buf = fs.readFileSync(src);
  const hash = sha256(buf);
  // Stored via chunked upload (less than 8 MiB, 1 chunk)
  assert.equal((await put(hash, 0, buf, asset.chunkHeaders(buf.length, 'src.mp4'))).status, 200);
  assert.equal((await complete(hash)).status, 200);

  const url = client.mediaHttpUrl({ hash }, origin);
  const outHttp = path.join(OUT, 'via-http.png');
  const outFile = path.join(OUT, 'via-file.png');
  const opts = { kind: 'video', seconds: 1.2, width: 160, height: 90, opacity: 1 };
  // ffmpeg makes requests on its own; main thread must stay free to respond: use async spawn
  const run = (args) => new Promise((resolve) => {
    const child = require_('node:child_process').spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = ''; child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, err }));
  });
  const a = await run(extractArgs({ ...opts, file: url, out: outHttp }));
  assert.equal(a.code, 0, a.err);
  const b = await run(extractArgs({ ...opts, file: src, out: outFile }));
  assert.equal(b.code, 0, b.err);
  assert.equal(sha256(fs.readFileSync(outHttp)), sha256(fs.readFileSync(outFile)), 'the frame extracted over HTTP is byte-for-byte identical to the one read from the file directly');
});

test('preflight middleware: answers only OPTIONS for asset service routes (the media plugin inserts it before Vite\'s built-in cors) and lets everything else pass', async () => {
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

test('reserved merge dispatch (C10 contract section 11): POST merge/<projectId>/<shared key> returns 501, only a placeholder that does not touch the store', async () => {
  const before = fs.readdirSync(media.mediaDir(projectRoot)).sort();
  const r = await fetch(`${base}/merge/proj-1/${'ab'.repeat(32)}`, { method: 'POST', body: '{"any":"thing"}', headers: { 'Content-Type': 'application/json', Origin: 'http://192.168.1.50:8080' } });
  assert.equal(r.status, 501);
  assert.deepEqual(await r.json(), { ok: false, error: 'not-implemented' });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  // Neither projectId nor share key is parsed: any shape still returns 501
  assert.equal((await fetch(`${base}/merge/${encodeURIComponent('不是项目')}/x`, { method: 'POST' })).status, 501);
  // Other methods 405; missing a segment is not this route
  const g = await fetch(`${base}/merge/proj-1/k`);
  assert.equal(g.status, 405);
  assert.equal(g.headers.get('allow'), 'POST');
  assert.notEqual((await fetch(`${base}/merge/proj-1`, { method: 'POST' })).status, 501);
  assert.deepEqual(fs.readdirSync(media.mediaDir(projectRoot)).sort(), before, 'nothing was written to the content store');
});
