/**
 * Manifest ingestion into content store and cross-node deduplication (contract
 * `docs/plan/manifest-contract.md` sections 1 and 3, section 6 test cases U1-U5).
 * Run: node --experimental-test-module-mocks --test server/test/artifact-dedup.test.mjs
 *
 * Written strictly to the contract, without looking at the implementation.
 *
 * Conventions (following the construction method in C6.2 `artifact-transfer.test.mjs`):
 *   - Several temporary frame stores A, B, and C, each with a real `FramePipeline` (injects
 *     `environment`, without probing); `server/bakery/index.mjs` is replaced entirely with a mock
 *     (`mock.module`), recording each time any of its functions is called: "no rendering" means
 *     these counts are 0.
 *   - One asset service (memory, port 0), one document service (content store module, memory,
 *     port 0); clients use C6.2 `createAssetClient` and this stage's `createContentClient`
 *     (via M5a `createWsEndpoint`).
 *   - sink: `createAssetSink({ pipeline, client, content })`; ref carries task `input` and
 *     `requires` (C6.2 section 11 item 3).
 *   - Manifest key `<resultKey>:<from>-<to>`, snapshot kind `snapshot-manifest`, stream kind
 *     `render-manifest` (contract section 1).
 *   - `resultFor(ref)` per contract is "computed on the fly by collect* for local coverage, and
 *     queried from content store to return the recorded manifest", always `await` it here.
 *
 * When implementation modules do not exist yet, each test case fails individually and reports the reason.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
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
const { snapshotDir } = await import('../snapshot-store.mjs');
const F = await import('./fake-artifact-fixtures.mjs');
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const {
  sha256, range, wire, snapshotTask, streamTask, dirKeyOf, manifestKey, refOf, metaOf, seedSnapshots, unpack,
  filesOf, writeStreamFixture, makeRoots, producerOf, startServices, TASK_FP,
} = F;

let transfer = null, transferError = null;
try { transfer = await import('../artifact-transfer.mjs'); } catch (err) { transferError = err; }
let clientMod = null, clientError = null;
try { clientMod = await import('../asset-store/client.mjs'); } catch (err) { clientError = err; }
function T() {
  if (transferError) throw new Error(`Cannot load server/artifact-transfer.mjs: ${transferError.message}`);
  return transfer;
}
function newClient(base) {
  if (clientError) throw new Error(`Cannot load server/asset-store/client.mjs: ${clientError.message}`);
  return clientMod.createAssetClient({ base });
}

const harness = createAssetHarness();
after(() => harness.cleanup());

/** One set per test case: frame store, services; cleaned up in t.after */
async function rig(t) {
  const roots = makeRoots(FramePipeline);
  t.after(() => roots.cleanup());
  const svc = await startServices(harness, newClient);
  t.after(() => svc.cleanup());
  return { roots, svc };
}

/** A produces a segment and pushes it up via sink.put (with content): returns result from sink */
async function produceAndPut(A, svc, task, frames = range(task.range.from, task.range.to)) {
  await seedSnapshots(A, task, frames);
  const sink = T().createAssetSink({ pipeline: A, client: svc.client, content: svc.content });
  const r = await sink.put({ ...refOf(task), artifacts: null, meta: metaOf(task) });
  assert.equal(r.complete, true, `A's sink.put received everything: ${JSON.stringify(r).slice(0, 200)}`);
  return r.result;
}

/**
 * Key appears in content store (writes manifest after sink.put; allow time for implementation to
 * finish writing after response)
 */
