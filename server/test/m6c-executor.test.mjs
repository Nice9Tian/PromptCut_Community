/**
 * Two items in M6c contract (`docs/plan/m6c-contract.md`) requiring executor and prerender pipeline:
 *   MC-X1-exec-*  Executor accepts fine-grained tasks with `kind: 'stream'`, no longer throws
 *                 `stream-not-supported` (smoke test, [Assumption A-X1-1])
 *   MC-X5-*       Idle gate for local queue node: claims if executor has available slots and no
 *                 interactive frame requests in last 500 ms; claims even if preload has not reached
 *                 ready; 0 new claims during scrub, finishes what is currently in hand
 * Run: node --experimental-test-module-mocks --test server/test/m6c-executor.test.mjs
 *
 * Written strictly per contract, not looking at implementation. `server/bakery/index.mjs` entirely
 * replaced with fake (`mock.module`), unit test does not launch Chrome or look for ffmpeg. X5 uses
 * real `FramePipeline` (`interactive: false`, injects `environment` and `playhead`) and real
 * `createPrerenderExecutor`; Date taken over by `mock.timers`. For simulation of preload and
 * interaction, see [Assumption A-X5-1] [A-X5-2] [A-X5-3] in `m6c-kit.mjs`. Implementation is not
 * on test branch: test cases for new behaviors are expected to fail here.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('Unit test does not open Chrome'); },
    findFfmpeg: async () => { throw new Error('Unit test does not look for ffmpeg'); },
    streamPngVideo: () => { throw new Error('Unit test does not encode'); },
    bakeFrames: async () => { throw new Error('Unit tests do not render'); },
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
const { createRenderQueue } = await import('../render-queue/index.mjs');
const { createLocalNode } = await import('../render-node/local-node.mjs');
const { describeEnvironment } = await import('../render-node/fingerprint.mjs');
const { createLoopback } = await import('./fake-loopback-transport.mjs');
const { streamTask, snapTask, nodeDescriptor, createPlayhead, simulatePreloadRunning, queueIdle } = await import('./m6c-kit.mjs');

const ENV = describeEnvironment({
  platform: 'win32',
  renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});

const temps = [];
const pipelines = [];
after(async () => {
  for (const p of pipelines) { try { await p.closeNow?.(); } catch { /* Finalize error does not affect result */ } }
  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function makePipeline(playhead) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm6c-exec-'));
  temps.push(root);
  const pipeline = new FramePipeline({
    root, origin: 'http://127.0.0.1:1', interactive: false, playhead, dataRoot: root, environment: ENV,
  });
  pipelines.push(pipeline);
  return pipeline;
}

const noProjects = { get: async () => null };

/* ================================================================== X1 executor accepts stream tasks */

test('MC-X1-exec: the executor\'s render of a stream task is no longer rejected with stream-not-supported (smoke test)', async () => {
  // Fake pipeline: any method of stream producer is an async no-op; real stream production (ffmpeg) belongs to queue-mode-probe / stream-produce-probe
  const producer = new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : async () => ({})) });
  const pipeline = {
    closed: false, envFingerprint: ENV.fingerprint, entries: new Map(), generations: new Map(),
    streams: () => producer, streamProducer: () => producer,
    queueHandles: () => true,
    planForQueue: async () => ({ entry: { key: 'e1', cardPlan: [] }, context: { entryKey: 'e1', cardPlan: [], streams: [] } }),
  };
  const projects = { get: async () => ({ id: 'p1', fps: 30, width: 16, height: 16, duration: 5, tracks: [{ id: 't1', clips: [] }], media: [] }) };
  const executor = createPrerenderExecutor({ pipeline, projects });
  const task = { ...streamTask(), source: { projectId: 'p1', projectRev: 1, userId: 'u1' }, state: 'claimed', version: 2, attempts: 0 };
  const controller = new AbortController();
  const outcome = await Promise.race([
    Promise.resolve().then(() => executor.render(task, { signal: controller.signal, progress: () => {} }))
      .then(() => ({ ok: true }), (error) => ({ ok: false, error })),
    new Promise(resolve => setTimeout(() => resolve({ ok: 'pending' }), 300)),
  ]);
  controller.abort('test-end');
  if (outcome.ok === false) {
    assert.notEqual(outcome.error?.code, 'stream-not-supported', `The executor still rejects the stream task: ${outcome.error?.message}`);
  }
});

/* ================================================================== X5 idle gate */

test('MC-X5-idle: when preload has not reached ready and there has been no interaction within 500 ms, the executor counts as idle', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const playhead = createPlayhead();
  const pipeline = await makePipeline(playhead);
  const executor = createPrerenderExecutor({ pipeline, projects: noProjects });
  simulatePreloadRunning(pipeline);
  assert.equal(queueIdle(pipeline, Date.now()), true, 'preload running, no interaction: should count as idle');
  playhead.stop(Date.now() - 2000);
  assert.equal(queueIdle(pipeline, Date.now()), true, 'Playhead that stopped 2 seconds ago: should count as idle');
});

