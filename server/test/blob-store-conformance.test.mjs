/**
 * 素材数据层 BlobStore 的一致性用例（契约 `docs/plan/asset-store-contract.md` 第 2 节，用例 K1～K16）。
 * 跑：node --test server/test/blob-store-conformance.test.mjs
 *
 * 同一套用例对 fs（临时目录，hooks 用本文件里的最小测试实现）和 memory（chunkSize 调小）各跑一遍。
 * 只照契约写，不看实现。分片长度一律取 `store.chunkSize`：fs 没有 chunkSize 选项，就是 8 MiB。
 *
 * 数据层模块用动态 import 载入：载不进来时每条用例各自失败、报同一个原因，而不是整个文件一条错。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test, after } from 'node:test';

let mod = null;
let loadError = null;
try {
  mod = await import('../asset-store/index.mjs');
} catch (err) {
  loadError = err;
}
function need() {
  if (loadError) throw new Error(`载不进 server/asset-store/index.mjs：${loadError.message}`);
  return mod;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-blob-store-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const MEM_CHUNK = 1024;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 确定性的伪随机字节，每个用例一份不同的内容 */
function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/** fs 实现的 hooks：最小的测试实现，照契约第 2 节「hooks 由调用方注入」 */
const CT = { mp4: 'video/mp4', webm: 'video/webm', png: 'image/png', wav: 'audio/wav' };
function makeHooks(dir) {
  const stored = [];
  return {
    stored,
    hooks: {
      async resolveFile(hash) {
        const key = String(hash).toLowerCase();
        let names = [];
        try { names = fs.readdirSync(dir); } catch { return null; }
        const hit = names.find((n) => n.toLowerCase() === key || n.toLowerCase().startsWith(`${key}.`));
        if (!hit) return null;
        const file = path.join(dir, hit);
        return fs.statSync(file).isFile() ? file : null;
      },
      onStored(entry) { stored.push(entry); },
      contentTypeForExt(ext) { return CT[String(ext || '').toLowerCase()] || 'application/octet-stream'; },
    },
  };
}

