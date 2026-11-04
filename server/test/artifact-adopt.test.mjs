/**
 * Cross-machine adoption (contract `docs/plan/manifest-contract.md` section 5, section 6 test cases A1-A2).
 * Run: node --experimental-test-module-mocks --test server/test/artifact-adopt.test.mjs
 *
 * Written strictly to the contract, without looking at the implementation.
 *
 * Conventions:
 *   - Two temporary frame stores A and B, each with a real `FramePipeline` (same environment
 *     fingerprint: contract W3 "two machines have the same fingerprint, so keys are completely
 *     identical"); `bakery/index.mjs` is replaced with a mock, recording each time its functions
 *     are called: "B did not call any rendering" means the count is 0.
 *   - Asset service (memory, port 0), document service (content store, memory, port 0), same as
 *     `artifact-dedup.test.mjs`.
 *   - Handcraft card plan per the control shape in `card-cache.mjs` (`clipId`, `snapshotKey`,
 *     `contentKey`, `envFingerprint`, `tier`, `capabilities`, `count`, `sampling`); A's "prerender"
 *     writes directly to the frame store via `commitSnapshots`.
 *   - A's "done pushing": slice out fine-grained tasks per `splitPlan` in `split.mjs` (resultKey
 *     and range strictly identical to queue), each task `collect*` → `pushResult` →
 *     `content.put(<kind>, '<resultKey>:<from>-<to>', result)`. This way, this file only depends
 *     on C6.2 push functions and content store client, not on push queue.
 *   - B: the same card plan (entry deep-copied) mounted into `B.entries`, a page session subscribes
 *     to this version; call `B.adoptFromManifests(entry, content, client)`.
 *   - Stream (A1 second case): B is `interactive: true`, read port connected, encoder name fixed
 *     (without probing). A's stream is handcrafted per `frame-stream.mjs` format, keys calculated
 *     using `planStreams(entry, { envFingerprint, codeVersion: '<STREAM_CODE_VERSION>:' })`
 *     (pipeline default `captureCode()` is empty).
 *
 * When implementations do not exist yet, each test case fails individually and reports the reason.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
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
const { snapshotDir } = await import('../snapshot-store.mjs');
const { planStreams, STREAM_CODE_VERSION } = await import('../frame-stream.mjs');
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const { splitPlan, planTaskOf } = await import('../render-node/split.mjs');
const F = await import('./fake-artifact-fixtures.mjs');
const E = await import('./fake-manifest-env.mjs');
const {
  sha256, range, htmlOf, unpack, treeOf, filesOf, makeRoots, startServices, producerOf, watchEntry, staged, writeStreamFixture,
  OWN_ENV, SHARED_CAPS, LOCAL_CAPS,
} = F;
const { countingAsset, countingContent } = E;

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
function adopt(pipeline, entry, content, client) {
  assert.equal(typeof pipeline.adoptFromManifests, 'function', 'FramePipeline must have adoptFromManifests(entry, content, client)');
  return pipeline.adoptFromManifests(entry, content, client);
}

const harness = createAssetHarness();
after(() => harness.cleanup());

const FP = OWN_ENV.fingerprint;
const ENTRY_KEY = sha256('entry-adopt');

async function rig(t) {
  const roots = makeRoots(FramePipeline, 'pc-c64-adopt-');
  t.after(() => roots.cleanup());
  const svc = await startServices(harness, newClient);
  t.after(() => svc.cleanup());
  return { roots, svc };
}

/** card plan: one shared tier card (130 frames, 3 segments), one local tier card (70 frames, 2 segments) */
function snapshotPlan() {
  const sharedKey = sha256('card-adopt-shared');
  const localKey = sha256('card-adopt-local');
  return [
    { clipId: 'clip-a', key: 'png-a', snapshotKey: resultKeyOf(sharedKey, FP), contentKey: sharedKey, envFingerprint: FP, tier: 'shared',
      capabilities: SHARED_CAPS, compositing: 'independent', count: 130, sampling: { firstFrame: 0 } },
    { clipId: 'clip-l', key: 'png-l', snapshotKey: resultKeyOf(localKey, FP), contentKey: localKey, envFingerprint: FP, tier: 'local',
      capabilities: LOCAL_CAPS, compositing: 'belowDependent', count: 70, sampling: { firstFrame: 0 } },
  ];
}
const entryOf = (cardPlan, project = { fps: 30, width: 1920, height: 1080, duration: 10, tracks: [] }) => ({ key: ENTRY_KEY, project, cardPlan, status: 'ready' });
const cloneEntry = (entry) => ({ ...entry, project: structuredClone(entry.project), cardPlan: structuredClone(entry.cardPlan) });
const targetOf = (control) => ({ tier: control.tier, entryKey: control.tier === 'local' ? ENTRY_KEY : null, key: control.snapshotKey });

