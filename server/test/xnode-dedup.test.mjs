/**
 * Cross-node deduplication: after document service restarts, when a segment completed by another
 * node with both tiers already in asset service is claimed by another node, it completes via
 * deduplication (`docs/archive/agent-reports/AGENT-xnode-dedup.md`; semantics in
 * `mechanism/document-service.md` "Render queue": "Results already in the asset service do not need
 * to be redone"; `product/rendering.md` "Two tiers": render nodes produce small size alongside
 * original size, and push both tiers to asset service).
 * Run: node --experimental-test-module-mocks --test server/test/xnode-dedup.test.mjs
 *
 * Scenario (M8 E3 on local, run `m8e3lanM` / `xdA1`): host-a finishes a segment, PC receives
 * `task.done` and pulls original size into the local frame store by manifest (`applyResult` only
 * pulls original size and PNG, not small size); after LAN host restarts, PC claims this segment:
 * local frame store "covers" the whole segment, but lacks small size.
 *
 *   X1  Local coverage, missing small size; manifest written by another node in content store has
 *       both tiers ready and chunks present: has returns true (deduplication), resultFor returns
 *       that manifest, pushing no chunks at all
 *   X2  Same as above, but manifest lacks small size (producer did not generate small size): has
 *       returns false, records sink.has-miss { reason: 'local-small-missing' }
 *       : handed over to executor to draw missing small size from local original size (no re-render
 *       of original size)
 *   X3  Same as above, manifest has both tiers ready, but asset service is missing one small
 *       bitmap: has returns false, records sink.has-miss { reason: 'blocks-missing', missing: 1 }
 *   X4  Other reasons for sink.has-miss: manifest missing, mismatch, incomplete, error fetching
 *       manifest (diagnostics; no behavior change)
 *   X5  Standalone render host pipeline (without push queue) enables small size (`enableSmallTier`):
 *       records small size for this batch as usual after commitSnapshots, without entering push
 *       queue and without opening Chrome; `PROMPTCUT_SMALL_TIER=0` can still disable it
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

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

const { createAssetSink, manifestKeyOf } = await import('../artifact-transfer.mjs');
const { FramePipeline } = await import('../frame-pipeline.mjs');
const { describeEnvironment } = await import('../render-node/fingerprint.mjs');
const { SMALL_SUFFIX } = await import('../bakery/small-bitmap.mjs');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const RESULT_KEY = sha256('rk:xnode-dedup');
const refOf = (from, to) => ({ kind: 'snapshot', tier: 'shared', resultKey: RESULT_KEY, range: { unit: 'localFrame', from, to } });
const htmlOf = (f) => Buffer.from(`<div>frame ${f}</div>`);
const smallOf = (f) => Buffer.from(`RIFF-small-${f}`);

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) { try { await c(); } catch { /* Cleanup failure does not affect outcome */ } } });

/**
 * PC frame store mock: original size written via `write`, small size written via `writeSmall`
 * (pulled frames lack small size); `smallTier` determines whether the pipeline enabled small size
 * (PC configured with push queue = enabled).
 */
