// C6.6 section 4: on-demand pulling for local asset service read routes (serving Range while saving
// to disk), prefetch queue, original-size asset check before export.
// Implemented in server/media-pull.mjs, attached to the `/@media/<hash>` miss branch in
// server/vite-plugin-media.ts.
// How to run: node --test server/test/media-pull.test.mjs
//
// Plugin is .ts, transpiled with typescript to a temp directory before import like asset-service.test;
// lazy-imported pull module paths are changed to absolute paths in the repository.
// "Remote asset service" is a small HTTP service started in this file: only implements
// `GET media/<hash>` (can rate-limit, can return wrong bytes) and `GET media/<hash>/chunks`.
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

/* ---------------- Local asset service (under test) ---------------- */
const local = await listen((req, res) => {
  void media.mediaMiddleware(projectRoot)(req, res, () => { res.statusCode = 404; res.end('no route'); });
});

/* ---------------- "Remote asset service" ---------------- */
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
 * Wait for background pull to store this hash into local content store, wait until deadline
 * (default 10 s), return file path; if still missing when expired, return null (asserted by caller).
 * Previously a step limit of "at most 50 / 200 times × 20 ms"; when the machine is busy (several npm
 * tests in parallel), background finalization may exceed 1-4 s and cause false negatives.
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

test('T5-pull-1: not in the local content store and no remote asset service connected → 404 (same as before)', async () => {
  const { hash } = addRemote(1000, 1);
  const r = await fetch(`${local}/@media/${hash}`);
  assert.equal(r.status, 404);
  assert.equal(remoteHits.length, 0, 'Without a remote connection, it does not ask');
});

test('T5-pull-2: remote connected → the same request gets all the bytes of the file; after the pull it enters the local content store, and the second request is a local hit', async () => {
  const { hash, bytes } = addRemote(300_000, 2);
  assert.equal((await setRemote({ base: REMOTE_BASE, ticket: 'tkt-secret-1' })).status, 200);
  const r = await fetch(`${local}/@media/${hash}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  const got = Buffer.from(await r.arrayBuffer());
  assert.equal(sha256(got), hash);
  // Pull finalization (verification, renaming) runs in background: wait for it to be stored
  await waitLocal(hash);
  const file = await localFile(hash);
  assert.ok(file && file.endsWith(`${hash}.mp4`), `It entered the local content store, with the extension taken from the remote Content-Type: ${file}`);
  assert.equal(fs.readFileSync(file).length, bytes.length);
  assert.equal(remoteHits.filter((h) => h.url.endsWith(hash)).length, 1);
  assert.equal(remoteHits[0].auth, 'Bearer tkt-secret-1', 'The ticket goes only into the Authorization header');
  const again = await fetch(`${local}/@media/${hash}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(again.status, 206);
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), bytes.subarray(0, 10));
  assert.equal(remoteHits.filter((h) => h.url.endsWith(hash)).length, 1, 'The second request no longer goes to the remote');
  assert.ok(!JSON.stringify(pull.pullLog()).includes('tkt-secret-1'), 'The ticket does not go into the log');
  const tmpLeft = fs.readdirSync(media.mediaDir(projectRoot)).filter((n) => n.startsWith('.pull-'));
  assert.deepEqual(tmpLeft, [], 'Temporary files are cleaned up');
});