async function manifestOf(content, kind, key, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const got = await content.get(kind, key);
    if (got || Date.now() - t0 > ms) return got;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/* ------------------------------------------------------------------ U1 */

test('U1 After A\'s sink put of a segment: the content store has a manifest with key <resultKey>:<from>-<to>, and its body equals result (snapshots and streams)', async (t) => {
  const { roots, svc } = await rig(t);
  const A = roots.make(await roots.root());
  const task = snapshotTask({ contentKey: sha256('card-U1'), from: 60, to: 119 });
  const result = await produceAndPut(A, svc, task);
  assert.equal(manifestKey(task), `${task.resultKey}:60-119`);
  const got = await manifestOf(svc.content, 'snapshot-manifest', manifestKey(task));
  assert.ok(got, `The content store has snapshot-manifest ${manifestKey(task)}`);
  assert.deepEqual(got.body, wire(result), 'The body is exactly the result that sink.put returned');
  assert.deepEqual(got.body, unpack(await T().collectSnapshotResult(A, task)).result, 'That is, the SnapshotResult of C6.2');
  assert.equal(await svc.content.get('render-manifest', manifestKey(task)), null, 'The snapshot manifest does not go into render-manifest');
  const listed = await svc.content.list('snapshot-manifest', `${task.resultKey}:`);
  assert.deepEqual(listed.items.map((i) => i.key), [manifestKey(task)], 'Only this segment\'s key was written, with no single key for the whole card');

  // Local tier: key uses the task's resultKey (not the dirKey written to disk)
  const entryKey = sha256('entry-U1');
  const local = snapshotTask({ tier: 'local', entryKey, contentKey: sha256('card-U1-local'), from: 0, to: 19, clipId: 'clip-l' });
  assert.notEqual(local.resultKey, dirKeyOf(local));
  const localResult = await produceAndPut(A, svc, local);
  const gotLocal = await manifestOf(svc.content, 'snapshot-manifest', manifestKey(local));
  assert.ok(gotLocal, `The local tier's manifest key is <resultKey>:<from>-<to>: ${manifestKey(local)}`);
  assert.deepEqual(gotLocal.body, wire(localResult));
  assert.equal(await svc.content.get('snapshot-manifest', `${dirKeyOf(local)}:0-19`), null, 'No key is produced from dirKey');

  // Stream: render-manifest
  const S = roots.make(await roots.root(), { interactive: true });
  const contentKey = sha256('stream-U1');
  const streamKey = resultKeyOf(contentKey, TASK_FP);
  await writeStreamFixture(S.root, { streamKey, segments: [0, 1, 2, 3, 4, 5, 6, 7] });
  const st = streamTask({ streamKey, contentKey, from: 0, to: 7 });
  const ssink = T().createAssetSink({ pipeline: S, client: svc.client, content: svc.content });
  const rs = await ssink.put({ ...refOf(st), artifacts: null, meta: metaOf(st) });
  assert.equal(rs.complete, true);
  const gotStream = await manifestOf(svc.content, 'render-manifest', manifestKey(st));
  assert.ok(gotStream, `The content store has render-manifest ${manifestKey(st)}`);
  assert.deepEqual(gotStream.body, wire(rs.result));
  assert.equal(gotStream.body.kind, 'stream');
});

test('U1 A manifest write failure is only logged and does not affect { complete: true, result }; with no content given, no manifest is written (C6.2 behavior)', async (t) => {
  const { roots, svc } = await rig(t);
  const A = roots.make(await roots.root());
  const task = snapshotTask({ contentKey: sha256('card-U1b'), from: 0, to: 59 });
  await seedSnapshots(A, task, range(0, 59));
  const broken = {
    put: async () => { throw Object.assign(new Error('docservice down'), { code: 'disconnected' }); },
    get: async () => null,
    list: async () => ({ items: [], truncated: false }),
  };
  const r = await T().createAssetSink({ pipeline: A, client: svc.client, content: broken }).put({ ...refOf(task), artifacts: null, meta: metaOf(task) });
  assert.equal(r.complete, true, 'A manifest write failure does not affect completion');
  assert.deepEqual(wire(r.result), unpack(await T().collectSnapshotResult(A, task)).result);
  for (const [n, h] of r.result.frames) assert.ok(await svc.client.has('snap', h), `The chunk of frame ${n} was pushed`);

  const other = snapshotTask({ contentKey: sha256('card-U1c'), from: 0, to: 59 });
  await seedSnapshots(A, other, range(0, 59));
  const r2 = await T().createAssetSink({ pipeline: A, client: svc.client }).put({ ...refOf(other), artifacts: null, meta: metaOf(other) });
  assert.equal(r2.complete, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await svc.content.get('snapshot-manifest', manifestKey(other)), null, 'No content given: no manifest is written');
});

/* ------------------------------------------------------------------ U2 */

test('U2 B does not have it locally, but the content store has the manifest and all chunks are present: has is true and resultFor returns exactly this manifest; B did not render and did not write the frame store', async (t) => {
  const { roots, svc } = await rig(t);
  const A = roots.make(await roots.root());
  const rootB = await roots.root();
  const B = roots.make(rootB);
  const task = snapshotTask({ contentKey: sha256('card-U2'), from: 0, to: 59 });
  const result = await produceAndPut(A, svc, task);
  assert.ok(await manifestOf(svc.content, 'snapshot-manifest', manifestKey(task)), 'Fixture: the manifest is in the content store');

  const before = bakeryCalls.length;
  const contentB = await svc.another('node-b');
  const sinkB = T().createAssetSink({ pipeline: B, client: svc.client, content: contentB });
  const noContent = T().createAssetSink({ pipeline: B, client: svc.client });
  assert.equal(await noContent.has(refOf(task)), false, 'Fixture: with no content given, B does not have it locally → false');
  assert.equal(await sinkB.has(refOf(task)), true, 'Manifest present, all chunks present, covers the whole segment → true');
  assert.equal(typeof sinkB.resultFor, 'function', 'sink provides resultFor(ref)');
  const got = await sinkB.resultFor(refOf(task));
  assert.deepEqual(wire(got), wire(result), 'resultFor returns exactly that manifest from the content store');
  assert.equal(bakeryCalls.length, before, 'B called no rendering at all');
  assert.deepEqual(await filesOf(snapshotDir(rootB, { tier: 'shared', key: task.resultKey })), {}, 'has only checks and does not fetch: B\'s frame store was not written');

  // A itself (local coverage): resultFor is computed on the fly by collect*
  const sinkA = T().createAssetSink({ pipeline: A, client: svc.client, content: svc.content });
  assert.equal(await sinkA.has(refOf(task)), true);
  assert.deepEqual(wire(await sinkA.resultFor(refOf(task))), unpack(await T().collectSnapshotResult(A, task)).result, 'Covered locally: collect* computes it on the spot');

  // Same for stream: render-manifest + chunks in px
  const S = roots.make(await roots.root(), { interactive: true });
  const contentKey = sha256('stream-U2');
  const streamKey = resultKeyOf(contentKey, TASK_FP);
  await writeStreamFixture(S.root, { streamKey, segments: range(8, 15) });
  const st = streamTask({ streamKey, contentKey, from: 8, to: 15 });
  const rs = await T().createAssetSink({ pipeline: S, client: svc.client, content: svc.content }).put({ ...refOf(st), artifacts: null, meta: metaOf(st) });
  assert.equal(rs.complete, true);
  await manifestOf(svc.content, 'render-manifest', manifestKey(st));
  const BS = roots.make(await roots.root(), { interactive: true });
  producerOf(BS);
  const sinkBS = T().createAssetSink({ pipeline: BS, client: svc.client, content: contentB });
  assert.equal(await sinkBS.has(refOf(st)), true, 'Stream: manifest present, all chunks present → true');
  assert.deepEqual(wire(await sinkBS.resultFor(refOf(st))), wire(rs.result));
  assert.equal(bakeryCalls.length, before, 'The stream did not render either');
});

test('U2 Wired into the local node (local-node): B claims this segment, completes it via dedup, and the executor is never called', async (t) => {
  const { roots, svc } = await rig(t);
  const A = roots.make(await roots.root());
  const B = roots.make(await roots.root());
  const task = snapshotTask({ contentKey: sha256('card-U2-node'), from: 0, to: 59 });
  await produceAndPut(A, svc, task);
  assert.ok(await manifestOf(svc.content, 'snapshot-manifest', manifestKey(task)));

  const { createRenderQueue } = await import('../render-queue/index.mjs');
  const { createLocalNode } = await import('../render-node/local-node.mjs');
  const { createLoopback } = await import('./fake-loopback-transport.mjs');
  const { createFakeExecutor, createTimerClock } = await import('./fake-render-executor.mjs');
  const clock = createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: 'epoch-u2' });
  lb.attach(queue);
  const exec = createFakeExecutor({ clock, planContext: () => { throw new Error('U2 does not plan'); } });

  const page = lb.connect('conn-page', { userId: 'u1', tenantId: 't1' });
  const inbox = [];
  page.onMessage((m) => inbox.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page-u2' });
  const { state, version, attempts, ...input } = task;
  void state; void version; void attempts;
  page.send({ type: 'task.publish', tasks: [{ ...input, source: { projectId: 'p1', projectRev: 1 } }] });

  const events = [];
  const contentB = await svc.another('node-b');
  const node = createLocalNode({
    nodeId: 'node-b',
    node: { profile: 'pc', userId: 'u9', envFingerprint: TASK_FP, codeVersions: ['c'], cardSourceVersions: {},
      capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 16_000 } },
    endpoint: lb.connect('conn-node-b', { userId: 'u9', tenantId: 't1' }),
    now: clock.now, random: () => 0.5, isIdle: () => true, maxConcurrent: 1, codeVersion: 'c',
    executor: exec.forNode('node-b'),
    sink: T().createAssetSink({ pipeline: B, client: svc.client, content: contentB }),
    onEvent: (e) => events.push(e),
  });
  node.start();
  const done = () => inbox.find((m) => m.type === 'task.done' && m.id === task.id);
  const t0 = Date.now();
  while (!done() && Date.now() - t0 < 15_000) {
    lb.flush();
    node.tick();
    lb.flush();
    queue.tick();
    lb.flush();
    await new Promise((resolve) => setTimeout(resolve, 5)); // sink.has goes over real network; give it real time
    clock.advance(200);
  }
  node.stop();
  lb.flush();
  assert.ok(done(), `The page received task.done: ${JSON.stringify(inbox.map((m) => m.type))}; node events: ${JSON.stringify(events).slice(0, 600)}`);
  assert.equal(exec.calls({ kind: 'render' }).length, 0, 'B did not call the executor');
  assert.ok(events.some((e) => e.type === 'dedup' && e.id === task.id), `Completed via dedup: ${JSON.stringify(events).slice(0, 400)}`);
  assert.deepEqual(lb.errors().map((e) => String(e?.stack ?? e)), [], 'The endpoint handler threw no exception');
});

