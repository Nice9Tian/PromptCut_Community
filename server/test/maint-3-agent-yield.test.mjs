/**
 * Dedicated Agent instances yield to Agent by batch when running fine-grained queue tasks
 * (item 5 of AGENT-maint-3; lead session requested fixing the 38 s measured by claim gate probe on
 * this branch).
 *
 *   MNT3-Y-1  During single-pass forward push (singlePass): an Agent task is waiting; stops this
 *             pass after delivering the current 4-frame chunk, yields, then pushes forward from the
 *             next unfinished batch; the set of pushed frames has the same union as without
 *             yielding, with no repushing of delivered frames; progress, snapshots on disk, and
 *             index are verbatim identical to those without yielding;
 *   MNT3-Y-2  When running batch by batch: yields between batches; snapshots on disk match those
 *             without yielding;
 *   MNT3-Y-3  Pipeline integration (real `runQueueTask` / `kickAgentIdle` / `runAgentTask` /
 *             `renderCardSnapshotRange`): queue lane is occupied, fine-grained snapshot task is
 *             handed to dedicated Agent instance; when it pushes to frame 2, an Agent task arrives:
 *             Agent task starts at next batch boundary (after frame 3 delivered), without waiting
 *             for the full segment; queue task still completes in the end, frames on disk match
 *             those without yielding; diagnostic `scheduler.yields` recorded once; heartbeat was
 *             called;
 *   MNT3-Y-4  `drainAgentInbox`: Agent tasks arriving back-to-back are finished in one pass;
 *             heartbeat is called every `AGENT_YIELD_BEAT_MS` while running, once before and once
 *             after;
 *   MNT3-Y-5  Lease (real queue + real node arrangement + real executor): queue task yields midway
 *             for 200 s (exceeding STALL_MS 120 s), executor heartbeat prevents it from being
 *             classified as stalled, completing in one go with no lease-lost; same scenario without
 *             heartbeat is reclaimed as stalled as usual (showing this test case genuinely tested
 *             stall rules);
 *   MNT3-Y-7  Agent tasks arriving in close succession (second arrives within 1 s after first
 *             finishes): both are finished in the same yield, without switching back to queue task
 *             in between;
 *   MNT3-Y-6  Whole-scene (local tier) path: `renderLocalSnapshots`'s `shouldStop` is queried every
 *             4 frames; when stopped, accumulated batches finalize as usual, returning the stopped
 *             frame.
 *
 * Do not launch Chrome: `server/bakery/index.mjs` is replaced with a mock; mock `bakeFrames` checks
 * `signal` between frames just like the real one, and a frame's snapshot precedes its screenshot.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const bakeLog = [];
/** Called once at start of each frame (tests insert events like Agent tasks here) */
let beforeFrame = null;
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { throw new Error('Unit test does not open Chrome'); },
    findFfmpeg: async () => 'ffmpeg',
    streamPngVideo: () => { throw new Error('Unit test does not encode'); },
    bakeFrames: async (bakery, opts = {}) => {
      const rec = { bakery: bakery?.name ?? null, targetFrames: [...(opts.targetFrames ?? [])], snapshotFrames: [...(opts.snapshotFrames ?? [])], events: [] };
      bakeLog.push(rec);
      for (const frame of rec.targetFrames) {
        // Same as real: cancellation only takes effect between frames
        if (opts.signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        await beforeFrame?.(frame, rec);
        if (rec.snapshotFrames.includes(frame)) {
          await opts.onSnapshot?.(frame, '<div data-pc-scene=""></div>', [{ id: 'clip-a', frame, html: `<p>a ${frame}</p>` }]);
          rec.events.push(`snap ${frame}`);
        }
        await opts.onFrame?.(frame, Buffer.from(`png-${frame}`));
        rec.events.push(`shot ${frame}`);
      }
      return { advancedFrames: rec.targetFrames.length };
    },
  },
});

const { FramePipeline, AGENT_YIELD_BEAT_MS } = await import('../frame-pipeline.mjs');
const { describeEnvironment } = await import('../render-node/fingerprint.mjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('Timed out waiting for the condition');
    await sleep(1);
  }
}