test('T5-pull-3: serve by Range while writing to disk; while the remote is still transferring slowly, a Range request for the part already on disk is answered first', async () => {
  const size = 2_000_000;
  const { hash, bytes } = addRemote(size, 3, { throttle: { chunk: 64 * 1024, ms: 40 } }); // Whole file is about 1.3 s
  await setRemote({ base: REMOTE_BASE });
  const t0 = Date.now();
  const r = await fetch(`${local}/@media/${hash}`, { headers: { Range: 'bytes=1000-50999' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 1000-50999/${size}`);
  const got = Buffer.from(await r.arrayBuffer());
  const ms = Date.now() - t0;
  assert.deepEqual(got, bytes.subarray(1000, 51000));
  // Wall-clock criterion changed to relative to whole file: previously ms < 800 (whole file ~1.3 s,
  // i.e. ~60%). When the machine is busy, both slow down together, evaluated by ratio;
  // plus the time-independent evidence that "at this point the whole file is not yet stored".
  // If it really degenerates into "only answer after whole file is downloaded" with ms ≥ fullMs,
  // it will still be blocked.
  assert.equal(await localFile(hash), null, 'At this point the whole file is not yet in the store');
  // Second request for the same hash attaches to the same pull task, without starting a new one
  const r2 = await fetch(`${local}/@media/${hash}`, { headers: { Range: 'bytes=0-99' } });
  assert.deepEqual(Buffer.from(await r2.arrayBuffer()), bytes.subarray(0, 100));
  assert.equal(remoteHits.filter((h) => h.url.endsWith(hash) && !h.range).length, 1, 'The same hash is pulled only once');
  const fullMs = (await waitLocal(hash)) ? Date.now() - t0 : Infinity;
  assert.ok(ms < fullMs * 0.6, `The first 50 KB was answered well before the whole file finished downloading: Range response ${ms} ms, whole file in the store ${fullMs} ms`);
  assert.ok(await localFile(hash), 'After the pull it enters the store');
});

test('T5-pull-4: the remote does not have it either (404) → 404; one that is not yet complete on the remote does not count as present', async () => {
  const { hash } = addRemote(1000, 4, { complete: false });
  await setRemote({ base: REMOTE_BASE });
  const r = await fetch(`${local}/@media/${hash}`);
  assert.equal(r.status, 404);
  assert.equal(await localFile(hash), null);
});

test('T5-pull-5: sha256 of the bytes from the remote does not match → not added to the local content store', async () => {
  const bytes = bytesOf(200_000, 5);
  const hash = sha256(bytes);
  remoteFiles.set(hash, { bytes, wrong: bytesOf(200_000, 55), type: 'video/mp4', complete: true });
  await setRemote({ base: REMOTE_BASE });
  await fetch(`${local}/@media/${hash}`).then((r) => r.arrayBuffer()).catch(() => null);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(await localFile(hash), null, 'What fails verification is not stored');
  assert.ok(pull.pullLog().some((e) => e.event === 'pull.mismatch' && e.hash === hash));
  const tmpLeft = fs.readdirSync(media.mediaDir(projectRoot)).filter((n) => n.startsWith('.pull-'));
  assert.deepEqual(tmpLeft, []);
});

test('T5-pull-6: when the Range start is far beyond the position already on disk (e.g. moov at the tail) → this part is passed straight through from the remote', async () => {
  const size = 12 * 1024 * 1024;
  const { hash, bytes } = addRemote(size, 6, { throttle: { chunk: 256 * 1024, ms: 50 } });
  await setRemote({ base: REMOTE_BASE });
  const head = await fetch(`${local}/@media/${hash}`, { headers: { Range: 'bytes=0-15' } });
  await head.arrayBuffer();
  const r = await fetch(`${local}/@media/${hash}`, { headers: { Range: `bytes=${size - 100}-` } });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(size - 100));
  assert.ok(remoteHits.some((h) => h.range === `bytes=${size - 100}-`), 'The tail part went to the remote with its Range');
  pull.setRemoteAssetService(null); // Abort slow pull
});

test('T5-prefetch-1: prefetch pulls one at a time in the given order and skips what is already local; clearing the remote cancels it', async () => {
  const a = addRemote(50_000, 71), b = addRemote(50_000, 72), c = addRemote(50_000, 73), d = addRemote(50_000, 74);
  await setRemote({ base: REMOTE_BASE });
  // b is pulled on demand first: skip during prefetch
  await (await fetch(`${local}/@media/${b.hash}`)).arrayBuffer();
  await waitLocal(b.hash);
  const r = await fetch(`${local}/api/media/prefetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ hash: c.hash }, { hash: b.hash }, { hash: a.hash }, { hash: d.hash }] }) });
  assert.deepEqual(await r.json(), { ok: true, queued: 4 });
  await waitLocal(d.hash);
  const starts = pull.pullLog().filter((e) => e.event === 'pull.start' && e.by === 'prefetch').map((e) => e.hash);
  assert.deepEqual(starts, [c.hash, a.hash, d.hash], 'In manifest order, skipping b which is already local');
  for (const x of [a, c, d]) assert.ok(await localFile(x.hash));
});

test('T5-prefetch-2: prefetch does nothing when no remote asset service is connected', async () => {
  const e = addRemote(10_000, 75);
  const r = await fetch(`${local}/api/media/prefetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ hash: e.hash }] }) });
  assert.deepEqual(await r.json(), { ok: true, queued: 0 });
  assert.equal(remoteHits.length, 0);
});

test('T7-originals-1: the pre-export check of asset original sizes asks only the currently connected asset service (remote: complete of chunks; the local cache does not count)', async () => {
  const ready = addRemote(10_000, 81);
  const notYet = addRemote(10_000, 82, { complete: false });
  // notYet is already in local cache (e.g. copied from another path), but remote is not complete:
  // still counted as not all arrived
  fs.writeFileSync(path.join(media.mediaDir(projectRoot), `${notYet.hash}.mp4`), notYet.bytes);
  await setRemote({ base: REMOTE_BASE, ticket: 'tkt-2' });
  const r = await fetch(`${local}/api/media/originals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: [ready.hash, notYet.hash] }) });
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.missing, [notYet.hash]);
  assert.ok(remoteHits.some((h) => h.url.endsWith(`${ready.hash}/chunks`) && h.auth === 'Bearer tkt-2'));
});

test('T7-originals-2: when no remote is connected it is the local asset service: look at the local content store', async () => {
  const have = bytesOf(5000, 83);
  const haveHash = sha256(have);
  fs.writeFileSync(path.join(media.mediaDir(projectRoot), `${haveHash}.mp4`), have);
  const missing = sha256(bytesOf(5000, 84));
  const r = await fetch(`${local}/api/media/originals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: [haveHash, missing] }) });
  assert.deepEqual((await r.json()).missing, [missing]);
});

test('T5-remote-1: the remote base address accepts only http(s) and none with a username; GET shows the status without returning the ticket', async () => {
  assert.equal((await setRemote({ base: 'file:///etc' })).status, 400);
  assert.equal((await setRemote({ base: 'http://u:p@127.0.0.1:1/api/asset' })).status, 400);
  await setRemote({ base: REMOTE_BASE + '/', ticket: 'tkt-3' });
  const st = await (await fetch(`${local}/api/media/remote`)).json();
  assert.equal(st.base, REMOTE_BASE);
  assert.ok(!JSON.stringify(st).includes('tkt-3'));
  assert.equal((await fetch(`${local}/api/media/remote`, { method: 'DELETE' })).status, 200);
  assert.equal((await (await fetch(`${local}/api/media/remote`)).json()).base, null);
});