/* ------------------------------------------------------------------ U3 */

test('U3 The manifest is present but one chunk is missing (deleted from the asset service): has is false', async (t) => {
  const { roots, svc } = await rig(t);
  const A = roots.make(await roots.root());
  const B = roots.make(await roots.root());
  const task = snapshotTask({ contentKey: sha256('card-U3'), from: 0, to: 59 });
  const result = await produceAndPut(A, svc, task);
  assert.ok(await manifestOf(svc.content, 'snapshot-manifest', manifestKey(task)));
  const sinkB = T().createAssetSink({ pipeline: B, client: svc.client, content: await svc.another('node-b') });
  assert.equal(await sinkB.has(refOf(task)), true, 'Fixture: true before the deletion');

  const lost = result.frames.find(([n]) => n === 41)[1];
  assert.equal(await svc.srv.stores.snap.remove(lost), true, 'Fixture: delete frame 41\'s chunk from snap');
  assert.equal(await svc.client.has('snap', lost), false);
  const sinkB2 = T().createAssetSink({ pipeline: B, client: svc.client, content: await svc.another('node-c') });
  assert.equal(await sinkB2.has(refOf(task)), false, 'One chunk missing → false');

  // Stream: delete chunks of a segment
  const S = roots.make(await roots.root(), { interactive: true });
  const contentKey = sha256('stream-U3');
  const streamKey = resultKeyOf(contentKey, TASK_FP);
  await writeStreamFixture(S.root, { streamKey, segments: range(0, 7) });
  const st = streamTask({ streamKey, contentKey, from: 0, to: 7 });
  const rs = await T().createAssetSink({ pipeline: S, client: svc.client, content: svc.content }).put({ ...refOf(st), artifacts: null, meta: metaOf(st) });
  assert.equal(rs.complete, true);
  await manifestOf(svc.content, 'render-manifest', manifestKey(st));
  const BS = roots.make(await roots.root(), { interactive: true });
  producerOf(BS);
  await svc.srv.stores.px.remove(rs.result.segments[5].hash);
  assert.equal(await T().createAssetSink({ pipeline: BS, client: svc.client, content: svc.content }).has(refOf(st)), false, 'Stream missing one segment\'s chunk → false');
});

