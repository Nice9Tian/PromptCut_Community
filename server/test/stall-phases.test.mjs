/**
 * Alive, active nodes should not be classified as stalled
 * (`docs/archive/agent-reports/AGENT-stall-phases.md`; contract
 * `docs/plan/render-queue-contract.md` A.12 [ruling]).
 * Run: npm test, or node --test server/test/stall-phases.test.mjs
 *
 * In M8 C1 (move to the cloud), two standalone render hosts with alive connections and lease
 * renewals sent as usual each lost 6 or 7 claims, and a task failed permanently after reaching
 * 3 attempts. The queue's stall rule (A.8 item 2) only checks the frame count `done`: when a node
 * exceeds STALL_MS during stages where the frame count does not change, such as "queuing for
 * prerender" and "pushing outputs", it is treated as hung and reclaimed. Here, real queue + real node
 * arrangement (`createLocalNode` / `createRenderHost`) + real executor (`prerender-executor.mjs`,
 * with pipeline replaced by a mock that runs on a fake clock and has only a single serial lane) +
 * artifact store pushing chunks on a fake clock are used to reproduce and verify:
 *
 *   S1  Pushing outputs exceeds STALL_MS (60 chunks, 10 s each, concurrency 4 ≈ 150 s): before the
 *       fix, reclaimed as stalled and permanently failed after 3 attempts; after the fix, progress
 *       is counted after pushing each chunk (`task.progress.step`), completing in one shot with no
 *       lease-lost
 *   S2  Host maxConcurrent 2, one serial lane: second segment queues behind first (first segment
 *       135 s), classified as stalled while queuing before the fix; after the fix, host only
 *       claims snapshots when the lane is free (idle claim), both segments complete in one shot
 *   S3  S2 host: while previous segment pushes outputs, next segment still claims and renders as
 *       usual (pushing and rendering overlap)
 *   S4  Hangs are still reclaimed (an extension of I8): put in artifact store never reports
 *       progress and never returns → reclaimed as stalled after STALL_MS
 *   S5  New node works as usual with old queue (dropping the step field)
 *   Q1  Queue: resets stall timer when step changes; reclaimed as stalled as usual when step is
 *       unchanged (renewals only); behavior of old nodes without step unchanged; returns
 *       bad-message when step is not a number
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createRenderQueue } from '../render-queue/index.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { createRenderHost } from '../render-node/host.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { createPrerenderExecutor } from '../prerender-executor.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createTimerClock } from './fake-render-executor.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const FP = 'fedcba9876543210';
const CV = 'c0de-stall';
const STEP_MS = 500;
const STALL_MS = 120_000;

/* ------------------------------------------------------------------ Fixtures */

const CONTENT_KEY = sha256('ck:title');
const RESULT_KEY = resultKeyOf(CONTENT_KEY, FP);

function fineTask(from, to, { projectId = 'proj-a' } = {}) {
  return {
    id: `snapshot:${RESULT_KEY}:${from}-${to}`, kind: 'snapshot', tier: 'shared', resultKey: RESULT_KEY,
    range: { unit: 'localFrame', from, to },
    source: { projectId, projectRev: 1 },
    input: { clipId: 'clip-title', cardId: 'title', entryKey: null, contentKey: CONTENT_KEY },
    weight: { class: 'heavy', estMs: null, frames: to - from + 1 },
    requires: { envFingerprint: FP, codeVersion: CV, cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false },
    priority: 10,
  };
}

/**
 * Pipeline mock: only has that single serial `'queue'` lane (same as `FramePipeline.runQueueTask`:
 * wait for previous → work → return), 4 frames per batch, `batchMs` per batch (fake clock),
 * reporting progress once per batch. `laneLog` records the time each segment enters/exits the lane.
 */