/** A's "prerender": each card writes these frames into the frame store */
async function prerender(A, cardPlan, framesOf = (c) => range(0, c.count - 1)) {
  for (const c of cardPlan) {
    const frames = framesOf(c);
    if (!frames.length) continue;
    await A.snapshots().commitSnapshots({ ...targetOf(c), clipId: c.clipId, capabilities: c.capabilities,
      items: frames.map((n) => ({ localFrame: n, html: htmlOf(n, `${c.clipId}`) })) });
  }
}

/** Slice out fine-grained tasks for this version per split.mjs (strictly identical to queue) */
function tasksOf(entry, streams = []) {
  return splitPlan({ planTask: planTaskOf({ projectId: 'p-adopt', projectRev: 1 }), entryKey: entry.key, cardPlan: entry.cardPlan, streams,
    envFingerprint: FP, codeVersion: 'c' });
}

/** A pushes a fine-grained task and writes the manifest; returns the manifest */
async function pushTask(A, svc, task) {
  const out = unpack(task.kind === 'stream' ? await T().collectStreamResult(A, task) : await T().collectSnapshotResult(A, task));
  await T().pushResult(svc.client, out.raw, out.readBlob);
  const kind = task.kind === 'stream' ? 'render-manifest' : 'snapshot-manifest';
  await svc.content.put(kind, `${task.resultKey}:${task.range.from}-${task.range.to}`, out.result);
  return out.result;
}

/* ------------------------------------------------------------------ A1 */

test('A1 A finishes prerendering and pushing; B calls adoptFromManifests with the same card plan: the frame store is byte-for-byte identical to A\'s, the ready index publishes the corresponding layer, and B calls no rendering at all', async (t) => {
  const { roots, svc } = await rig(t);
  const rootA = await roots.root(), rootB = await roots.root();
  const A = roots.make(rootA), B = roots.make(rootB);
  const plan = snapshotPlan();
  const entryA = entryOf(plan);
  await prerender(A, plan);
  const tasks = tasksOf(entryA);
  assert.deepEqual(tasks.map((x) => `${x.tier}:${x.range.from}-${x.range.to}`), ['shared:0-59', 'shared:60-119', 'shared:120-129', 'local:0-59', 'local:60-69'], 'Fixture: 5 segments');
  assert.equal(tasks[0].resultKey, plan[0].snapshotKey, 'Shared tier resultKey = snapshotKey');
  assert.equal(tasks[3].resultKey, resultKeyOf(`${ENTRY_KEY}/${plan[1].contentKey}`, FP), 'Local tier resultKey follows E.9');
  let blocks = 0;
  for (const task of tasks) blocks += (await pushTask(A, svc, task)).frames.length;
  assert.equal(blocks, 200);

  const entryB = cloneEntry(entryA);
  const watch = watchEntry(B, entryB);
  const before = bakeryCalls.length;
  const asset = countingAsset(svc.client);
  const contentB = countingContent(await svc.another('node-b'));
  const out = await adopt(B, entryB, contentB, asset);
  // Ji-2: snapshot has been withdrawn, adoptFromManifests no longer pulls the snapshot manifest
  assert.deepEqual({ manifests: out?.manifests, fetched: out?.fetched, written: out?.written }, { manifests: 0, fetched: 0, written: 0 },
    `Returns { manifests, fetched, written }: ${JSON.stringify(out)}`);
  assert.equal(asset.puts.length, 0, 'Adopting does not upload');
  assert.equal(bakeryCalls.length, before, 'B called no rendering at all');

  // Call again: skipped on this machine
  const again = await adopt(B, entryB, await svc.another('node-b2'), countingAsset(svc.client));
  assert.equal(again.fetched, 0, 'Nothing is fetched again');
  assert.equal(again.written, 0);
});

