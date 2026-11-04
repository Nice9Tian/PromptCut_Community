/**
 * Push queue encounters evicted key (storage plan `docs/plan/storage-plan.md`; `server/artifact-push.mjs`):
 * when a segment's key directory is evicted by frame store or deleted by "clear cache" (or file
 * cannot be read midway through pushing), drop this segment and record `push.evicted`,
 * do not retry indefinitely, and do not block other segments in the queue. Failures when key
 * directory still exists back off and retry as usual.
 *
 * Pipeline is mock (only frame store root, `snapshots()`, and empty `entries`), asset service is
 * an in-memory mock client, does not start a service.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SnapshotStore } from '../snapshot-store.mjs';
import { createPushQueue, unitDirOf, unitEvicted } from '../artifact-push.mjs';

const hex = seed => crypto.createHash('sha256').update(String(seed)).digest('hex');

async function rig(t) {
  const root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pc-push-evicted-')), 'frame-library');
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(path.dirname(root), { recursive: true, force: true, maxRetries: 3 }));
  const pipeline = { root, entries: new Map(), snapshots: () => new SnapshotStore(root) };
  return { root, pipeline };
}

/** Write `count` frame snapshots to shared tier, returns unit for this segment */
async function seedShared(pipeline, seed, count = 3) {
  const key = hex(seed);
  const dir = pipeline.snapshots().dir({ tier: 'shared', key });
  await fs.mkdir(dir, { recursive: true });
  for (let f = 0; f < count; f++) await fs.writeFile(path.join(dir, `${f}.html`), `<div>${seed}-${f}</div>`);
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ count, frames: [[0, count - 1]] }));
  return { unit: { kind: 'snapshot', tier: 'shared', resultKey: key, dirKey: key, range: { from: 0, to: count - 1 } }, dir };
}

function fakeClient({ onPut } = {}) {
  const puts = [];
  return {
    puts,
    async put(ns, bytes, opts) {
      if (onPut) await onPut(puts.length, { ns, bytes, opts });
      puts.push({ ns, hash: crypto.createHash('sha256').update(bytes).digest('hex') });
      return { uploaded: true };
    },
    async has() { return false; },
    async get() { return null; },
  };
}

function queueOf(t, pipeline, client, options = {}) {
  const logs = [];
  const queue = createPushQueue({ pipeline, client, gate: false, attach: false, concurrency: 1, log: (event, fields) => logs.push([event, fields]), ...options });
  t.after(() => queue.stop());
  return { queue, logs };
}