let seq = 0;
const KINDS = {
  fs() {
    const dir = path.join(TMP, `fs-${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    const { hooks, stored } = makeHooks(dir);
    const store = need().createBlobStore({ kind: 'fs', dir, hooks });
    return { store, dir, stored };
  },
  memory() {
    const store = need().createBlobStore({ kind: 'memory', chunkSize: MEM_CHUNK });
    return { store };
  },
  // SP（`docs/plan/shared-project-contract.md` 第 1 节）：托管组合用的分目录布局，不注入 resolveFile（按布局自己找）。
  // 不回 `dir`：K11 里按原布局查文件路径的两条断言只对原布局成立，分目录布局的路径另在 sp-hosting 的 SPH 用例里查
  'fs-shard'() {
    const dir = path.join(TMP, `shard-${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    const store = need().createBlobStore({ kind: 'fs', dir, shard: true, hooks: { contentTypeForExt: makeHooks(dir).hooks.contentTypeForExt } });
    return { store };
  },
};
/** 用例标签 → 实现报的 `kind`（分目录布局仍是 fs 实现） */
const kindOf = (label) => (label === 'fs-shard' ? 'fs' : label);

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const count = (size, cs) => Math.max(1, Math.ceil(size / cs));
const sliceOf = (buf, n, cs) => buf.subarray(n * cs, Math.min(buf.length, (n + 1) * cs));
/** 可读流形式的 source */
const streamOf = (buf) => Readable.from([Buffer.from(buf)]);
/** 异步可迭代形式的 source，分小块、每块之间让出事件循环，方便并发交错 */
async function* piecesOf(buf, piece = 257) {
  for (let i = 0; i < buf.length; i += piece) {
    await new Promise((r) => setImmediate(r));
    yield Buffer.from(buf.subarray(i, i + piece));
  }
}
async function readAll(readable) {
  assert.ok(readable, 'read 应返回可读流');
  const parts = [];
  for await (const c of readable) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}
async function putAll(store, hash, buf, ext = 'mp4') {
  const cs = store.chunkSize;
  for (let n = 0; n < count(buf.length, cs); n++) {
    const r = await store.putChunk(hash, n, { size: buf.length, ext }, streamOf(sliceOf(buf, n, cs)));
    assert.equal(r.status, 'ok', `第 ${n} 片：${JSON.stringify(r)}`);
  }
}
const unknownChunks = (cs) => ({ size: null, chunkSize: cs, received: [], complete: false });

/* ------------------------------------------------------------------ *
 * K15（与实现种类无关，只跑一次）
 * ------------------------------------------------------------------ */

test('K15 createBlobStore：oss 抛 not-implemented；未知 kind 抛 TypeError；BLOB_CHUNK_SIZE 是 8 MiB', () => {
  const { createBlobStore, BLOB_CHUNK_SIZE } = need();
  assert.equal(BLOB_CHUNK_SIZE, 8 * 1024 * 1024);
  assert.throws(() => createBlobStore({ kind: 'oss' }), (err) => {
    assert.ok(err instanceof Error);
    assert.equal(err.code, 'not-implemented');
    return true;
  });
  assert.throws(() => createBlobStore({ kind: 's3' }), TypeError);
  assert.throws(() => createBlobStore({ kind: '' }), TypeError);
  assert.throws(() => createBlobStore({}), TypeError);
  const mem = createBlobStore({ kind: 'memory' });
  assert.equal(mem.kind, 'memory');
  assert.equal(mem.chunkSize, BLOB_CHUNK_SIZE, 'memory 不给 chunkSize 时就是 8 MiB');
  assert.equal(createBlobStore({ kind: 'memory', chunkSize: MEM_CHUNK }).chunkSize, MEM_CHUNK);
});

/* ------------------------------------------------------------------ *
 * K1～K14：同一套对两种实现各跑一遍
 * ------------------------------------------------------------------ */

for (const [kind, make] of Object.entries(KINDS)) {
  test(`K1 ${kind}：没见过的哈希 chunks 为 size:null、received:[]；stat、read 为 null；complete 为 unknown`, async () => {
    const { store } = make();
    assert.equal(store.kind, kindOf(kind));
    const h = sha256(Buffer.from(`k1-${kind}`));
    assert.deepEqual(await store.chunks(h), unknownChunks(store.chunkSize));
    assert.equal(await store.stat(h), null);
    assert.equal(await store.read(h), null);
    assert.equal(await store.read(h, { start: 0, end: 0 }), null);
    assert.deepEqual(await store.complete(h), { status: 'unknown' });
    assert.equal(await store.remove(h), false);
  });

  test(`K2 ${kind}：putChunk 成功；同一片重传结果相同（幂等）；source 可以是流或异步可迭代`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs + 10, 2);
    const h = sha256(buf);
    const first = await store.putChunk(h, 1, { size: buf.length, ext: 'mp4' }, streamOf(sliceOf(buf, 1, cs)));
    assert.deepEqual(first, { status: 'ok', bytes: 10 });
    const again = await store.putChunk(h, 1, { size: buf.length, ext: 'mp4' }, piecesOf(sliceOf(buf, 1, cs), 3));
    assert.deepEqual(again, first, '同一片重传（异步可迭代 source）结果相同');
    assert.deepEqual(await store.chunks(h), { size: buf.length, chunkSize: cs, received: [1], complete: false });
    assert.deepEqual(await store.putChunk(h, 0, { size: buf.length, ext: 'mp4' }, piecesOf(sliceOf(buf, 0, cs), 4099)), { status: 'ok', bytes: cs });
    assert.deepEqual(await store.putChunk(h, 0, { size: buf.length, ext: 'mp4' }, streamOf(sliceOf(buf, 0, cs))), { status: 'ok', bytes: cs });
    assert.deepEqual((await store.chunks(h)).received, [0, 1]);
    assert.equal(await store.stat(h), null, '没 complete 之前不算入库');
    assert.deepEqual(await store.complete(h), { status: 'ok', size: buf.length, ext: 'mp4' });
    assert.deepEqual(await readAll(await store.read(h)), buf, '重传过的分片，入库字节仍然正确');
  });

  test(`K3 ${kind}：同一哈希报不同 size → size-mismatch，已收的不动`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs + 10, 3);
    const h = sha256(buf);
    assert.equal((await store.putChunk(h, 1, { size: buf.length, ext: 'mp4' }, streamOf(sliceOf(buf, 1, cs)))).status, 'ok');
    // 第 0 片在 size+1 下长度仍是整片，不会先撞上长度检查
    const r = await store.putChunk(h, 0, { size: buf.length + 1, ext: 'mp4' }, streamOf(sliceOf(buf, 0, cs)));
    assert.deepEqual(r, { status: 'size-mismatch', size: buf.length });
    assert.deepEqual(await store.chunks(h), { size: buf.length, chunkSize: cs, received: [1], complete: false });
    // 原 size 照常能传完、收尾
    assert.equal((await store.putChunk(h, 0, { size: buf.length, ext: 'mp4' }, streamOf(sliceOf(buf, 0, cs)))).status, 'ok');
    assert.equal((await store.complete(h)).status, 'ok');
  });

  test(`K4 ${kind}：实收字节多了或少了 → length，这一片不算收到（包括撤掉此前已收到的标记），也不写坏相邻分片`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs + 10, 4);
    const h = sha256(buf);
    const meta = { size: buf.length, ext: 'mp4' };

    // 最后一片：少了、多了
    assert.deepEqual(await store.putChunk(h, 1, meta, streamOf(sliceOf(buf, 1, cs).subarray(0, 9))), { status: 'length', expected: 10, got: 9 });
    assert.deepEqual(await store.putChunk(h, 1, meta, streamOf(Buffer.alloc(11, 7))), { status: 'length', expected: 10, got: 11 });
    assert.deepEqual((await store.chunks(h)).received, []);

    // 先收下第 1 片，再让第 0 片超长：超出的字节不能写进第 1 片的位置
    assert.equal((await store.putChunk(h, 1, meta, streamOf(sliceOf(buf, 1, cs)))).status, 'ok');
    const long = Buffer.concat([sliceOf(buf, 0, cs), Buffer.alloc(5, 0xee)]);
    assert.deepEqual(await store.putChunk(h, 0, meta, streamOf(long)), { status: 'length', expected: cs, got: cs + 5 });
    assert.deepEqual((await store.chunks(h)).received, [1]);

    // 已收到的一片，重传时长度不对：这一片变回「没收到」
    assert.equal((await store.putChunk(h, 0, meta, streamOf(sliceOf(buf, 0, cs)))).status, 'ok');
    assert.deepEqual((await store.chunks(h)).received, [0, 1]);
    assert.deepEqual(await store.putChunk(h, 0, meta, piecesOf(sliceOf(buf, 0, cs).subarray(0, cs - 1), 997)), { status: 'length', expected: cs, got: cs - 1 });
    assert.deepEqual((await store.chunks(h)).received, [1], '重传失败的那一片撤掉了「收到」');
    assert.deepEqual((await store.complete(h)).missing, [0]);

    // 补齐后收尾：字节完整（超长那次没写坏第 1 片）
    assert.equal((await store.putChunk(h, 0, meta, streamOf(sliceOf(buf, 0, cs)))).status, 'ok');
    assert.deepEqual(await store.complete(h), { status: 'ok', size: buf.length, ext: 'mp4' });
    assert.deepEqual(await readAll(await store.read(h)), buf);
  });

  test(`K5 ${kind}：n 越界 → out-of-range，已收的不动`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs + 10, 5);
    const h = sha256(buf);
    const meta = { size: buf.length, ext: 'mp4' };
    assert.equal((await store.putChunk(h, 0, meta, streamOf(sliceOf(buf, 0, cs)))).status, 'ok');
    assert.deepEqual(await store.putChunk(h, 2, meta, streamOf(Buffer.alloc(10))), { status: 'out-of-range', count: 2 });
    assert.deepEqual(await store.putChunk(h, 7, meta, streamOf(Buffer.alloc(10))), { status: 'out-of-range', count: 2 });
    assert.deepEqual(await store.chunks(h), { size: buf.length, chunkSize: cs, received: [0], complete: false });

    const small = bytesOf(33, 55);
    const hs = sha256(small);
    assert.deepEqual(await store.putChunk(hs, 1, { size: 33, ext: '' }, streamOf(small)), { status: 'out-of-range', count: 1 }, '小于一片的素材就是 1 片');
    assert.deepEqual((await store.chunks(hs)).received, []);
  });

  test(`K6 ${kind}：缺片时 complete → incomplete，missing 正确，已收的不动`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs * 3 + 17, 6); // 4 片
    const h = sha256(buf);
    const meta = { size: buf.length, ext: 'mp4' };
    for (const n of [0, 2]) assert.equal((await store.putChunk(h, n, meta, streamOf(sliceOf(buf, n, cs)))).status, 'ok');
    assert.deepEqual(await store.complete(h), { status: 'incomplete', missing: [1, 3] });
    assert.deepEqual(await store.chunks(h), { size: buf.length, chunkSize: cs, received: [0, 2], complete: false });
    assert.equal(await store.stat(h), null);
    assert.equal((await store.putChunk(h, 3, meta, streamOf(sliceOf(buf, 3, cs)))).status, 'ok');
    assert.deepEqual(await store.complete(h), { status: 'incomplete', missing: [1] });
  });

  test(`K7 ${kind}：字节被篡改 → hash-mismatch，之后 received 为 []、stat 为 null、哈希回到没见过`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs + 100, 7);
    const h = sha256(buf);
    const bad = Buffer.from(buf);
    bad[cs + 50] ^= 0xff; // 篡改第 1 片里的一个字节
    const meta = { size: buf.length, ext: 'mp4' };
    for (let n = 0; n < 2; n++) assert.equal((await store.putChunk(h, n, meta, streamOf(sliceOf(bad, n, cs)))).status, 'ok');
    assert.deepEqual((await store.chunks(h)).received, [0, 1]);
    assert.deepEqual(await store.complete(h), { status: 'hash-mismatch', actual: sha256(bad) });
    const later = await store.chunks(h);
    assert.deepEqual(later.received, [], '已收分片全部丢弃');
    assert.equal(later.complete, false);
    assert.deepEqual(later, unknownChunks(cs), '暂存全部丢弃后就是没见过的哈希');
    assert.equal(await store.stat(h), null);
    assert.equal(await store.read(h), null);
    assert.deepEqual(await store.complete(h), { status: 'unknown' });
    // 从头重传正确字节可以入库
    await putAll(store, h, buf);
    assert.equal((await store.complete(h)).status, 'ok');
  });

  test(`K8 ${kind}：全部到齐 → ok；stat 正确；read 全件与区间的字节都对`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs * 2 + 321, 8); // 3 片
    const h = sha256(buf);
    const t0 = Date.now();
    await putAll(store, h, buf, 'mp4');
    assert.deepEqual(await store.complete(h), { status: 'ok', size: buf.length, ext: 'mp4' });
    assert.deepEqual(await store.chunks(h), { size: buf.length, chunkSize: cs, received: [0, 1, 2], complete: true });

    const st = await store.stat(h);
    assert.ok(st, 'stat 不为 null');
    assert.equal(st.size, buf.length);
    assert.equal(st.ext, 'mp4');
    assert.equal(st.contentType, 'video/mp4');
    assert.ok(st.mtimeMs === null || (typeof st.mtimeMs === 'number' && Number.isFinite(st.mtimeMs)), `mtimeMs：${st.mtimeMs}`);
    if (kind === 'memory') {
      assert.equal(typeof st.mtimeMs, 'number', 'memory 的 mtimeMs 取入库时刻');
      assert.ok(st.mtimeMs >= t0 - 5 && st.mtimeMs <= Date.now() + 5, `mtimeMs 在入库前后：${st.mtimeMs}`);
    }

    assert.deepEqual(await readAll(await store.read(h)), buf, '全件');
    assert.deepEqual(await readAll(await store.read(h, {})), buf, '空选项 = 全件');
    const ranges = [
      [0, 0], [100, 199], [cs - 5, cs + 4], [cs - 1, cs], [cs, 2 * cs - 1], [0, buf.length - 1], [buf.length - 1, buf.length - 1],
    ];
    for (const [start, end] of ranges) {
      assert.deepEqual(await readAll(await store.read(h, { start, end })), buf.subarray(start, end + 1), `闭区间 ${start}-${end}`);
    }
    assert.deepEqual(await readAll(await store.read(h, { start: buf.length - 10 })), buf.subarray(buf.length - 10), 'end 缺省到末尾');
    assert.deepEqual(await readAll(await store.read(h, { start: cs + 7 })), buf.subarray(cs + 7), '跨片起点、到末尾');

    // 没有扩展名、contentType 回落
    const plain = bytesOf(50, 88);
    const hp = sha256(plain);
    await putAll(store, hp, plain, '');
    assert.deepEqual(await store.complete(hp), { status: 'ok', size: 50, ext: '' });
    const sp = await store.stat(hp);
    assert.equal(sp.ext, '');
    assert.equal(sp.contentType, 'application/octet-stream');
  });

  test(`K9 ${kind}：入库后再 putChunk → complete（source 读完丢掉、不落盘）；再 complete → ok`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs + 3, 9);
    const h = sha256(buf);
    await putAll(store, h, buf, 'png');
    assert.equal((await store.complete(h)).status, 'ok');

    let drained = false;
    async function* garbage() { yield Buffer.alloc(cs, 0x55); drained = true; }
    assert.deepEqual(await store.putChunk(h, 0, { size: buf.length, ext: 'png' }, garbage()), { status: 'complete' });
    assert.ok(drained, '请求体读完');
    // 入库后：size 不同、长度不对、越界之外的任何分片也都回 complete
    assert.deepEqual(await store.putChunk(h, 1, { size: buf.length, ext: 'mp4' }, streamOf(Buffer.alloc(1))), { status: 'complete' });
    assert.deepEqual(await store.putChunk(h, 0, { size: buf.length + 9, ext: 'png' }, streamOf(Buffer.alloc(2))), { status: 'complete' });

    assert.deepEqual(await store.complete(h), { status: 'ok', size: buf.length, ext: 'png' });
    assert.deepEqual(await readAll(await store.read(h)), buf, '字节没被改');
    assert.equal((await store.stat(h)).ext, 'png');
    assert.equal((await store.chunks(h)).complete, true);
  });

  test(`K10 ${kind}：所有分片并发 putChunk，再 complete：结果与顺序写相同`, async () => {
    const buf = bytesOf((kind === 'memory' ? MEM_CHUNK : 8 * 1024 * 1024) * 3 + 77, 10); // 4 片
    const h = sha256(buf);

    const seqEnv = make();
    await putAll(seqEnv.store, h, buf, 'webm');
    const seqDone = await seqEnv.store.complete(h);

    const { store } = make();
    const cs = store.chunkSize;
    const order = [3, 1, 0, 2];
    const results = await Promise.all(order.map((n) =>
      store.putChunk(h, n, { size: buf.length, ext: 'webm' }, piecesOf(sliceOf(buf, n, cs), kind === 'memory' ? 61 : 512 * 1024))));
    results.forEach((r, i) => assert.deepEqual(r, { status: 'ok', bytes: sliceOf(buf, order[i], cs).length }, `第 ${order[i]} 片`));
    assert.deepEqual(await store.chunks(h), { size: buf.length, chunkSize: cs, received: [0, 1, 2, 3], complete: false });
    const done = await store.complete(h);
    assert.deepEqual(done, seqDone);
    assert.deepEqual(done, { status: 'ok', size: buf.length, ext: 'webm' });
    const [a, b] = [await store.stat(h), await seqEnv.store.stat(h)];
    assert.deepEqual({ size: a.size, ext: a.ext, contentType: a.contentType }, { size: b.size, ext: b.ext, contentType: b.contentType });
    assert.equal(sha256(await readAll(await store.read(h))), h);

    // 同一片被并发写两次（重传与原传赛跑）也不坏
    const buf2 = bytesOf(cs * 2 + 5, 11);
    const h2 = sha256(buf2);
    const meta2 = { size: buf2.length, ext: 'webm' };
    const twice = await Promise.all([0, 0, 1, 2, 2].map((n) => store.putChunk(h2, n, meta2, piecesOf(sliceOf(buf2, n, cs), kind === 'memory' ? 97 : 1024 * 1024))));
    assert.ok(twice.every((r) => r.status === 'ok'), JSON.stringify(twice));
    assert.deepEqual(await store.complete(h2), { status: 'ok', size: buf2.length, ext: 'webm' });
    assert.equal(sha256(await readAll(await store.read(h2))), h2);
  });

  test(`K11 ${kind}：remove 后 stat 为 null，chunks 为未知；第二次 remove 返回 false`, async () => {
    const { store, dir } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(400, 12);
    const h = sha256(buf);
    await putAll(store, h, buf, 'mp4');
    assert.equal((await store.complete(h)).status, 'ok');
    assert.equal(await store.remove(h), true);
    assert.equal(await store.stat(h), null);
    assert.equal(await store.read(h), null);
    assert.deepEqual(await store.chunks(h), unknownChunks(cs));
    assert.deepEqual(await store.complete(h), { status: 'unknown' });
    assert.equal(await store.remove(h), false);
    if (dir) assert.ok(!fs.existsSync(path.join(dir, `${h}.mp4`)), 'fs：全件已删');

    // 只有暂存的哈希也能删
    const part = bytesOf(cs + 1, 13);
    const hp = sha256(part);
    assert.equal((await store.putChunk(hp, 1, { size: part.length, ext: 'mp4' }, streamOf(sliceOf(part, 1, cs)))).status, 'ok');
    assert.equal(await store.remove(hp), true);
    assert.deepEqual(await store.chunks(hp), unknownChunks(cs));
    assert.equal(await store.remove(hp), false);
    if (dir) assert.ok(!fs.existsSync(path.join(dir, '.chunks', hp)), 'fs：暂存目录已删');

    // 删掉之后同一哈希可以重新上传
    await putAll(store, h, buf, 'mp4');
    assert.equal((await store.complete(h)).status, 'ok');
    assert.deepEqual(await readAll(await store.read(h)), buf);
  });

  test(`K12 ${kind}：usage 的计数正确（blobs、bytes、staging）`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    assert.deepEqual(await store.usage(), { blobs: 0, bytes: 0, staging: 0 });

    const a = bytesOf(cs + 20, 121);
    const b = bytesOf(300, 122);
    const c = bytesOf(200, 123);
    const [ha, hb, hc] = [a, b, c].map(sha256);
    assert.equal((await store.putChunk(ha, 0, { size: a.length, ext: 'mp4' }, streamOf(sliceOf(a, 0, cs)))).status, 'ok');
    assert.deepEqual(await store.usage(), { blobs: 0, bytes: 0, staging: 1 });
    await putAll(store, hb, b, 'png');
    assert.deepEqual(await store.usage(), { blobs: 0, bytes: 0, staging: 2 });
    assert.equal((await store.complete(hb)).status, 'ok');
    assert.deepEqual(await store.usage(), { blobs: 1, bytes: 300, staging: 1 });
    // hash-mismatch 丢掉暂存
    const wrong = sha256(Buffer.from('k12-wrong'));
    await putAll(store, wrong, c, 'png');
    assert.deepEqual(await store.usage(), { blobs: 1, bytes: 300, staging: 2 });
    assert.equal((await store.complete(wrong)).status, 'hash-mismatch');
    assert.deepEqual(await store.usage(), { blobs: 1, bytes: 300, staging: 1 });
    // 入库第二个
    assert.equal((await store.putChunk(ha, 1, { size: a.length, ext: 'mp4' }, streamOf(sliceOf(a, 1, cs)))).status, 'ok');
    assert.equal((await store.complete(ha)).status, 'ok');
    assert.deepEqual(await store.usage(), { blobs: 2, bytes: 300 + a.length, staging: 0 });
    // 同一内容再传不算两份
    assert.equal((await store.putChunk(hb, 0, { size: b.length, ext: 'png' }, streamOf(b))).status, 'complete');
    assert.deepEqual(await store.usage(), { blobs: 2, bytes: 300 + a.length, staging: 0 });
    await putAll(store, hc, c, 'png');
    assert.equal(await store.remove(hb), true);
    assert.deepEqual(await store.usage(), { blobs: 1, bytes: a.length, staging: 1 });
    assert.equal(await store.remove(hc), true);
    assert.deepEqual(await store.usage(), { blobs: 1, bytes: a.length, staging: 0 });
  });

  test(`K13 ${kind}：ext 以最先登记的非空值为准，之后不改`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs * 2 + 1, 13); // 3 片
    const h = sha256(buf);
    const size = buf.length;
    assert.equal((await store.putChunk(h, 0, { size, ext: '' }, streamOf(sliceOf(buf, 0, cs)))).status, 'ok');
    assert.equal((await store.putChunk(h, 1, { size, ext: 'mp4' }, streamOf(sliceOf(buf, 1, cs)))).status, 'ok');
    assert.equal((await store.putChunk(h, 2, { size, ext: 'webm' }, streamOf(sliceOf(buf, 2, cs)))).status, 'ok');
    assert.equal((await store.putChunk(h, 0, { size, ext: 'png' }, streamOf(sliceOf(buf, 0, cs)))).status, 'ok');
    assert.deepEqual(await store.complete(h), { status: 'ok', size, ext: 'mp4' });
    const st = await store.stat(h);
    assert.equal(st.ext, 'mp4');
    assert.equal(st.contentType, 'video/mp4');

    // 从头到尾都没给扩展名
    const plain = bytesOf(40, 131);
    const hp = sha256(plain);
    assert.equal((await store.putChunk(hp, 0, { size: 40, ext: '' }, streamOf(plain))).status, 'ok');
    assert.deepEqual(await store.complete(hp), { status: 'ok', size: 40, ext: '' });
  });

  test(`K14 ${kind}：大写哈希与小写哈希是同一个；格式不对抛 TypeError`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs + 9, 14);
    const h = sha256(buf);
    const H = h.toUpperCase();
    const meta = { size: buf.length, ext: 'mp4' };
    assert.equal((await store.putChunk(H, 0, meta, streamOf(sliceOf(buf, 0, cs)))).status, 'ok');
    assert.equal((await store.putChunk(h, 1, meta, streamOf(sliceOf(buf, 1, cs)))).status, 'ok');
    assert.deepEqual((await store.chunks(h)).received, [0, 1]);
    assert.deepEqual((await store.chunks(H)).received, [0, 1]);
    assert.deepEqual(await store.complete(H), { status: 'ok', size: buf.length, ext: 'mp4' });
    assert.equal((await store.stat(h)).size, buf.length);
    assert.equal((await store.stat(H)).size, buf.length);
    assert.deepEqual(await readAll(await store.read(H, { start: 1, end: 3 })), buf.subarray(1, 4));
    assert.deepEqual(await store.putChunk(H, 0, meta, streamOf(sliceOf(buf, 0, cs))), { status: 'complete' });
    assert.deepEqual((await store.usage()).blobs, 1);
    assert.equal(await store.remove(H), true);
    assert.equal(await store.stat(h), null);

    const bad = ['xyz', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '', `${h}.mp4`];
    for (const x of bad) {
      await assert.rejects(async () => store.stat(x), TypeError, `stat(${JSON.stringify(x)})`);
      await assert.rejects(async () => store.read(x), TypeError, `read(${JSON.stringify(x)})`);
      await assert.rejects(async () => store.chunks(x), TypeError, `chunks(${JSON.stringify(x)})`);
      await assert.rejects(async () => store.putChunk(x, 0, { size: 1, ext: '' }, streamOf(Buffer.alloc(1))), TypeError, `putChunk(${JSON.stringify(x)})`);
      await assert.rejects(async () => store.complete(x), TypeError, `complete(${JSON.stringify(x)})`);
      await assert.rejects(async () => store.remove(x), TypeError, `remove(${JSON.stringify(x)})`);
    }
  });
}

