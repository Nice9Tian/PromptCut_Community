/**
 * M3 in-process integration: local node arrangement (`createLocalNode`) × real queue
 * (`createRenderQueue`), chained into an end-to-end pipeline via loopback transport, fake
 * executor, and in-memory artifact store (Contract `docs/plan/render-queue-contract.md` Section D,
 * test cases I1–I10, plus I11: existing fine-grained tasks merged into subscriptions and resent
 * during version changes).
 * Run: node --test server/test/render-queue-inproc.test.mjs
 *
 * Written strictly against Contract Section D, Section A (queue messages and behavior), B.4 / B.5,
 * and design `docs/plan/distributed-prerender-queue.md`, without inspecting the implementation of
 * `local-node.mjs`; the module under test is driven only via the public interface in D.2
 * (start / tick / yieldAll / stop / running / settled / session / onEvent).
 *
 * Topology: one queue, one loopback, several local nodes, one to two page publishers (pages send
 * `publisher.hello` and `task.publish` directly using loopback endpoints). All use fake clocks
 * (`createTimerClock`), without waiting on real timers.
 *
 * Driver loop (D.4): flush → yield event loop (setImmediate, letting Promises of fake executor
 * and fake artifact store settle) → tick each node → queue.tick → advance fake clock when
 * conditions are not met. The loop has a maximum step limit; if exceeded, it fails and prints
 * `describe()`.
 *
 * Each test case checks (`hygiene`): endpoint handlers threw no exceptions (`errors()` is empty),
 * every delivered message can round-trip through JSON, queue never returned `error`, artifact
 * store received no calls violating D.1, and there are no unhandled Promise rejections.
 *
 * Assertions only cover what is explicitly specified in the contract / design. Several areas not
 * strictly specified in the contract are bypassed by tests:
 *   - Which node grabs which task first in the same step (random source has a fixed seed, but
 *     specific ownership is not asserted; only asserts "exactly once" and "who cannot claim");
 *   - Whether `lastError` remains after completion (only reads `lastError` in `describe()` at the
 *     moment of reclaiming);
 *   - What other progress updates are sent beyond `task.progress { done: 0 }` when the node starts
 *     work (D.2 ruling); does not assert the exact sequence of messages.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';
import { createArtifactSink } from './fake-artifact-sink.mjs';
import { createFakeExecutor, createTimerClock } from './fake-render-executor.mjs';

// ---------------------------------------------------------------- Constants (defaults from Contract A.2, used only to calculate time windows)

const LEASE_MS = 30_000;
const RECONNECT_GRACE_MS = 10_000;
const STALL_MS = 120_000;
const STEP_MS = 250;

const FP_A = '0123456789abcdef';
const FP_B = 'fedcba9876543210';
const CV = 'c0de5a';
const FPS = 30;

// ---------------------------------------------------------------- Unhandled Promise rejections

const unhandled = [];
process.on('unhandledRejection', reason => { unhandled.push(reason); });

// ---------------------------------------------------------------- Utilities

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
/** Contract B.1: resultKey = sha256(`${contentKey}\n${envFingerprint}`), computed by the test itself without relying on implementation */
const resultKeyOf = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);
const sorted = list => [...list].sort();
const counts = list => list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());

/** Fixed-seed pseudorandom number (mulberry32), [0, 1). */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Coarse-grained task published by page (shape of planTaskOf in Contract B.4, written by test itself). */
function planTaskInput(projectId, projectRev, priority = 0) {
  return {
    id: `plan:${projectId}@${projectRev}`, kind: 'plan', resultKey: `${projectId}@${projectRev}`, range: null,
    source: { projectId, projectRev }, input: {}, weight: { class: 'medium', estMs: null, frames: null },
    requires: {}, priority,
  };
}
const planIdOf = (projectId, projectRev) => `plan:${projectId}@${projectRev}`;

// ---------------------------------------------------------------- PlanContext fixture

/**
 * Create a control based on plan() output of `server/card-cache.mjs` (fields match the object it
 * pushes, plus cardId). `tier` is handwritten according to `snapshotTier(capabilities)` rules:
 * stateful + independent → shared, stateful + belowDependent → local, stateless → none.
 */
function control({ clipId, cardId, label, capabilities, start, count }) {
  const compositing = capabilities.compositing ?? 'unknown';
  const stateful = capabilities.frameMode === 'stateful';
  const tier = !stateful ? 'none' : (compositing === 'independent' || compositing === 'sourceDependent') ? 'shared' : 'local';
  const firstFrame = Math.ceil(start * FPS - 1e-9);
  return {
    key: sha256(`png:${label}`), snapshotKey: sha256(`snap:${label}`), costKey: sha256(`cost:${label}`),
    frameMode: capabilities.frameMode, tier, capabilities, clipId, nodeId: `n:${clipId}`,
    start, end: start + count / FPS, count,
    sampling: { firstFrame, fps: { numerator: FPS, denominator: 1 }, phase: { numerator: 0, denominator: 1 } },
    compositing, cacheable: compositing === 'independent', needPrerendering: false,
    appearance: { frame: null, opacity: 1, width: 1920, height: 1080 },
    cardId,
  };
}

const WEIGHTS = { 'clip-title': 'heavy', 'clip-glass': 'medium', 'clip-lower': 'light', 'clip-video': 'heavy' };

/**
 * PlanContext of a project version (D.1, fed to splitPlan as is):
 *   Title (particle card, shared tier, 130 frames → 3 segments, heavy)
 *   Frosted glass (local tier, 45 frames → 1 segment, medium)
 *   Lower third (shared tier, 70 frames → 2 segments, light)
 *   Plain text (stateless, tier none → not split)
 *   One track stream (segments 0–11 → 2 stream tasks, heavy)
 * Total of 8 fine-grained tasks. `salt` uses a different set of content keys (for other projects).
 */
function planContextFor(salt = 'p1') {
  const stateful = { frameMode: 'stateful', compositing: 'independent' };
  return {
    entryKey: sha256(`entry:${salt}`),
    cardPlan: [
      control({ clipId: 'clip-title', cardId: 'particles', label: `${salt}:title`, capabilities: stateful, start: 0, count: 130 }),
      control({ clipId: 'clip-glass', cardId: 'glass', label: `${salt}:glass`, capabilities: { frameMode: 'stateful', compositing: 'belowDependent' }, start: 2, count: 45 }),
      control({ clipId: 'clip-lower', cardId: 'lowerThird', label: `${salt}:lower`, capabilities: stateful, start: 1, count: 70 }),
      control({ clipId: 'clip-text', cardId: 'text', label: `${salt}:text`, capabilities: { frameMode: 'stateless', compositing: 'independent' }, start: 0, count: 90 }),
    ],
    prerenderSet: new Set(['clip-title', 'clip-glass', 'clip-lower', 'clip-text']),
    streams: [{ streamKey: sha256(`stream:${salt}`), topClipId: 'clip-video', firstSegment: 0, lastSegment: 11 }],
    anchorFrames: [90],
    // Code identity of custom cards: starting from c66-host-cards, only user cards and cards modified
    // in overlay layer are listed; unmodified built-in cards are not here (covered by codeVersion);
    // original { particles: 'builtin:12', lowerThird: 'builtin:3' } was the shape prior to that.
    // From M7 D1, splitter only emits browser portion for built-in cards where "cardSources is empty"
    // (writes input.compositing, required by Rule 7 for browser-only), which I5 browser relies on to
    // claim its own light tasks
    cardSourceVersions: {},
    weightOf: c => ({ class: WEIGHTS[c.clipId] ?? 'medium', estMs: null }),
    isUserCard: () => false,
    isGraphCard: () => false,
  };
}

/**
 * Next version of the same project (I11): only the "lower third" card was modified (its shared
 * key changed); shared keys and track stream keys for other cards remain unchanged.
 * entry.key changes with version (real-world scenario), so key for local-tier frosted-glass card
 * also changes and must be rerendered; shared tier and streams are unaffected.
 */
function planContextV2(salt = 'p1') {
  const ctx = planContextFor(salt);
  ctx.entryKey = sha256(`entry:${salt}:v2`);
  ctx.cardPlan = ctx.cardPlan.map(c => (c.clipId !== 'clip-lower' ? c
    : control({ clipId: 'clip-lower', cardId: 'lowerThird', label: `${salt}:lower:v2`, capabilities: c.capabilities, start: c.start, count: c.count })));
  return ctx;
}