function fakePipeline(clock, { batchMs }) {
  let chain = Promise.resolve();
  const laneLog = [];
  const control = {
    clipId: 'clip-title', tier: 'shared', snapshotKey: RESULT_KEY, contentKey: CONTENT_KEY, count: 300, cacheable: true,
    capabilities: { frameMode: 'stateful', compositing: 'independent' },
  };
  return {
    laneLog,
    envFingerprint: FP,
    queueHandles: () => true,
    prerenderPicked: () => true,
    async planForQueue(project) {
      return { entry: { key: 'entry-1', project, cardPlan: [control] }, context: { entryKey: 'entry-1', cardPlan: [control] }, streamSpecs: [] };
    },
    renderCardSnapshotRange(entry, ctl, range, { signal, progress } = {}) {
      const work = chain.catch(() => {}).then(async () => {
        if (signal?.aborted) throw Object.assign(new Error('Queue task cancelled'), { cancelled: true });
        const rec = { range: `${range.from}-${range.to}`, in: clock.now(), out: null };
        laneLog.push(rec);
        try {
          let done = 0;
          for (let f = range.from; f <= range.to; f += 4) {
            await clock.sleep(batchMs, signal);
            done += Math.min(4, range.to - f + 1);
            progress?.(done);
          }
        } finally { rec.out = clock.now(); }
      });
      chain = work.catch(() => {});
      return work.then(() => null);
    },
  };
}

/**
 * Artifact store mock: `has` checks whether it received everything; `put` pushes in chunks
 * (`blockMs` per chunk, concurrency 4, fake clock), reporting once via `report` after each chunk.
 * When `hang: true`, put never reports progress and never returns. `puts` records start and end of
 * each push.
 */
function fakeSink(clock, { blocks = 60, blockMs = 10_000, hang = false } = {}) {
  const stored = new Set();
  const puts = [];
  return {
    puts,
    async has(ref) { return stored.has(`${ref.resultKey}:${ref.range.from}-${ref.range.to}`); },
    async put(entry, { signal, report } = {}) {
      const rec = { id: entry.meta.taskId, nodeId: entry.meta.nodeId, start: clock.now(), end: null };
      puts.push(rec);
      if (hang) return new Promise(() => {});
      report?.({ stage: 'push' });
      let pushed = 0;
      report?.({ blocks, pushed, bytes: 0 });
      const lanes = Array.from({ length: 4 }, async (_, lane) => {
        for (let b = lane; b < blocks; b += 4) {
          await clock.sleep(blockMs, signal);
          pushed += 1;
          report?.({ blocks, pushed, bytes: pushed * 1000 });
        }
      });
      await Promise.all(lanes);
      rec.end = clock.now();
      stored.add(`${entry.resultKey}:${entry.range.from}-${entry.range.to}`);
      return { complete: true, result: { v: 1 } };
    },
  };
}

function projectsStub() {
  return { get: async () => ({ id: 'proj-a', tracks: [{ clips: [] }], duration: 10, fps: 30 }) };
}