/* ------------------------------------------------------------------ *
 * K16：只对 fs
 * ------------------------------------------------------------------ */

test('K16 fs：目录布局与今天一致（暂存 .chunks/<hash>/ 里有 meta.json、data、<n>.ok；入库后 <hash>.<ext>，暂存删掉）', async () => {
  const { store, dir, stored } = KINDS.fs();
  const cs = store.chunkSize;
  assert.equal(cs, 8 * 1024 * 1024, 'fs 的分片是 8 MiB');
  const buf = bytesOf(cs + 1000, 16);
  const h = sha256(buf);
  const staging = path.join(dir, '.chunks', h);

  assert.equal((await store.putChunk(h.toUpperCase(), 1, { size: buf.length, ext: 'mp4' }, streamOf(sliceOf(buf, 1, cs)))).status, 'ok');
  assert.ok(fs.existsSync(staging), '暂存目录按小写哈希建在 .chunks/<hash>/');
  const names = fs.readdirSync(staging).sort();
  for (const n of ['meta.json', 'data', '1.ok']) assert.ok(names.includes(n), `暂存目录里有 ${n}：${names.join(', ')}`);
  assert.ok(!names.includes('0.ok'), '没收到的片没有标记');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(staging, 'meta.json'), 'utf8')), { size: buf.length, ext: 'mp4' });
  assert.ok(fs.statSync(path.join(staging, 'data')).size >= cs + 1000, 'data 按偏移原位写');
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith(h)).length, 0, '入库前没有全件');

  assert.equal((await store.putChunk(h, 0, { size: buf.length, ext: 'mp4' }, streamOf(sliceOf(buf, 0, cs)))).status, 'ok');
  assert.ok(fs.existsSync(path.join(staging, '0.ok')));
  assert.equal((await store.complete(h)).status, 'ok');

  const whole = path.join(dir, `${h}.mp4`);
  assert.ok(fs.existsSync(whole), '<dir>/<hash>.<ext> 存在');
  assert.equal(sha256(fs.readFileSync(whole)), h);
  assert.ok(!fs.existsSync(staging), '.chunks/<hash> 不存在');

  // onStored 收到入库信息（file 是文件名，契约第 8 节第 3 条）
  assert.equal(stored.length, 1);
  const e = stored[0];
  assert.equal(e.hash, h);
  assert.equal(e.file, `${h}.mp4`);
  assert.equal(e.ext, 'mp4');
  assert.equal(e.size, buf.length);
  assert.equal(e.contentType, 'video/mp4', 'contentType 用 hooks.contentTypeForExt');

  // 没有扩展名：<dir>/<hash>
  const plain = bytesOf(99, 161);
  const hp = sha256(plain);
  assert.equal((await store.putChunk(hp, 0, { size: 99, ext: '' }, streamOf(plain))).status, 'ok');
  assert.equal((await store.complete(hp)).status, 'ok');
  assert.ok(fs.existsSync(path.join(dir, hp)), '<dir>/<hash>（无扩展名）');
  assert.equal(sha256(fs.readFileSync(path.join(dir, hp))), hp);
  assert.ok(!fs.existsSync(path.join(dir, '.chunks', hp)));
});

