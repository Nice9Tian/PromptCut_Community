/**
 * Hand over assets already in the local content store to the upload queue by hash (C10a integration
 * rework: when "move to the cloud" is enabled, assets in the project before enabling must also move
 * to the cloud).
 * Run: node --test server/test/upload-enqueue-existing.test.mjs
 *
 * `enqueueLocalMedia` (`server/upload-queue.mjs`) accepts the request body of
 * `POST /api/media/upload-queue/enqueue`; the queue uses real `createUploadQueue` (in-memory only,
 * targeting a mock asset service client for logging) to check queued tiers, small before large,
 * only accepting locally existing items, and reporting missing items.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createUploadQueue, enqueueLocalMedia } from '../upload-queue.mjs';

const h = (c) => c.repeat(64);
const V_ORIG = h('a'), V_SMALL = h('b'), IMG = h('c'), GONE = h('d'), GONE_SMALL = h('e');
const LOCAL = new Map([[V_ORIG, `/lib/${V_ORIG}.mp4`], [V_SMALL, `/lib/${V_SMALL}.mp4`], [IMG, `/lib/${IMG}.png`]]);
const resolveFile = (hash) => LOCAL.get(hash) ?? null;

function queueWith({ remote = true } = {}) {
  const client = { putFile: async () => ({ uploaded: true, sent: 1 }), chunks: async () => ({ complete: true }) };
  return createUploadQueue({ file: null, target: () => (remote ? { client, base: 'http://h/api/asset' } : null), resolveFile });
}

test('UQE-1 a video\'s two tiers are queued small first, then large; an image has only one tier, the asset original size; the extension comes from the local file', async () => {
  const q = queueWith();
  const r = await enqueueLocalMedia(q, { items: [{ name: 'v.mp4', original: V_ORIG, small: V_SMALL }, { name: 'i.png', original: IMG }] }, resolveFile);
  assert.deepEqual(r, { queued: [V_ORIG, IMG], missing: [], bad: 0, local: false });
  const s = q.stats();
  assert.deepEqual(s.items.map((i) => [i.id, i.tiers]), [[V_ORIG, ['small', 'original']], [IMG, ['original']]]);
});

test('UQE-2 accepts only what exists locally: asset original size missing → the whole asset is not queued and the absence is reported; asset small size missing → only the asset original size is uploaded and the missing asset small size is reported', async () => {
  const q = queueWith();
  const r = await enqueueLocalMedia(q, { items: [{ original: GONE, small: V_SMALL }, { original: V_ORIG, small: GONE_SMALL }] }, resolveFile);
  assert.deepEqual(r.queued, [V_ORIG]);
  assert.deepEqual(r.missing, [GONE, GONE_SMALL]);
  assert.deepEqual(q.stats().items.map((i) => [i.id, i.tiers]), [[V_ORIG, ['original']]]);
});

test('UQE-3 also accepts { hashes } (each treated as an asset original size tier); items with the wrong shape are counted as bad; re-queuing the same asset original size only merges tiers', async () => {
  const q = queueWith();
  const r = await enqueueLocalMedia(q, { hashes: [V_ORIG, 'not-a-hash', IMG] }, resolveFile);
  assert.deepEqual(r, { queued: [V_ORIG, IMG], missing: [], bad: 1, local: false });
  await enqueueLocalMedia(q, { items: [{ original: V_ORIG, small: V_SMALL }] }, resolveFile);
  const s = q.stats();
  assert.equal(s.merged, 1);
  assert.deepEqual(s.items[0].tiers, ['small', 'original'], 'Still small first, then large, after merging');
});

test('UQE-4 currently connected to the local asset service (queue is a no-op): returns local, nothing is queued', async () => {
  const q = queueWith({ remote: false });
  const r = await enqueueLocalMedia(q, { items: [{ original: V_ORIG }, { original: IMG }] }, resolveFile);
  assert.equal(r.local, true);
  assert.deepEqual(r.queued, []);
  assert.equal(q.stats().items.length, 0);
});

test('UQE-5 submitting the original size while the small size is still transcoding: waits for the persistent two-tier manager and does not upload early; even if the page has not written back yet after generation, small still goes before large', async () => {
  const q = queueWith();
  let known = { state: 'pending' };
  const options = { getTiers: () => known };
  const body = { items: [{ original: V_ORIG }] };
  const pending = await enqueueLocalMedia(q, body, resolveFile, options);
  assert.deepEqual(pending, { queued: [], deferred: [V_ORIG], missing: [], bad: 0, local: false });
  assert.equal(q.stats().items.length, 0, 'A supplementary submission must not jump ahead of the two-tier manager to upload the original size');
  known = { state: 'ready', small: V_SMALL };
  await enqueueLocalMedia(q, body, resolveFile, options);
  assert.deepEqual(q.stats().items.map(i => i.tiers), [['small', 'original']]);
});

test('UQE-6 an asset whose transcode failed or that has no two-tier registration still uploads the original size, without waiting forever', async () => {
  for (const state of ['failed', 'none', 'unknown']) {
    const q = queueWith();
    const r = await enqueueLocalMedia(q, { hashes: [V_ORIG] }, resolveFile, { getTiers: () => ({ state }) });
    assert.deepEqual(r.queued, [V_ORIG]);
    assert.deepEqual(q.stats().items.map(i => i.tiers), [['original']]);
  }
});

test('UQE-7 first report that the original size is explicitly missing; a local target does not record a remote transcode to-do', async () => {
  const q = queueWith({ remote: false });
  const options = { isLocal: () => true, getTiers: () => ({ state: 'pending' }) };
  const r = await enqueueLocalMedia(q, { hashes: [GONE, V_ORIG] }, resolveFile, options);
  assert.deepEqual(r, { queued: [], missing: [GONE], bad: 0, local: true });
  assert.equal(q.stats().items.length, 0);
});

test('UQE-8 cancel: withdraws assets that are uploading or queued and removes them from the queue; aborts in-flight chunks', async () => {
  let putAborted = false;
  let putStarted = false;
  const client = {
    putFile: async (_ns, _file, { signal, beforeChunk }) => {
      putStarted = true;
      try {
        await beforeChunk();
        await new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          setTimeout(resolve, 5000);
        });
        return { uploaded: true, sent: 1 };
      } catch (err) {
        putAborted = true;
        throw err;
      }
    },
    chunks: async () => ({ complete: true }),
  };
  const q = createUploadQueue({ file: null, target: () => ({ client, base: 'http://h/api/asset' }), resolveFile });
  await enqueueLocalMedia(q, { items: [{ original: V_ORIG, small: V_SMALL }, { original: IMG }] }, resolveFile);
  assert.equal(q.stats().items.length, 2);
  q.start();
  while (!putStarted) await new Promise((r) => setTimeout(r, 10));
  // Cancel V_ORIG currently uploading
  const cancelRes = await q.cancel([V_ORIG]);
  assert.deepEqual(cancelRes, { ok: true, cancelled: [V_ORIG] });
  assert.equal(putAborted, true);
  assert.deepEqual(q.stats().items.map((i) => i.id), [IMG]);
  // Cancel queued IMG
  const cancelAllRes = await q.cancel();
  assert.deepEqual(cancelAllRes, { ok: true, cancelled: [IMG] });
  assert.equal(q.stats().items.length, 0);
  await q.stop();
});

test('UQE-9 /api/media/upload-queue/cancel endpoint: withdraws in-flight and queued files and cleans up local files not yet registered; files that have finished uploading and left the queue are not deleted', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-uqe-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mediaDir = path.join(dir, 'out', 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const file1 = path.join(mediaDir, `${V_ORIG}.mp4`);
  const file2 = path.join(mediaDir, `${IMG}.png`);
  fs.writeFileSync(file1, 'data1');
  fs.writeFileSync(file2, 'data2');
  fs.writeFileSync(path.join(mediaDir, 'index.json'), JSON.stringify({
    version: 1, items: {
      [V_ORIG]: { file: `${V_ORIG}.mp4`, name: 'video.mp4', ext: 'mp4', size: 5 },
      [IMG]: { file: `${IMG}.png`, name: 'image.png', ext: 'png', size: 5 },
    },
  }));

  const { mediaMiddleware } = await import('../vite-plugin-media.ts');
  const m = mediaMiddleware(dir);
  const server = http.createServer((req, res) => { void m(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // Set remote target first (queue is a no-op when connecting to local asset service; does not enqueue)
  const setTarget = await fetch(`${base}/api/media/upload-queue/target`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: 'http://remote.asset.service/api' }),
  });
  assert.equal(setTarget.status, 200);

  // Enqueue both items
  const enq = await fetch(`${base}/api/media/upload-queue/enqueue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: [V_ORIG, IMG] }),
  });
  assert.equal(enq.status, 200);

  // 1. POST /api/media/upload-queue/cancel: cancel V_ORIG
  const c1 = await fetch(`${base}/api/media/upload-queue/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: [V_ORIG] }),
  });
  const j1 = await c1.json();
  assert.deepEqual(j1.cancelled, [V_ORIG]);
  assert.deepEqual(j1.cleaned, [V_ORIG]);
  assert.equal(fs.existsSync(file1), false, 'In-flight/queued files are deleted');

  // 2. DELETE /api/media/upload-queue/<hash>: cancel IMG
  const c2 = await fetch(`${base}/api/media/upload-queue/${IMG}`, { method: 'DELETE' });
  const j2 = await c2.json();
  assert.deepEqual(j2.cancelled, [IMG]);
  assert.deepEqual(j2.cleaned, [IMG]);
  assert.equal(fs.existsSync(file2), false, 'Withdrawn files are deleted');

  // 3. Files not in the queue (already fully uploaded and dequeued): cancel will not delete them
  const doneFile = path.join(mediaDir, `${V_SMALL}.mp4`);
  fs.writeFileSync(doneFile, 'finished-data');
  fs.writeFileSync(path.join(mediaDir, 'index.json'), JSON.stringify({
    version: 1, items: { [V_SMALL]: { file: `${V_SMALL}.mp4`, name: 'done.mp4', ext: 'mp4', size: 13 } },
  }));
  const c3 = await fetch(`${base}/api/media/upload-queue/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: [V_SMALL] }),
  });
  const j3 = await c3.json();
  assert.deepEqual(j3.cancelled, [], 'No longer in the queue');
  assert.deepEqual(j3.cleaned, [], 'Nothing was withdrawn');
  assert.equal(fs.existsSync(doneFile), true, 'Files that finished uploading are not deleted by mistake');
});
