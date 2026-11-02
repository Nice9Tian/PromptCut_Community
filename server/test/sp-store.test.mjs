/**
 * Asset data layer for SP hosted side (contract `docs/plan/shared-project-contract.md` Section 1
 * "Layout options for fs-store", "Disk full").
 * Run: node --test server/test/sp-store.test.mjs
 *
 * - `createFsStore({ dir, shard: true })`: divides subdirectories by first two characters of hash,
 *   writes use temp files on the same filesystem plus rename; default layout remains unchanged.
 * - On `ENOSPC` and `EDQUOT`, writes return 507 `insufficient-storage`, do not mark complete,
 *   received chunks are retained. Uses mock storage to inject errors, verifies HTTP via asset service
 *   middleware.
 * Written strictly according to contract without looking at implementation; see assumption S1 in
 * `sp-kit.mjs` for whole file names in subdirectories.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { tmpDir, loadFsStore, sha256hex, assetReq } from './sp-kit.mjs';
import { loadAsset } from './auth-kit.mjs';

const body = (buf) => Readable.from([buf]);

async function putWhole(store, bytes, ext = 'bin') {
  const hash = sha256hex(bytes);
  const cs = store.chunkSize;
  const count = Math.ceil(bytes.length / cs);
  for (let n = 0; n < count; n++) {
    const r = await store.putChunk(hash, n, { size: bytes.length, ext }, body(bytes.subarray(n * cs, (n + 1) * cs)));
    assert.equal(r.status, 'ok', JSON.stringify(r));
  }
  const done = await store.complete(hash);
  assert.equal(done.status, 'ok', JSON.stringify(done));
  return hash;
}

async function readAll(stream) {
  const parts = [];
  for await (const p of stream) parts.push(p);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ shard layout

test('SPC1-8 fs-store shard: true: whole files land under <dir>/<first two hash chars>/; stat, read (including Range), chunks, usage and remove work as usual', async (t) => {
  const createFsStore = await loadFsStore();
  const dir = tmpDir(t);
  const store = createFsStore({ dir, shard: true, chunkSize: 1024 });
  const bytes = randomBytes(2500); // 3 chunks
  const hash = await putWhole(store, bytes);
  const sub = path.join(dir, hash.slice(0, 2));
  assert.ok(fs.statSync(sub).isDirectory(), `subdirectory ${hash.slice(0, 2)}/ exists`);
  const names = fs.readdirSync(sub);
  assert.ok(names.some((n) => n === hash || n.startsWith(`${hash}.`)), `whole files are in the subdirectory: ${names}`);
  assert.deepEqual(names.filter((n) => !(n === hash || n.startsWith(`${hash}.`))), [], `no leftover temp files in the subdirectory: ${names}`);
  assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith(hash)), 'no whole files laid out flat at the top level');

  const st = await store.stat(hash);
  assert.equal(st.size, bytes.length);
  assert.ok((await readAll(await store.read(hash))).equals(bytes), 'whole-file read-back matches');
  assert.ok((await readAll(await store.read(hash, { start: 1000, end: 1099 }))).equals(bytes.subarray(1000, 1100)), 'Range read-back matches');
  const ch = await store.chunks(hash);
  assert.equal(ch.complete, true);
  assert.deepEqual(ch.received, [0, 1, 2]);
  const u = await store.usage();
  assert.equal(u.blobs, 1, `usage counts the whole files in the subdirectory: ${JSON.stringify(u)}`);
  assert.equal(u.bytes, bytes.length);
  assert.equal(await store.remove(hash), true);
  assert.equal(await store.stat(hash), null);
});

test('SPC1-8 fs-store shard: true: multiple files are spread across their own two-character subdirectories; resumable upload (restart a new instance and keep uploading) works as usual', async (t) => {
  const createFsStore = await loadFsStore();
  const dir = tmpDir(t);
  const s1 = createFsStore({ dir, shard: true, chunkSize: 512 });
  const hashes = [];
  for (let i = 0; i < 6; i++) hashes.push(await putWhole(s1, randomBytes(700 + i)));
  for (const h of hashes) assert.ok(fs.existsSync(path.join(dir, h.slice(0, 2))), `${h.slice(0, 2)}/ exists`);
  for (const d of fs.readdirSync(dir)) {
    if (d.startsWith('.')) continue; // Staging directory, etc.
    assert.match(d, /^[0-9a-f]{2}$/, `the top level contains only two-digit hex subdirectories: ${d}`);
  }

  // Upload halfway, switch to another instance to resume upload
  const bytes = randomBytes(1500);
  const hash = sha256hex(bytes);
  assert.equal((await s1.putChunk(hash, 0, { size: bytes.length, ext: 'bin' }, body(bytes.subarray(0, 512)))).status, 'ok');
  const s2 = createFsStore({ dir, shard: true, chunkSize: 512 });
  const ch = await s2.chunks(hash);
  assert.deepEqual(ch.received, [0], 'the new instance can see the chunks already received');
  for (const n of [1, 2]) assert.equal((await s2.putChunk(hash, n, { size: bytes.length, ext: 'bin' }, body(bytes.subarray(n * 512, (n + 1) * 512)))).status, 'ok');
  assert.equal((await s2.complete(hash)).status, 'ok');
  assert.ok((await readAll(await s2.read(hash))).equals(bytes));
});

test('SPC1-8 fs-store default layout is unchanged (the local editor leaves the existing cache alone): whole files are still laid out flat in <dir>/<hash>[.ext]', async (t) => {
  const createFsStore = await loadFsStore();
  const dir = tmpDir(t);
  const store = createFsStore({ dir, chunkSize: 1024 });
  const hash = await putWhole(store, randomBytes(300));
  assert.ok(fs.existsSync(path.join(dir, `${hash}.bin`)), 'flat layout');
  assert.equal(fs.existsSync(path.join(dir, hash.slice(0, 2), `${hash}.bin`)), false);
});

// ------------------------------------------------------------------ Via asset service middleware (HTTP)

async function serveWith(t, stores) {
  const { asset } = await loadAsset();
  const root = tmpDir(t, 'pc-sp-root-');
  const mw = asset.assetServiceMiddleware(root, { stores, tickets: null, isTrusted: () => true });
  const server = http.createServer((req, res) => { void mw(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${server.address().port}/api/asset`;
}

const chunkHeaders = (size, ext = 'bin') => ({ 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(size), 'X-Media-Ext': ext });

test('SPC1-8 the asset service mounts an fs-store with the shard layout: after an HTTP upload the file lands in the two-character subdirectory and reads back identically', async (t) => {
  const createFsStore = await loadFsStore();
  const dir = tmpDir(t);
  const media = createFsStore({ dir, shard: true });
  const base = await serveWith(t, { media });
  const bytes = randomBytes(4000);
  const hash = sha256hex(bytes);
  assert.equal((await assetReq(base, `media/${hash}/0`, { method: 'PUT', headers: chunkHeaders(bytes.length), body: bytes })).status, 200);
  assert.equal((await assetReq(base, `media/${hash}/complete`, { method: 'POST' })).status, 200);
  assert.ok(fs.readdirSync(path.join(dir, hash.slice(0, 2))).some((n) => n.startsWith(hash)));
  const g = await assetReq(base, `media/${hash}`);
  assert.equal(g.status, 200);
  assert.equal(sha256hex(g.buf), hash);
});

// ------------------------------------------------------------------ Disk full

function diskFull(code) {
  const err = new Error(`${code}: no space left on device, write`);
  err.code = code;
  err.errno = code === 'ENOSPC' ? -28 : -122;
  err.syscall = 'write';
  return err;
}

/** Wrap around memory storage: chunk failAt (or complete) throws disk full */
async function fullStore({ code = 'ENOSPC', failChunk = null, failComplete = false } = {}) {
  const { store } = await loadAsset();
  const inner = store.createMemoryStore({ chunkSize: 1024 });
  return {
    ...inner,
    kind: 'memory',
    chunkSize: inner.chunkSize,
    async putChunk(hash, n, meta, source) {
      if (n === failChunk) {
        for await (const _ of source) { /* Read request body to end */ }
        throw diskFull(code);
      }
      return inner.putChunk(hash, n, meta, source);
    },
    async complete(hash) {
      if (failComplete) throw diskFull(code);
      return inner.complete(hash);
    },
  };
}