test('K16 fs：老的整件导入（直接放在 <dir>/<hash>.<ext>、经 hooks.resolveFile 找到）算已入库', async () => {
  const { store, dir } = KINDS.fs();
  const cs = store.chunkSize;
  const buf = bytesOf(5000, 162);
  const h = sha256(buf);
  fs.writeFileSync(path.join(dir, `${h}.wav`), buf);

  const st = await store.stat(h);
  assert.ok(st, 'stat 找到老导入的文件');
  assert.equal(st.size, 5000);
  assert.equal(st.ext, 'wav');
  assert.equal(st.contentType, 'audio/wav');
  assert.equal(typeof st.mtimeMs, 'number');
  assert.deepEqual(await store.chunks(h), { size: 5000, chunkSize: cs, received: [0], complete: true });
  assert.deepEqual(await store.putChunk(h, 0, { size: 5000, ext: 'wav' }, streamOf(buf)), { status: 'complete' });
  assert.deepEqual(await store.complete(h), { status: 'ok', size: 5000, ext: 'wav' });
  assert.deepEqual(await readAll(await store.read(h, { start: 10, end: 19 })), buf.subarray(10, 20));
  assert.ok(!fs.existsSync(path.join(dir, '.chunks', h)), '入库后的 putChunk 不落盘');
});