const ENV = describeEnvironment({
  platform: 'win32', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  vendor: 'Google Inc. (Google)', chromeVersion: 'HeadlessChrome/138.0.7204.49',
});
const N = 30;
const project = { id: 'mnt3-yield', fps: 30, width: 320, height: 180, duration: 1, style: {}, media: [],
  tracks: [{ id: 't1', clips: [{ id: 'clip-a', cardId: 'demo-a', start: 0, end: 1 }] }] };
const graph = { definitions: [], nodes: [{ id: 'n-a', adapter: 'chrome', cardId: 'demo-a', capabilities: { compositing: 'independent', frameMode: 'stateful' }, inputs: {} }],
  outputs: [{ nodeId: 'n-a', clipId: 'clip-a', start: 0, end: 1, opacity: 1 }] };

const withTmp = async (fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-mnt3-yield-'));
  try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
};

async function setup(root, { interactive = false } = {}) {
  const pipeline = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', environment: ENV, dataRoot: root, interactive, ...(interactive ? { mode: 'full' } : {}) });
  await pipeline.ensureCardLocks();
  const entry = await pipeline.entry(project);
  pipeline.recordCardPlan(entry, entry.cardCache.plan(graph).map(c => ({ ...c, tier: 'shared' })));
  entry.cardCache.hasComplete = async () => false;
  entry.cardCache.put = async () => true;
  entry.cardCache.finish = async () => {};
  const control = entry.cardPlan.find(c => c.clipId === 'clip-a');
  return { pipeline, entry, control };
}
async function diskOf(pipeline, control) {
  const index = await pipeline.snapshots().snapshotIndex({ tier: 'shared', key: control.snapshotKey });
  const dir = pipeline.snapshots().dir({ tier: 'shared', key: control.snapshotKey });
  const files = {};
  for (let n = 0; n < N; n++) { try { files[n] = await fs.readFile(path.join(dir, `${n}.html`), 'utf8'); } catch { /* None */ } }
  return { frames: index.frames, files };
}
const fakeBakery = (name, log = []) => ({
  name, page: { setViewport: async () => {}, evaluate: async () => graph },
  reset: async () => { log.push(`${name}.reset`); }, client: { send: async () => {} }, close: async () => {},
});

/**
 * fillCardControls runs a segment directly; `yieldAt`: when pushed to this frame, an Agent task
 * arrives (shouldYield becomes true), yieldPoint records 'Y' and clears
 */
async function runFill(root, { singlePass, range, yieldAt = null }) {
  bakeLog.length = 0;
  const { pipeline, entry, control } = await setup(root);
  const log = [];
  let waiting = false;
  beforeFrame = (frame) => { if (frame === yieldAt) waiting = true; };
  const batches = [];
  const yielding = yieldAt === null ? {} : {
    shouldYield: () => waiting,
    yieldPoint: async () => { log.push(`Y after ${bakeLog.at(-1)?.events.at(-1)}`); waiting = false; return true; },
  };
  try {
    await pipeline.fillCardControls(entry, fakeBakery('b'), null, [control], { range, singlePass, ...yielding,
      onBatch: ({ first, frames, snapshotFrames }) => batches.push({ first, frames: [...frames], snapshotFrames: [...snapshotFrames] }) });
    return { log, batches, bakes: bakeLog.map(r => ({ ...r })), disk: await diskOf(pipeline, control) };
  } finally { beforeFrame = null; await pipeline.close().catch(() => {}); }
}

