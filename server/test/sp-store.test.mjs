/**
 * SP 托管端的素材数据层（契约 `docs/plan/shared-project-contract.md` 第 1 节「fs-store 的布局选项」「磁盘满」）。
 * 跑：node --test server/test/sp-store.test.mjs
 *
 * - `createFsStore({ dir, shard: true })`：按哈希前两位分子目录，写入走同文件系统临时文件加改名；缺省布局不变。
 * - `ENOSPC`、`EDQUOT` 时写入回 507 `insufficient-storage`，不标记完成，已收的分片保留。用假存储注入错误，经素材服务中间件验 HTTP。
 * 只照契约写，不看实现；全件在子目录里的文件名见 `sp-kit.mjs` 假设 S1。
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

// ------------------------------------------------------------------ shard 布局

test('SPC1-8 fs-store shard: true：全件落在 <dir>/<哈希前两位>/ 下；stat、read（含 Range）、chunks、usage、remove 照常', async (t) => {
  const createFsStore = await loadFsStore();
  const dir = tmpDir(t);
  const store = createFsStore({ dir, shard: true, chunkSize: 1024 });
  const bytes = randomBytes(2500); // 3 片
  const hash = await putWhole(store, bytes);
  const sub = path.join(dir, hash.slice(0, 2));
  assert.ok(fs.statSync(sub).isDirectory(), `子目录 ${hash.slice(0, 2)}/ 存在`);
  const names = fs.readdirSync(sub);
  assert.ok(names.some((n) => n === hash || n.startsWith(`${hash}.`)), `全件在子目录里：${names}`);
  assert.deepEqual(names.filter((n) => !(n === hash || n.startsWith(`${hash}.`))), [], `子目录里没有残留的临时文件：${names}`);
  assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith(hash)), '顶层没有平铺的全件');

  const st = await store.stat(hash);
  assert.equal(st.size, bytes.length);
  assert.ok((await readAll(await store.read(hash))).equals(bytes), '整件读回一致');
  assert.ok((await readAll(await store.read(hash, { start: 1000, end: 1099 }))).equals(bytes.subarray(1000, 1100)), 'Range 读回一致');
  const ch = await store.chunks(hash);
  assert.equal(ch.complete, true);
  assert.deepEqual(ch.received, [0, 1, 2]);
  const u = await store.usage();
  assert.equal(u.blobs, 1, `usage 数得到子目录里的全件：${JSON.stringify(u)}`);
  assert.equal(u.bytes, bytes.length);
  assert.equal(await store.remove(hash), true);
  assert.equal(await store.stat(hash), null);
});

test('SPC1-8 fs-store shard: true：多件分散在各自的前两位子目录；续传（重启一个新实例接着传）照常', async (t) => {
  const createFsStore = await loadFsStore();
  const dir = tmpDir(t);
  const s1 = createFsStore({ dir, shard: true, chunkSize: 512 });
  const hashes = [];
  for (let i = 0; i < 6; i++) hashes.push(await putWhole(s1, randomBytes(700 + i)));
  for (const h of hashes) assert.ok(fs.existsSync(path.join(dir, h.slice(0, 2))), `${h.slice(0, 2)}/ 存在`);
  for (const d of fs.readdirSync(dir)) {
    if (d.startsWith('.')) continue; // 暂存目录等
    assert.match(d, /^[0-9a-f]{2}$/, `顶层只有两位十六进制子目录：${d}`);
  }

  // 传一半、换一个实例接着传
  const bytes = randomBytes(1500);
  const hash = sha256hex(bytes);
  assert.equal((await s1.putChunk(hash, 0, { size: bytes.length, ext: 'bin' }, body(bytes.subarray(0, 512)))).status, 'ok');
  const s2 = createFsStore({ dir, shard: true, chunkSize: 512 });
  const ch = await s2.chunks(hash);
  assert.deepEqual(ch.received, [0], '新实例看得到已收的分片');
  for (const n of [1, 2]) assert.equal((await s2.putChunk(hash, n, { size: bytes.length, ext: 'bin' }, body(bytes.subarray(n * 512, (n + 1) * 512)))).status, 'ok');
  assert.equal((await s2.complete(hash)).status, 'ok');
  assert.ok((await readAll(await s2.read(hash))).equals(bytes));
});

test('SPC1-8 fs-store 缺省布局不变（本机编辑器不动既有缓存）：全件仍平铺在 <dir>/<哈希>[.ext]', async (t) => {
  const createFsStore = await loadFsStore();
  const dir = tmpDir(t);
  const store = createFsStore({ dir, chunkSize: 1024 });
  const hash = await putWhole(store, randomBytes(300));
  assert.ok(fs.existsSync(path.join(dir, `${hash}.bin`)), '平铺布局');
  assert.equal(fs.existsSync(path.join(dir, hash.slice(0, 2), `${hash}.bin`)), false);
});

// ------------------------------------------------------------------ 经素材服务中间件（HTTP）

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

test('SPC1-8 素材服务挂 shard 布局的 fs-store：HTTP 上传后文件落在前两位子目录里，取回一致', async (t) => {
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

// ------------------------------------------------------------------ 磁盘满

function diskFull(code) {
  const err = new Error(`${code}: no space left on device, write`);
  err.code = code;
  err.errno = code === 'ENOSPC' ? -28 : -122;
  err.syscall = 'write';
  return err;
}

/** 在内存存储外面包一层：第 failAt 片（或 complete）抛磁盘满 */
async function fullStore({ code = 'ENOSPC', failChunk = null, failComplete = false } = {}) {
  const { store } = await loadAsset();
  const inner = store.createMemoryStore({ chunkSize: 1024 });
  return {
    ...inner,
    kind: 'memory',
    chunkSize: inner.chunkSize,
    async putChunk(hash, n, meta, source) {
      if (n === failChunk) {
        for await (const _ of source) { /* 读完请求体 */ }
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
  test(`SPC1-9 写分片时 ${code} → 507 insufficient-storage；已收的分片保留；不标记完成`, async (t) => {
    const media = await fullStore({ code, failChunk: 1 });
    const base = await serveWith(t, { media });
    const bytes = randomBytes(2500);
    const hash = sha256hex(bytes);
    const p0 = await assetReq(base, `media/${hash}/0`, { method: 'PUT', headers: chunkHeaders(bytes.length), body: bytes.subarray(0, 1024) });
    assert.equal(p0.status, 200);
    const p1 = await assetReq(base, `media/${hash}/1`, { method: 'PUT', headers: chunkHeaders(bytes.length), body: bytes.subarray(1024, 2048) });
    assert.equal(p1.status, 507, `磁盘满回 507：${p1.status} ${p1.buf}`);
    assert.deepEqual(p1.json, { ok: false, error: 'insufficient-storage' });
    const ch = await assetReq(base, `media/${hash}/chunks`);
    assert.equal(ch.status, 200);
    assert.deepEqual(ch.json.received, [0], '已收的分片保留');
    assert.equal(ch.json.complete, false);
    assert.equal((await assetReq(base, `media/${hash}`)).status, 404, '没有标记完成');
  });

  test(`SPC1-9 complete 时 ${code} → 507 insufficient-storage；不标记完成，分片仍在，空间回来后能续上`, async (t) => {
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
    assert.equal((await assetReq(base, `media/${hash}`)).status, 404, '没有标记完成');
    const ch = await assetReq(base, `media/${hash}/chunks`);
    assert.deepEqual(ch.json.received, [0, 1], '分片仍在');
  });
}

test('SPC1-9 别的写入错误（EACCES）不回 507', async (t) => {
  const { store } = await loadAsset();
  const inner = store.createMemoryStore({ chunkSize: 1024 });
  const media = {
    ...inner, chunkSize: inner.chunkSize,
    async putChunk(_h, _n, _m, source) {
      for await (const _ of source) { /* 读完 */ }
      const err = new Error('EACCES: permission denied'); err.code = 'EACCES'; throw err;
    },
  };
  const base = await serveWith(t, { media });
  const bytes = randomBytes(100);
  const r = await assetReq(base, `media/${sha256hex(bytes)}/0`, { method: 'PUT', headers: chunkHeaders(bytes.length), body: bytes });
  assert.notEqual(r.status, 507);
  assert.ok(r.status >= 500, `${r.status}`);
});
