/**
 * Unconditional push (contract `docs/plan/manifest-contract.md` Section 4, Section 6 test cases
 * W1-W6).
 * Run: node --experimental-test-module-mocks --test server/test/artifact-push.test.mjs
 *
 * Written strictly against the contract, without looking at the implementation.
 *
 * Conventions:
 *   - A temporary frame store, a real `FramePipeline` (injects `environment`, does not probe;
 *     `bakery/index.mjs` replaced with a mock, does not launch Chrome); asset service (memory,
 *     port 0) and document service (content store, memory, port 0) same as
 *     `artifact-dedup.test.mjs`.
 *   - Push queue:
 *     `createPushQueue({ pipeline, client, content, dir, log, concurrency, now, setTimeout, clearTimeout })`.
 *     `dir` is the frame store root. The contract states backoff requires "injecting a clock" but
 *     does not specify the option name; here we pass `now` / `setTimeout` / `clearTimeout`
 *     following the M5a `createWsEndpoint` convention (fake clock, see `createManualClock` in
 *     `fake-manifest-env.mjs`). Passed to every queue so failed segments do not hold a real 5 s timer.
 *   - "Pipeline configured with a push queue": the contract does not specify how to configure it.
 *     Here `attachQueue(pipeline, queue)`: calls `setPushQueue` if the pipeline has it, otherwise
 *     sets `pipeline.pushQueue = queue` (`createPushQueue` itself already attached it; neither
 *     conflicts).
 *   - `enqueue(unit, priority)`: `priority` takes numeric 0 / 1 / 2 (`normal` / `low` / `lowest` in
 *     the contract table, established as final tiers in Section 9 Item 2); returns `Promise<void>`,
 *     which fulfills after the queue file is written back (Section 9 Item 1); tests await it before
 *     reading `push-queue.json`;
 *     `unit` = `{ kind, tier, resultKey, dirKey, entryKey, range, canvasHeavy }`.
 *   - Push order follows the write order of the content store manifest (`content.put`, which is the
 *     push order when concurrency is 1).
 *   - The hook needs to calculate this segment's `to` (consistent with `split.mjs`: the last segment
 *     goes to `count - 1`), so test cases using hooks attach an entry to the pipeline, with this
 *     card's control (`clipId`, `snapshotKey`, `tier`, `count`) in the card plan.
 *
 * When implementation modules do not exist yet, each test case fails individually and reports the
 * reason.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAssetHarness } from './fake-asset-service.mjs';

const bakeryCalls = [];
const refuse = (name) => (...args) => { bakeryCalls.push(name); void args; throw new Error(`Unit test does not render (${name})`); };
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async (...a) => refuse('openBakery')(...a),
    findFfmpeg: async (...a) => refuse('findFfmpeg')(...a),
    streamPngVideo: refuse('streamPngVideo'),
    bakeFrames: async (...a) => refuse('bakeFrames')(...a),
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const F = await import('./fake-artifact-fixtures.mjs');
const E = await import('./fake-manifest-env.mjs');
const {
  sha256, range, wire, snapshotTask, dirKeyOf, manifestKey, seedSnapshots, unpack, htmlOf, bigHtml, dataImageHtml, dataImageBytes,
  makeRoots, startServices, treeOf, producerOf, OWN_ENV, SHARED_CAPS, LOCAL_CAPS,
} = F;
const { countingAsset, countingContent, createManualClock, until } = E;

let transfer = null, transferError = null;
try { transfer = await import('../artifact-transfer.mjs'); } catch (err) { transferError = err; }
let pushMod = null, pushError = null;
try { pushMod = await import('../artifact-push.mjs'); } catch (err) { pushError = err; }
let clientMod = null, clientError = null;
try { clientMod = await import('../asset-store/client.mjs'); } catch (err) { clientError = err; }
function T() {
  if (transferError) throw new Error(`Cannot load server/artifact-transfer.mjs: ${transferError.message}`);
  return transfer;
}
function P() {
  if (pushError) throw new Error(`Cannot load server/artifact-push.mjs: ${pushError.message}`);
  assert.equal(typeof pushMod.createPushQueue, 'function', `artifact-push.mjs must export createPushQueue; exports: ${Object.keys(pushMod).join(', ')}`);
  return pushMod;
}
function newClient(base) {
  if (clientError) throw new Error(`Cannot load server/asset-store/client.mjs: ${clientError.message}`);
  return clientMod.createAssetClient({ base });
}

const harness = createAssetHarness();
after(() => harness.cleanup());

const FP = OWN_ENV.fingerprint;
const NORMAL = 0, LOW = 1, LOWEST = 2;

async function rig(t) {
  const roots = makeRoots(FramePipeline, 'pc-c64-push-');
  t.after(() => roots.cleanup());
  const svc = await startServices(harness, newClient);
  t.after(() => svc.cleanup());
  return { roots, svc };
}

/** Creates a queue (with a fake clock), calls stop when the test ends */
function queueOf(t, { pipeline, client, content, dir, concurrency = 1, clock = createManualClock() }) {
  const logs = [];
  const queue = P().createPushQueue({
    pipeline, client, content, dir, concurrency,
    log: (...args) => logs.push(args),
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  assert.ok(queue && typeof queue.enqueue === 'function' && typeof queue.start === 'function' && typeof queue.stop === 'function' && typeof queue.stats === 'function',
    'PushQueue = { enqueue, start, stop, stats }');
  t.after(async () => { try { await queue.stop(); } catch { /* Stopped */ } });
  const live = { queue, logs };
  liveQueues.add(live);
  t.after(() => { liveQueues.delete(live); });
  return { queue, clock, logs };
}

/**
 * Queues created by this test case: on wait timeout, includes each queue's lastError and recent
 * retry logs in the error, so intermittent failures can be diagnosed
 */
const liveQueues = new Set();
const queueDiag = () => JSON.stringify([...liveQueues].map(({ queue, logs }) => ({
  stats: (({ running, pending, inflight, backingOff, pushed, failures, uploaded, skipped, manifests }) => ({ running, pending, inflight, backingOff, pushed, failures, uploaded, skipped, manifests }))(queue.stats()),
  lastError: queue.stats().lastError,
  retries: logs.filter(([event]) => event === 'push.retry').slice(-3),
}))).slice(0, 1500);

function attachQueue(pipeline, queue) {
  if (typeof pipeline.setPushQueue === 'function') pipeline.setPushQueue(queue);
  else if (pipeline.pushQueue !== queue) pipeline.pushQueue = queue;
}

/** Shared-tier control for one card (card plan shape, `card-cache.mjs`) */
function sharedControl({ clipId, contentKey, count, capabilities = SHARED_CAPS }) {
  return { clipId, key: `png-${clipId}`, snapshotKey: resultKeyOf(contentKey, FP), contentKey, envFingerprint: FP, tier: 'shared', capabilities, count, sampling: { firstFrame: 0 } };
}
function entryWith(pipeline, controls, key = sha256(`entry-${Math.random()}`)) {
  const entry = { key, project: { fps: 30, width: 1920, height: 1080, duration: 10, tracks: [] }, cardPlan: controls, status: 'ready' };
  pipeline.entries.set(key, entry);
  return entry;
}
const unitOf = (task, canvasHeavy = false) => ({
  kind: 'snapshot', tier: task.tier, resultKey: task.resultKey, dirKey: dirKeyOf(task), entryKey: task.tier === 'local' ? task.input.entryKey : null,
  range: { ...task.range }, canvasHeavy,
});
/** First occurrence of each key in the manifest write order */
const putOrder = (content) => [...new Set(content.puts().map((c) => c.key))];
const waitPuts = (content, n, ms = 15_000) => until(() => content.puts().length >= n, { timeoutMs: ms, what: () => `The content store has only ${content.puts().length} manifests written: ${JSON.stringify(putOrder(content))}; queue: ${queueDiag()}` });

/**
 * Reads the queue file; returns null if absent. If hitting an in-progress rename replacement by the
 * queue (reporting EPERM / EBUSY / EACCES on Windows), waits briefly and retries instead of treating
 * it as "absent"
 */
async function readQueueFile(dir) {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.readFile(path.join(dir, 'push-queue.json'), 'utf8'); }
    catch (err) {
      if (err?.code === 'ENOENT' || attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) return null;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/* ------------------------------------------------------------------ W1 */

test('W1 A pipeline with a push queue configured: commitSnapshots writes 130 frames (across 3 segments): each segment is enqueued exactly once; after pushing, the asset service has all the chunks and the content store has 3 manifests', async (t) => {
  const { roots, svc } = await rig(t);
  const root = await roots.root();
  const A = roots.make(root);
  const asset = countingAsset(svc.client);
  const content = countingContent(svc.content);
  const { queue } = queueOf(t, { pipeline: A, client: asset, content, dir: root });
  const enqueued = [];
  const rawEnqueue = queue.enqueue.bind(queue);
  const pending = [];
  queue.enqueue = (unit, priority) => { enqueued.push({ unit: wire(unit), priority }); const r = rawEnqueue(unit, priority); pending.push(r); return r; };
  attachQueue(A, queue);

  const contentKey = sha256('card-W1');
  const control = sharedControl({ clipId: 'clip-w1', contentKey, count: 130 });
  entryWith(A, [control]);
  const rk = control.snapshotKey;
  // Writes in batches (10 frames per batch, 13 batches), via commitSnapshots just like prerendering
  for (let from = 0; from < 130; from += 10) {
    await A.snapshots().commitSnapshots({ tier: 'shared', key: rk, clipId: 'clip-w1', capabilities: SHARED_CAPS,
      items: range(from, from + 9).map((n) => ({ localFrame: n, html: htmlOf(n, 'W1') })) });
  }
  // If the hook calls enqueue via the queue object attached to the pipeline, queued units can be
  // observed here; if not (the implementation enqueues directly in a closure), inspect only the push
  // results
  if (enqueued.length) {
    const distinct = new Map(enqueued.map((e) => [`${e.unit.resultKey}:${e.unit.range.from}-${e.unit.range.to}`, e]));
    assert.deepEqual([...distinct.keys()].sort(), [`${rk}:0-59`, `${rk}:120-129`, `${rk}:60-119`].sort(),
      `Three segments, with keys consistent with the split in split.mjs (the last segment ends at count - 1): ${JSON.stringify([...distinct.keys()])}`);
    for (const e of distinct.values()) {
      assert.equal(e.unit.kind, 'snapshot');
      assert.equal(e.unit.tier, 'shared');
      assert.equal(e.unit.resultKey, rk, 'Shared tier resultKey = snapshotKey');
    }
  }
  assert.equal(content.puts().length, 0, 'Nothing is pushed before start()');
  // The hook does not await enqueue (Section 9 Item 1): wait for the returned Promise to fulfill (if
  // observable) before reading the queue file
  await Promise.all(pending);
  await until(async () => (await readQueueFile(root)) !== null, { timeoutMs: 3000, what: () => 'push-queue.json was not written after enqueueing' });
  const persisted = await readQueueFile(root);
  assert.ok(persisted, 'Enqueueing writes <dir>/push-queue.json');
  assert.doesNotThrow(() => JSON.parse(persisted), 'push-queue.json is valid JSON');

  queue.start();
  await waitPuts(content, 3);
  await new Promise((resolve) => setTimeout(resolve, 300)); // Check for extra pushes
  assert.deepEqual(putOrder(content).sort(), [`${rk}:0-59`, `${rk}:120-129`, `${rk}:60-119`].sort());
  assert.equal(content.puts().length, 3, `Each segment is pushed exactly once: ${JSON.stringify(content.puts().map((c) => c.key))}`);
  const perHash = new Map();
  for (const p of asset.puts) perHash.set(p.hash, (perHash.get(p.hash) ?? 0) + 1);
  assert.equal(perHash.size, 130, '130 chunks');
  assert.ok([...perHash.values()].every((n) => n === 1), 'Each chunk is pushed only once');
  for (const [from, to] of [[0, 59], [60, 119], [120, 129]]) {
    const task = snapshotTask({ contentKey, from, to, fp: FP });
    assert.equal(task.resultKey, rk);
    const expected = unpack(await T().collectSnapshotResult(A, task)).result;
    const got = await svc.content.get('snapshot-manifest', manifestKey(task));
    assert.ok(got, `The content store has ${manifestKey(task)}`);
    assert.deepEqual(got.body, expected, `The manifest for ${from}-${to} is the SnapshotResult of C6.2`);
    for (const [n, h, bytes] of expected.frames) {
      const st = await svc.srv.stores.snap.stat(h);
      assert.ok(st && st.size === bytes, `The chunk of frame ${n} is in snap`);
    }
  }
  const stats = queue.stats();
  assert.ok(stats && typeof stats === 'object', 'stats() returns an object');
  assert.equal(bakeryCalls.length, 0, 'Pushing does not trigger rendering');
});

test('W1 Pushing runs in the background: when the asset service hangs, commitSnapshots still returns quickly and does not block prerendering', async (t) => {
  const { roots, svc } = await rig(t);
  const root = await roots.root();
  const A = roots.make(root);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const asset = countingAsset(svc.client, { beforePut: () => gate });
  const content = countingContent(svc.content);
  const { queue } = queueOf(t, { pipeline: A, client: asset, content, dir: root, concurrency: 2 });
  attachQueue(A, queue);
  const control = sharedControl({ clipId: 'clip-w1b', contentKey: sha256('card-W1b'), count: 120 });
  entryWith(A, [control]);
  queue.start();
  await A.snapshots().commitSnapshots({ tier: 'shared', key: control.snapshotKey, clipId: 'clip-w1b', capabilities: SHARED_CAPS,
    items: range(0, 59).map((n) => ({ localFrame: n, html: htmlOf(n, 'W1b') })) });
  await until(() => asset.puts.length > 0, { timeoutMs: 5000, what: () => 'The queue did not start pushing the first segment' });
  // The push is stuck on the gate and will never complete before the test releases it:
  // if commitSnapshots returns before the release, it proves it does not wait for the push.
  // Do not use a wall-clock threshold like "< 2000 ms": during full parallel runs the CPU is at full
  // load, and writing 60 frames alone occasionally takes two to three seconds.
  const t0 = Date.now();
  let limit;
  const idx = await Promise.race([
    A.snapshots().commitSnapshots({ tier: 'shared', key: control.snapshotKey, clipId: 'clip-w1b', capabilities: SHARED_CAPS,
      items: range(60, 119).map((n) => ({ localFrame: n, html: htmlOf(n, 'W1b') })) }),
    new Promise((resolve, reject) => { limit = setTimeout(() => reject(new Error(`With the push stuck, commitSnapshots had still not returned after ${Date.now() - t0} ms: it is waiting on the push`)), 20_000); }),
  ]).finally(() => clearTimeout(limit));
  assert.equal(asset.puts.filter((p) => p.ok).length, 0, 'When commitSnapshots returned, the push was still stuck (not a single chunk got pushed)');
  assert.deepEqual(idx.frames, [[0, 119]], 'Writing to disk is unaffected');
  release();
  await waitPuts(content, 2);
});

/* ------------------------------------------------------------------ W2 */

test('W2 Priority: when one shared-tier segment, one local-tier segment and one segment with an oversize frame are enqueued at the same time, the push order is normal → low → lowest', async (t) => {
  const { roots, svc } = await rig(t);
  const root = await roots.root();
  const A = roots.make(root);
  const shared = snapshotTask({ contentKey: sha256('card-W2-shared'), from: 0, to: 59, fp: FP });
  const entryKey = sha256('entry-W2');
  const local = snapshotTask({ tier: 'local', entryKey, contentKey: sha256('card-W2-local'), from: 0, to: 59, fp: FP, clipId: 'clip-l' });
  const over = snapshotTask({ contentKey: sha256('card-W2-over'), from: 0, to: 59, fp: FP });
  // Writes to the frame store first (queue not yet created: bypasses hooks)
  await seedSnapshots(A, shared, range(0, 59), { tag: 'S' });
  await seedSnapshots(A, local, range(0, 59), { tag: 'L' });
  const idx = await seedSnapshots(A, over, range(0, 59), { html: (n) => (n === 17 ? bigHtml(n) : htmlOf(n, 'O')) });
  assert.deepEqual(idx.oversize, [[17, 17]], 'Fixture: frame 17 is oversize');

  const content = countingContent(svc.content);
  const { queue } = queueOf(t, { pipeline: A, client: svc.client, content, dir: root, concurrency: 1 });
  // Deliberately enqueued in order: lowest → low → normal
  await queue.enqueue(unitOf(over), LOWEST);
  await queue.enqueue(unitOf(local), LOW);
  await queue.enqueue(unitOf(shared), NORMAL);
  queue.start();
  await waitPuts(content, 3);
  assert.deepEqual(putOrder(content), [manifestKey(shared), manifestKey(local), manifestKey(over)], 'normal → low → lowest');
  // All three manifests are correct
  for (const task of [shared, local, over]) {
    const got = await svc.content.get('snapshot-manifest', manifestKey(task));
    assert.deepEqual(got?.body, unpack(await T().collectSnapshotResult(A, task)).result, `Manifest of ${task.tier} ${manifestKey(task).slice(-6)}`);
  }
  const overBody = (await svc.content.get('snapshot-manifest', manifestKey(over))).body;
  assert.equal(overBody.frames.length, 60, 'Oversize frames are in the manifest too');
  assert.equal(overBody.dirKey, over.resultKey);
  const localBody = (await svc.content.get('snapshot-manifest', manifestKey(local))).body;
  assert.deepEqual([localBody.tier, localBody.entryKey, localBody.dirKey], ['local', entryKey, dirKeyOf(local)], 'The local-tier manifest carries entryKey and the on-disk key');
});

/* ------------------------------------------------------------------ W3 */

test('W3 A segment where data:image takes more than half is pushed at low (the hook decides this itself; below half it is still normal; one with an oversize frame is lowest)', async (t) => {
  const { roots, svc } = await rig(t);
  const root = await roots.root();
  const A = roots.make(root);
  const content = countingContent(svc.content);
  const { queue } = queueOf(t, { pipeline: A, client: svc.client, content, dir: root, concurrency: 1 });
  const enqueued = [];
  const rawEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = (unit, priority) => { enqueued.push({ unit: wire(unit), priority }); return rawEnqueue(unit, priority); };
  attachQueue(A, queue);

  const X = sharedControl({ clipId: 'clip-img', contentKey: sha256('card-W3-img'), count: 60 });      // data:image ≈ 80%
  const Y = sharedControl({ clipId: 'clip-some', contentKey: sha256('card-W3-some'), count: 60 });    // data:image ≈ 30%
  const Z = sharedControl({ clipId: 'clip-over', contentKey: sha256('card-W3-over'), count: 60 });    // One frame is oversized
  entryWith(A, [X, Y, Z]);
  const htmlX = (n) => dataImageHtml(n, 0.8);
  const htmlY = (n) => dataImageHtml(n, 0.3);
  const share = (fn) => { let img = 0, all = 0; for (const n of range(0, 59)) { const h = fn(n); img += dataImageBytes(h); all += Buffer.byteLength(h, 'utf8'); } return img / all; };
  assert.ok(share(htmlX) > 0.7, `Fixture: the data:image share of X is ${share(htmlX).toFixed(3)}`);
  assert.ok(share(htmlY) < 0.4 && share(htmlY) > 0.2, `Fixture: the data:image share of Y is ${share(htmlY).toFixed(3)}`);
  const commit = (c, html) => A.snapshots().commitSnapshots({ tier: 'shared', key: c.snapshotKey, clipId: c.clipId, capabilities: SHARED_CAPS,
    items: range(0, 59).map((n) => ({ localFrame: n, html: html(n) })) });
  // Enqueue order X, Z, Y (this is the order under FIFO)
  await commit(X, htmlX);
  await commit(Z, (n) => (n === 30 ? bigHtml(n) : htmlOf(n, 'Z')));
  await commit(Y, htmlY);
  t.diagnostic(`Hook enqueued: ${JSON.stringify(enqueued.map((e) => [e.unit.resultKey?.slice(0, 6), e.priority]))}`);
  queue.start();
  await waitPuts(content, 3);
  assert.deepEqual(putOrder(content), [`${Y.snapshotKey}:0-59`, `${X.snapshotKey}:0-59`, `${Z.snapshotKey}:0-59`],
    'Y (normal) → X (data:image over half, low) → Z (has an oversize frame, lowest)');
});

/* ------------------------------------------------------------------ W4 */

test('W4 stop() halfway through pushing, then rebuild the queue from the same dir: unfinished segments continue pushing, finished ones are not pushed again (counting put uploads)', async (t) => {
  const { roots, svc } = await rig(t);
  const root = await roots.root();
  const A = roots.make(root);
  const tasks = ['a', 'b', 'c', 'd'].map((k) => snapshotTask({ contentKey: sha256(`card-W4-${k}`), from: 0, to: 59, fp: FP }));
  const segOf = new Map();
  for (const [i, task] of tasks.entries()) {
    await seedSnapshots(A, task, range(0, 59), { tag: `W4-${i}` });
    for (const [, h] of unpack(await T().collectSnapshotResult(A, task)).result.frames) segOf.set(h, i);
  }

  // First queue: the first segment pushes to completion as usual; the second segment blocks as soon as
  // pushing starts, at which point stop() is called, then let it fail
  let first = null, second = null, releaseSecond;
  const blocked = new Promise((resolve) => { releaseSecond = resolve; });
  const asset1 = countingAsset(svc.client, {
    beforePut: async ({ hash }) => {
      const seg = segOf.get(hash);
      if (first === null) first = seg;
      if (seg === first) return;
      if (second === null) second = seg;
      await blocked;
      throw Object.assign(new Error('Interrupted at shutdown'), { status: 503 });
    },
  });
  const content1 = countingContent(svc.content);
  const q1 = queueOf(t, { pipeline: A, client: asset1, content: content1, dir: root, concurrency: 1 });
  for (const task of tasks) await q1.queue.enqueue(unitOf(task), NORMAL); // Section 9 Item 1: fulfills only after writing back the queue file
  const before = await readQueueFile(root);
  assert.ok(before && tasks.every((task) => before.includes(task.resultKey)), 'All four segments were written into push-queue.json');
  q1.queue.start();
  await until(() => second !== null, { timeoutMs: 10_000, what: () => `The second segment did not start pushing: first=${first}; queue: ${queueDiag()}` });
  assert.equal(content1.puts().length, 1, 'The first segment finished pushing and its manifest was written');
  await q1.queue.stop();
  releaseSecond();
  // stop() does not wait for in-flight pushing segments (contract): after the second segment is
  // released, it fails and writes the queue file once more. Wait for it to finalize and finish writing
  // before reading the file; otherwise it may read a file mid-replacement (on Windows, reading at the
  // instant of rename-replacement fails), or collide with q2's restore below.
  await until(() => q1.queue.stats().inflight === 0, { timeoutMs: 10_000, what: () => `The second segment never finished; queue: ${queueDiag()}` });
  await q1.queue.stop(); // Calling stop again on an already-stopped queue does only one thing: wait for all queued writebacks to complete
  await new Promise((resolve) => setTimeout(resolve, 100));
  const doneKey = manifestKey(tasks[first]);
  assert.deepEqual(content1.puts().map((c) => c.key), [doneKey], 'No other segments are pushed after stopping');
  const persisted = await readQueueFile(root);
  assert.ok(persisted, 'The queue file is still there');
  assert.ok(!persisted.includes(tasks[first].resultKey), 'Finished segments are not left in the file');
  for (const [i, task] of tasks.entries()) if (i !== first) assert.ok(persisted.includes(task.resultKey), `Unfinished segment ${i} is still in the file`);

  // Second queue: same dir, resumes pushing after reconstruction
  const asset2 = countingAsset(svc.client);
  const content2 = countingContent(svc.content);
  const q2 = queueOf(t, { pipeline: A, client: asset2, content: content2, dir: root, concurrency: 1 });
  q2.queue.start();
  await waitPuts(content2, 3);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const rest = tasks.filter((_, i) => i !== first).map(manifestKey);
  assert.deepEqual(putOrder(content2).sort(), [...rest].sort(), 'The remaining three segments continue and finish pushing');
  assert.equal(content2.puts().length, 3, 'Once per segment');
  assert.equal(asset2.puts.filter((p) => segOf.get(p.hash) === first).length, 0, 'Not a single chunk of the finished first segment is pushed again');
  assert.equal(asset2.puts.filter((p) => segOf.get(p.hash) !== first).length, 180, '180 chunks for the remaining three segments');
  for (const task of tasks) assert.ok(await svc.content.get('snapshot-manifest', manifestKey(task)), `${manifestKey(task).slice(-12)} is in the content store`);
  const after_ = await readQueueFile(root);
  assert.ok(after_ === null || tasks.every((task) => !after_.includes(task.resultKey)), 'After everything completes, no finished segments are left in the file');
});

/* ------------------------------------------------------------------ W5 */

test('W5 The asset service returns 500 for a segment: that segment is retried with backoff at 5 s and 30 s (injected clock) and finally succeeds; other segments are unaffected', async (t) => {
  const { roots, svc } = await rig(t);
  const root = await roots.root();
  const A = roots.make(root);
  const tasks = ['a', 'b', 'c'].map((k) => snapshotTask({ contentKey: sha256(`card-W5-${k}`), from: 0, to: 59, fp: FP }));
  const bad = new Set();
  let sentinel = null;
  for (const [i, task] of tasks.entries()) {
    await seedSnapshots(A, task, range(0, 59), { tag: `W5-${i}` });
    const frames = unpack(await T().collectSnapshotResult(A, task)).result.frames;
    if (i === 1) { for (const [, h] of frames) bad.add(h); sentinel = frames[0][1]; }
  }
  // Each chunk determines success or failure based on its own put count (500 for the first two,
  // succeeds on the third). Cannot decide by the sentinel chunk's count: chunks within a segment are
  // put with 4-way concurrency; which one reaches beforePut first depends on disk read speed. In the
  // third round other chunks may race ahead of the sentinel and still be judged as failures, causing
  // this segment to re-enter 120 s backoff; the fake clock is not advanced further, causing the test
  // to time out (intermittent during full parallel runs).
  let attempts = 0;
  const tries = new Map();
  const asset = countingAsset(svc.client, {
    beforePut: ({ hash }) => {
      if (hash === sentinel) attempts++;
      const n = (tries.get(hash) ?? 0) + 1;
      tries.set(hash, n);
      if (bad.has(hash) && n <= 2) throw Object.assign(new Error('HTTP 500'), { status: 500 });
    },
  });
  const content = countingContent(svc.content);
  const clock = createManualClock();
  const { queue } = queueOf(t, { pipeline: A, client: asset, content, dir: root, concurrency: 1, clock });
  for (const task of tasks) await queue.enqueue(unitOf(task), NORMAL);
  queue.start();
  await waitPuts(content, 2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(putOrder(content).sort(), [manifestKey(tasks[0]), manifestKey(tasks[2])].sort(), 'Other segments are unaffected');
  assert.equal(attempts, 1, 'The failed segment was tried once');
  assert.equal(await svc.content.get('snapshot-manifest', manifestKey(tasks[1])), null, 'The failed segment does not write a manifest');

  await clock.advance(4_999);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(attempts, 1, 'No retry before 5 s');
  await clock.advance(1);
  await until(() => attempts === 2, { timeoutMs: 3000, what: () => `No retry after 5 s elapsed: attempts=${attempts}, registered timers ${JSON.stringify(clock.delays)}` });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await svc.content.get('snapshot-manifest', manifestKey(tasks[1])), null, 'The second attempt still failed');

  await clock.advance(29_999);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(attempts, 2, 'No retry before another 30 s of waiting');
  await clock.advance(1);
  await until(() => attempts === 3, { timeoutMs: 3000, what: () => `No retry after 30 s elapsed: attempts=${attempts}, registered timers ${JSON.stringify(clock.delays)}` });
  await waitPuts(content, 3);
  const got = await svc.content.get('snapshot-manifest', manifestKey(tasks[1]));
  assert.deepEqual(got?.body, unpack(await T().collectSnapshotResult(A, tasks[1])).result, 'The third attempt succeeded and the manifest was written to the content store');
  assert.equal(content.puts().length, 3, 'A segment that succeeded is not pushed again');
});

/* ------------------------------------------------------------------ W6 */

// fMP4 composite file (same as frame-stream.test.mjs): storeSegment must be able to split and validate
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (version, flags) => u32(((version & 0xff) << 24) | (flags & 0xffffff));
function makeInit({ width = 64, height = 64, level = 0x1f } = {}) {
  const avcC = box('avcC', Buffer.from([1, 0x64, 0x00, level, 0xff, 0xe1, 0x00, 0x00, 0x01, 0x00, 0x00]));
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(1, 6);
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const avc1 = box('avc1', entry, avcC);
  const stsd = box('stsd', full(0, 0), u32(1), avc1);
  const mdhd = box('mdhd', full(0, 0), u32(0), u32(0), u32(15360), u32(0), u32(0));
  const moov = box('moov', box('trak', box('mdia', mdhd, box('minf', box('stbl', stsd)))));
  return Buffer.concat([box('ftyp', Buffer.from('isom'), u32(512)), moov]);
}
function makeSegment(sizes, fill = 1) {
  const tfhd = box('tfhd', full(0, 0x020020), u32(1), u32(0x01010000));
  const trunBody = (dataOffset) => Buffer.concat([full(0, 0x000205), u32(sizes.length), u32(dataOffset), u32(0x02000000), ...sizes.map(u32)]);
  const probe = box('moof', box('traf', tfhd, box('trun', trunBody(0))));
  const moof = box('moof', box('traf', tfhd, box('trun', trunBody(probe.length + 8))));
  const mdat = box('mdat', Buffer.concat(sizes.map((n, i) => Buffer.alloc(n, fill + i))));
  return Buffer.concat([moof, mdat]);
}

/**
 * The results of the same write sequence on main (without a push queue configured) after C6.2,
 * recorded by running this test on `claude/c6-4` (dc1addc):
 * file → sha256; `at` (`Date.now()`) in `stream.json` is normalized to 0 before computing.
 */
const GOLDEN = {
  commit1: {
    count: 10,
    frames: [
      [
        0,
        9
      ]
    ],
    oversize: [],
    written: [
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9
    ],
    oversized: []
  },
  commit2: {
    count: 19,
    frames: [
      [
        0,
        11
      ],
      [
        13,
        19
      ]
    ],
    oversize: [
      [
        12,
        12
      ]
    ],
    written: [
      10,
      11,
      13,
      14,
      15,
      16,
      17,
      18,
      19
    ],
    oversized: [
      12
    ]
  },
  commit3: {
    count: 5,
    frames: [
      [
        0,
        4
      ]
    ],
    oversize: [],
    written: [
      0,
      1,
      2,
      3,
      4
    ],
    oversized: []
  },
  staged: [],
  streamStats: 2,
  stagedAfter: [
    {
      kind: 'stream',
      key: '5517a8bfe97b060bb52e6467e56b225715869c8e8b895dd54ffa48496cab01c9',
      ranges: [
        [
          0,
          1
        ]
      ]
    }
  ],
  files: {
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/0.html': '75082248faa2a87647ec9828cc5a9f0c9d6a1df58571389f84a329137357d16b',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/1.html': 'a218ea33014a442314c535809c62b2a19c237af650d35c03ce7bb4c49705bbd9',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/10.html': '6e8228abc539ca53a7ccc4c0f29dee04c1a3a8f4b0aa2cfedaf68d33a0973e66',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/11.html': '4501a9ad3e8f18f7be1b962440161521689fe5197963ceb525b4fc7305e9bfcc',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/12.html': 'c8bb3b41c1ec8371d52649b229fec2c8179e61f215a1f32a534509d15bf49637',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/13.html': '44c2c19742c83e29a46bbca2abd73c80d46e0becb43ab36852905cb64fd8765c',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/14.html': 'afd2faf8438b08a3a3bb4a5110c465322c9cd98dac2f38ebcb912e2f705bce95',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/15.html': '9102cf004b6524868eb4f407c0f1beb950e06613b08559f76ebf1eaf6b3ea3aa',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/16.html': 'e87aafd2147d8a342f9ad9fe6363974f9e79c799a377716e1f4f635c1a551f0b',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/17.html': '48786b3925062133167dca28fedc2df96309c6a089c76895666cfeb270a9c16a',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/18.html': '09387aa8c8c6668df59f752b63ab1b6a09b96d004ebbbdf4acfee47603042d3b',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/19.html': '084303ed742e69b5b7681c8ece903df25febd61ba0cde83b10130915227f28a0',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/2.html': '65f924f49f79acce505d119c56b497e2dad404542189e86f444f86653f59e717',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/3.html': '03df86f8203c59a617d256436b9acfe6a303d9238c1500950787a9f11487e80d',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/4.html': 'a0988094bb3c660c5e366064ce6682fc4da0e65c4de1470547e6a3f8007f52e0',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/5.html': '74e6c57f4fed0c88afa6b210772276979831df4af225854cd39891805736b461',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/6.html': 'fbe7fffed5c537d6951a3c640cbcda32c857f6eba08055f2703fc35b2bc57269',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/7.html': '5d45e7221ea6b81674de33480a81873f5223790d19cdbcc132ed14a935f3a2f8',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/8.html': 'b2146a9bc9c6ff0801b3044ba7c37f3fb6bdb1b9181ef121149ff4bafa2db108',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/9.html': '0f2e48adc573fd46bb663b87be086c6f14291ee0bbf1c32723db22f0faedef0d',
    'controls-html/f6590b292089fcdfc23ce88f99b693a07ccefb4d101041dec8ec7f62d5bda04a/index.json': 'fb44521ec46be4ced8e844051faf11b87e9bdb46486696c9b45cd73f982f3e01',
    'controls-local/448952440c0214b285530725ee9e5e7513666983317ca84fdcaf68c3324ec28d/609337f08f815ee6ebd8b5bb7e695a3d587f744059b51489c84248aba099047a/0.html': 'e4fb5efb47136d510cc023cf3aed0759b25c58d62fc15bcff4154b95793d7e6f',
    'controls-local/448952440c0214b285530725ee9e5e7513666983317ca84fdcaf68c3324ec28d/609337f08f815ee6ebd8b5bb7e695a3d587f744059b51489c84248aba099047a/1.html': 'c7251178ef2c10898151022839fad7d28e1a9cdc97cf33b0a39ff6fa3f948a59',
    'controls-local/448952440c0214b285530725ee9e5e7513666983317ca84fdcaf68c3324ec28d/609337f08f815ee6ebd8b5bb7e695a3d587f744059b51489c84248aba099047a/2.html': '979e25c23a47264ab819bb9c7f192cd445ff2d1645c778fad22471ec44d13c91',
    'controls-local/448952440c0214b285530725ee9e5e7513666983317ca84fdcaf68c3324ec28d/609337f08f815ee6ebd8b5bb7e695a3d587f744059b51489c84248aba099047a/3.html': 'f3ebcd45c3041dd2c1aec256e57dfa7b37c1ad0992d4d2f15fde894f2699bc8c',
    'controls-local/448952440c0214b285530725ee9e5e7513666983317ca84fdcaf68c3324ec28d/609337f08f815ee6ebd8b5bb7e695a3d587f744059b51489c84248aba099047a/4.html': '5e90dbe11ecda22ac852d7d7022c2baabbc18a4f705ce7d8609fb8fde0a615f1',
    'controls-local/448952440c0214b285530725ee9e5e7513666983317ca84fdcaf68c3324ec28d/609337f08f815ee6ebd8b5bb7e695a3d587f744059b51489c84248aba099047a/index.json': '2e79bc7f2ab28f6e4255f9402ee86a4d916c78f59bbaefbdc882d3f300468c99',
    'streams/5517a8bfe97b060bb52e6467e56b225715869c8e8b895dd54ffa48496cab01c9/0-312d810e32dd8d36.m4s': '312d810e32dd8d364cccbb4b2ea1e96c55d3053576bf6299f58a4679bb5d7a66',
    'streams/5517a8bfe97b060bb52e6467e56b225715869c8e8b895dd54ffa48496cab01c9/1-8b7a9f5ffe8ee475.m4s': '8b7a9f5ffe8ee475c119bbda4b033f157e4540456187e3546a57a0b7161c7252',
    'streams/5517a8bfe97b060bb52e6467e56b225715869c8e8b895dd54ffa48496cab01c9/init-a01177ae56eef330.mp4': 'a01177ae56eef330122d54c5a419f0c7843e5dfbeb656f3ceb5c254e91ba238e',
    // The manifest records `version: STREAM_CODE_VERSION`. Render refactor "Ji-1" incremented it from 1
    // to 2, and bytes of this single file changed accordingly (other fields, stream keys, and segments
    // remained unchanged: changing the constant back to 1 still yields the originally recorded
    // 5c074ef83138e314fb829b238eeac62127ebfaac4844ac83d5107d015b66c75e).
    // 2026-10-13 "Sparse Stream 1" modified this entry: the stream manifest records an additional
    // `originFrame` (this stream's own first frame), and `version` followed `STREAM_CODE_VERSION` from 2
    // to 3.
    // "Sparse Stream 1" Phase 2 modified it again: `version` followed `STREAM_CODE_VERSION` from 3 to 4
    // (here storeSegment is called directly without a position rectangle; nowhere else in the manifest
    // changed).
    // 2026-10-17 Stream manifest bucket alignment: the stream manifest records an additional
    // `lastFrame` (this stream's own last frame, used for cross-task 8-segment bucket tail truncation;
    // removing it still yields c25fc173...).
    // Whether a push queue is configured does not affect it; other files are completely unchanged.
    'streams/5517a8bfe97b060bb52e6467e56b225715869c8e8b895dd54ffa48496cab01c9/stream.json': '33b11571683bb2954d727db01a93beafc56c8d95d8fa209940b6299a18161863'
  }
};

async function w6Scenario(A, rootA) {
  const out = {};
  // Shared tier: two batches, the second batch contains one oversized frame
  const shared = snapshotTask({ contentKey: sha256('card-W6-shared'), from: 0, to: 59, fp: FP });
  out.commit1 = wire(await A.snapshots().commitSnapshots({ tier: 'shared', key: shared.resultKey, clipId: 'clip-w6', capabilities: SHARED_CAPS,
    items: range(0, 9).map((n) => ({ localFrame: n, html: htmlOf(n, 'W6') })) }));
  out.commit2 = wire(await A.snapshots().commitSnapshots({ tier: 'shared', key: shared.resultKey, clipId: 'clip-w6', capabilities: SHARED_CAPS,
    items: range(10, 19).map((n) => ({ localFrame: n, html: n === 12 ? bigHtml(n) : htmlOf(n, 'W6') })) }));
  // Local tier
  const entryKey = sha256('entry-W6');
  const local = snapshotTask({ tier: 'local', entryKey, contentKey: sha256('card-W6-local'), from: 0, to: 59, fp: FP, clipId: 'clip-w6l' });
  out.commit3 = wire(await A.snapshots().commitSnapshots({ tier: 'local', entryKey, key: dirKeyOf(local), clipId: 'clip-w6l', capabilities: LOCAL_CAPS,
    items: range(0, 4).map((n) => ({ localFrame: n, html: htmlOf(n, 'W6L') })) }));
  out.staged = A.ready.stagedKeys().map(wire);

  // Stream: storeSegment two segments (the second replaces the sparse version of the first)
  const prod = producerOf(A, 'libx264');
  const streamKey = resultKeyOf(sha256('stream-W6'), FP);
  const spec = { streamKey, contentKey: sha256('stream-W6'), envFingerprint: FP, kind: 'card', plane: 'local', clipIds: ['clip-s'], topClipId: 'clip-s', fps: 30,
    bound: { x: 0, y: 0, w: 64, h: 64 }, offset: { x: 0, y: 0 }, originFrame: 0, firstFrame: 0, lastFrame: 29, firstSegment: 0, lastSegment: 1, total: 30, members: [] };
  const state = { spec, manifest: prod.freshManifest(spec), aliases: new Set(), entryKey, reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set(), generation: 1 };
  prod.streams.set(streamKey, state);
  prod.entryKey = entryKey;
  const rect = { x: 0, y: 0, w: 64, h: 64 };
  const fmp4 = (sizes, fill) => Buffer.concat([makeInit(), makeSegment(sizes, fill)]);
  await prod.storeSegment(state, 1, { segment: 0, stride: 1, rect, encoder: 'libx264', samples: 3, out: { bytes: fmp4([10, 4, 4], 1), encodeMs: 12, tailMs: 3 } });
  await prod.storeSegment(state, 1, { segment: 1, stride: 1, rect, encoder: 'libx264', samples: 2, out: { bytes: fmp4([9, 5], 7), encodeMs: 11, tailMs: 2 } });
  out.streamStats = prod.stats.segments;
  out.stagedAfter = A.ready.stagedKeys().map(wire).sort((a, b) => `${a.kind}${a.key}`.localeCompare(`${b.kind}${b.key}`));

  // On-disk state: sha256 of all files (at in stream.json normalized)
  const tree = await treeOf(rootA);
  out.files = {};
  for (const [rel, buf] of Object.entries(tree).sort(([a], [b]) => a.localeCompare(b))) {
    if (rel.startsWith('controls-lock/')) continue; // Lock store is unrelated to this test
    let bytes = buf;
    if (rel.endsWith('stream.json')) {
      const m = JSON.parse(buf.toString('utf8'));
      for (const s of Object.values(m.segments ?? {})) s.at = 0;
      bytes = Buffer.from(JSON.stringify(m));
    }
    out.files[rel] = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  return out;
}

test('W6 A pipeline without a push queue: the behavior and on-disk content of commitSnapshots and storeSegment are exactly the same as main after C6.2', async (t) => {
  const roots = makeRoots(FramePipeline, 'pc-c64-w6-');
  t.after(() => roots.cleanup());
  const rootA = await roots.root();
  const A = roots.make(rootA, { interactive: true });
  assert.ok(!A.pushQueue, 'No push queue is configured by default');
  const got = await w6Scenario(A, rootA);
  if (process.env.PC_W6_DUMP) console.log(JSON.stringify(got));
  assert.deepEqual(got, GOLDEN, 'Return value, ready index and on-disk content match item by item');
  assert.equal(await readQueueFile(rootA), null, 'No push queue configured: push-queue.json is not written');
  assert.equal(bakeryCalls.length, 0);
});