/* ------------------------------------------------------------------ U4 */

test('U4 The manifest covers only some frames (all chunks present): has is false', async (t) => {
  const { roots, svc } = await rig(t);
  const A = roots.make(await roots.root());
  const B = roots.make(await roots.root());
  const task = snapshotTask({ contentKey: sha256('card-U4'), from: 0, to: 59 });
  // A only has 0~29: its own sink.put returns complete: false and does not write manifest;
  // manually write "partial manifest" into content store here
  await seedSnapshots(A, task, range(0, 29));
  const partial = unpack(await T().collectSnapshotResult(A, task));
  assert.equal(partial.result.frames.length, 30, 'Fixture: the manifest has only 30 frames');
  await T().pushResult(svc.client, partial.raw, partial.readBlob);
  await svc.content.put('snapshot-manifest', manifestKey(task), partial.result);
  const sinkB = T().createAssetSink({ pipeline: B, client: svc.client, content: svc.content });
  assert.equal(await sinkB.has(refOf(task)), false, 'The manifest does not cover 30-59 → false');
  // Only query the covered segment (another key): key not in content store → false; not on this machine → false
  assert.equal(await sinkB.has(refOf(snapshotTask({ contentKey: sha256('card-U4'), from: 0, to: 29 }))), false, 'A different key cannot be found');

  // The manifest range says full segment and frames are fully listed, but a middle frame
  // is missing (frame 17 not in frames)
  const holey = { ...partial.result, frames: [] };
  await seedSnapshots(A, task, range(30, 59));
  const full = unpack(await T().collectSnapshotResult(A, task));
  await T().pushResult(svc.client, full.raw, full.readBlob);
  holey.frames = full.result.frames.filter(([n]) => n !== 17);
  await svc.content.put('snapshot-manifest', manifestKey(task), holey);
  assert.equal(await T().createAssetSink({ pipeline: B, client: svc.client, content: svc.content }).has(refOf(task)), false, 'One frame missing in the middle → false');
  // After completing → true (confirm that the two false results above were not due to other reasons)
  await svc.content.put('snapshot-manifest', manifestKey(task), full.result);
  assert.equal(await T().createAssetSink({ pipeline: B, client: svc.client, content: svc.content }).has(refOf(task)), true, 'Manifest complete → true');

  // Stream: manifest is missing a segment number
  const S = roots.make(await roots.root(), { interactive: true });
  const contentKey = sha256('stream-U4');
  const streamKey = resultKeyOf(contentKey, TASK_FP);
  await writeStreamFixture(S.root, { streamKey, segments: [0, 1, 2, 3, 5, 6, 7] });
  const st = streamTask({ streamKey, contentKey, from: 0, to: 7 });
  const sr = unpack(await T().collectStreamResult(S, st));
  await T().pushResult(svc.client, sr.raw, sr.readBlob);
  await svc.content.put('render-manifest', manifestKey(st), sr.result);
  const BS = roots.make(await roots.root(), { interactive: true });
  producerOf(BS);
  assert.equal(await T().createAssetSink({ pipeline: BS, client: svc.client, content: svc.content }).has(refOf(st)), false, 'Stream missing segment 4 → false');
});