/** Calculate fine-grained tasks this PlanContext should yield per Contract B.4 (taking only fields used in assertions). */
function expectedDerived(ctx, fp) {
  const out = [];
  for (const c of ctx.cardPlan) {
    if (!c.snapshotKey || !c.clipId) continue;
    if (ctx.prerenderSet && !ctx.prerenderSet.has(c.clipId)) continue;
    if (c.tier !== 'shared' && c.tier !== 'local') continue;
    const contentKey = c.tier === 'shared' ? c.snapshotKey : `${ctx.entryKey}/${c.snapshotKey}`;
    const resultKey = resultKeyOf(contentKey, fp);
    for (let from = 0; from < c.count; from += 60) {
      const to = Math.min(c.count - 1, from + 59);
      out.push({
        id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier: c.tier, resultKey, contentKey,
        range: { unit: 'localFrame', from, to }, weightClass: ctx.weightOf(c).class, clipId: c.clipId,
      });
    }
  }
  for (const s of ctx.streams) {
    const resultKey = resultKeyOf(s.streamKey, fp);
    // Sparse stream has one task for the entire stream (rr-motion-preempt rule); full density tasks
    // are split by 8 segments
    out.push({
      id: `stream:${resultKey}:${s.firstSegment}-${s.lastSegment}:sparse`, kind: 'stream', tier: null, resultKey, contentKey: s.streamKey,
      range: { unit: 'segment', from: s.firstSegment, to: s.lastSegment }, weightClass: ctx.weightOf({ clipId: s.topClipId }).class, clipId: s.topClipId,
      density: 'sparse',
    });
    for (let from = s.firstSegment; from <= s.lastSegment; from += 8) {
      const to = Math.min(s.lastSegment, from + 7);
      out.push({
        id: `stream:${resultKey}:${from}-${to}`, kind: 'stream', tier: null, resultKey, contentKey: s.streamKey,
        range: { unit: 'segment', from, to }, weightClass: ctx.weightOf({ clipId: s.topClipId }).class, clipId: s.topClipId,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- Node descriptor (Contract B.2)

const CARD_VERSIONS = { particles: ['builtin:12'], lowerThird: ['builtin:3'] };

function pcNode(fp, userId) {
  return {
    profile: 'pc', userId, envFingerprint: fp, codeVersions: [CV], cardSourceVersions: CARD_VERSIONS,
    capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 16_000 },
  };
}
function browserNode(fp, userId) {
  return {
    profile: 'browser', userId, envFingerprint: fp, codeVersions: [CV], cardSourceVersions: CARD_VERSIONS,
    capabilities: { transcode: false, userCards: false, graphCards: false, memoryMB: 1_500 },
  };
}

// ---------------------------------------------------------------- Assembly

/**
 * An in-process environment. `clock`, `sink`, and `exec` can be reused from the previous set
 * (I10 queue restart: artifact store and executor outlive the queue).
 */
function createRig({ epoch = 'epoch-1', clock, sink, exec, planContext } = {}) {
  clock ??= createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch });
  lb.attach(queue);
  sink ??= createArtifactSink();
  exec ??= createFakeExecutor({ clock, planContext: planContext ?? (task => planContextFor(task.source.projectId)) });
  const nodes = [];
  const pages = [];

  function addPage(name, { userId = 'u1', tenantId = 't1', publisherId = `page-${name}` } = {}) {
    const ep = lb.connect(`conn-${name}`, { userId, tenantId });
    const inbox = [];
    ep.onMessage(m => { inbox.push(m); });
    ep.send({ type: 'publisher.hello', publisherId });
    const page = {
      name, ep, inbox, publisherId, connId: ep.connId,
      publishPlan(projectId, projectRev, priority = 0) { ep.send({ type: 'task.publish', tasks: [planTaskInput(projectId, projectRev, priority)] }); },
      of: type => inbox.filter(m => m.type === type),
      doneCount: id => inbox.filter(m => m.type === 'task.done' && m.id === id).length,
      done: id => inbox.find(m => m.type === 'task.done' && m.id === id),
      failedOf: id => inbox.filter(m => m.type === 'task.failed' && m.id === id),
    };
    pages.push(page);
    return page;
  }

  function addNode(nodeId, { fp = FP_A, profile = 'pc', userId = 'u9', tenantId = 't1', maxConcurrent = 1, seed = 1, node, projects } = {}) {
    const ep = lb.connect(`conn-${nodeId}`, { userId, tenantId });
    const rec = { nodeId, ep, connId: ep.connId, fp, idle: true, ticking: true, stopped: false, events: [] };
    rec.node = node ?? (profile === 'browser' ? browserNode(fp, userId) : pcNode(fp, userId));
    rec.local = createLocalNode({
      nodeId, node: rec.node, endpoint: ep,
      now: clock.now, random: seeded(seed), isIdle: () => rec.idle, maxConcurrent,
      codeVersion: CV, executor: exec.forNode(nodeId), sink,
      ...(projects ? { projects } : {}),   // M6c X3: browser-only cannot watch 'all' and must list projects
      onEvent: event => { rec.events.push(event); },
    });
    rec.eventsOf = type => rec.events.filter(e => e.type === type);
    rec.stop = () => { rec.stopped = true; rec.local.stop(); };
    nodes.push(rec);
    return rec;
  }

  /** All delivered queue → endpoint messages of a given type: [{ connId, message, index }] */
  function out(type) {
    return lb.log().map((e, index) => ({ ...e, index })).filter(e => e.dir === 'out' && e.message.type === type);
  }
  /** All delivered endpoint → queue messages of a given type */
  function inbound(type) {
    return lb.log().map((e, index) => ({ ...e, index })).filter(e => e.dir === 'in' && e.message.type === type);
  }
  const task = id => queue.describe().tasks.find(t => t.id === id) ?? null;

  return { clock, lb, queue, sink, exec, nodes, pages, addPage, addNode, out, inbound, task };
}

/** Deliver to convergence: flush → yield event loop until no pending messages (giving async continuations ample chance). */
async function settle(rig) {
  for (let round = 0; round < 1_000; round++) {
    rig.lb.flush();
    await new Promise(resolve => setImmediate(resolve));
    if (rig.lb.pending() === 0) {
      await new Promise(resolve => setImmediate(resolve));
      if (rig.lb.pending() === 0) return;
    }
  }
  throw new Error('message round trips do not converge');
}

/** Wait for `promise` to settle, yielding at most `turns` event loop turns (without advancing fake clock); fails if still unsettled. */
async function within(promise, what, turns = 50) {
  let settledFlag = false;
  const guarded = Promise.resolve(promise).finally(() => { settledFlag = true; });
  for (let i = 0; i < turns && !settledFlag; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(settledFlag, what);
  return guarded;
}

/** One tick: flush / yield → tick each node → queue.tick (deliver to convergence after each step). */
async function beat(rig, onStep, step) {
  await settle(rig);
  if (onStep) {
    await onStep(step);
    await settle(rig);
  }
  for (const n of rig.nodes) if (n.ticking && !n.stopped) n.local.tick();
  await settle(rig);
  rig.queue.tick();
  await settle(rig);
}

/** Drive until `until()` holds; advance fake clock if unsatisfied. Fails and prints describe() if step limit exceeded. */
async function drive(rig, until, { maxSteps = 4_000, stepMs = STEP_MS, onStep } = {}) {
  for (let step = 0; step < maxSteps; step++) {
    await beat(rig, onStep, step);
    if (until()) return step;
    rig.clock.advance(stepMs);
  }
  assert.fail(`condition still not met after more than ${maxSteps} steps; queue.describe():\n${JSON.stringify(rig.queue.describe(), null, 1)}`
    + `\nNodes running: ${JSON.stringify(rig.nodes.map(n => [n.nodeId, n.stopped ? 'stopped' : n.local.running()]))}`);
}

/** After conditions are met, idle for a few more ticks to check for late duplicate completions or similar. */
async function coast(rig, steps = 40, stepMs = STEP_MS) {
  for (let i = 0; i < steps; i++) {
    await beat(rig);
    rig.clock.advance(stepMs);
  }
  await beat(rig);
}

/** All nodes have no work left (nodes in `except` do not count: it holds a stalled execution waiting for the test to release). */
const allRunningEmpty = (rig, except = []) => rig.nodes.every(n => n.stopped || except.includes(n) || n.local.running().length === 0);

/** Hygiene condition that must hold for every test case (D.4, last paragraph). */
function hygiene(rig, { unhandledBefore = 0 } = {}) {
  assert.deepEqual(rig.lb.errors().map(e => String(e?.stack ?? e)), [], 'The endpoint handler / queue.handle threw an exception');
  assert.deepEqual(rig.lb.nonJson(), [], 'some message cannot round-trip through JSON');
  for (const e of rig.lb.log()) {
    assert.deepEqual(JSON.parse(JSON.stringify(e.message)), e.message, `Message changed after JSON round trip: ${JSON.stringify(e.message)}`);
  }
  const errors = rig.out('error').map(e => [e.connId, e.message]);
  assert.deepEqual(errors, [], 'Queue replied with an error (format error or wrong role)');
  assert.deepEqual(rig.sink.misuse(), [], 'Output store received a call that does not conform to D.1');
  assert.deepEqual(rig.exec.errors().map(String), [], 'The executor\'s progress callback threw an exception');
  assert.deepEqual(unhandled.slice(unhandledBefore).map(e => String(e?.stack ?? e)), [], 'there are unhandled Promise rejections');
}

/** For each id: exactly one task.done on the page, queue replied with task.completed once, done in describe. */
function assertCompletedOnce(rig, page, ids) {
  const completed = counts(rig.out('task.completed').map(e => e.message.id));
  const view = new Map(rig.queue.describe().tasks.map(t => [t.id, t]));
  for (const id of ids) {
    assert.equal(page.doneCount(id), 1, `${id}: the page should receive exactly one task.done, got ${page.doneCount(id)}`);
    assert.equal(completed.get(id) ?? 0, 1, `${id}: the queue should acknowledge completion exactly once, got ${completed.get(id) ?? 0}`);
    assert.equal(view.get(id)?.state, 'done', `${id}: should be done in describe`);
  }
}

/** Records of successful claims: [{ connId, id, task }] */
const claimsOf = rig => rig.out('task.claimed').map(e => ({ connId: e.connId, id: e.message.id, task: e.message.task, index: e.index }));

/** Every id on the page received task.done, and nodes have no work left (for `except`, see allRunningEmpty). */
const allDone = (rig, page, ids, except = []) => () => ids.every(id => page.doneCount(id) >= 1) && allRunningEmpty(rig, except);

// ================================================================ I1

test('I1 full pipeline: the page publishes a plan, two pc nodes claim, split, execute, push output and report completion; the page receives all task.done', async () => {
  const before = unhandled.length;
  const rig = createRig();
  const page = rig.addPage('page', { userId: 'u1', tenantId: 't1', publisherId: 'page-u1' });
  // The node's connection credential is for another user (same tenant): fine-grained tasks' userId
  // should inherit from the plan's (the page's), not the splitting node's
  const a = rig.addNode('node-a', { fp: FP_A, userId: 'u9', seed: 1 });
  const b = rig.addNode('node-b', { fp: FP_A, userId: 'u9', seed: 2 });
  a.local.start();
  b.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);

  const planId = planIdOf('p1', 1);
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  assert.equal(expected.length, 9, 'The fixture should split out 9 fine-grained tasks (6 snapshots, 1 sparse stream, 2 full-density streams)');
  assert.ok(expected.some(t => t.kind === 'snapshot') && expected.some(t => t.kind === 'stream'));
  const ids = [planId, ...expected.map(t => t.id)];

  await drive(rig, allDone(rig, page, ids));
  await coast(rig);

  // Exactly one node claims and splits the plan
  const planClaims = claimsOf(rig).filter(c => c.id === planId);
  assert.equal(planClaims.length, 1, 'plan should be claimed exactly once');
  const splitter = rig.nodes.find(n => n.connId === planClaims[0].connId);
  const splits = rig.nodes.flatMap(n => n.eventsOf('plan-split').map(e => ({ nodeId: n.nodeId, e })));
  assert.equal(splits.length, 1, 'Should be split exactly once');
  assert.equal(splits[0].nodeId, splitter.nodeId);
  assert.equal(splits[0].e.id, planId);
  assert.deepEqual(sorted(splits[0].e.derived), sorted(expected.map(t => t.id)));
  assert.equal(rig.exec.calls({ kind: 'plan' }).length, 1, 'executor.plan is called only once');

  // plan's task.done: result = { ranges: null, derived } (D.2, step 4)
  const planDone = page.done(planId);
  assert.equal(planDone.result.ranges, null);
  assert.deepEqual(sorted(planDone.result.derived), sorted(expected.map(t => t.id)));

  // Each task completes exactly once
  assertCompletedOnce(rig, page, ids);
  const view = rig.queue.describe();
  assert.deepEqual(sorted(view.tasks.map(t => t.id)), sorted(ids));
  for (const t of view.tasks) {
    assert.equal(t.state, 'done', t.id);
    assert.equal(t.attempts, 0, `${t.id} attempts`);
  }
  assert.equal(rig.out('task.lease-lost').length, 0, 'No claim should be lost on the happy path');

  // Fine-grained tasks: inherit the page's user and subscription; fingerprint and code version are
  // from the splitting node
  const derivedClaims = claimsOf(rig).filter(c => c.id !== planId);
  assert.deepEqual(sorted(derivedClaims.map(c => c.id)), sorted(expected.map(t => t.id)), 'Each fine-grained task is claimed exactly once');
  for (const { id, task } of derivedClaims) {
    const exp = expected.find(t => t.id === id);
    assert.equal(task.kind, exp.kind, id);
    assert.equal(task.resultKey, exp.resultKey, id);
    assert.deepEqual(task.range, exp.range, id);
    assert.equal(task.source.userId, 'u1', `${id}: source.userId should be the page's user`);
    assert.equal(task.source.tenantId, 't1', id);
    assert.equal(task.source.projectId, 'p1', id);
    assert.equal(task.source.projectRev, 1, id);
    assert.equal(task.source.derivedFrom, planId, id);
    assert.equal(task.source.publisher.id, splitter.nodeId, `${id}: the publisher is the splitter node (publisherId defaults to nodeId)`);
    assert.equal(task.requires.envFingerprint, FP_A, id);
    assert.equal(task.requires.codeVersion, CV, id);
  }
  for (const t of view.tasks.filter(t => t.id !== planId)) {
    assert.ok(t.subscribers.includes('page-u1'), `${t.id}: the page should inherit the subscription`);
  }

  // Artifact store: every segment of each result key exists, each segment was pushed exactly once,
  // and accounting info matches the completer
  const completer = new Map(rig.out('task.completed').map(e => [e.message.id, rig.nodes.find(n => n.connId === e.connId).nodeId]));
  for (const t of expected) {
    assert.ok(rig.sink.holds(t.resultKey, t.range), `${t.id}: the output store should hold this segment`);
    // For a single stream, the sparse stream task and full-density task push the same key and segment,
    // each pushed once: count separately by task id
    const puts = rig.sink.puts().filter(p => p.resultKey === t.resultKey && p.range.from === t.range.from && p.range.to === t.range.to && p.meta?.taskId === t.id);
    assert.equal(puts.length, 1, `${t.id}: should be pushed exactly once`);
    assert.equal(puts[0].meta.taskId, t.id);
    assert.equal(puts[0].meta.nodeId, completer.get(t.id), `${t.id}: meta.nodeId should be the node that completed it`);
    assert.ok(Number.isInteger(puts[0].meta.token));
    assert.equal(rig.exec.renderCount(t.id), 1, `${t.id}: should be rendered exactly once`);
    assert.deepEqual(page.done(t.id).result.ranges, [[t.range.from, t.range.to]], `${t.id}: ranges`);
    assert.equal(page.done(t.id).resultKey, t.resultKey);
  }
  // Artifact store saves by "result key + range" (same as writeManifest): one entry for each task's own key;
  // sparse stream has one task for the whole stream, also written at 8 segments per bucket,
  // those buckets share the same key and entry with full-density tasks, full density overwriting sparse
  const keyOf = t => `${t.resultKey}#${t.range.from}-${t.range.to}`;
  assert.equal(rig.sink.entries().length, new Set(expected.map(keyOf)).size);
  for (const t of expected.filter(x => x.kind === 'stream' && !x.density)) {
    assert.ok(rig.sink.stores(t.resultKey, t.range), `${t.id}: the key (also the bucket) of the full-density task is stored`);
    assert.notEqual(rig.sink.entries().find(e => keyOf(e) === keyOf(t)).sparse, true, `${t.id}: the bucket is the full-density version`);
  }
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I2

test('I2 The output store already has some of the results: those segments skip executor.render and complete directly (dedup); the rest render as usual', async () => {
  const before = unhandled.length;
  const rig = createRig();
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  // Pre-populate three segments: title segment 1, lower third segment 2, track stream segment 2
  const seeded3 = [
    expected.find(t => t.clipId === 'clip-title' && t.range.from === 0),
    expected.find(t => t.clipId === 'clip-lower' && t.range.from === 60),
    expected.find(t => t.kind === 'stream' && t.range.from === 8 && !t.density),
  ];
  assert.ok(seeded3.every(Boolean));
  for (const t of seeded3) rig.sink.seed({ resultKey: t.resultKey, range: t.range });
  // Pre-populate three segments: title segment 1, lower third segment 2, track stream segment 2
  // (sparse stream whole stream 0-11 and full density 8-11 have different ranges; matches 3 items here)
  const seededAll = expected.filter(t => seeded3.some(s => s.resultKey === t.resultKey && s.range.from === t.range.from && s.range.to === t.range.to));
  assert.equal(seededAll.length, 3);

  // Publish this one first, then have nodes check in: nodes see the plan via queue.snapshot
  const page = rig.addPage('page', { publisherId: 'page-u1' });
  await settle(rig);
  page.publishPlan('p1', 1);
  await settle(rig);
  const a = rig.addNode('node-a', { seed: 3 });
  const b = rig.addNode('node-b', { seed: 4 });
  a.local.start();
  b.local.start();

  const planId = planIdOf('p1', 1);
  const ids = [planId, ...expected.map(t => t.id)];
  await drive(rig, allDone(rig, page, ids));
  await coast(rig);

  assertCompletedOnce(rig, page, ids);
  const dedupIds = rig.nodes.flatMap(n => n.eventsOf('dedup').map(e => e.id));
  for (const t of seededAll) {
    assert.equal(rig.exec.renderCount(t.id), 0, `${t.id}: already in the output store, should not render`);
    assert.equal(page.done(t.id).result.dedup, true, `${t.id}: the result of task.done should carry dedup: true`);
    assert.deepEqual(page.done(t.id).result.ranges, [[t.range.from, t.range.to]]);
    assert.equal(rig.sink.puts().filter(p => p.meta?.taskId === t.id).length, 0, `${t.id}: should not push output again`);
    assert.ok(dedupIds.includes(t.id), `${t.id}: should report a dedup event`);
  }
  for (const t of expected.filter(t => !seededAll.includes(t))) {
    assert.equal(rig.exec.renderCount(t.id), 1, `${t.id}: should be rendered exactly once`);
    assert.notEqual(page.done(t.id).result.dedup, true, `${t.id}: was not completed by dedup`);
    assert.ok(rig.sink.holds(t.resultKey, t.range));
  }
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I3

test('I3 A node disconnects during execution (close after partition): after the grace period another node takes over and completes the task; the late result from the disconnected node is discarded', async () => {
  const before = unhandled.length;
  const rig = createRig();
  // Fine-grained task rendering on node-a is unconditionally stalled (until the test releases it),
  // so that when it disconnects it is guaranteed to hold a running task
  rig.exec.on((task, { nodeId }) => nodeId === 'node-a' && task.kind !== 'plan', { hang: true });
  const page = rig.addPage('page', { publisherId: 'page-u1' });
  const a = rig.addNode('node-a', { seed: 5 });
  const b = rig.addNode('node-b', { seed: 6 });
  a.local.start();
  b.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);

  const planId = planIdOf('p1', 1);
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  const ids = [planId, ...expected.map(t => t.id)];

  // 1) Wait until node-a holds a stalled fine-grained task
  await drive(rig, () => rig.exec.hung().some(c => c.nodeId === 'node-a'));
  const victim = rig.exec.hung().find(c => c.nodeId === 'node-a').id;
  assert.ok(a.local.running().includes(victim));
  const token = a.local.session.held().find(h => h.id === victim)?.token;
  assert.ok(Number.isInteger(token), 'node-a should hold victim at this moment');

  // 2) Partition: drop messages in both directions; close connection after 2 seconds
  rig.lb.partition(a.connId);
  const cutIndex = rig.lb.log().length;
  for (let i = 0; i < 8; i++) { await beat(rig); rig.clock.advance(STEP_MS); }
  a.ep.close();
  const closedAt = rig.clock.now();

  // 3) Reclaimed after grace period, and another node takes over to complete
  let reclaimedAt = null;
  let reclaimError = null;
  // node-a's stalled execution is not released until step 4, so do not wait for its running table to clear here
  await drive(rig, allDone(rig, page, ids, [a]), {
    onStep: () => {
      const t = rig.task(victim);
      if (reclaimedAt === null && t && t.attempts === 1) {
        reclaimedAt = rig.clock.now();
        reclaimError = t.lastError;
      }
    },
  });
  assert.ok(reclaimedAt !== null, 'victim should have been reclaimed');
  assert.ok(reclaimedAt - closedAt > RECONNECT_GRACE_MS, `Should be reclaimed only after the grace period (${RECONNECT_GRACE_MS} ms), actual ${reclaimedAt - closedAt} ms`);
  // Reclamation occurs during queue.tick of a tick and is read at the start of the next tick,
  // so the upper bound is relaxed by three ticks
  assert.ok(reclaimedAt - closedAt <= RECONNECT_GRACE_MS + 3 * STEP_MS, 'Should be reclaimed as soon as the grace period is over');
  assert.equal(reclaimError, 'disconnected');
  const finisher = rig.out('task.completed').filter(e => e.message.id === victim);
  assert.equal(finisher.length, 1);
  assert.equal(finisher[0].connId, b.connId, 'victim should be completed by another node');
  assert.equal(rig.task(victim).attempts, 1);

  // 4) Release node-a's stalled render: thinking it still holds it, the late completion report is
  // sent over the closed connection and dropped
  assert.equal(rig.exec.release({ nodeId: 'node-a' }), 1);
  await coast(rig);
  const lateFromA = rig.lb.log().slice(cutIndex).filter(e => e.dir === 'in' && e.connId === a.connId);
  assert.deepEqual(lateFromA, [], 'Not a single message from node-a should reach the queue after the partition');
  assert.deepEqual(a.local.running(), [], 'node-a\'s execution should settle after unblocking');
  assertCompletedOnce(rig, page, ids);
  for (const t of rig.queue.describe().tasks) assert.equal(t.state, 'done', t.id);
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I4

test('I4 Execution failure: a retryable failure succeeds after failing once (attempts 1); a non-retryable one enters failed and the page receives task.failed', async () => {
  const before = unhandled.length;
  const rig = createRig();
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  const retryId = expected.find(t => t.kind === 'stream' && t.range.from === 0).id;
  const fatalId = expected.find(t => t.clipId === 'clip-glass').id;
  rig.exec.on(retryId, { fail: { retryable: true, message: 'gpu-hiccup' }, times: 1 });
  rig.exec.on(fatalId, { fail: { retryable: false, message: 'card-crashed' } });

  const page = rig.addPage('page', { publisherId: 'page-u1' });
  const a = rig.addNode('node-a', { seed: 7 });
  const b = rig.addNode('node-b', { seed: 8 });
  a.local.start();
  b.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);

  const planId = planIdOf('p1', 1);
  const okIds = [planId, ...expected.map(t => t.id).filter(id => id !== fatalId)];
  await drive(rig, () => allDone(rig, page, okIds)() && page.failedOf(fatalId).length > 0);
  await coast(rig);

  assertCompletedOnce(rig, page, okIds);
  // Retryable: fails once, completes after retry
  assert.equal(rig.task(retryId).state, 'done');
  assert.equal(rig.task(retryId).attempts, 1);
  assert.equal(rig.exec.renderCount(retryId), 2);
  assert.equal(page.failedOf(retryId).length, 0, 'A retryable failure should not notify task.failed');
  const retryFails = rig.inbound('task.fail').filter(e => e.message.id === retryId);
  assert.equal(retryFails.length, 1);
  assert.equal(retryFails[0].message.error, 'gpu-hiccup');
  assert.notEqual(retryFails[0].message.retryable, false);

  // Non-retryable: fails directly with failed, page receives one task.failed
  const fatal = rig.task(fatalId);
  assert.equal(fatal.state, 'failed');
  assert.equal(fatal.attempts, 1);
  assert.equal(fatal.lastError, 'card-crashed');
  assert.equal(rig.exec.renderCount(fatalId), 1, 'A non-retryable one should not render again');
  const failedMsgs = page.failedOf(fatalId);
  assert.equal(failedMsgs.length, 1);
  assert.equal(failedMsgs[0].error, 'card-crashed');
  assert.equal(page.doneCount(fatalId), 0);
  const fatalFails = rig.inbound('task.fail').filter(e => e.message.id === fatalId);
  assert.equal(fatalFails.length, 1);
  assert.equal(fatalFails[0].message.retryable, false);
  assert.ok(rig.nodes.some(n => n.eventsOf('failed').some(e => e.id === fatalId)), 'Should report a failed event');
  assert.ok(!rig.sink.holds(expected.find(t => t.id === fatalId).resultKey, expected.find(t => t.id === fatalId).range));

  // Rest as usual: attempts 0
  for (const t of rig.queue.describe().tasks) {
    if (t.id !== retryId && t.id !== fatalId) assert.equal(t.attempts, 0, t.id);
  }
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I5

test('I5 Browser-only node + pc node, plus another user\'s project: the browser only does the user\'s own light / medium snapshots', async () => {
  const before = unhandled.length;
  const rig = createRig();
  const page1 = rig.addPage('page-u1', { userId: 'u1', tenantId: 't1', publisherId: 'page-u1' });
  const page2 = rig.addPage('page-u2', { userId: 'u2', tenantId: 't1', publisherId: 'page-u2' });
  // Browser ticks first: its claims reach queue first in same tick, ensuring it actually gets work
  // M6c X3: pure browser cannot watch 'all' (returns forbidden); lists two projects (originally defaulted to 'all')
  const br = rig.addNode('node-br', { profile: 'browser', userId: 'u1', fp: FP_A, seed: 9, projects: ['p1', 'p2'] });
  const pc = rig.addNode('node-pc', { profile: 'pc', userId: 'u1', fp: FP_A, seed: 10 });
  br.local.start();
  pc.local.start();
  await settle(rig);
  page1.publishPlan('p1', 1);
  page2.publishPlan('p2', 1);

  const exp1 = expectedDerived(planContextFor('p1'), FP_A);
  const exp2 = expectedDerived(planContextFor('p2'), FP_A);
  const ids1 = [planIdOf('p1', 1), ...exp1.map(t => t.id)];
  const ids2 = [planIdOf('p2', 1), ...exp2.map(t => t.id)];
  assert.equal(new Set([...ids1, ...ids2]).size, ids1.length + ids2.length, 'Task ids of the two projects do not overlap');

  await drive(rig, () => allDone(rig, page1, ids1)() && ids2.every(id => page2.doneCount(id) >= 1));
  await coast(rig);

  assertCompletedOnce(rig, page1, ids1);
  assertCompletedOnce(rig, page2, ids2);

  // What the browser can do: light / medium snapshots of p1
  const eligible = new Set(exp1.filter(t => t.kind === 'snapshot' && (t.weightClass === 'light' || t.weightClass === 'medium')).map(t => t.id));
  assert.ok(eligible.size > 0);
  const brClaims = claimsOf(rig).filter(c => c.connId === br.connId);
  assert.ok(brClaims.length > 0, 'The browser node should claim the user\'s own light tasks');
  for (const { id, task } of brClaims) {
    assert.equal(task.kind, 'snapshot', `${id}: the browser does not claim plan / stream tasks`);
    assert.ok(['light', 'medium'].includes(task.weight.class), `${id}: the browser only claims light / medium`);
    assert.equal(task.source.userId, 'u1', `${id}: the browser only claims the user's own tasks`);
    assert.ok(eligible.has(id), id);
  }
  // Should not even attempt to claim (node local filtering: rules 2, 4, 6; cannot see others' tasks at all)
  const brTries = rig.inbound('task.claim').filter(e => e.connId === br.connId).map(e => e.message.id);
  for (const id of brTries) assert.ok(eligible.has(id), `The browser should not try to claim ${id}`);
  const brCompleted = rig.out('task.completed').filter(e => e.connId === br.connId).map(e => e.message.id);
  assert.ok(brCompleted.length > 0);
  for (const id of brCompleted) assert.ok(eligible.has(id), `${id} completed by the browser should be the user's own light / medium snapshot`);

  // Cannot even see others' tasks (contract A.9 visibility, design Q2)
  const own = new Set(ids1);
  for (const e of rig.lb.log().filter(e => e.dir === 'out' && e.connId === br.connId)) {
    const m = e.message;
    const views = m.type === 'queue.snapshot' ? m.tasks : (m.type === 'task.opened' || m.type === 'task.claimed') ? [m.task] : [];
    for (const v of views) assert.equal(v.source.userId, 'u1', `The browser received another user's task ${v.id} (${m.type})`);
    if (['task.taken', 'task.closed', 'task.lease-lost', 'task.claim-rejected'].includes(m.type)) {
      assert.ok(own.has(m.id), `The browser received ${m.type} of another user's task: ${m.id}`);
    }
  }
  // Fine-grained tasks of other users inherit u2, all completed by pc
  for (const c of claimsOf(rig).filter(c => ids2.includes(c.id))) {
    assert.equal(c.connId, pc.connId);
    if (c.task.kind !== 'plan') assert.equal(c.task.source.userId, 'u2', c.id);
  }
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I6

test('I6 pc nodes with two different environment fingerprints: in the first round the fine-grained tasks are claimed only by nodes with the same fingerprint as the plan claimant; in the second round the cards locked by the first round are keyed with the lock owner\'s fingerprint and finished by nodes with the lock owner\'s fingerprint (contract F.7); PlanContext cannot override the fingerprints of the splitter node and the lock', async () => {
  const before = unhandled.length;
  // PlanContext returned by executor carries other fingerprints and code versions: D.2 specifies
  // that splitting node's own fingerprint and code version must take effect
  const rig = createRig({
    planContext: task => ({ ...planContextFor(task.source.projectId), envFingerprint: 'ffffffffffffffff', codeVersion: 'cv-bogus' }),
  });
  const page = rig.addPage('page', { publisherId: 'page-u1' });
  const b1 = rig.addNode('node-b1', { fp: FP_B, seed: 11 });
  const a1 = rig.addNode('node-a1', { fp: FP_A, seed: 12 });
  const a2 = rig.addNode('node-a2', { fp: FP_A, seed: 13 });
  const fpOf = new Map(rig.nodes.map(n => [n.connId, n.fp]));

  // Round 1: only b1 is present, plan claimed by b1 → fingerprint for this version is FP_B
  b1.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);
  const plan1 = planIdOf('p1', 1);
  await drive(rig, () => claimsOf(rig).some(c => c.id === plan1));
  a1.local.start();
  a2.local.start();
  const exp1 = expectedDerived(planContextFor('p1'), FP_B);
  const ids1 = [plan1, ...exp1.map(t => t.id)];
  await drive(rig, allDone(rig, page, ids1));

  // Round 2: b1 is not idle, new version of plan claimed by a1 / a2 (splitting node fingerprint FP_A);
  // after claiming, b1 returns to idle.
  // Round 1 already locked each card and stream to FP_B (per-card fingerprint lock, contract F.1 / F.7):
  // splitting node publish using FP_A is rejected from creation,
  // resend using locking party's fingerprint FP_B: content unchanged, so these are the same batch
  // of tasks from round 1 (already done), page still receives all task.done.
  b1.idle = false;
  page.publishPlan('p1', 2);
  const plan2 = planIdOf('p1', 2);
  await drive(rig, () => claimsOf(rig).some(c => c.id === plan2));
  b1.idle = true;
  const exp2 = expectedDerived(planContextFor('p1'), FP_B);
  const ids2 = [plan2, ...exp2.map(t => t.id)];
  await drive(rig, allDone(rig, page, ids2));
  await coast(rig);

  assertCompletedOnce(rig, page, [...ids1, ...ids2]);
  const claims = claimsOf(rig);
  assert.equal(claims.find(c => c.id === plan1).connId, b1.connId);
  assert.notEqual(claims.find(c => c.id === plan2).connId, b1.connId);

  for (const [round, exp, fp] of [[1, exp1, FP_B], [2, exp2, FP_B]]) {
    const expIds = new Set(exp.map(t => t.id));
    const roundClaims = claims.filter(c => expIds.has(c.id));
    assert.deepEqual(sorted(roundClaims.map(c => c.id)), sorted(expIds), `Round ${round}: each fine-grained task is claimed exactly once`);
    for (const c of roundClaims) {
      assert.equal(fpOf.get(c.connId), fp, `Round ${round}: ${c.id} was claimed by a node with a different fingerprint`);
      assert.equal(c.task.requires.envFingerprint, fp, c.id);
      assert.equal(c.task.requires.codeVersion, CV, c.id);
    }
    // Nodes with different fingerprints should not even attempt (rule 1)
    for (const e of rig.inbound('task.claim').filter(e => expIds.has(e.message.id))) {
      assert.equal(fpOf.get(e.connId), fp, `Round ${round}: a node with a different fingerprint tried to claim ${e.message.id}`);
    }
  }
  // Round 2 derives keys using locking party's fingerprint: same batch of tasks as round 1,
  // no re-render (prior to F.7, asserted result keys of both rounds were distinct and round 2 was all real renders)
  assert.deepEqual(sorted(exp2.map(t => t.id)), sorted(exp1.map(t => t.id)));
  assert.deepEqual(sorted(page.done(plan2).result.derived), sorted(exp2.map(t => t.id)), 'In the second round the plan\'s derived is the batch keyed with the lock fingerprint');
  for (const t of [...exp1, ...exp2]) assert.ok(rig.sink.holds(t.resultKey, t.range), t.id);
  for (const t of exp2) assert.equal(rig.exec.renderCount(t.id), 1, t.id);
  assert.equal(rig.nodes.flatMap(n => n.eventsOf('dedup')).length, 0);
  // Tasks deriving keys with splitting node's own fingerprint (FP_A) are rejected from creation,
  // leaving no dead tasks in the queue that no one can claim
  const deadIds = new Set(expectedDerived(planContextFor('p1'), FP_A).map(t => t.id));
  assert.deepEqual(rig.queue.describe().tasks.filter(t => deadIds.has(t.id)).map(t => t.id), []);
  assert.equal(claims.filter(c => deadIds.has(c.id)).length, 0);
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I7

test('I7 An executing node becomes not idle and yieldAll is called: the task is put back (attempts not incremented) and completed by another node; the yielding node\'s execution is aborted and its result discarded', async () => {
  const before = unhandled.length;
  const rig = createRig();
  // node-a renders slowly, making it easy to yield mid-execution
  rig.exec.on((task, { nodeId }) => nodeId === 'node-a', { durationMs: 4_000 });
  const page = rig.addPage('page', { publisherId: 'page-u1' });
  const a = rig.addNode('node-a', { seed: 14 });
  const b = rig.addNode('node-b', { seed: 15 });
  a.local.start();
  b.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);

  const planId = planIdOf('p1', 1);
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  const ids = [planId, ...expected.map(t => t.id)];

  let victim = null;
  let releaseIndex = null;
  await drive(rig, () => victim !== null && allDone(rig, page, ids)(), {
    onStep: async () => {
      if (victim !== null) return;
      const call = rig.exec.calls({ kind: 'render', nodeId: 'node-a' }).find(c => c.state === 'running');
      if (!call) return;
      victim = call.id;
      // User starts playback: not idle, release all tasks in hand
      a.idle = false;
      a.local.yieldAll('playing');
      await settle(rig);
      releaseIndex = rig.inbound('task.release').find(e => e.connId === a.connId && e.message.id === victim)?.index ?? null;
    },
  });

  assert.ok(victim, 'node-a should have yielded in the middle of execution');
  assert.ok(releaseIndex !== null, 'node-a should send task.release for victim');
  assert.equal(rig.inbound('task.release').find(e => e.index === releaseIndex).message.reason, 'playing');
  // Releasing does not count as failure (C2): attempts not incremented; open(1) → claimed(2) → open(3) → claimed(4) → done(5)
  const t = rig.task(victim);
  assert.equal(t.state, 'done');
  assert.equal(t.attempts, 0);
  assert.equal(t.version, 5);
  const finisher = rig.out('task.completed').filter(e => e.message.id === victim);
  assert.equal(finisher.length, 1);
  assert.equal(finisher[0].connId, b.connId, 'victim should be completed by another node');

  // Yielding node: execution aborted, result discarded, sends no further messages for victim,
  // and did not push to artifact store
  const aCall = rig.exec.calls({ kind: 'render', nodeId: 'node-a', id: victim })[0];
  assert.equal(aCall.abortSeen, true, 'node-a\'s execution should be aborted');
  assert.ok(a.eventsOf('discarded').some(e => e.id === victim), 'node-a should report discarded');
  const afterRelease = rig.lb.log().slice(releaseIndex + 1).filter(e => e.dir === 'in' && e.connId === a.connId && e.message.id === victim);
  assert.deepEqual(afterRelease, [], 'node-a should not send any more messages for victim after putting it back');
  assert.equal(rig.sink.puts().filter(p => p.meta?.taskId === victim && p.meta?.nodeId === 'node-a').length, 0);
  assert.ok(!a.local.running().includes(victim));
  assert.deepEqual(a.local.session.held(), []);
  await coast(rig);
  assertCompletedOnce(rig, page, ids);
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I8

/**
 * Shared part of I8: fine-grained task rendering on node-a is unconditionally stalled (reports no
 * progress, ignores abort); wait until it holds a stalled task, then `onHang(a)`, drive until
 * reclaimed and another node completes; finally release stalled render, verifying late results
 * are discarded.
 */
async function runHungNode({ seedA, seedB, onHang }) {
  const before = unhandled.length;
  const rig = createRig();
  rig.exec.on((task, { nodeId }) => nodeId === 'node-a' && task.kind !== 'plan', { hang: true });
  const page = rig.addPage('page', { publisherId: 'page-u1' });
  const a = rig.addNode('node-a', { seed: seedA });
  const b = rig.addNode('node-b', { seed: seedB });
  a.local.start();
  b.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);
  const planId = planIdOf('p1', 1);
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  const ids = [planId, ...expected.map(t => t.id)];

  await drive(rig, () => rig.exec.hung().some(c => c.nodeId === 'node-a'));
  const hungCall = rig.exec.hung().find(c => c.nodeId === 'node-a');
  const victim = hungCall.id;
  onHang(a);

  let reclaimedAt = null;
  let reclaimError = null;
  // Execution on the hung node ignores abort and waits for final release, so do not wait for its
  // running table to clear here
  await drive(rig, allDone(rig, page, ids, [a]), {
    onStep: () => {
      const t = rig.task(victim);
      if (reclaimedAt === null && t && t.attempts === 1) {
        reclaimedAt = rig.clock.now();
        reclaimError = t.lastError;
      }
    },
  });
  const lostMsgs = rig.out('task.lease-lost').filter(e => e.connId === a.connId && e.message.id === victim);
  assert.equal(lostMsgs.length, 1, 'The hung node should receive one lease-lost');
  assert.equal(lostMsgs[0].message.reason, reclaimError, 'The reason of lease-lost is the reclaim reason (contract A.12 [ruling])');
  assert.ok(a.eventsOf('lost').some(e => e.id === victim), 'The hung node should report lost');
  assert.equal(rig.exec.hung().find(c => c.id === victim)?.abortSeen, true, 'After losing the claim, the corresponding execution should be aborted');
  const finisher = rig.out('task.completed').filter(e => e.message.id === victim);
  assert.equal(finisher.length, 1);
  assert.equal(finisher[0].connId, b.connId, 'victim should be completed by another node');
  assert.equal(rig.task(victim).attempts, 1);

  // Release stalled render: late results are discarded, no messages sent, and nothing pushed to
  // artifact store
  assert.equal(rig.exec.release({ nodeId: 'node-a' }), 1);
  await coast(rig);
  assert.ok(a.eventsOf('discarded').some(e => e.id === victim), 'A late result should report discarded');
  const lateFromA = rig.lb.log().slice(lostMsgs[0].index + 1).filter(e => e.dir === 'in' && e.connId === a.connId && e.message.id === victim);
  assert.deepEqual(lateFromA, [], 'After losing the claim, the hung node should not send any more messages for victim');
  assert.equal(rig.sink.puts().filter(p => p.meta?.taskId === victim && p.meta?.nodeId === 'node-a').length, 0);
  assert.deepEqual(a.local.running(), [], 'After unblocking, the hung node\'s execution should settle');
  assertCompletedOnce(rig, page, ids);
  hygiene(rig, { unhandledBefore: before });
  return { hungCall, reclaimedAt, reclaimError };
}

test('I8 The executor hangs (reports no progress) while the hung node keeps ticking as usual: STALL_MS after the progress(0) sent at start, the task is reclaimed as a stall and another node completes it; the late result is discarded', async () => {
  const { hungCall, reclaimedAt, reclaimError } = await runHungNode({
    seedA: 16, seedB: 17,
    // Hung node ticks as usual (sends renewals as normal), but claims no new work: avoids grabbing
    // released tasks back and stalling again
    onHang: a => { a.idle = false; },
  });
  assert.equal(reclaimError, 'stalled');
  // On start, progress(0) is at the same moment as starting; progress unchanged thereafter,
  // reclaimed only strictly after STALL_MS (A.8, item 2)
  assert.ok(reclaimedAt - hungCall.startedAt > STALL_MS, `Should be reclaimed after STALL_MS, actual ${reclaimedAt - hungCall.startedAt} ms`);
  assert.ok(reclaimedAt - hungCall.startedAt <= STALL_MS + 3 * STEP_MS, 'Should be reclaimed as soon as STALL_MS has passed');
});

test('I8 supplement: the hung node\'s heartbeat stops too (no more ticks): reclaimed when the lease expires, another node completes it; the late result is discarded', async () => {
  const { hungCall, reclaimedAt, reclaimError } = await runHungNode({
    seedA: 18, seedB: 19,
    onHang: a => { a.ticking = false; },
  });
  assert.equal(reclaimError, 'lease-expired');
  // Claim, progress(0) on start, and stall are in the same tick (same moment); node no longer ticks
  // or renews lease thereafter, so lease expires exactly at that moment + LEASE_MS, reclaimed only
  // strictly after (A.8, item 1)
  assert.ok(reclaimedAt - hungCall.startedAt > LEASE_MS, `Reclaimed too early: ${reclaimedAt - hungCall.startedAt} ms`);
  assert.ok(reclaimedAt - hungCall.startedAt <= LEASE_MS + 3 * STEP_MS, `Should be reclaimed as soon as the lease ends, actual ${reclaimedAt - hungCall.startedAt} ms`);
});

// ================================================================ I9

test('I9 The output store receives a push only partially (failNextPut): the task reports failure, is retried and completes; in the end each segment completes exactly once', async () => {
  const before = unhandled.length;
  const rig = createRig();
  rig.sink.failNextPut(2);
  const page = rig.addPage('page', { publisherId: 'page-u1' });
  const a = rig.addNode('node-a', { seed: 20 });
  const b = rig.addNode('node-b', { seed: 21 });
  a.local.start();
  b.local.start();
  await settle(rig);
  page.publishPlan('p1', 1);

  const planId = planIdOf('p1', 1);
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  const ids = [planId, ...expected.map(t => t.id)];
  await drive(rig, allDone(rig, page, ids));
  await coast(rig);

  assertCompletedOnce(rig, page, ids);
  const badPuts = rig.sink.puts().filter(p => !p.complete);
  assert.equal(badPuts.length, 2);
  const failures = counts(badPuts.map(p => p.meta.taskId));
  const fails = rig.inbound('task.fail');
  assert.equal(fails.length, 2, 'Each partial receipt should report one failure');
  for (const e of fails) {
    assert.equal(e.message.error, 'sink-incomplete');
    assert.notEqual(e.message.retryable, false, 'A partial receipt is handled as retryable');
  }
  assert.deepEqual(sorted(fails.map(e => e.message.id)), sorted(badPuts.map(p => p.meta.taskId)));
  for (const [id, n] of failures) {
    assert.equal(rig.task(id).state, 'done', id);
    assert.equal(rig.task(id).attempts, n, `${id}: attempts should equal the number of partial receipts`);
    assert.equal(rig.exec.renderCount(id), n + 1, `${id}: must re-render after a partial receipt`);
  }
  for (const t of expected) {
    assert.ok(rig.sink.holds(t.resultKey, t.range), t.id);
    if (!failures.has(t.id)) assert.equal(rig.task(t.id).attempts, 0, t.id);
  }
  assert.equal(page.of('task.failed').length, 0);
  hygiene(rig, { unhandledBefore: before });
});

// ================================================================ I10

test('I10 Queue restart (new instance, new epoch): everything completes after the page republishes; segments already in the output store go through dedup and are not rendered again', async () => {
  const before = unhandled.length;
  // Part 1: ran halfway (at least two fine-grained tasks completed, some still rendering)
  const rig1 = createRig({ epoch: 'epoch-1' });
  rig1.exec.on(() => true, { durationMs: 2_000 });
  const page1 = rig1.addPage('page', { publisherId: 'page-u1' });
  const a1 = rig1.addNode('node-a', { seed: 22 });
  const b1 = rig1.addNode('node-b', { seed: 23 });
  a1.local.start();
  b1.local.start();
  await settle(rig1);
  page1.publishPlan('p1', 1);
  const planId = planIdOf('p1', 1);
  const expected = expectedDerived(planContextFor('p1'), FP_A);
  const derivedIds = expected.map(t => t.id);
  await drive(rig1, () => derivedIds.filter(id => page1.doneCount(id) > 0).length >= 2
    && rig1.exec.calls({ kind: 'render' }).some(c => c.state === 'running'));
  hygiene(rig1, { unhandledBefore: before });

  // Document service restart: old connections all severed, node instances stopped (running tasks
  // aborted, sending no messages)
  const heldBefore = a1.local.session.held();
  a1.stop();
  b1.stop();
  await settle(rig1);
  assert.equal(rig1.lb.pending(), 0, 'A stopped node should not send any more messages');
  // stop aborts running tasks; fake executor rejects abort immediately, so settled() should settle
  // within a few event loop turns (without advancing clock)
  await within(Promise.all([a1.local.settled(), b1.local.settled()]), 'settled() should settle after stop() (running tasks are aborted)');
  await settle(rig1);
  assert.equal(rig1.lb.pending(), 0, 'A stopped node should not send any more messages');
  assert.deepEqual([...a1.local.running(), ...b1.local.running()], [], 'No tasks should still be running after stop()');
  const inSink = new Set(expected.filter(t => rig1.sink.holds(t.resultKey, t.range)).map(t => t.id));
  assert.ok(inSink.size >= 2, 'The output store should already contain segments before the restart');
  assert.ok(inSink.size < expected.length, 'There should still be unfinished segments before the restart');
  const rendersBefore = new Map(derivedIds.map(id => [id, rig1.exec.renderCount(id)]));

  // Part 2: new queue (new epoch), artifact store and executor reused; page reconnects and
  // republishes under same publisher identity
  const rig2 = createRig({ epoch: 'epoch-2', clock: rig1.clock, sink: rig1.sink, exec: rig1.exec });
  const page2 = rig2.addPage('page', { publisherId: 'page-u1' });
  const a2 = rig2.addNode('node-a', { seed: 24 });
  const b2 = rig2.addNode('node-b', { seed: 25 });
  // New process instance uses old claim to resume: running table is empty, resume' is empty (D.2 ruling)
  a2.local.start(heldBefore);
  b2.local.start();
  await settle(rig2);
  page2.publishPlan('p1', 1);
  const ids = [planId, ...derivedIds];
  await drive(rig2, allDone(rig2, page2, ids));
  await coast(rig2);

  assert.equal(rig2.queue.describe().epoch, 'epoch-2');
  assert.notEqual(rig1.queue.describe().epoch, rig2.queue.describe().epoch);
  for (const m of page2.inbox) assert.equal(m.epoch, 'epoch-2', `${m.type} should carry the new epoch`);
  const hello = rig2.inbound('node.hello').find(e => e.connId === a2.connId);
  assert.deepEqual(hello.message.resume ?? [], [], 'The new instance does not resume the old queue\'s claims');

  assertCompletedOnce(rig2, page2, ids);
  for (const t of rig2.queue.describe().tasks) assert.equal(t.state, 'done', t.id);
  for (const t of expected) {
    const done = page2.done(t.id);
    if (inSink.has(t.id)) {
      assert.equal(done.result.dedup, true, `${t.id}: already in the output store before the restart, should go through dedup`);
      assert.equal(rig2.exec.renderCount(t.id), rendersBefore.get(t.id), `${t.id}: should not be rendered again`);
    } else {
      assert.notEqual(done.result.dedup, true, `${t.id}: partially received before the restart, should re-render`);
      assert.equal(rig2.exec.renderCount(t.id), rendersBefore.get(t.id) + 1, `${t.id}: rendered exactly once after the restart`);
    }
    assert.ok(rig2.sink.holds(t.resultKey, t.range), t.id);
  }
  hygiene(rig2, { unhandledBefore: before });
});

// ================================================================ I11

/**
 * Shared assembly for I11: two PlanContext versions v1 / v2, two pages (two tabs of the same user).
 * Page A publishes v1 and v2, page B publishes only v2.
 *
 * Contract A.4 "existing task with same id": do not resend to those already subscribers. Page A has
 * long subscribed to v1 fine-grained tasks via inheritance from v1, so for those unchanged in v2
 * it will not receive a second task.done (it already received one during v1); "resend" falls on
 * page B which only subscribed to v2 plan. Both pages combined cover: no duplicate (A) and resend /
 * merged (B).
 */
function createVersionRig() {
  const rig = createRig({ planContext: task => (task.source.projectRev === 2 ? planContextV2('p1') : planContextFor('p1')) });
  const pageA = rig.addPage('page-a', { userId: 'u1', publisherId: 'page-a' });
  const pageB = rig.addPage('page-b', { userId: 'u1', publisherId: 'page-b' });
  const v1 = expectedDerived(planContextFor('p1'), FP_A);
  const v2 = expectedDerived(planContextV2('p1'), FP_A);
  const v1Ids = new Set(v1.map(t => t.id));
  const unchanged = v2.filter(t => v1Ids.has(t.id));
  const changed = v2.filter(t => !v1Ids.has(t.id));
  // Fixture self-check: title (3 segments) and track stream (2 segments) unchanged; lower third
  // (shared key changed) and frosted glass (local tier key contains entry.key) need re-render
  assert.deepEqual(sorted(new Set(unchanged.map(t => t.clipId))), ['clip-title', 'clip-video']);
  assert.deepEqual(sorted(new Set(changed.map(t => t.clipId))), ['clip-glass', 'clip-lower']);
  const ids1 = [planIdOf('p1', 1), ...v1.map(t => t.id)];
  const ids2 = [planIdOf('p1', 2), ...v2.map(t => t.id)];
  return { rig, pageA, pageB, v1, v2, unchanged, changed, ids1, ids2 };
}

/** Common concluding assertions for I11. */
function assertVersions({ rig, pageA, pageB, v1, v2, unchanged, changed, ids1, ids2 }) {
  // Page A: exactly one task.done for each task of v1 and v2 (unchanged ones received during v1, no duplicates)
  for (const id of new Set([...ids1, ...ids2])) assert.equal(pageA.doneCount(id), 1, `Page A should get exactly one task.done for ${id}`);
  // Page B: exactly one for each task of v2 (unchanged ones rely on merged subscription / resend)
  for (const id of ids2) assert.equal(pageB.doneCount(id), 1, `Page B should get exactly one task.done for ${id}`);
  for (const id of ids1.filter(id => !ids2.includes(id))) assert.equal(pageB.doneCount(id), 0, `Page B did not subscribe to ${id} of v1`);
  assert.equal(pageA.of('task.failed').length + pageB.of('task.failed').length, 0);
  // Result of v2 plan lists all v2 fine-grained tasks (including existing ones)
  assert.deepEqual(sorted(pageB.done(planIdOf('p1', 2)).result.derived), sorted(v2.map(t => t.id)));
  // Each task in queue completed exactly once and was claimed exactly once; unchanged ones are not
  // re-rendered or re-claimed
  const completed = counts(rig.out('task.completed').map(e => e.message.id));
  const claimed = counts(claimsOf(rig).map(c => c.id));
  for (const t of [...v1, ...changed]) {
    assert.equal(completed.get(t.id), 1, `${t.id} should complete exactly once`);
    assert.equal(claimed.get(t.id), 1, `${t.id} should be claimed exactly once`);
    assert.equal(rig.exec.renderCount(t.id), 1, `${t.id} should render exactly once`);
    assert.ok(rig.sink.holds(t.resultKey, t.range), t.id);
  }
  for (const t of unchanged) {
    const d = rig.task(t.id);
    assert.deepEqual([d.state, d.version, d.attempts], ['done', 3, 0], `${t.id}: v2 does not reopen it`);
    assert.deepEqual(pageB.done(t.id).result.ranges, [[t.range.from, t.range.to]]);
    assert.equal(pageB.done(t.id).resultKey, t.resultKey);
    assert.ok(d.subscribers.includes('page-a') && d.subscribers.includes('page-b'), `${t.id} should have the subscriptions of both pages merged in`);
  }
  for (const t of changed) assert.equal(rig.task(t.id).state, 'done', t.id);
}

test('I11 The same page first publishes v1 and everything completes, then publishes v2 (only one card changed): the page gets task.done for all v2 fine-grained tasks, unchanged ones are backfilled without re-rendering, changed ones render as usual', async () => {
  const before = unhandled.length;
  const env = createVersionRig();
  const { rig, pageA, pageB, ids1, ids2 } = env;
  const a = rig.addNode('node-a', { seed: 26 });
  const b = rig.addNode('node-b', { seed: 27 });
  a.local.start();
  b.local.start();
  await settle(rig);

  pageA.publishPlan('p1', 1);
  await drive(rig, allDone(rig, pageA, ids1));
  const bBefore = pageB.inbox.length;

  pageA.publishPlan('p1', 2);
  pageB.publishPlan('p1', 2);
  await drive(rig, () => allDone(rig, pageA, ids2)() && allDone(rig, pageB, ids2)());
  await coast(rig);

  assert.equal(pageB.inbox.slice(0, bBefore).filter(m => m.type === 'task.done').length, 0, 'Page B had subscribed to nothing before v2');
  // Unchanged ones are already done when v2 is published: page B receives resends (A.4 "existing task with same id")
  for (const t of env.unchanged) assert.equal(pageB.doneCount(t.id), 1, `${t.id}: page B should receive the backfilled task.done`);
  assertVersions(env);
  hygiene(rig, { unhandledBefore: before });
});

test('I11 v2\'s plan is split while v1\'s fine-grained tasks are still open / claimed: the page eventually receives their task.done, exactly once', async () => {
  const before = unhandled.length;
  const env = createVersionRig();
  const { rig, pageA, pageB, ids1, ids2 } = env;
  rig.exec.on(() => true, { durationMs: 3_000 });
  const a = rig.addNode('node-a', { seed: 28 });
  const b = rig.addNode('node-b', { seed: 29 });
  a.local.start();
  b.local.start();
  await settle(rig);

  pageA.publishPlan('p1', 1);
  const plan1 = planIdOf('p1', 1);
  const plan2 = planIdOf('p1', 2);
  await drive(rig, () => pageA.doneCount(plan1) > 0);
  // v1 just finished splitting; v2 plan jumps the queue (priority 100, design section 3 "AI panel
  // preview queue jump"), splitting while v1's fine-grained tasks are still in progress
  pageA.publishPlan('p1', 2, 100);
  pageB.publishPlan('p1', 2, 100);
  let statesAtSplit = null;
  await drive(rig, () => {
    if (statesAtSplit === null && pageA.doneCount(plan2) > 0) {
      statesAtSplit = new Map(env.unchanged.map(t => [t.id, rig.task(t.id)?.state]));
    }
    return statesAtSplit !== null;
  });
  const inFlight = [...statesAtSplit].filter(([, s]) => s === 'open' || s === 'claimed').map(([id]) => id);
  assert.ok(inFlight.length > 0, `Precondition: when v2 is split, some unchanged fine-grained tasks should still be open / claimed, actual ${JSON.stringify([...statesAtSplit])}`);

  await drive(rig, () => allDone(rig, pageA, [...ids1, ...ids2])() && allDone(rig, pageB, ids2)());
  await coast(rig);

  for (const id of inFlight) {
    assert.equal(pageA.doneCount(id), 1, `${id}: page A received only one`);
    assert.equal(pageB.doneCount(id), 1, `${id}: page B (merged subscription) received exactly one`);
  }
  assertVersions(env);
  hygiene(rig, { unhandledBefore: before });
});