/** One project space: queue + loopback + page publisher */
function space(clock, { transformIn = null } = {}) {
  const lb = createLoopback();
  const queue = createRenderQueue({
    now: clock.now, send: lb.queueSend, epoch: 'epoch-stall',
  });
  // S5: simulate old queue: inbound messages drop unrecognized fields before being passed to the queue
  if (transformIn) lb.attach({ ...queue, handle: (connId, message) => queue.handle(connId, transformIn(message)) });
  else lb.attach(queue);
  const page = lb.connect('page', { userId: 'alice', tenantId: 'proj-a' });
  const inbox = [];
  page.onMessage((m) => inbox.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page-a' });
  const log = () => lb.log();
  return {
    lb, queue, inbox,
    publish: (tasks) => page.send({ type: 'task.publish', tasks }),
    doneCount: (id) => inbox.filter((m) => m.type === 'task.done' && m.id === id).length,
    failed: () => inbox.filter((m) => m.type === 'task.failed'),
    leaseLost: () => log().filter((e) => e.dir === 'out' && e.message.type === 'task.lease-lost').map((e) => e.message),
    claims: () => log().map((e, index) => ({ ...e, index })).filter((e) => e.dir === 'out' && e.message.type === 'task.claimed'),
    task: (id) => queue.describe().tasks.find((t) => t.id === id),
  };
}

async function settle(sp) {
  for (let round = 0; round < 1000; round++) {
    sp.lb.flush();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    if (sp.lb.pending() === 0) return;
  }
  throw new Error('message round trips do not converge');
}

/** Driver: settle → node tick → queue tick → advance fake clock, until until() or step limit */
async function drive(sp, clock, tick, until, maxSteps = 4000) {
  for (let i = 0; i < maxSteps; i++) {
    await settle(sp);
    tick();
    await settle(sp);
    sp.queue.tick();
    await settle(sp);
    if (until()) return clock.now();
    clock.advance(STEP_MS);
  }
  return null;
}

function pcNode(sp, clock, { executor, sink, nodeId = 'pc-1' }) {
  const ep = sp.lb.connect(`conn-${nodeId}`, { userId: 'alice', tenantId: 'proj-a' });
  const events = [];
  const local = createLocalNode({
    nodeId,
    node: { profile: 'pc', envFingerprint: FP, codeVersions: [CV], cardSourceVersions: {}, capabilities: { transcode: false, userCards: true, graphCards: false } },
    endpoint: ep, now: clock.now, random: () => 0, maxConcurrent: 1, codeVersion: CV, executor, sink,
    onEvent: (e) => events.push(e),
  });
  local.start();
  return { local, events };
}

/* ================================================================== S1 */

test('S1 pushing the output takes longer than STALL_MS (about 150 s): each chunk pushed counts as progress, it completes in one go with no lease-lost', async () => {
  const clock = createTimerClock();
  const sp = space(clock);
  const pipeline = fakePipeline(clock, { batchMs: 1_000 });
  const executor = createPrerenderExecutor({ pipeline, projects: projectsStub() });
  const sink = fakeSink(clock, { blocks: 60, blockMs: 10_000 });
  const node = pcNode(sp, clock, { executor, sink });
  const task = fineTask(0, 59);
  sp.publish([task]);
  const endedAt = await drive(sp, clock, () => node.local.tick(), () => sp.doneCount(task.id) === 1 || sp.failed().length > 0);
  const view = sp.task(task.id);
  const lost = node.events.filter((e) => e.type === 'lost');
  assert.deepEqual(sp.leaseLost().map((m) => m.reason), [], `the claim should not be lost; the node's lost events: ${JSON.stringify(lost)}`);
  assert.ok(endedAt !== null, 'should finish within the step limit');
  assert.equal(view.state, 'done', `should be done (actual ${view.state}, lastError ${view.lastError})`);
  assert.equal(view.attempts, 0, 'Completed in one attempt');
  assert.equal(sink.puts.length, 1, 'pushed only once');
  assert.ok(sink.puts[0].end - sink.puts[0].start > STALL_MS, `the push itself exceeds STALL_MS (${sink.puts[0].end - sink.puts[0].start} ms)`);
  await node.local.stop();
});

/* ================================================================== S2 / S3 */

async function hostRun({ cap = 2, batchMs, push, tasks }) {
  const clock = createTimerClock();
  const sp = space(clock);
  const pipeline = fakePipeline(clock, { batchMs });
  const sink = fakeSink(clock, push);
  const events = [];
  const host = createRenderHost({
    entries: [{ projectId: 'proj-a', url: 'ws://unused.invalid/docservice' }],
    connect: () => ({
      endpoint: sp.lb.connect('host-0', { userId: 'renderbox', tenantId: 'proj-a' }),
      executor: createPrerenderExecutor({ pipeline, projects: projectsStub() }),
      sink,
    }),
    nodeIdOf: () => 'host:test/p0',
    envFingerprint: FP, codeVersion: CV, maxConcurrent: cap, now: clock.now, random: () => 0,
    onEvent: (e) => events.push({ ...e, at: clock.now() }),
  });
  host.start();
  sp.publish(tasks);
  const ids = tasks.map((t) => t.id);
  const endedAt = await drive(sp, clock, () => host.tick(), () => ids.every((id) => sp.doneCount(id) >= 1) || sp.failed().length > 0, 6000);
  host.shutdown('test-end');
  return { clock, sp, pipeline, sink, events, ids, endedAt };
}

test('S2 host with maxConcurrent 2 and one serial lane (135 s per segment): a queued segment is not judged stalled, and all complete in one go', async () => {
  const tasks = [fineTask(0, 59), fineTask(60, 119), fineTask(120, 179)];
  const { sp, pipeline, events, ids, endedAt } = await hostRun({ batchMs: 9_000, push: { blocks: 8, blockMs: 1_000 }, tasks });
  const lost = events.filter((e) => e.type === 'lost').map((e) => ({ id: e.id.slice(-8), reason: e.reason, phase: e.phase, detail: e.detail, sinceDoneMs: e.sinceDoneMs }));
  assert.deepEqual(sp.leaseLost().map((m) => m.reason), [], `the claim should not be lost; lost: ${JSON.stringify(lost)}`);
  assert.ok(endedAt !== null, 'should finish within the step limit');
  for (const id of ids) {
    const view = sp.task(id);
    assert.equal(view.state, 'done', `${id.slice(-8)}:${view.state} ${view.lastError}`);
    assert.equal(view.attempts, 0, `${id.slice(-8)} completes in one go`);
  }
  assert.equal(pipeline.laneLog.length, ids.length, 'each segment is rendered only once');
});

test('S3 host: while the previous segment pushes its output, the next segment is still claimed and rendered (push and render overlap)', async () => {
  const tasks = [fineTask(0, 59), fineTask(60, 119)];
  // Render a segment for 15 s, push a segment for 60 s (8 chunks, 30 s each, concurrency 4)
  const { sp, sink, pipeline, ids } = await hostRun({ batchMs: 1_000, push: { blocks: 8, blockMs: 30_000 }, tasks });
  for (const id of ids) assert.equal(sp.task(id).state, 'done');
  const first = sink.puts.find((p) => p.id === ids[0]) ?? sink.puts[0];
  const secondLane = pipeline.laneLog.find((r) => r.range !== first.id.split(':').at(-1));
  assert.ok(secondLane, 'the second segment entered the lane');
  assert.ok(secondLane.in < first.end, `the second segment started rendering before the first finished pushing (entered the lane at ${secondLane.in}, first push finished at ${first.end})`);
});

/* ================================================================== S4 */

test('S4 a hang is still reclaimed: the output store put never reports progress and never returns → reclaimed as stalled after STALL_MS', async () => {
  const clock = createTimerClock();
  const sp = space(clock);
  const pipeline = fakePipeline(clock, { batchMs: 500 });
  const executor = createPrerenderExecutor({ pipeline, projects: projectsStub() });
  const sink = fakeSink(clock, { hang: true });
  const node = pcNode(sp, clock, { executor, sink });
  const task = fineTask(0, 59);
  sp.publish([task]);
  const t0 = clock.now();
  await drive(sp, clock, () => node.local.tick(), () => sp.leaseLost().length > 0, 1000);
  const lost = sp.leaseLost();
  assert.equal(lost.length, 1, 'should be reclaimed once');
  assert.equal(lost[0].reason, 'stalled');
  const at = clock.now() - t0;
  assert.ok(at > STALL_MS && at < STALL_MS + 20_000, `reclaimed shortly after STALL_MS (actual ${at} ms)`);
  const ev = node.events.find((e) => e.type === 'lost');
  assert.equal(ev.phase, 'push', 'in the push phase when reclaimed');
  await node.local.stop();
});

/* ================================================================== S5 */

test('S5 new node against an old queue (the queue drops the step field): completes as before, no error', async () => {
  const clock = createTimerClock();
  // Old queue only recognizes id / token / done: remove step
  const sp = space(clock, { transformIn: (m) => { if (m?.type !== 'task.progress') return m; const { step, ...rest } = m; return rest; } });
  const pipeline = fakePipeline(clock, { batchMs: 500 });
  const executor = createPrerenderExecutor({ pipeline, projects: projectsStub() });
  const sink = fakeSink(clock, { blocks: 8, blockMs: 1_000 });
  const node = pcNode(sp, clock, { executor, sink });
  const task = fineTask(0, 59);
  sp.publish([task]);
  await drive(sp, clock, () => node.local.tick(), () => sp.doneCount(task.id) === 1);
  assert.equal(sp.task(task.id).state, 'done', 'completes as usual when the push is fast');
  assert.deepEqual(sp.leaseLost(), []);
  await node.local.stop();
});

/* ================================================================== Q1 */

test('Q1 queue: a changed step restarts the stall timer; a lease renewal without a new step is stalled as before; old nodes that send no step are unchanged; a step that is not a number returns bad-message', () => {
  let t = 1_000_000;
  const sent = [];
  const q = createRenderQueue({ now: () => t, send: (connId, msg) => sent.push({ connId, msg }), epoch: 'q1' });
  q.connect('n', { userId: 'u', tenantId: 't' });
  q.connect('p', { userId: 'u', tenantId: 't' });
  q.handle('n', { type: 'node.hello', nodeId: 'N', profile: 'pc' });
  q.handle('p', { type: 'publisher.hello', publisherId: 'P' });
  const a = fineTask(0, 59);
  const b = fineTask(60, 119);
  q.handle('p', { type: 'task.publish', tasks: [a, b] });
  q.handle('n', { type: 'task.claim', id: a.id, expectVersion: 1 });
  q.handle('n', { type: 'task.claim', id: b.id, expectVersion: 1 });
  const at = (v) => { t = v; q.tick(); };
  const T0 = 1_000_000;
  // a: new node, frame count stays at 60, step increments every 10 s (pushing chunks); b: old node,
  // renews only without step
  q.handle('n', { type: 'task.progress', id: a.id, token: 2, done: 60, step: 1 });
  q.handle('n', { type: 'task.progress', id: b.id, token: 2, done: 60 });
  for (let s = 10; s <= 300; s += 10) {
    at(T0 + s * 1000);
    if (q.describe().tasks.find((x) => x.id === a.id).state === 'claimed') q.handle('n', { type: 'task.progress', id: a.id, token: 2, done: 60, step: 1 + s / 10 });
    if (q.describe().tasks.find((x) => x.id === b.id).state === 'claimed') q.handle('n', { type: 'task.progress', id: b.id, token: 2, done: 60 });
  }
  const view = (id) => q.describe().tasks.find((x) => x.id === id);
  assert.equal(view(a.id).state, 'claimed', 'step keeps changing: not reclaimed after 300 s');
  assert.equal(view(a.id).claim.progress.step, 31);
  assert.equal(view(b.id).state, 'open', 'old node\'s frame count does not move: reclaimed as stalled as before');
  assert.equal(view(b.id).lastError, 'stalled');
  // After that, a only renews lease and step stops changing: reclaimed after STALL_MS
  const since = t;
  for (let s = 10; s <= 130; s += 10) {
    at(since + s * 1000);
    if (view(a.id).state === 'claimed') q.handle('n', { type: 'task.progress', id: a.id, token: 2, done: 60, step: 31 });
  }
  assert.equal(view(a.id).state, 'open', 'reclaimed as stalled when step does not move (a hang is still reclaimed)');
  assert.equal(view(a.id).lastError, 'stalled');
  // Format
  sent.length = 0;
  q.handle('n', { type: 'task.progress', id: a.id, token: 2, done: 1, step: 'x', reqId: 'bad' });
  assert.equal(sent.at(-1).msg.type, 'error');
  assert.equal(sent.at(-1).msg.reason, 'bad-message');
});