test('MC-X5-drag: not idle if dragged 100 ms ago; idle again 500 ms after the drag stops', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const playhead = createPlayhead();
  const pipeline = await makePipeline(playhead);
  const executor = createPrerenderExecutor({ pipeline, projects: noProjects });
  playhead.drag(Date.now());
  t.mock.timers.tick(100);
  assert.equal(queueIdle(pipeline, Date.now()), false, 'Dragged 100 ms ago: not idle');
  t.mock.timers.tick(500);
  assert.equal(queueIdle(pipeline, Date.now()), true, 'The last drag was 600 ms ago: per the contract of 500 ms it should count as idle');
});

test('MC-X5-play: not idle during playback', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const playhead = createPlayhead();
  const pipeline = await makePipeline(playhead);
  const executor = createPrerenderExecutor({ pipeline, projects: noProjects });
  playhead.play(Date.now());
  t.mock.timers.tick(50);
  assert.equal(queueIdle(pipeline, Date.now()), false);
});

/**
 * Real queue + loopback + local node: `isIdle` connects to idle gate of real executor, `render`
 * controlled by test (manually released). Page publishes 4 snapshot clips, preload runs continuously.
 */
async function idleRig(t) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const playhead = createPlayhead();
  const pipeline = await makePipeline(playhead);
  const real = createPrerenderExecutor({ pipeline, projects: noProjects });
  simulatePreloadRunning(pipeline);

  const lb = createLoopback();
  const queue = createRenderQueue({ now: () => Date.now(), send: lb.queueSend });
  lb.attach(queue);
  const page = lb.connect('conn-page', { userId: 'u1', tenantId: 't1' });
  const pageInbox = [];
  page.onMessage(m => pageInbox.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page-1' });

  const claims = [];
  const gates = new Map();   // id → release function
  const ep = lb.connect('conn-node', { userId: 'u1', tenantId: 't1' });
  const endpoint = {
    send: (m) => { if (m?.type === 'task.claim') claims.push({ id: m.id, at: Date.now() }); ep.send(m); },
    onMessage: (h) => ep.onMessage(h),
  };
  const executor = {
    plan: async () => { throw new Error('No splitting here'); },
    render: (task) => new Promise((resolve) => gates.set(task.id, resolve)),
    isIdle: (now) => queueIdle(pipeline, now),
  };
  const sink = { has: async () => false, put: async () => ({ complete: true, result: {} }) };
  const node = nodeDescriptor({ nodeId: 'node-local', capabilities: { streams: false } });
  const local = createLocalNode({
    nodeId: 'node-local', node, endpoint, now: () => Date.now(), random: () => 0.5, maxConcurrent: 1,
    isIdle: () => queueIdle(pipeline, Date.now()), executor, sink,
  });
  local.start();
  lb.flush();
  const tasks = [0, 1, 2, 3].map(seg => snapTask({ seg, key: 'rk-idle' }));
  page.send({ type: 'task.publish', tasks });
  lb.flush();

  const settle = () => new Promise(resolve => setImmediate(resolve));
  const step = async (ms) => {
    t.mock.timers.tick(ms);
    queue.tick();
    local.tick();
    lb.flush();
    await settle();
    lb.flush();
  };
  return { playhead, claims, gates, tasks, step, settle, lb, pageInbox, local };
}

test('MC-X5-claim-before-ready: this machine\'s node already starts claiming fine-grained tasks while preload has not reached ready', async (t) => {
  const rig = await idleRig(t);
  for (let i = 0; i < 4; i += 1) await rig.step(250);
  assert.ok(rig.claims.length >= 1, `Should also claim while preload is running; claims: ${JSON.stringify(rig.claims)}`);
});

test('MC-X5-drag-no-claim: during a simulated drag there are 0 new claims and the task in hand is finished; claiming resumes after the drag stops', async (t) => {
  const rig = await idleRig(t);
  for (let i = 0; i < 4 && rig.gates.size === 0; i += 1) await rig.step(250);
  assert.equal(rig.gates.size, 1, `First claimed a segment and started work: ${JSON.stringify(rig.claims)}`);
  const [heldId] = [...rig.gates.keys()];

  // Scrub for 2 seconds: report playhead every 100 ms
  const dragStart = Date.now();
  rig.playhead.drag(Date.now());
  let released = false;
  for (let i = 0; i < 20; i += 1) {
    rig.playhead.drag(Date.now());
    if (i === 5 && !released) { rig.gates.get(heldId)(null); released = true; }   // Segment in hand completes halfway through scrub
    await rig.step(100);
  }
  const during = rig.claims.filter(c => c.at > dragStart);
  assert.equal(during.length, 0, `There should be no new claims during the drag: ${JSON.stringify(during)}`);
  const done = rig.pageInbox.filter(m => m.type === 'task.done').map(m => m.id);
  assert.ok(done.includes(heldId), `The segment in hand should be finished: ${JSON.stringify(done)}`);

  // Resumes after stopping for 500 ms
  const stopAt = Date.now();
  for (let i = 0; i < 10; i += 1) await rig.step(100);
  assert.ok(rig.claims.some(c => c.at > stopAt), `Claiming should resume after the drag stops: ${JSON.stringify(rig.claims)}`);
  for (const resolve of rig.gates.values()) resolve(null);
  rig.local.stop();
});
