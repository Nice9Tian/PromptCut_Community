/**
 * Conformance test cases for the asset data layer BlobStore (contract
 * `docs/plan/asset-store-contract.md` section 2, test cases K1~K16).
 * Run: node --test server/test/blob-store-conformance.test.mjs
 *
 * The same test suite runs once each for fs (temporary directory, hooks using the minimal test
 * implementation in this file) and memory (smaller chunkSize). Written strictly to the contract
 * without looking at implementations. Chunk lengths always take `store.chunkSize`: fs has no
 * chunkSize option, which is 8 MiB.
 *
 * Data layer modules are loaded via dynamic import: when failing to load, each test case fails
 * individually reporting the same reason, rather than the whole file producing a single error.
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
  if (loadError) throw new Error(`cannot load server/asset-store/index.mjs: ${loadError.message}`);
  return mod;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-blob-store-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const MEM_CHUNK = 1024;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Deterministic pseudo-random bytes, with different content for each test case */
function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/** fs implementation hooks: minimal test implementation, per contract section 2 "hooks are injected by the caller" */
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
  // SP (`docs/plan/shared-project-contract.md` section 1): subdirectory layout used by hosted
  // composites, does not inject resolveFile (locates files on its own by layout).
  // Does not return `dir`: the two assertions in K11 checking file paths against the original
  // layout hold only for the original layout; paths in the subdirectory layout are checked
  // separately in sp-hosting SPH test cases
  'fs-shard'() {
    const dir = path.join(TMP, `shard-${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    const store = need().createBlobStore({ kind: 'fs', dir, shard: true, hooks: { contentTypeForExt: makeHooks(dir).hooks.contentTypeForExt } });
    return { store };
  },
};
/** Test case label → implementation-reported `kind` (subdirectory layout is still an fs implementation) */
const kindOf = (label) => (label === 'fs-shard' ? 'fs' : label);

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

const count = (size, cs) => Math.max(1, Math.ceil(size / cs));
const sliceOf = (buf, n, cs) => buf.subarray(n * cs, Math.min(buf.length, (n + 1) * cs));
/** Source in readable stream form */
const streamOf = (buf) => Readable.from([Buffer.from(buf)]);
/** Source in async iterable form, split into small chunks, yielding event loop between chunks for concurrent interleaving */
async function* piecesOf(buf, piece = 257) {
  for (let i = 0; i < buf.length; i += piece) {
    await new Promise((r) => setImmediate(r));
    yield Buffer.from(buf.subarray(i, i + piece));
  }
}
async function readAll(readable) {
  assert.ok(readable, 'read should return a readable stream');
  const parts = [];
  for await (const c of readable) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}
async function putAll(store, hash, buf, ext = 'mp4') {
  const cs = store.chunkSize;
  for (let n = 0; n < count(buf.length, cs); n++) {
    const r = await store.putChunk(hash, n, { size: buf.length, ext }, streamOf(sliceOf(buf, n, cs)));
    assert.equal(r.status, 'ok', `Chunk ${n}: ${JSON.stringify(r)}`);
  }
}
const unknownChunks = (cs) => ({ size: null, chunkSize: cs, received: [], complete: false });

/* ------------------------------------------------------------------ *
 * K15 (independent of implementation kind, runs only once)
 * ------------------------------------------------------------------ */

test('K15 createBlobStore: oss throws not-implemented; an unknown kind throws TypeError; BLOB_CHUNK_SIZE is 8 MiB', () => {
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
  assert.equal(mem.chunkSize, BLOB_CHUNK_SIZE, 'Without a chunkSize, memory uses 8 MiB');
  assert.equal(createBlobStore({ kind: 'memory', chunkSize: MEM_CHUNK }).chunkSize, MEM_CHUNK);
});

/* ------------------------------------------------------------------ *
 * K1~K14: same suite runs once for each of the two implementations
 * ------------------------------------------------------------------ */

for (const [kind, make] of Object.entries(KINDS)) {
  test(`K1 ${kind}: for a hash never seen, chunks is size:null, received:[]; stat and read are null; complete is unknown`, async () => {
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

  test(`K2 ${kind}: putChunk succeeds; re-sending the same chunk gives the same result (idempotent); source can be a stream or an async iterable`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs + 10, 2);
    const h = sha256(buf);
    const first = await store.putChunk(h, 1, { size: buf.length, ext: 'mp4' }, streamOf(sliceOf(buf, 1, cs)));
    assert.deepEqual(first, { status: 'ok', bytes: 10 });
    const again = await store.putChunk(h, 1, { size: buf.length, ext: 'mp4' }, piecesOf(sliceOf(buf, 1, cs), 3));
    assert.deepEqual(again, first, 'Re-sending the same chunk (async iterable source) gives the same result');
    assert.deepEqual(await store.chunks(h), { size: buf.length, chunkSize: cs, received: [1], complete: false });
    assert.deepEqual(await store.putChunk(h, 0, { size: buf.length, ext: 'mp4' }, piecesOf(sliceOf(buf, 0, cs), 4099)), { status: 'ok', bytes: cs });
    assert.deepEqual(await store.putChunk(h, 0, { size: buf.length, ext: 'mp4' }, streamOf(sliceOf(buf, 0, cs))), { status: 'ok', bytes: cs });
    assert.deepEqual((await store.chunks(h)).received, [0, 1]);
    assert.equal(await store.stat(h), null, 'Not counted as stored before complete');
    assert.deepEqual(await store.complete(h), { status: 'ok', size: buf.length, ext: 'mp4' });
    assert.deepEqual(await readAll(await store.read(h)), buf, 'For a chunk that was re-sent, the stored bytes are still correct');
  });

  test(`K3 ${kind}: the same hash reporting a different size → size-mismatch, chunks already received are left alone`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs + 10, 3);
    const h = sha256(buf);
    assert.equal((await store.putChunk(h, 1, { size: buf.length, ext: 'mp4' }, streamOf(sliceOf(buf, 1, cs)))).status, 'ok');
    // Under size+1, chunk 0 is still a full chunk in length and will not hit the length check first
    const r = await store.putChunk(h, 0, { size: buf.length + 1, ext: 'mp4' }, streamOf(sliceOf(buf, 0, cs)));
    assert.deepEqual(r, { status: 'size-mismatch', size: buf.length });
    assert.deepEqual(await store.chunks(h), { size: buf.length, chunkSize: cs, received: [1], complete: false });
    // The original size can finish uploading and finalize as usual
    assert.equal((await store.putChunk(h, 0, { size: buf.length, ext: 'mp4' }, streamOf(sliceOf(buf, 0, cs)))).status, 'ok');
    assert.equal((await store.complete(h)).status, 'ok');
  });

  test(`K4 ${kind}: too many or too few bytes actually received → length; this chunk does not count as received (including removing the mark that was set earlier) and does not corrupt neighboring chunks`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs + 10, 4);
    const h = sha256(buf);
    const meta = { size: buf.length, ext: 'mp4' };

    // Last chunk: too short, too long
    assert.deepEqual(await store.putChunk(h, 1, meta, streamOf(sliceOf(buf, 1, cs).subarray(0, 9))), { status: 'length', expected: 10, got: 9 });
    assert.deepEqual(await store.putChunk(h, 1, meta, streamOf(Buffer.alloc(11, 7))), { status: 'length', expected: 10, got: 11 });
    assert.deepEqual((await store.chunks(h)).received, []);

    // Accept chunk 1 first, then make chunk 0 oversized: excess bytes must not be written into
    // chunk 1's position
    assert.equal((await store.putChunk(h, 1, meta, streamOf(sliceOf(buf, 1, cs)))).status, 'ok');
    const long = Buffer.concat([sliceOf(buf, 0, cs), Buffer.alloc(5, 0xee)]);
    assert.deepEqual(await store.putChunk(h, 0, meta, streamOf(long)), { status: 'length', expected: cs, got: cs + 5 });
    assert.deepEqual((await store.chunks(h)).received, [1]);

    // For an already received chunk, retransmitting with an invalid length reverts this chunk to
    // "not received"
    assert.equal((await store.putChunk(h, 0, meta, streamOf(sliceOf(buf, 0, cs)))).status, 'ok');
    assert.deepEqual((await store.chunks(h)).received, [0, 1]);
    assert.deepEqual(await store.putChunk(h, 0, meta, piecesOf(sliceOf(buf, 0, cs).subarray(0, cs - 1), 997)), { status: 'length', expected: cs, got: cs - 1 });
    assert.deepEqual((await store.chunks(h)).received, [1], 'The chunk whose re-send failed had its "received" mark removed');
    assert.deepEqual((await store.complete(h)).missing, [0]);

    // Finalize after filling missing parts: bytes are intact (the oversized write did not corrupt
    // chunk 1)
    assert.equal((await store.putChunk(h, 0, meta, streamOf(sliceOf(buf, 0, cs)))).status, 'ok');
    assert.deepEqual(await store.complete(h), { status: 'ok', size: buf.length, ext: 'mp4' });
    assert.deepEqual(await readAll(await store.read(h)), buf);
  });

  test(`K5 ${kind}: n out of range → out-of-range, chunks already received are left alone`, async () => {
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
    assert.deepEqual(await store.putChunk(hs, 1, { size: 33, ext: '' }, streamOf(small)), { status: 'out-of-range', count: 1 }, 'An asset smaller than one chunk is 1 chunk');
    assert.deepEqual((await store.chunks(hs)).received, []);
  });

  test(`K6 ${kind}: complete with chunks missing → incomplete, missing is correct, chunks already received are left alone`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs * 3 + 17, 6); // 4 chunks
    const h = sha256(buf);
    const meta = { size: buf.length, ext: 'mp4' };
    for (const n of [0, 2]) assert.equal((await store.putChunk(h, n, meta, streamOf(sliceOf(buf, n, cs)))).status, 'ok');
    assert.deepEqual(await store.complete(h), { status: 'incomplete', missing: [1, 3] });
    assert.deepEqual(await store.chunks(h), { size: buf.length, chunkSize: cs, received: [0, 2], complete: false });
    assert.equal(await store.stat(h), null);
    assert.equal((await store.putChunk(h, 3, meta, streamOf(sliceOf(buf, 3, cs)))).status, 'ok');
    assert.deepEqual(await store.complete(h), { status: 'incomplete', missing: [1] });
  });

  test(`K7 ${kind}: tampered bytes → hash-mismatch, after which received is [], stat is null, and the hash goes back to never seen`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs + 100, 7);
    const h = sha256(buf);
    const bad = Buffer.from(buf);
    bad[cs + 50] ^= 0xff; // Tamper with one byte in chunk 1
    const meta = { size: buf.length, ext: 'mp4' };
    for (let n = 0; n < 2; n++) assert.equal((await store.putChunk(h, n, meta, streamOf(sliceOf(bad, n, cs)))).status, 'ok');
    assert.deepEqual((await store.chunks(h)).received, [0, 1]);
    assert.deepEqual(await store.complete(h), { status: 'hash-mismatch', actual: sha256(bad) });
    const later = await store.chunks(h);
    assert.deepEqual(later.received, [], 'All received chunks are discarded');
    assert.equal(later.complete, false);
    assert.deepEqual(later, unknownChunks(cs), 'After all staging data is discarded it is a hash never seen');
    assert.equal(await store.stat(h), null);
    assert.equal(await store.read(h), null);
    assert.deepEqual(await store.complete(h), { status: 'unknown' });
    // Retransmitting the correct bytes from the beginning can be stored
    await putAll(store, h, buf);
    assert.equal((await store.complete(h)).status, 'ok');
  });

  test(`K8 ${kind}: all chunks arrived → ok; stat is correct; read returns correct bytes for the whole file and for ranges`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs * 2 + 321, 8); // 3 chunks
    const h = sha256(buf);
    const t0 = Date.now();
    await putAll(store, h, buf, 'mp4');
    assert.deepEqual(await store.complete(h), { status: 'ok', size: buf.length, ext: 'mp4' });
    assert.deepEqual(await store.chunks(h), { size: buf.length, chunkSize: cs, received: [0, 1, 2], complete: true });

    const st = await store.stat(h);
    assert.ok(st, 'stat is not null');
    assert.equal(st.size, buf.length);
    assert.equal(st.ext, 'mp4');
    assert.equal(st.contentType, 'video/mp4');
    assert.ok(st.mtimeMs === null || (typeof st.mtimeMs === 'number' && Number.isFinite(st.mtimeMs)), `mtimeMs: ${st.mtimeMs}`);
    if (kind === 'memory') {
      assert.equal(typeof st.mtimeMs, 'number', 'The mtimeMs of memory is the time it was stored');
      assert.ok(st.mtimeMs >= t0 - 5 && st.mtimeMs <= Date.now() + 5, `mtimeMs falls around the storing time: ${st.mtimeMs}`);
    }

    assert.deepEqual(await readAll(await store.read(h)), buf, 'Whole file');
    assert.deepEqual(await readAll(await store.read(h, {})), buf, 'Empty options = whole file');
    const ranges = [
      [0, 0], [100, 199], [cs - 5, cs + 4], [cs - 1, cs], [cs, 2 * cs - 1], [0, buf.length - 1], [buf.length - 1, buf.length - 1],
    ];
    for (const [start, end] of ranges) {
      assert.deepEqual(await readAll(await store.read(h, { start, end })), buf.subarray(start, end + 1), `Closed range ${start}-${end}`);
    }
    assert.deepEqual(await readAll(await store.read(h, { start: buf.length - 10 })), buf.subarray(buf.length - 10), 'end defaults to the end of the file');
    assert.deepEqual(await readAll(await store.read(h, { start: cs + 7 })), buf.subarray(cs + 7), 'Start across a chunk boundary, through to the end');

    // No file extension, contentType falls back
    const plain = bytesOf(50, 88);
    const hp = sha256(plain);
    await putAll(store, hp, plain, '');
    assert.deepEqual(await store.complete(hp), { status: 'ok', size: 50, ext: '' });
    const sp = await store.stat(hp);
    assert.equal(sp.ext, '');
    assert.equal(sp.contentType, 'application/octet-stream');
  });

  test(`K9 ${kind}: putChunk after storing → complete (the source is read to the end and discarded, not written to disk); complete again → ok`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs + 3, 9);
    const h = sha256(buf);
    await putAll(store, h, buf, 'png');
    assert.equal((await store.complete(h)).status, 'ok');

    let drained = false;
    async function* garbage() { yield Buffer.alloc(cs, 0x55); drained = true; }
    assert.deepEqual(await store.putChunk(h, 0, { size: buf.length, ext: 'png' }, garbage()), { status: 'complete' });
    assert.ok(drained, 'The request body is fully read');
    // After being stored: any chunk other than size mismatch, invalid length, or out-of-bounds also
    // returns complete
    assert.deepEqual(await store.putChunk(h, 1, { size: buf.length, ext: 'mp4' }, streamOf(Buffer.alloc(1))), { status: 'complete' });
    assert.deepEqual(await store.putChunk(h, 0, { size: buf.length + 9, ext: 'png' }, streamOf(Buffer.alloc(2))), { status: 'complete' });

    assert.deepEqual(await store.complete(h), { status: 'ok', size: buf.length, ext: 'png' });
    assert.deepEqual(await readAll(await store.read(h)), buf, 'The bytes were not changed');
    assert.equal((await store.stat(h)).ext, 'png');
    assert.equal((await store.chunks(h)).complete, true);
  });

  test(`K10 ${kind}: putChunk on all chunks concurrently, then complete: the result is the same as writing in order`, async () => {
    const buf = bytesOf((kind === 'memory' ? MEM_CHUNK : 8 * 1024 * 1024) * 3 + 77, 10); // 4 chunks
    const h = sha256(buf);

    const seqEnv = make();
    await putAll(seqEnv.store, h, buf, 'webm');
    const seqDone = await seqEnv.store.complete(h);

    const { store } = make();
    const cs = store.chunkSize;
    const order = [3, 1, 0, 2];
    const results = await Promise.all(order.map((n) =>
      store.putChunk(h, n, { size: buf.length, ext: 'webm' }, piecesOf(sliceOf(buf, n, cs), kind === 'memory' ? 61 : 512 * 1024))));
    results.forEach((r, i) => assert.deepEqual(r, { status: 'ok', bytes: sliceOf(buf, order[i], cs).length }, `chunk ${order[i]}`));
    assert.deepEqual(await store.chunks(h), { size: buf.length, chunkSize: cs, received: [0, 1, 2, 3], complete: false });
    const done = await store.complete(h);
    assert.deepEqual(done, seqDone);
    assert.deepEqual(done, { status: 'ok', size: buf.length, ext: 'webm' });
    const [a, b] = [await store.stat(h), await seqEnv.store.stat(h)];
    assert.deepEqual({ size: a.size, ext: a.ext, contentType: a.contentType }, { size: b.size, ext: b.ext, contentType: b.contentType });
    assert.equal(sha256(await readAll(await store.read(h))), h);

    // Writing the same chunk concurrently twice (retransmission races with original transmission) does
    // not corrupt it
    const buf2 = bytesOf(cs * 2 + 5, 11);
    const h2 = sha256(buf2);
    const meta2 = { size: buf2.length, ext: 'webm' };
    const twice = await Promise.all([0, 0, 1, 2, 2].map((n) => store.putChunk(h2, n, meta2, piecesOf(sliceOf(buf2, n, cs), kind === 'memory' ? 97 : 1024 * 1024))));
    assert.ok(twice.every((r) => r.status === 'ok'), JSON.stringify(twice));
    assert.deepEqual(await store.complete(h2), { status: 'ok', size: buf2.length, ext: 'webm' });
    assert.equal(sha256(await readAll(await store.read(h2))), h2);
  });

  test(`K11 ${kind}: after remove, stat is null and chunks is unknown; a second remove returns false`, async () => {
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
    if (dir) assert.ok(!fs.existsSync(path.join(dir, `${h}.mp4`)), 'fs: the whole file is deleted');

    // Hashes that only have staged data can also be deleted
    const part = bytesOf(cs + 1, 13);
    const hp = sha256(part);
    assert.equal((await store.putChunk(hp, 1, { size: part.length, ext: 'mp4' }, streamOf(sliceOf(part, 1, cs)))).status, 'ok');
    assert.equal(await store.remove(hp), true);
    assert.deepEqual(await store.chunks(hp), unknownChunks(cs));
    assert.equal(await store.remove(hp), false);
    if (dir) assert.ok(!fs.existsSync(path.join(dir, '.chunks', hp)), 'fs: the staging directory is deleted');

    // After deletion, the same hash can be re-uploaded
    await putAll(store, h, buf, 'mp4');
    assert.equal((await store.complete(h)).status, 'ok');
    assert.deepEqual(await readAll(await store.read(h)), buf);
  });

  test(`K12 ${kind}: the usage counts are correct (blobs, bytes, staging)`, async () => {
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
    // hash-mismatch discards staged data
    const wrong = sha256(Buffer.from('k12-wrong'));
    await putAll(store, wrong, c, 'png');
    assert.deepEqual(await store.usage(), { blobs: 1, bytes: 300, staging: 2 });
    assert.equal((await store.complete(wrong)).status, 'hash-mismatch');
    assert.deepEqual(await store.usage(), { blobs: 1, bytes: 300, staging: 1 });
    // Store the second one
    assert.equal((await store.putChunk(ha, 1, { size: a.length, ext: 'mp4' }, streamOf(sliceOf(a, 1, cs)))).status, 'ok');
    assert.equal((await store.complete(ha)).status, 'ok');
    assert.deepEqual(await store.usage(), { blobs: 2, bytes: 300 + a.length, staging: 0 });
    // Uploading the same content again does not count as two copies
    assert.equal((await store.putChunk(hb, 0, { size: b.length, ext: 'png' }, streamOf(b))).status, 'complete');
    assert.deepEqual(await store.usage(), { blobs: 2, bytes: 300 + a.length, staging: 0 });
    await putAll(store, hc, c, 'png');
    assert.equal(await store.remove(hb), true);
    assert.deepEqual(await store.usage(), { blobs: 1, bytes: a.length, staging: 1 });
    assert.equal(await store.remove(hc), true);
    assert.deepEqual(await store.usage(), { blobs: 1, bytes: a.length, staging: 0 });
  });

  test(`K13 ${kind}: ext is the first non-empty value registered and does not change afterwards`, async () => {
    const { store } = make();
    const cs = store.chunkSize;
    const buf = bytesOf(cs * 2 + 1, 13); // 3 chunks
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

    // No file extension was provided from start to finish
    const plain = bytesOf(40, 131);
    const hp = sha256(plain);
    assert.equal((await store.putChunk(hp, 0, { size: 40, ext: '' }, streamOf(plain))).status, 'ok');
    assert.deepEqual(await store.complete(hp), { status: 'ok', size: 40, ext: '' });
  });

  test(`K14 ${kind}: an uppercase hash and a lowercase hash are the same one; a malformed hash throws TypeError`, async () => {
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
 * K16: fs only
 * ------------------------------------------------------------------ */

test('K16 fs: the directory layout is the same as today (staging .chunks/<hash>/ contains meta.json, data and <n>.ok; after storing it is <hash>.<ext> and the staging is deleted)', async () => {
  const { store, dir, stored } = KINDS.fs();
  const cs = store.chunkSize;
  assert.equal(cs, 8 * 1024 * 1024, 'The fs chunk size is 8 MiB');
  const buf = bytesOf(cs + 1000, 16);
  const h = sha256(buf);
  const staging = path.join(dir, '.chunks', h);

  assert.equal((await store.putChunk(h.toUpperCase(), 1, { size: buf.length, ext: 'mp4' }, streamOf(sliceOf(buf, 1, cs)))).status, 'ok');
  assert.ok(fs.existsSync(staging), 'Staging directory is created under .chunks/<hash>/ using the lowercase hash');
  const names = fs.readdirSync(staging).sort();
  for (const n of ['meta.json', 'data', '1.ok']) assert.ok(names.includes(n), `Staging directory contains ${n}: ${names.join(', ')}`);
  assert.ok(!names.includes('0.ok'), 'Chunks not received have no marker');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(staging, 'meta.json'), 'utf8')), { size: buf.length, ext: 'mp4' });
  assert.ok(fs.statSync(path.join(staging, 'data')).size >= cs + 1000, 'data is written in place at the offset');
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith(h)).length, 0, 'No whole file before it is stored');

  assert.equal((await store.putChunk(h, 0, { size: buf.length, ext: 'mp4' }, streamOf(sliceOf(buf, 0, cs)))).status, 'ok');
  assert.ok(fs.existsSync(path.join(staging, '0.ok')));
  assert.equal((await store.complete(h)).status, 'ok');

  const whole = path.join(dir, `${h}.mp4`);
  assert.ok(fs.existsSync(whole), '<dir>/<hash>.<ext> exists');
  assert.equal(sha256(fs.readFileSync(whole)), h);
  assert.ok(!fs.existsSync(staging), '.chunks/<hash> does not exist');

  // onStored receives stored information (file is file name, contract section 8 item 3)
  assert.equal(stored.length, 1);
  const e = stored[0];
  assert.equal(e.hash, h);
  assert.equal(e.file, `${h}.mp4`);
  assert.equal(e.ext, 'mp4');
  assert.equal(e.size, buf.length);
  assert.equal(e.contentType, 'video/mp4', 'contentType uses hooks.contentTypeForExt');

  // No file extension: <dir>/<hash>
  const plain = bytesOf(99, 161);
  const hp = sha256(plain);
  assert.equal((await store.putChunk(hp, 0, { size: 99, ext: '' }, streamOf(plain))).status, 'ok');
  assert.equal((await store.complete(hp)).status, 'ok');
  assert.ok(fs.existsSync(path.join(dir, hp)), '<dir>/<hash> (no extension)');
  assert.equal(sha256(fs.readFileSync(path.join(dir, hp))), hp);
  assert.ok(!fs.existsSync(path.join(dir, '.chunks', hp)));
});

test('K16 fs: a legacy whole-file import (placed directly at <dir>/<hash>.<ext>, found via hooks.resolveFile) counts as already stored', async () => {
  const { store, dir } = KINDS.fs();
  const cs = store.chunkSize;
  const buf = bytesOf(5000, 162);
  const h = sha256(buf);
  fs.writeFileSync(path.join(dir, `${h}.wav`), buf);

  const st = await store.stat(h);
  assert.ok(st, 'stat finds the legacy imported file');
  assert.equal(st.size, 5000);
  assert.equal(st.ext, 'wav');
  assert.equal(st.contentType, 'audio/wav');
  assert.equal(typeof st.mtimeMs, 'number');
  assert.deepEqual(await store.chunks(h), { size: 5000, chunkSize: cs, received: [0], complete: true });
  assert.deepEqual(await store.putChunk(h, 0, { size: 5000, ext: 'wav' }, streamOf(buf)), { status: 'complete' });
  assert.deepEqual(await store.complete(h), { status: 'ok', size: 5000, ext: 'wav' });
  assert.deepEqual(await readAll(await store.read(h, { start: 10, end: 19 })), buf.subarray(10, 20));
  assert.ok(!fs.existsSync(path.join(dir, '.chunks', h)), 'putChunk after storing does not write to disk');
});

/* ------------------------------------------------------------------ *
 * K17, K18: contract section 8, items 7 and 8
 * ------------------------------------------------------------------ */

test('K17 memory: size over 256 MiB returns size-mismatch and is not registered', async () => {
  const { store } = KINDS.memory();
  const LIMIT = 256 * 1024 * 1024;
  for (const size of [LIMIT + 1, 64 * 1024 * 1024 * 1024]) {
    const h = sha256(Buffer.from(`k17-${size}`));
    async function* body() { yield Buffer.alloc(MEM_CHUNK, 1) }
    const r = await store.putChunk(h, 0, { size, ext: 'mp4' }, body());
    assert.equal(r?.status, 'size-mismatch', `size ${size}: ${JSON.stringify(r)}`);
    assert.deepEqual(await store.chunks(h), unknownChunks(store.chunkSize), 'Not registered');
    assert.deepEqual(await store.usage(), { blobs: 0, bytes: 0, staging: 0 });
  }
  // Normal size behaves as usual
  const buf = bytesOf(100, 17);
  const h = sha256(buf);
  assert.equal((await store.putChunk(h, 0, { size: 100, ext: '' }, streamOf(buf))).status, 'ok');
});

test('K18 fs: usage counts only files shaped like <hash> and <hash>.<ext>; index files and other files do not count', async () => {
  const { store, dir } = KINDS.fs();
  const buf = bytesOf(321, 18);
  const h = sha256(buf);
  assert.equal((await store.putChunk(h, 0, { size: 321, ext: 'mp4' }, streamOf(buf))).status, 'ok');
  assert.equal((await store.complete(h)).status, 'ok');
  const before = await store.usage();
  assert.deepEqual(before, { blobs: 1, bytes: 321, staging: 0 });

  // Media index (written by vite-plugin-media to <mediaDir>/index.json) and other miscellaneous files
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, items: { [h]: { file: `${h}.mp4`, ext: 'mp4', size: 321, contentType: 'video/mp4' } } }, null, 2));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(dir, `${'a'.repeat(63)}.mp4`), 'short-hash');
  fs.mkdirSync(path.join(dir, 'b'.repeat(64)), { recursive: true });
  assert.deepEqual(await store.usage(), before, 'Counts unchanged');
});