function frameLibrary({ smallTier = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-xnode-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const index = { frames: [], oversize: [] };
  return {
    root,
    write(from, to) {
      for (let f = from; f <= to; f++) fs.writeFileSync(path.join(root, `${f}.html`), htmlOf(f));
      index.frames = [[from, to]];
    },
    writeSmall(from, to) { for (let f = from; f <= to; f++) fs.writeFileSync(path.join(root, `${f}${SMALL_SUFFIX}`), smallOf(f)); },
    pipeline: {
      snapshots: () => ({ snapshotIndex: async () => ({ frames: index.frames.map((r) => [...r]), oversize: [] }), dir: () => root }),
      whenSmallSettled: async () => {},
      smallTierEnabled: () => smallTier,
    },
  };
}

/** Asset service mock (content-addressed) */
function assetStore() {
  const blocks = new Map();
  const calls = { put: 0, uploaded: 0, has: 0 };
  return {
    blocks, calls,
    preload(bufs) { for (const b of bufs) blocks.set(sha256(b), b); },
    async put(ns, bytes) {
      calls.put += 1;
      const hash = sha256(bytes);
      if (blocks.has(hash)) return { hash, size: bytes.length, uploaded: false };
      calls.uploaded += 1;
      blocks.set(hash, Buffer.from(bytes));
      return { hash, size: bytes.length, uploaded: true };
    },
    async has(ns, hash) { calls.has += 1; return blocks.has(hash); },
  };
}

function contentStore({ failGet = false } = {}) {
  const items = new Map();
  return {
    items,
    async put(kind, key, body) { items.set(`${kind}|${key}`, structuredClone(body)); },
    async get(kind, key) {
      if (failGet) throw Object.assign(new Error('Content store content.get: connection disconnected'), { code: 'disconnected' });
      const body = items.get(`${kind}|${key}`);
      return body ? { body: structuredClone(body) } : null;
    },
  };
}

/** Manifest written to content store after output and push by another node (host-a): original size + (optional) small size */
function otherNodeManifest(from, to, { small = true } = {}) {
  const frames = [], smalls = [];
  for (let f = from; f <= to; f++) {
    frames.push([f, sha256(htmlOf(f)), htmlOf(f).length]);
    smalls.push([f, sha256(smallOf(f)), smallOf(f).length]);
  }
  return {
    v: 1, kind: 'snapshot', tier: 'shared', resultKey: RESULT_KEY, dirKey: RESULT_KEY, entryKey: null,
    range: { from, to }, canvasHeavy: false, frames, ...(small ? { small: smalls } : {}),
  };
}
const blocksOf = (from, to, { small = true } = {}) => {
  const out = [];
  for (let f = from; f <= to; f++) { out.push(htmlOf(f)); if (small) out.push(smallOf(f)); }
  return out;
};
const missLines = (logs) => logs.filter((l) => l.event === 'sink.has-miss').map((l) => l.fields);

test('X1 Locally covered but missing the small size, while another node\'s manifest in the content store has both tiers and all chunks present: has returns true (dedup), resultFor returns that manifest, and not a single chunk is pushed', async () => {
  const lib = frameLibrary();
  lib.write(0, 7); // Original size pulled by manifest, without small size
  const store = assetStore();
  store.preload(blocksOf(0, 7));
  const content = contentStore();
  const manifest = otherNodeManifest(0, 7);
  await content.put('snapshot-manifest', manifestKeyOf(refOf(0, 7)), manifest);
  const logs = [];
  const sink = createAssetSink({ pipeline: lib.pipeline, client: store, content, log: (event, fields) => logs.push({ event, fields }) });
  assert.equal(await sink.has(refOf(0, 7)), true, `Should take the dedup path: ${JSON.stringify(missLines(logs))}`);
  assert.equal(store.calls.put, 0, 'Not a single chunk is pushed');
  const got = await sink.resultFor(refOf(0, 7));
  assert.deepEqual(got, manifest, 'resultFor returns the manifest from the content store (with the small size), not the one computed locally that lacks the small size');
  assert.equal(missLines(logs).length, 0);
});

test('X2 Locally covered but missing the small size, and the manifest has no small size either: has returns false and logs sink.has-miss local-small-missing (handing it to the executor to draw the small size)', async () => {
  const lib = frameLibrary();
  lib.write(0, 7);
  const store = assetStore();
  store.preload(blocksOf(0, 7, { small: false }));
  const content = contentStore();
  await content.put('snapshot-manifest', manifestKeyOf(refOf(0, 7)), otherNodeManifest(0, 7, { small: false }));
  const logs = [];
  const sink = createAssetSink({ pipeline: lib.pipeline, client: store, content, log: (event, fields) => logs.push({ event, fields }) });
  assert.equal(await sink.has(refOf(0, 7)), false);
  const [line] = missLines(logs);
  assert.equal(line?.reason, 'local-small-missing', JSON.stringify(logs));
  assert.equal(line.covered, true);
  assert.equal(line.manifest, 'no-small', 'State why the manifest in the content store cannot be used either');
});

test('X3 Locally covered but missing the small size, and the manifest has both tiers but one small bitmap is missing on the asset service: has returns false and logs blocks-missing', async () => {
  const lib = frameLibrary();
  lib.write(0, 7);
  const store = assetStore();
  store.preload(blocksOf(0, 7).filter((b) => !b.equals(smallOf(5))));
  const content = contentStore();
  await content.put('snapshot-manifest', manifestKeyOf(refOf(0, 7)), otherNodeManifest(0, 7));
  const logs = [];
  const sink = createAssetSink({ pipeline: lib.pipeline, client: store, content, log: (event, fields) => logs.push({ event, fields }) });
  assert.equal(await sink.has(refOf(0, 7)), false);
  const [line] = missLines(logs);
  assert.equal(line?.reason, 'blocks-missing', JSON.stringify(logs));
  assert.equal(line.total, 16);
  assert.equal(line.missing, 1);
  assert.equal(line.errors, 0);
});

test('X4 Other reasons for sink.has-miss: manifest absent, mismatched, incomplete, or an error fetching the manifest (this machine does not have this segment)', async () => {
  const cases = [
    { name: 'manifest-missing', setup: async () => {} },
    { name: 'manifest-mismatch', setup: async (c) => c.put('snapshot-manifest', manifestKeyOf(refOf(0, 7)), { ...otherNodeManifest(0, 7), resultKey: sha256('Other') }), field: /^resultKey:/ },
    { name: 'manifest-incomplete', setup: async (c) => c.put('snapshot-manifest', manifestKeyOf(refOf(0, 7)), { ...otherNodeManifest(0, 7), frames: otherNodeManifest(0, 7).frames.slice(0, 5) }) },
    { name: 'manifest-get-failed', failGet: true, setup: async () => {} },
  ];
  for (const k of cases) {
    const lib = frameLibrary();
    const store = assetStore();
    store.preload(blocksOf(0, 7));
    const content = contentStore({ failGet: k.failGet === true });
    await k.setup(content);
    const logs = [];
    const sink = createAssetSink({ pipeline: lib.pipeline, client: store, content, log: (event, fields) => logs.push({ event, fields }) });
    assert.equal(await sink.has(refOf(0, 7)), false, k.name);
    const [line] = missLines(logs);
    assert.equal(line?.reason, k.name, `${k.name}:${JSON.stringify(logs)}`);
    assert.equal(line.covered, false);
    if (k.field) assert.match(line.field, k.field);
  }
  // Not given to content store
  const lib = frameLibrary();
  const logs = [];
  const sink = createAssetSink({ pipeline: lib.pipeline, client: assetStore(), log: (event, fields) => logs.push({ event, fields }) });
  assert.equal(await sink.has(refOf(0, 7)), false);
  assert.equal(missLines(logs)[0]?.reason, 'no-content');
});

/* ------------------------------------------------------------------ X5 Standalone render host pipeline enables small size */

const OWN_ENV = describeEnvironment({
  platform: 'win32', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});

test('X5 A pipeline without a push queue (standalone render host) enables the small size: after commitSnapshots it records this batch\'s small sizes, without entering the push queue and without launching Chrome', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-xnode-host-'));
  const p = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: OWN_ENV, dataRoot: root, interactive: false });
  cleanups.push(async () => { await p.close(); await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const args = { tier: 'shared', key: 'f'.repeat(64), clipId: 'c1', items: [{ localFrame: 0, html: '<div>0</div>' }, { localFrame: 1, html: '<div>1</div>' }] };
  assert.equal(p.smallTierEnabled(), false, 'Default: without a push queue it is not enabled');
  await p.snapshots().commitSnapshots(args);
  assert.equal(p.smallPending?.length ?? 0, 0, 'Nothing is recorded when it is not enabled');
  p.enableSmallTier();
  assert.equal(p.smallTierEnabled(), false, 'Ji-2: the small size has been discontinued, always false');
  assert.equal(p.pushQueue ?? null, null, 'Still no push queue');
  const calls = bakeryCalls.length;
  await p.snapshots().commitSnapshots({ ...args, items: [{ localFrame: 2, html: '<div>2</div>' }] });
  assert.equal(p.smallPending?.length ?? 0, 0, 'No small sizes are recorded after discontinuation');
  assert.equal(p.enqueueSnapshotPush(args), 0, 'No push queue: nothing is enqueued');
  assert.equal(bakeryCalls.length, calls, 'openBakery was never called');
  assert.equal(p.scheduleSmallSnapshots({ ...args, adopted: true }), false, 'Pulled-in frames are still not scheduled');
  p.smallPending = [];
});