test('MNT3-Y-1 yield to the Agent during a forward pass: stop after finishing the current 4-frame block and resume the pass from the next batch not yet done; the frames are identical to the no-yield case', async () => {
  const range = { from: 0, to: 23 };
  const plain = await withTmp(root => runFill(root, { singlePass: true, range }));
  const yielded = await withTmp(root => runFill(root, { singlePass: true, range, yieldAt: 5 }));
  assert.equal(plain.bakes.length, 1);
  // Agent task arrives at frame 5: stops after delivering frame 4-7 chunk, yields, then pushes
  // forward from frame 8
  assert.equal(yielded.bakes.length, 2);
  assert.deepEqual(yielded.bakes[0].events.filter(e => e.startsWith('shot')).map(e => Number(e.slice(5))), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(yielded.bakes[1].targetFrames, Array.from({ length: 16 }, (_, i) => 8 + i));
  assert.deepEqual(yielded.log, ['Y after shot 7']);
  // Frames pushed for screenshots: two passes combined match exactly the pass without yielding,
  // not repushing a single frame
  const shots = r => r.bakes.flatMap(b => b.events.filter(e => e.startsWith('shot')).map(e => Number(e.slice(5))));
  assert.deepEqual(shots(yielded), shots(plain));
  // Progress, snapshots on disk, and index: verbatim identical
  assert.deepEqual(yielded.batches, plain.batches);
  assert.deepEqual(yielded.disk, plain.disk);
  assert.deepEqual(plain.disk.frames, [[0, 23]]);
});

test('MNT3-Y-2 when running batch by batch, yield between two batches; the snapshots on disk are identical to the no-yield case', async () => {
  const range = { from: 0, to: 15 };
  const plain = await withTmp(root => runFill(root, { singlePass: false, range }));
  const yielded = await withTmp(root => runFill(root, { singlePass: false, range, yieldAt: 5 }));
  assert.deepEqual(yielded.bakes.map(b => b.targetFrames[0]), [0, 4, 8, 12]);
  assert.deepEqual(yielded.log, ['Y after shot 7'], 'Yield after batch 4 (4-7) is done and before batch 8 starts');
  assert.deepEqual(yielded.batches, plain.batches);
  assert.deepEqual(yielded.disk, plain.disk);
});

test('MNT3-Y-3 pipeline integration: when an Agent task arrives while the dedicated instance is working on a fine-grained snapshot task, it starts at the next batch boundary, and the queue task still finishes in the end with the same frames', async () => {
  const baseline = await withTmp(root => runFill(root, { singlePass: true, range: { from: 0, to: 23 } }));
  await withTmp(async root => {
    bakeLog.length = 0;
    const { pipeline, entry, control } = await setup(root, { interactive: true });
    pipeline.agentGraceMs = 0;
    const log = [];
    pipeline.lanes.set('queue', { bakery: fakeBakery('queue', log) });
    pipeline.lanes.set('agent', { bakery: fakeBakery('agent', log) });
    let openHold;
    const hold = new Promise(resolve => { openHold = resolve; });
    try {
      // queue lane is occupied by an item
      const a = pipeline.runQueueTask(async lease => { await lease(project); log.push('A:start'); await hold; log.push('A:end'); }, undefined, { tag: 'card:other' });
      await until(() => log.includes('A:start'));
      // Fine-grained snapshot task: queued and taken over by an idle dedicated instance
      let agentTask = null;
      beforeFrame = (frame, rec) => {
        if (rec.bakery === 'agent' && frame === 2 && !agentTask) {
          agentTask = pipeline.runAgentTask(async lease => { const b = await lease(project); log.push(`X@${b.name} after ${bakeLog.at(-1)?.events.at(-1)}`); return 'X'; });
        }
      };
      const beats = [];
      const b = pipeline.renderCardSnapshotRange(entry, control, { from: 0, to: 23 }, { heartbeat: () => beats.push(Date.now()) });
      await b;
      assert.ok(agentTask, 'The Agent task arrived while the dedicated instance was pushing frames');
      assert.equal(await agentTask, 'X');
      // Agent task starts after frame 3 delivered (frame 0-3 chunk), not waiting for full 24-frame segment
      assert.deepEqual(log.filter(e => e.startsWith('X')), ['X@agent after shot 3']);
      const agentBakes = bakeLog.filter(r => r.bakery === 'agent');
      assert.deepEqual(agentBakes.map(r => r.targetFrames[0]), [0, 4], 'One pass before yielding, and one pass from frame 4 after yielding');
      assert.equal(bakeLog.filter(r => r.bakery === 'queue').length, 0, 'The whole fine-grained snapshot task runs on the dedicated instance');
      // Frames on disk match those without yielding
      assert.deepEqual(await diskOf(pipeline, control), baseline.disk);
      const y = pipeline.diagnostics().scheduler.yields;
      assert.equal(y.count, 1);
      assert.equal(y.tasks, 1);
      assert.equal(y.last.reason, 'batch');
      assert.ok(beats.length >= 2, `Heartbeat called once before and once after yielding (${beats.length})`);
      const recent = pipeline.diagnostics().scheduler.recent;
      assert.ok(recent.some(r => r.kind === 'queue' && r.worker === 'agent'), 'The scheduling record shows the fine-grained snapshot task starting on the dedicated instance');
      openHold();
      await a;
    } finally { beforeFrame = null; openHold?.(); await pipeline.close().catch(() => {}); }
  });
});

test('MNT3-Y-4 drainAgentInbox: tasks arriving back to back are finished in one go; heartbeats are called periodically while working, once before and once after', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const svc = new FramePipeline({ root: os.tmpdir(), origin: () => 'http://127.0.0.1:1', interactive: true, mode: 'full' });
  svc.agentGraceMs = 0;   // Grace period see also Y-7
  const beats = [];
  let release;
  const gateP = new Promise(resolve => { release = resolve; });
  const unit = { inbox: [] };
  const order = [];
  unit.inbox.push({ body: async () => { order.push('x1'); await gateP; return 1; }, resolve: v => order.push(`ok${v}`), reject: () => {} });
  const draining = svc.drainAgentInbox(unit, { heartbeat: () => beats.push('b'), reason: 'batch' });
  await Promise.resolve();
  // Another arrives while running the first: continues running within the same yield
  unit.inbox.push({ body: async () => { order.push('x2'); return 2; }, resolve: v => order.push(`ok${v}`), reject: () => {} });
  t.mock.timers.tick(AGENT_YIELD_BEAT_MS * 3);
  assert.equal(beats.length, 1 + 3, 'Once at the start + once every 20 s');
  release();
  assert.equal(await draining, 2);
  assert.deepEqual(order, ['x1', 'ok1', 'x2', 'ok2']);
  assert.equal(beats.length, 1 + 3 + 1, 'Once more at the end');
  assert.equal(svc.agentYieldStats.count, 1);
  assert.equal(svc.agentYieldStats.tasks, 2);
  await svc.close().catch(() => {});
});