const withTimeout = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: still not done after ${ms} ms`)), ms).unref())]);

test('unitDirOf: the shared tier, the local tier and the stream each point to their own key directory in the frame store', async t => {
  const { root, pipeline } = await rig(t);
  const k = hex('a'), e = hex('e');
  assert.equal(unitDirOf(pipeline, { kind: 'snapshot', tier: 'shared', dirKey: k }), path.join(root, 'controls-html', k));
  assert.equal(unitDirOf(pipeline, { kind: 'snapshot', tier: 'local', entryKey: e, dirKey: k }), path.join(root, 'controls-local', e, k));
  assert.equal(unitDirOf(pipeline, { kind: 'stream', resultKey: k }), path.join(root, 'streams', k));
  assert.equal(await unitEvicted(pipeline, { kind: 'stream', resultKey: k }), true);
  assert.equal(await unitEvicted({ root: null, snapshots: () => { throw new Error('x'); } }, { kind: 'snapshot', dirKey: k }), false, 'not judged evicted when the directory cannot be computed');
});

test('key directory evicted after being queued: this segment is dropped and logged as push.evicted, not retried, and does not block other segments in the queue', async t => {
  const { pipeline } = await rig(t);
  const gone = await seedShared(pipeline, 'gone');
  const kept = await seedShared(pipeline, 'kept');
  const client = fakeClient();
  const { queue, logs } = queueOf(t, pipeline, client);
  await queue.enqueue(gone.unit);
  await queue.enqueue(kept.unit);
  // Eviction: entire key directory is gone (frame store eviction first renames into trash directory,
  // then deletes; to this caller, the directory is simply gone)
  await fs.rm(gone.dir, { recursive: true, force: true });
  queue.start();
  await withTimeout(queue.drain(), 10_000, 'queue not drained');
  const stats = queue.stats();
  assert.equal(stats.evicted, 1);
  assert.equal(stats.failures, 0, 'not counted as a failure, no backoff');
  assert.equal(stats.pushed, 1, 'other segments are still pushed');
  assert.equal(client.puts.length, 3, 'only the 3 frames of the remaining segment were pushed');
  const line = logs.find(([event]) => event === 'push.evicted');
  assert.ok(line, `log one push.evicted line: ${JSON.stringify(logs.map(l => l[0]))}`);
  assert.match(line[1].id, new RegExp(gone.unit.resultKey));
  assert.equal(logs.some(([event]) => event === 'push.retry'), false);
});

test('key directory of a stream evicted (no stream.json): dropped, not retried forever as no-stream-manifest', async t => {
  const { pipeline } = await rig(t);
  const client = fakeClient();
  const { queue, logs } = queueOf(t, pipeline, client, { backoff: [60_000] });
  await queue.enqueue({ kind: 'stream', resultKey: hex('stream'), range: { from: 0, to: 3 } });
  queue.start();
  await withTimeout(queue.drain(), 10_000, 'queue not drained');
  assert.equal(queue.stats().evicted, 1);
  assert.equal(queue.stats().failures, 0);
  assert.deepEqual(logs.map(([event]) => event).filter(e => e.startsWith('push.')), ['push.evicted']);
});

test('key directory evicted midway through a push (chunks cannot be read): this segment is dropped, no retry', async t => {
  const { pipeline } = await rig(t);
  const seg = await seedShared(pipeline, 'mid', 12);
  // Delete key directory when pushing first chunk: subsequent chunks cannot be read
  const client = fakeClient({ onPut: async index => { if (index === 0) await fs.rm(seg.dir, { recursive: true, force: true }); } });
  const { queue, logs } = queueOf(t, pipeline, client, { backoff: [60_000] });
  await queue.enqueue(seg.unit);
  queue.start();
  await withTimeout(queue.drain(), 10_000, 'queue not drained');
  const stats = queue.stats();
  assert.equal(stats.evicted, 1);
  assert.equal(stats.failures, 0);
  assert.equal(stats.pushed, 0);
  assert.ok(logs.some(([event]) => event === 'push.evicted'));
  assert.equal(logs.some(([event]) => event === 'push.retry'), false);
});

test('failures while the key directory still exists are still retried with backoff (not treated as eviction)', async t => {
  const { pipeline } = await rig(t);
  const seg = await seedShared(pipeline, 'flaky');
  const client = fakeClient({ onPut: async () => { throw Object.assign(new Error('asset service unavailable'), { code: 'ECONNREFUSED' }); } });
  const { queue, logs } = queueOf(t, pipeline, client, { backoff: [60_000] });
  await queue.enqueue(seg.unit);
  queue.start();
  for (let i = 0; i < 200 && !queue.stats().failures; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const stats = queue.stats();
  assert.equal(stats.failures, 1);
  assert.equal(stats.evicted, 0);
  assert.equal(stats.backingOff, 1, 'still in the queue, backing off');
  assert.ok(logs.some(([event]) => event === 'push.retry'));
});

test('one eviction takes many segments: push.evicted logs only the first few entries and then one in every 100', async t => {
  const { pipeline } = await rig(t);
  const client = fakeClient();
  const { queue, logs } = queueOf(t, pipeline, client);
  for (let i = 0; i < 205; i++) await queue.enqueue({ kind: 'stream', resultKey: hex(`s${i}`), range: { from: 0, to: 0 } });
  queue.start();
  await withTimeout(queue.drain(), 20_000, 'queue not drained');
  assert.equal(queue.stats().evicted, 205);
  const lines = logs.filter(([event]) => event === 'push.evicted');
  assert.deepEqual(lines.map(([, f]) => f.count), [1, 2, 3, 100, 200]);
});