test('A1 stream: A finishes pushing a track stream; B calls adoptFromManifests to fetch all of its segments and publish the stream range, without rendering', async (t) => {
  const { roots, svc } = await rig(t);
  const rootA = await roots.root(), rootB = await roots.root();
  const A = roots.make(rootA, { interactive: true });
  const B = roots.make(rootB, { interactive: true });
  // A card that can enter the stream: independent, on a visible track, has cardId; 45 frames → segments 0..2
  const contentKey = sha256('card-adopt-stream');
  const control = { clipId: 'clip-s', key: 'png-s', snapshotKey: resultKeyOf(contentKey, FP), contentKey, envFingerprint: FP, tier: 'shared',
    capabilities: SHARED_CAPS, compositing: 'independent', count: 45, sampling: { firstFrame: 0 } };
  const project = { fps: 30, width: 1920, height: 1080, duration: 2, media: [],
    tracks: [{ id: 't1', clips: [{ id: 'clip-s', cardId: 'demo-card', start: 0, end: 1.5 }] }] };
  const entryA = entryOf([control], project);
  const specs = planStreams(entryA, { envFingerprint: FP, codeVersion: `${STREAM_CODE_VERSION}:` });
  assert.equal(specs.length, 1, `Fixture: one stream ${JSON.stringify(specs.map((s) => [s.streamKey?.slice(0, 8), s.firstSegment, s.lastSegment]))}`);
  const spec = specs[0];
  const streamTasks = tasksOf(entryA, specs).filter((x) => x.kind === 'stream');
  assert.equal(streamTasks.length, 1);
  assert.equal(streamTasks[0].resultKey, spec.streamKey, 'The stream task\'s resultKey = streamKey');
  const segs = range(spec.firstSegment, spec.lastSegment);
  const fx = await writeStreamFixture(rootA, { streamKey: spec.streamKey, segments: segs });
  producerOf(A);
  const result = await pushTask(A, svc, streamTasks[0]);
  assert.deepEqual(Object.keys(result.segments).map(Number).sort((a, b) => a - b), segs);

  const entryB = cloneEntry(entryA);
  const prodB = producerOf(B);
  watchEntry(B, entryB);
  const before = bakeryCalls.length;
  const out = await adopt(B, entryB, await svc.another('node-b'), svc.client);
  assert.ok(out.manifests >= 1, `Found the stream's manifest: ${JSON.stringify(out)}`);
  const dirB = path.join(rootB, 'streams', spec.streamKey);
  const fb = await filesOf(dirB);
  for (const [name, buf] of Object.entries(fx.files)) assert.ok(fb[name]?.equals(buf), `B has ${name}, identical to A`);
  const state = prodB.streams.get(spec.streamKey);
  assert.ok(state?.manifest, 'The manifest was merged into B\'s producer state');
  for (const n of segs) {
    assert.equal(state.manifest.segments[n]?.adopted, true, `Segment ${n} is marked adopted`);
    assert.notEqual(prodB.segmentState(state, n), 'stale', `Segment ${n} is not judged stale on B`);
  }
  assert.deepEqual(staged(B, 'stream', spec.streamKey)?.ranges, [[spec.firstSegment, spec.lastSegment]], `The ready index has the stream attached: ${JSON.stringify(B.ready.stagedKeys())}`);
  assert.equal(bakeryCalls.length, before, 'B called no rendering at all');
});

/* ------------------------------------------------------------------ A2 */

test('A2 Some segments are not in the content store and some already exist locally: only those that are in the content store and missing locally are fetched, and the returned counts are correct', async (t) => {
  const { roots, svc } = await rig(t);
  const rootA = await roots.root(), rootB = await roots.root();
  const A = roots.make(rootA), B = roots.make(rootB);
  const plan = snapshotPlan();
  const entryA = entryOf(plan);
  await prerender(A, plan);
  const tasks = tasksOf(entryA);
  const byName = Object.fromEntries(tasks.map((x) => [`${x.tier}:${x.range.from}-${x.range.to}`, x]));
  // In content store: shared tier 0-59, 120-129, local tier 60-69; missing: shared tier 60-119, local tier 0-59
  const pushed = {};
  for (const name of ['shared:0-59', 'shared:120-129', 'local:60-69']) pushed[name] = await pushTask(A, svc, byName[name]);
  // B already has shared tier 0-59 locally (same content as A)
  await B.snapshots().commitSnapshots({ ...targetOf(plan[0]), clipId: 'clip-a', capabilities: SHARED_CAPS,
    items: range(0, 59).map((n) => ({ localFrame: n, html: htmlOf(n, 'clip-a') })) });

  const entryB = cloneEntry(entryA);
  watchEntry(B, entryB);
  const asset = countingAsset(svc.client);
  const before = bakeryCalls.length;
  const out = await adopt(B, entryB, await svc.another('node-b'), asset);
  // Ji-2: snapshot has been withdrawn, adoptFromManifests no longer pulls the snapshot manifest
  assert.deepEqual({ manifests: out?.manifests, fetched: out?.fetched, written: out?.written }, { manifests: 0, fetched: 0, written: 0 },
    `Returns { manifests, fetched, written }: ${JSON.stringify(out)}`);
  assert.equal(asset.gets.length, 0);

  const idxShared = await B.snapshots().snapshotIndex(targetOf(plan[0]));
  assert.deepEqual(idxShared.frames, [[0, 59]], 'Shared tier: only the 0-59 that already existed locally, and snapshots are no longer fetched from the remote');
  const idxLocal = await B.snapshots().snapshotIndex(targetOf(plan[1]));
  assert.deepEqual(idxLocal.frames, [], 'Local tier: snapshots are no longer fetched');
  const fa = await filesOf(snapshotDir(rootA, targetOf(plan[0]))), fb = await filesOf(snapshotDir(rootB, targetOf(plan[0])));
  for (const n of range(0, 59)) assert.ok(fb[`${n}.html`]?.equals(fa[`${n}.html`]), `Frame ${n} matches A`);
  assert.equal(fb['120.html'], undefined, 'Snapshots are no longer fetched');
  assert.equal(fb['60.html'], undefined, 'Segments not in the content store are not fetched');
  assert.equal(bakeryCalls.length, before, 'adoptFromManifests itself does not render');
});