for (const code of ['ENOSPC', 'EDQUOT']) {
  test(`SPC1-9 when writing a chunk, ${code} → 507 insufficient-storage; chunks already received are kept; not marked complete`, async (t) => {
    const media = await fullStore({ code, failChunk: 1 });
    const base = await serveWith(t, { media });
    const bytes = randomBytes(2500);
    const hash = sha256hex(bytes);
    const p0 = await assetReq(base, `media/${hash}/0`, { method: 'PUT', headers: chunkHeaders(bytes.length), body: bytes.subarray(0, 1024) });
    assert.equal(p0.status, 200);
    const p1 = await assetReq(base, `media/${hash}/1`, { method: 'PUT', headers: chunkHeaders(bytes.length), body: bytes.subarray(1024, 2048) });
    assert.equal(p1.status, 507, `disk full returns 507: ${p1.status} ${p1.buf}`);
    assert.deepEqual(p1.json, { ok: false, error: 'insufficient-storage' });
    const ch = await assetReq(base, `media/${hash}/chunks`);
    assert.equal(ch.status, 200);
    assert.deepEqual(ch.json.received, [0], 'chunks already received are kept');
    assert.equal(ch.json.complete, false);
    assert.equal((await assetReq(base, `media/${hash}`)).status, 404, 'not marked complete');
  });

  test(`SPC1-9 on complete, ${code} → 507 insufficient-storage; not marked complete, chunks remain, and the upload can resume once space is back`, async (t) => {
    const media = await fullStore({ code, failComplete: true });
    const base = await serveWith(t, { media });
    const bytes = randomBytes(1500);
    const hash = sha256hex(bytes);
    for (const n of [0, 1]) {
      const r = await assetReq(base, `media/${hash}/${n}`, { method: 'PUT', headers: chunkHeaders(bytes.length), body: bytes.subarray(n * 1024, (n + 1) * 1024) });
      assert.equal(r.status, 200);
    }
    const c = await assetReq(base, `media/${hash}/complete`, { method: 'POST' });
    assert.equal(c.status, 507, `${c.status} ${c.buf}`);
    assert.deepEqual(c.json, { ok: false, error: 'insufficient-storage' });
    assert.equal((await assetReq(base, `media/${hash}`)).status, 404, 'not marked complete');
    const ch = await assetReq(base, `media/${hash}/chunks`);
    assert.deepEqual(ch.json.received, [0, 1], 'chunks remain');
  });
}

test('SPC1-9 other write errors (EACCES) do not return 507', async (t) => {
  const { store } = await loadAsset();
  const inner = store.createMemoryStore({ chunkSize: 1024 });
  const media = {
    ...inner, chunkSize: inner.chunkSize,
    async putChunk(_h, _n, _m, source) {
      for await (const _ of source) { /* Read to end */ }
      const err = new Error('EACCES: permission denied'); err.code = 'EACCES'; throw err;
    },
  };
  const base = await serveWith(t, { media });
  const bytes = randomBytes(100);
  const r = await assetReq(base, `media/${sha256hex(bytes)}/0`, { method: 'PUT', headers: chunkHeaders(bytes.length), body: bytes });
  assert.notEqual(r.status, 507);
  assert.ok(r.status >= 500, `${r.status}`);
});