/* ------------------------------------------------------------------ U5 */

test('U5 Two segments of the same card, one produced by A and one by B: both keys are in the content store and do not overwrite each other; a third machine C fetches both segments and can fetch them completely', async (t) => {
  const { roots, svc } = await rig(t);
  const rootA = await roots.root(), rootB = await roots.root(), rootC = await roots.root();
  const A = roots.make(rootA), B = roots.make(rootB), C = roots.make(rootC);
  const contentKey = sha256('card-U5');
  const seg1 = snapshotTask({ contentKey, from: 0, to: 59 });
  const seg2 = snapshotTask({ contentKey, from: 60, to: 119 });
  assert.equal(seg1.resultKey, seg2.resultKey, 'Same card: same resultKey');

  const contentA = svc.content;
  const contentB = await svc.another('node-b');
  await seedSnapshots(A, seg1, range(0, 59), { tag: 'A' });
  await seedSnapshots(B, seg2, range(60, 119), { tag: 'B' });
  // Two nodes push concurrently
  const [r1, r2] = await Promise.all([
    T().createAssetSink({ pipeline: A, client: svc.client, content: contentA }).put({ ...refOf(seg1), artifacts: null, meta: metaOf(seg1) }),
    T().createAssetSink({ pipeline: B, client: svc.client, content: contentB }).put({ ...refOf(seg2), artifacts: null, meta: metaOf(seg2) }),
  ]);
  assert.equal(r1.complete, true);
  assert.equal(r2.complete, true);
  const m1 = await manifestOf(svc.content, 'snapshot-manifest', manifestKey(seg1));
  const m2 = await manifestOf(svc.content, 'snapshot-manifest', manifestKey(seg2));
  assert.ok(m1 && m2, `Both keys are present: ${manifestKey(seg1)}, ${manifestKey(seg2)}`);
  assert.deepEqual(m1.body, wire(r1.result), 'The first segment was written by A and not overwritten by B');
  assert.deepEqual(m2.body, wire(r2.result), 'The second segment was written by B');
  assert.deepEqual(m1.body.frames.map(([n]) => n), range(0, 59));
  assert.deepEqual(m2.body.frames.map(([n]) => n), range(60, 119));
  const listed = await svc.content.list('snapshot-manifest', `${seg1.resultKey}:`);
  assert.deepEqual(listed.items.map((i) => i.key).sort(), [manifestKey(seg1), manifestKey(seg2)].sort());

  // C: check manifest by key, pull two segments
  const contentC = await svc.another('node-c');
  const sinkC = T().createAssetSink({ pipeline: C, client: svc.client, content: contentC });
  for (const seg of [seg1, seg2]) assert.equal(await sinkC.has(refOf(seg)), true, `C can find ${manifestKey(seg)} and all chunks are present`);
  for (const seg of [seg1, seg2]) {
    const got = await contentC.get('snapshot-manifest', manifestKey(seg));
    const out = await T().applyResult(C, svc.client, got.body);
    assert.equal(out.fetched, 60, `${manifestKey(seg)}: fetched 60 chunks`);
  }
  const dirOf = (root) => snapshotDir(root, { tier: 'shared', key: seg1.resultKey });
  const fa = await filesOf(dirOf(rootA)), fb = await filesOf(dirOf(rootB)), fc = await filesOf(dirOf(rootC));
  for (const n of range(0, 59)) assert.ok(fc[`${n}.html`]?.equals(fa[`${n}.html`]), `C's frame ${n} matches A`);
  for (const n of range(60, 119)) assert.ok(fc[`${n}.html`]?.equals(fb[`${n}.html`]), `C's frame ${n} matches B`);
  const idx = await C.snapshots().snapshotIndex({ tier: 'shared', key: seg1.resultKey });
  assert.deepEqual(idx.frames, [[0, 119]], 'C fetched both segments completely');
  // After pulling, C covers it locally
  const plain = T().createAssetSink({ pipeline: C, client: svc.client });
  for (const seg of [seg1, seg2]) assert.equal(await plain.has(refOf(seg)), true);
});