/* ------------------------------------------------------------------ Y-5 Lease */

const { createRenderQueue } = await import('../render-queue/index.mjs');
const { createLocalNode } = await import('../render-node/local-node.mjs');
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
const { createLoopback } = await import('./fake-loopback-transport.mjs');
const { createTimerClock } = await import('./fake-render-executor.mjs');

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const FP = 'fedcba9876543210';
const CV = 'c0de-yield';
const CONTENT_KEY = sha256('ck:yield');
const RESULT_KEY = resultKeyOf(CONTENT_KEY, FP);
const STEP_MS = 500;

function fineTask(from, to) {
  return {
    id: `snapshot:${RESULT_KEY}:${from}-${to}`, kind: 'snapshot', tier: 'shared', resultKey: RESULT_KEY,
    range: { unit: 'localFrame', from, to }, source: { projectId: 'proj-a', projectRev: 1 },
    input: { clipId: 'clip-y', cardId: 'y', entryKey: null, contentKey: CONTENT_KEY },
    weight: { class: 'heavy', estMs: null, frames: to - from + 1 },
    requires: { envFingerprint: FP, codeVersion: CV, cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false },
    priority: 10,
  };
}
/**
 * Pipeline double: pushes a batch for a segment, "yields" yieldMs (calls heartbeat every
 * AGENT_YIELD_BEAT_MS, not if `beat: false`), then finishes remaining batches
 */