/* ------------------------------------------------------------------ X6 Full chain: host finishes → PC pulls original size → restart → PC claims */

test('X6 The whole chain: host finishes both tiers and pushes them up; PC pulls the original size per the manifest; after the queue is rebuilt (document service restart) only PC is present, claims this segment and completes it by dedup, and the executor is not called', async (t) => {
  const F = await import('./fake-artifact-fixtures.mjs');
  const { createAssetHarness } = await import('./fake-asset-service.mjs');
  const { createAssetClient } = await import('../asset-store/client.mjs');
  const T = await import('../artifact-transfer.mjs');
  const harness = createAssetHarness();
  t.after(() => harness.cleanup());
  const roots = F.makeRoots(FramePipeline, 'pc-xnode-chain-');
  t.after(() => roots.cleanup());
  const svc = await F.startServices(harness, (base) => createAssetClient({ base }));
  t.after(() => svc.cleanup());

  // host-a: no push queue, enables small size (before fix this switch did not exist; fixture wrote small size files directly to simulate generation)
  const A = roots.make(await roots.root());
  A.enableSmallTier?.();
  const task = F.snapshotTask({ contentKey: sha256('card-xnode'), from: 0, to: 29 });
  await F.seedSnapshots(A, task, F.range(0, 29));
  const dirA = A.snapshots().dir({ tier: 'shared', key: task.resultKey });
  for (const f of F.range(0, 29)) await fsp.writeFile(path.join(dirA, `${f}${SMALL_SUFFIX}`), smallOf(f));
  const putA = await T.createAssetSink({ pipeline: A, client: svc.client, content: svc.content }).put({ ...F.refOf(task), artifacts: null, meta: F.metaOf(task) });
  assert.equal(putA.complete, true, JSON.stringify(putA).slice(0, 300));
  assert.equal(T.smallFramesOf(putA.result).length, 30, 'The host\'s manifest has both tiers');

  // PC: configured with push queue (small size enabled); receives task.done and pulls by manifest: pulls only original size
  const B = roots.make(await roots.root());
  assert.equal(B.smallTierEnabled(), false, 'Retired: small size discontinued');
  await T.applyResult(B, svc.client, putA.result);
  const dirB = B.snapshots().dir({ tier: 'shared', key: task.resultKey });
  assert.ok(fs.existsSync(path.join(dirB, '0.html')), 'PC has the original size locally');
  assert.ok(!fs.existsSync(path.join(dirB, `0${SMALL_SUFFIX}`)), 'PC has no small size locally (applyResult does not pull it)');

  // Document service restart: queue exists in memory only and rebuilds empty; publisher republishes the same segment; after restart only PC node remains
  const { createRenderQueue } = await import('../render-queue/index.mjs');
  const { createLocalNode } = await import('../render-node/local-node.mjs');
  const { createLoopback } = await import('./fake-loopback-transport.mjs');
  const { createFakeExecutor, createTimerClock } = await import('./fake-render-executor.mjs');
  const clock = createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: 'epoch-after-restart' });
  lb.attach(queue);
  const exec = createFakeExecutor({ clock, planContext: () => { throw new Error('X6 does not plan'); } });
  const page = lb.connect('conn-page', { userId: 'u1', tenantId: 't1' });
  const inbox = [];
  page.onMessage((m) => inbox.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page-x6' });
  const { state, version, attempts, ...input } = task;
  void state; void version; void attempts;
  page.send({ type: 'task.publish', tasks: [{ ...input, source: { projectId: 'p1', projectRev: 1 } }] });

  const events = [];
  const logs = [];
  const contentB = await svc.another('node-pc');
  const node = createLocalNode({
    nodeId: 'node-pc',
    node: { profile: 'pc', userId: 'u9', envFingerprint: F.TASK_FP, codeVersions: ['c'], cardSourceVersions: {},
      capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 16_000 } },
    endpoint: lb.connect('conn-node-pc', { userId: 'u9', tenantId: 't1' }),
    now: clock.now, random: () => 0.5, isIdle: () => true, maxConcurrent: 1, codeVersion: 'c',
    executor: exec.forNode('node-pc'),
    sink: T.createAssetSink({ pipeline: B, client: svc.client, content: contentB, log: (event, fields) => logs.push({ event, fields }) }),
    onEvent: (e) => events.push(e),
  });
  node.start();
  const done = () => inbox.find((m) => m.type === 'task.done' && m.id === task.id);
  const t0 = Date.now();
  while (!done() && Date.now() - t0 < 15_000) {
    lb.flush(); node.tick(); lb.flush(); queue.tick(); lb.flush();
    await new Promise((resolve) => setTimeout(resolve, 5)); // sink.has uses real network
    clock.advance(200);
  }
  node.stop();
  lb.flush();
  assert.ok(done(), `Received task.done: ${JSON.stringify(inbox.map((m) => m.type))}; node events: ${JSON.stringify(events).slice(0, 400)}`);
  assert.ok(events.some((e) => e.type === 'dedup' && e.id === task.id),
    `Completed via dedup: ${JSON.stringify(events.map((e) => e.type))}; ${JSON.stringify(logs.filter((l) => l.event === 'sink.has-miss'))}`);
  // Ji-2: small size discontinued; PC local original size is complete, completes via deduplication
  assert.equal((done().result?.frames ?? []).length, 30, 'task.done carries a manifest of 30 frames at the original size');
});