/* ------------------------------------------------------------------ *
 * K17、K18：契约第 8 节第 7、8 条
 * ------------------------------------------------------------------ */

test('K17 memory：size 超过 256 MiB 回 size-mismatch，不登记', async () => {
  const { store } = KINDS.memory();
  const LIMIT = 256 * 1024 * 1024;
  for (const size of [LIMIT + 1, 64 * 1024 * 1024 * 1024]) {
    const h = sha256(Buffer.from(`k17-${size}`));
    async function* body() { yield Buffer.alloc(MEM_CHUNK, 1) }
    const r = await store.putChunk(h, 0, { size, ext: 'mp4' }, body());
    assert.equal(r?.status, 'size-mismatch', `size ${size}：${JSON.stringify(r)}`);
    assert.deepEqual(await store.chunks(h), unknownChunks(store.chunkSize), '不登记');
    assert.deepEqual(await store.usage(), { blobs: 0, bytes: 0, staging: 0 });
  }
  // 正常大小照常
  const buf = bytesOf(100, 17);
  const h = sha256(buf);
  assert.equal((await store.putChunk(h, 0, { size: 100, ext: '' }, streamOf(buf))).status, 'ok');
});

test('K18 fs：usage 只数 <hash> 与 <hash>.<ext> 形状的文件，索引文件和其它文件不算', async () => {
  const { store, dir } = KINDS.fs();
  const buf = bytesOf(321, 18);
  const h = sha256(buf);
  assert.equal((await store.putChunk(h, 0, { size: 321, ext: 'mp4' }, streamOf(buf))).status, 'ok');
  assert.equal((await store.complete(h)).status, 'ok');
  const before = await store.usage();
  assert.deepEqual(before, { blobs: 1, bytes: 321, staging: 0 });

  // 媒体索引（vite-plugin-media 写在 <mediaDir>/index.json）和其它杂项文件
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, items: { [h]: { file: `${h}.mp4`, ext: 'mp4', size: 321, contentType: 'video/mp4' } } }, null, 2));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(dir, `${'a'.repeat(63)}.mp4`), 'short-hash');
  fs.mkdirSync(path.join(dir, 'b'.repeat(64)), { recursive: true });
  assert.deepEqual(await store.usage(), before, '计数不变');
});