function yieldingPipeline(clock, { yieldMs, beat }) {
  const control = { clipId: 'clip-y', tier: 'shared', snapshotKey: RESULT_KEY, contentKey: CONTENT_KEY, count: 60, cacheable: true,
    capabilities: { frameMode: 'stateful', compositing: 'independent' } };
  return {
    envFingerprint: FP, queueHandles: () => true, prerenderPicked: () => true,
    async planForQueue(p) { return { entry: { key: 'entry-y', project: p, cardPlan: [control] }, context: { entryKey: 'entry-y', cardPlan: [control] }, streamSpecs: [] }; },
    async renderCardSnapshotRange(entry, ctl, range, { signal, progress, heartbeat } = {}) {
      let done = 0;
      for (let f = range.from; f <= range.to; f += 4) {
        await clock.sleep(1_000, signal);
        done += Math.min(4, range.to - f + 1);
        progress?.(done);
        if (f === range.from) {
          // Yield: like drainAgentInbox, reports once at start, every AGENT_YIELD_BEAT_MS, and at end
          if (beat) heartbeat?.();
          for (let t = 0; t < yieldMs; t += AGENT_YIELD_BEAT_MS) {
            await clock.sleep(Math.min(AGENT_YIELD_BEAT_MS, yieldMs - t), signal);
            if (beat) heartbeat?.();
          }
        }
      }
      return null;
    },
  };
}
function fakeSink() {
  const stored = new Set();
  return {
    async has(ref) { return stored.has(`${ref.resultKey}:${ref.range.from}-${ref.range.to}`); },
    async put(entry) { stored.add(`${entry.resultKey}:${entry.range.from}-${entry.range.to}`); return { complete: true, result: { v: 1 } }; },
  };
}
async function leaseRun({ beat }) {
  const clock = createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: 'epoch-yield' });
  lb.attach(queue);
  const page = lb.connect('page', { userId: 'alice', tenantId: 'proj-a' });
  const inbox = [];
  page.onMessage(m => inbox.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page-a' });
  const pipeline = yieldingPipeline(clock, { yieldMs: 200_000, beat });
  const executor = createPrerenderExecutor({ pipeline, projects: { get: async () => ({ id: 'proj-a', tracks: [{ clips: [] }], duration: 10, fps: 30 }) } });
  const ep = lb.connect('conn-pc', { userId: 'alice', tenantId: 'proj-a' });
  const local = createLocalNode({
    nodeId: 'pc-1', node: { profile: 'pc', envFingerprint: FP, codeVersions: [CV], cardSourceVersions: {}, capabilities: { transcode: false, userCards: true, graphCards: false } },
    endpoint: ep, now: clock.now, random: () => 0, maxConcurrent: 1, codeVersion: CV, executor, sink: fakeSink(),
  });
  local.start();
  const task = fineTask(0, 59);
  page.send({ type: 'task.publish', tasks: [task] });
  const settle = async () => {
    for (let round = 0; round < 1000; round++) {
      lb.flush();
      for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
      if (lb.pending() === 0) return;
    }
  };
  const leaseLost = () => lb.log().filter(e => e.dir === 'out' && e.message.type === 'task.lease-lost').map(e => e.message.reason);
  for (let i = 0; i < 2000; i++) {
    await settle(); local.tick(); await settle(); queue.tick(); await settle();
    if (inbox.some(m => m.type === 'task.done' && m.id === task.id) || leaseLost().length) break;
    clock.advance(STEP_MS);
  }
  const view = queue.describe().tasks.find(t => t.id === task.id);
  await local.stop();
  return { view, leaseLost: leaseLost() };
}

test('MNT3-Y-5 yielding for 200 s (exceeding STALL_MS): the heartbeat of the executor keeps the queue task from being judged stalled and it completes in one attempt; without a heartbeat it is still reclaimed as stalled', async () => {
  const withBeat = await leaseRun({ beat: true });
  assert.deepEqual(withBeat.leaseLost, [], 'The lease was not lost while yielding');
  assert.equal(withBeat.view.state, 'done');
  assert.equal(withBeat.view.attempts, 0, 'Completed in one attempt');
  const noBeat = await leaseRun({ beat: false });
  assert.deepEqual(noBeat.leaseLost.slice(0, 1), ['stalled'], 'For comparison: without a heartbeat it is reclaimed after 120 s without progress');
});

