/**
 * When two paths push the same content concurrently, the data layer must not revoke chunks it has
 * already answered "received" for (claude/push-incomplete, report
 * `docs/reports/AGENT-push-incomplete.md`).
 *
 * Repro: The render node's artifact store and the local push queue push chunks of the same segment
 * almost simultaneously. When A finishes uploading chunk 0 (already returned 200) and is about to
 * finalize, B also comes to upload chunk 0: the original implementation revoked chunk 0's mark
 * before B wrote, so A's `complete` returned `incomplete`. Here, a controllable source is used to
 * lay out both interleavings, running across all three data layers (memory, fs original layout, fs
 * subdirectory layout).
 *
 * Run: node --test server/test/blob-store-concurrent-push.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { PassThrough } from 'node:stream';
import { createMemoryStore, createFsStore } from '../asset-store/index.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-concurrent-push-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const CS = 16;
let seq = 0;
const kinds = {
  memory: () => createMemoryStore({ chunkSize: CS }),
  'fs-flat': () => createFsStore({ dir: path.join(TMP, `flat-${seq++}`), chunkSize: CS }),
  'fs-shard': () => createFsStore({ dir: path.join(TMP, `shard-${seq++}`), chunkSize: CS, shard: true }),
};

/** Wait for the data layer to start reading this source (indicating putChunk has passed the registration step) */
function controlled() {
  const src = new PassThrough();
  const started = new Promise((resolve) => {
    const origRead = src._read.bind(src);
    src._read = (n) => { resolve(); return origRead(n); };
    src.once('resume', resolve);
  });
  return { src, started };
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function readAll(stream) {
  const parts = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
}

for (const [kind, make] of Object.entries(kinds)) {
  test(`${kind}: A has received chunk 0; while B's re-send of the same chunk has not finished writing, A's completion does not return incomplete`, async () => {
    const store = make();
    const buf = crypto.randomBytes(CS * 2 + 5);
    const h = sha256(buf);
    const meta = { size: buf.length, ext: 'webp' };
    for (let n = 0; n < 3; n++) {
      assert.equal((await store.putChunk(h, n, meta, [buf.subarray(n * CS, Math.min(buf.length, (n + 1) * CS))])).status, 'ok');
    }
    // B retransmits chunk 0, bytes are still in flight
    const b = controlled();
    const bDone = store.putChunk(h, 0, meta, b.src);
    await Promise.race([b.started, tick(200)]);
    await tick();
    assert.deepEqual((await store.chunks(h)).received, [0, 1, 2], 'Chunks already received are not removed because of a re-send');
    const done = await store.complete(h);
    assert.equal(done.status, 'ok', `A completion: ${JSON.stringify(done)}`);
    b.src.end(buf.subarray(0, CS));
    const bRes = await bDone;
    assert.ok(bRes.status === 'ok' || bRes.status === 'complete', `B's re-send: ${JSON.stringify(bRes)}`);
    assert.equal(sha256(await readAll(await store.read(h))), h);
  });

  test(`${kind}: A and B upload chunk 0 at the same time; A finishes writing first and completes and is stored, and B returns complete instead of discarded when it finishes writing`, async () => {
    const store = make();
    const buf = crypto.randomBytes(CS - 3);
    const h = sha256(buf);
    const meta = { size: buf.length, ext: 'webp' };
    const b = controlled();
    const bDone = store.putChunk(h, 0, meta, b.src);
    await Promise.race([b.started, tick(200)]);
    await tick();
    assert.equal((await store.putChunk(h, 0, meta, [buf])).status, 'ok');
    const done = await store.complete(h);
    assert.equal(done.status, 'ok', `A completion: ${JSON.stringify(done)}`);
    b.src.end(buf);
    const bRes = await bDone;
    assert.ok(bRes.status === 'ok' || bRes.status === 'complete', `B: ${JSON.stringify(bRes)}`);
    assert.equal(sha256(await readAll(await store.read(h))), h);
    assert.equal((await store.chunks(h)).complete, true);
  });

  test(`${kind}: when a chunk already received is re-sent and the stream breaks, the mark is kept (the stored bytes were never touched)`, async () => {
    const store = make();
    const buf = crypto.randomBytes(CS + 4);
    const h = sha256(buf);
    const meta = { size: buf.length, ext: 'webp' };
    assert.equal((await store.putChunk(h, 0, meta, [buf.subarray(0, CS)])).status, 'ok');
    assert.equal((await store.putChunk(h, 1, meta, [buf.subarray(CS)])).status, 'ok');
    const broken = (async function* () { yield buf.subarray(0, 5); throw new Error('Connection lost'); })();
    await assert.rejects(store.putChunk(h, 0, meta, broken));
    assert.deepEqual((await store.chunks(h)).received, [0, 1]);
    assert.equal((await store.complete(h)).status, 'ok');
    assert.equal(sha256(await readAll(await store.read(h))), h);
  });
}