test('MNT3-Y-6 the whole-scene path: renderLocalSnapshots asks shouldStop every 4 frames, returns the frame it stopped at when stopping, and the batch accumulated so far is closed out as usual', async () => {
  await withTmp(async root => {
    bakeLog.length = 0;
    const svc = new FramePipeline({ root, origin: () => 'http://127.0.0.1:1', interactive: false });
    const closed = [];
    svc.snapshotTargets = () => new Map([['clip-a', { tier: 'local', key: 'k-local' }]]);
    svc.snapshots = () => ({ batch: () => ({ key: 'k-local', written: 1, add: async () => {}, close: async () => { closed.push('close'); return { frames: [[0, 7]] }; } }) });
    const published = [];
    svc.publishLayer = (...args) => published.push(args[3]);
    const entry = { key: 'e1', dir: root, cardPlan: [] };
    let ask = 0;
    const frames = Array.from({ length: 12 }, (_, i) => i);
    const stopped = await svc.renderLocalSnapshots(entry, frames, fakeBakery('b'), null, { shouldStop: () => ++ask >= 2 });
    assert.equal(stopped, 7, 'Stops at the second ask (after frame 7 is delivered)');
    assert.deepEqual(bakeLog[0].events.filter(e => e.startsWith('snap')).map(e => Number(e.slice(5))), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(closed, ['close'], 'The batch accumulated so far is closed out as usual when stopping');
    assert.deepEqual(published, [[[0, 7]]]);
    const whole = await svc.renderLocalSnapshots(entry, frames.filter(n => n > 7), fakeBakery('b'), null, { shouldStop: () => false });
    assert.equal(whole, undefined, 'Returns undefined if it did not stop');
    await svc.close().catch(() => {});
  });
});

test('MNT3-Y-7 Agent tasks arriving one right after the other: the second arrives within the grace period and is finished in the same yield, without switching back to the queue task in between', async () => {
  await withTmp(async root => {
    bakeLog.length = 0;
    const { pipeline, entry, control } = await setup(root, { interactive: true });
    pipeline.agentGraceMs = 0;
    const log = [];
    pipeline.lanes.set('queue', { bakery: fakeBakery('queue', log) });
    pipeline.lanes.set('agent', { bakery: fakeBakery('agent', log) });
    let openHold;
    const hold = new Promise(resolve => { openHold = resolve; });
    try {
      const a = pipeline.runQueueTask(async lease => { await lease(project); log.push('A:start'); await hold; }, undefined, { tag: 'card:other' });
      await until(() => log.includes('A:start'));
      let first = null, second = null;
      beforeFrame = (frame, rec) => {
        if (rec.bakery === 'agent' && frame === 2 && !first) {
          // Grace period is 200 ms from here (leading 0 lets snapshot task be taken over by dedicated
          // instance first)
          pipeline.agentGraceMs = 200;
          first = pipeline.runAgentTask(async lease => {
            await lease(project); log.push(`X1 after ${bakeLog.at(-1)?.events.at(-1)}`);
            // Second arrives 20 ms after finish (simulates queueing "measure entity box" only after see_frames
            // renders)
            setTimeout(() => { second = pipeline.runAgentTask(async l => { await l(project); log.push(`X2 after ${bakeLog.at(-1)?.events.at(-1)}`); return 2; }); }, 20);
            return 1;
          });
        }
      };
      await pipeline.renderCardSnapshotRange(entry, control, { from: 0, to: 23 }, {});
      assert.equal(await first, 1);
      assert.equal(await second, 2);
      assert.deepEqual(log.filter(e => e.startsWith('X')), ['X1 after shot 3', 'X2 after shot 3'], 'The queue task pushed no more frames between the two');
      const y = pipeline.diagnostics().scheduler.yields;
      assert.equal(y.count, 1, 'Yielded only once');
      assert.equal(y.tasks, 2);
      assert.deepEqual(bakeLog.filter(r => r.bakery === 'agent').map(r => r.targetFrames[0]), [0, 4]);
      openHold();
      await a;
    } finally { beforeFrame = null; openHold?.(); await pipeline.close().catch(() => {}); }
  });
});
