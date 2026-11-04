/**
 * Unit tests on the queue side of c10a contract Section 17 (numbered C10A-L17-Q…): semantics of
 * "priority" under "render queue" in `mechanism/document-service.md`.
 * From 2026-10-07 onward, tasks published by online pages are all normal priority; the `backfill`
 * tier has no new publishers; queue and nodes still recognize it solely for legacy pages during
 * deployment transition; these test cases pin down this compatibility.
 *
 *   Q1 Claim order: normal before backfill, same priority by publication order; when picking
 *      candidates, nodes do not touch backfill while normal remains
 *   Q2 Existing task with same result key is not re-created (prerender retry plan task determines
 *      key by clip manifest; duplicate publications only merge)
 *   Q3 If existing is backfill and someone publishes as normal: upgraded to normal (node view
 *      receives new task.opened); opposite does not downgrade
 *   Q4 Legacy clients: missing priority / with integer still treated as normal; shape validation
 *      for prerender retry plan tasks
 *   Q5 Node claiming prerender retry plan task: clips in manifest are split into fine-grained tasks
 *      as heavy cards, fine-grained tasks marked backfill, no stream splitting
 *   Q6 Pipeline: prerender retry registrations merged into prerender set by "project + content identity",
 *      normal plans and track streams do not include them
 *
 * Run: node --test server/test/c10a-l17-queue.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue, backfillPlanTaskOf, backfillSig, priorityBand, isBackfillPlan } from '../render-queue/index.mjs';
import { parseInbound } from '../render-queue/messages.mjs';
import { rankCandidates, pickCandidate } from '../render-node/pick.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { splitPlan } from '../render-node/split.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';

const FP = '0123456789abcdef';
const CV = 'c0de5a';

/** Inbound shape of a snapshot fine-grained task (id determined by content) */
function fineTask(resultKey, priority, projectId = 'p1') {
  const t = {
    id: `snapshot:${resultKey}:0-59`, kind: 'snapshot', tier: 'shared', resultKey, range: { unit: 'localFrame', from: 0, to: 59 },
    source: { projectId, projectRev: 1 }, input: { clipId: `clip-${resultKey}`, contentKey: `ck-${resultKey}` },
    weight: { class: 'heavy', estMs: null, frames: 60 }, requires: {},
  };
  if (priority !== undefined) t.priority = priority;
  return t;
}

/** Directly drive queue: publisher + one pc node (watch 'all'), messages collected per connection */
function rig() {
  let now = 1_000;
  const inbox = new Map();
  const q = createRenderQueue({ now: () => now, send: (connId, msg) => { if (!inbox.has(connId)) inbox.set(connId, []); inbox.get(connId).push(msg); }, epoch: 'e1' });
  q.connect('pub', { userId: 'member' });
  q.handle('pub', { type: 'publisher.hello', publisherId: 'P' });
  q.connect('node', { userId: 'creator' });
  q.handle('node', { type: 'node.hello', nodeId: 'N', profile: 'pc', envFingerprint: FP, codeVersions: [CV] });
  q.handle('node', { type: 'queue.watch', projects: 'all' });
  const take = (connId) => { const list = inbox.get(connId) ?? []; inbox.set(connId, []); return list; };
  return {
    q, take,
    tick(ms) { now += ms; },
    publish(tasks) { q.handle('pub', { type: 'task.publish', tasks, reqId: `r${now}` }); return take('pub').find((m) => m.type === 'task.published'); },
  };
}

test('C10A-L17-Q1 claim order: normal before backfill, and within the same priority by publish order; while normal tasks remain, a node picks not a single backfill', () => {
  const r = rig();
  r.publish([fineTask('b1', 'backfill')]); r.tick(10);
  r.publish([fineTask('n1', 10)]); r.tick(10);
  r.publish([fineTask('b2', 'backfill')]); r.tick(10);
  r.publish([fineTask('n2')]); r.tick(10);            // Legacy client: without priority
  r.publish([fineTask('n3', 'normal')]);
  const opened = r.take('node').filter((m) => m.type === 'task.opened').map((m) => m.task);
  assert.equal(opened.length, 5);
  // Sort: tier (normal first) → integer rank descending → publication order
  assert.deepEqual(rankCandidates(opened).map((t) => t.resultKey), ['n1', 'n2', 'n3', 'b1', 'b2']);
  // Even if random source reaches the last rank, cannot pick backfill: only picks within the top tier
  for (const random of [() => 0, () => 0.5, () => 0.999]) {
    assert.equal(priorityBand(pickCandidate(opened, { k: 8, random }).priority), 'normal');
  }
  // Claim one by one like a real node (k = 1): backfill's turn only after all three normal, backfill by publication order
  const order = [];
  let view = opened;
  while (view.length) {
    const pick = pickCandidate(view, { k: 1 });
    r.q.handle('node', { type: 'task.claim', id: pick.id, expectVersion: pick.version });
    assert.ok(r.take('node').some((m) => m.type === 'task.claimed' && m.id === pick.id), `claim ${pick.id}`);
    order.push(pick.resultKey);
    view = view.filter((t) => t.id !== pick.id);
  }
  assert.deepEqual(order, ['n1', 'n2', 'n3', 'b1', 'b2']);
});

test('C10A-L17-Q2 a task that already exists for the same result key is not started again: republishing fine-grained tasks only merges them; a prerender retry plan task takes its key from the clip manifest', () => {
  const r = rig();
  const first = r.publish([fineTask('k1', 'backfill')]);
  assert.equal(first.results[0].created, true);
  const again = r.publish([fineTask('k1', 'backfill')]);
  assert.equal(again.results[0].created, false);
  assert.equal(r.q.describe().tasks.length, 1);

  // Prerender retry plan task: same manifest (order, duplicates do not matter) gives same key;
  // different manifests give different keys; all differ from normal plan keys
  const a = backfillPlanTaskOf({ projectId: 'p1', projectRev: 4, clips: ['c2', 'c1', 'c1'] });
  const b = backfillPlanTaskOf({ projectId: 'p1', projectRev: 4, clips: ['c1', 'c2'] });
  const c = backfillPlanTaskOf({ projectId: 'p1', projectRev: 4, clips: ['c1'] });
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.notEqual(a.id, 'plan:p1@4');
  assert.equal(backfillSig(['c2', 'c1']), backfillSig(['c1', 'c2', 'c1']));
  assert.deepEqual(a.input.clips, ['c1', 'c2']);
  assert.equal(a.priority, 'backfill');
  assert.ok(isBackfillPlan(a));
  assert.equal(r.publish([a]).results[0].created, true);
  assert.equal(r.publish([b]).results[0].created, false, 'a batch that is still waiting is not started again');
  assert.equal(r.publish([c]).results[0].created, true);
  assert.equal(r.q.describe().tasks.filter((t) => t.id.startsWith('plan:')).length, 2);
});

test('C10A-L17-Q3 an existing backfill task is promoted to normal by a normal publish; normal is not downgraded by a backfill publish', () => {
  const r = rig();
  r.publish([fineTask('u1', 'backfill')]);
  const before = r.take('node').find((m) => m.type === 'task.opened');
  assert.equal(before.task.priority, 'backfill');
  const version = before.task.version;

  const up = r.publish([fineTask('u1', 10)]);
  assert.equal(up.results[0].created, false);
  const reopened = r.take('node').filter((m) => m.type === 'task.opened');
  assert.equal(reopened.length, 1, 'after the promotion the node view receives a new task.opened');
  assert.equal(reopened[0].task.priority, 10);
  assert.equal(reopened[0].task.version, version, 'promotion is not a state transition, version unchanged');
  assert.equal(priorityBand(reopened[0].task.priority), 'normal');

  // Vice versa: already has normal, publishing as backfill does not downgrade
  r.publish([fineTask('u2', 'normal')]);
  r.take('node');
  r.publish([fineTask('u2', 'backfill')]);
  assert.equal(r.take('node').filter((m) => m.type === 'task.opened').length, 0);
  // Upgraded task can be claimed as usual
  r.q.handle('node', { type: 'task.claim', id: fineTask('u1').id, expectVersion: version });
  assert.ok(r.take('node').some((m) => m.type === 'task.claimed' && m.task.priority === 10));
});

test('C10A-L17-Q4 old clients are still treated as normal; shape validation of priority and of the prerender retry plan task', () => {
  const parse = (task) => parseInbound({ type: 'task.publish', tasks: [task] });
  // Without priority → 0; integer as-is; 'normal' / 'backfill' as-is
  assert.equal(parse(fineTask('a')).body.tasks[0].priority, 0);
  assert.equal(parse(fineTask('a', 50)).body.tasks[0].priority, 50);
  assert.equal(parse(fineTask('a', 'backfill')).body.tasks[0].priority, 'backfill');
  assert.equal(priorityBand(0), 'normal');
  assert.equal(priorityBand(50), 'normal');
  assert.equal(priorityBand(undefined), 'normal');
  // Other strings and decimals are format errors
  assert.equal(parse(fineTask('a', 'urgent')).ok, false);
  assert.equal(parse(fineTask('a', 1.5)).ok, false);
  // Prerender retry plan task: must be marked backfill, have non-empty clip manifest, valid signature
  const plan = backfillPlanTaskOf({ projectId: 'p1', projectRev: 2, clips: ['x'] });
  assert.equal(parse(plan).ok, true);
  assert.equal(parse({ ...plan, priority: 'normal' }).ok, false);
  assert.equal(parse({ ...plan, input: {} }).ok, false);
  assert.equal(parse({ ...plan, input: { clips: [] } }).ok, false);
  assert.equal(parse({ ...plan, input: { clips: [''] } }).ok, false);
  const badSig = { ...plan, resultKey: 'p1@2#backfill:BAD!', id: 'plan:p1@2#backfill:BAD!' };
  assert.equal(parse(badSig).ok, false);
  // Normal plan as before: result key must equal projectId@projectRev
  assert.equal(parse({ ...plan, resultKey: 'p1@2', id: 'plan:p1@2', priority: 0, input: {} }).ok, true);
});

/** PlanContext for prerender retry tests: one card classified locally as heavy (c-heavy), one card classified locally as light (c-light), one stream */
function contextWithLight() {
  const control = (clipId, label) => ({
    clipId, cardId: 'card', key: `png-${label}`, snapshotKey: `snap-${label}`, contentKey: `snap-${label}`, tier: 'shared',
    capabilities: { frameMode: 'stateful', compositing: 'independent' }, cacheable: true, count: 90,
    sampling: { firstFrame: 0, fps: { numerator: 30, denominator: 1 }, phase: { numerator: 0, denominator: 1 } },
  });
  return {
    entryKey: 'entry-1',
    cardPlan: [control('c-heavy', 'h'), control('c-light', 'l')],
    prerenderSet: new Set(['c-heavy']),
    streams: [{ streamKey: 'stream-1', contentKey: 'stream-1', topClipId: 'c-heavy', firstSegment: 0, lastSegment: 3 }],
    anchorFrames: [0],
    cardSourceVersions: {},
    weightOf: () => ({ class: 'heavy', estMs: null }),
  };
}

test('C10A-L17-Q5 a node that claims a prerender retry plan task: treats the clips in the manifest as heavy cards and cuts them into fine-grained tasks, marks the fine-grained tasks backfill, and does not cut track streams', async () => {
  let now = 5_000;
  const lb = createLoopback();
  const q = createRenderQueue({ now: () => now, send: lb.queueSend, epoch: 'e1' });
  lb.attach(q);
  // Page (legacy page sending backfill tier) only publishes
  const page = lb.connect('page', { userId: 'member' });
  const pageMsgs = [];
  page.onMessage((m) => pageMsgs.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page' });
  // Render node: creator's pc node; records task.publish sent by it
  const raw = lb.connect('node', { userId: 'creator' });
  const nodeOut = [];
  const endpoint = { send: (m) => { nodeOut.push(m); raw.send(m); }, onMessage: (h) => raw.onMessage(h) };
  const plans = [];
  const executor = {
    async plan(task) { plans.push(task.id); return contextWithLight(); },
    render: () => new Promise(() => {}),   // This case only checks splitting
  };
  const sink = { has: async () => false, put: async () => ({ complete: true }) };
  const events = [];
  const node = createLocalNode({
    nodeId: 'N', endpoint, now: () => now, random: () => 0, codeVersion: CV, executor, sink, maxConcurrent: 1,
    node: { profile: 'pc', envFingerprint: FP, codeVersions: [CV], cardSourceVersions: {}, capabilities: { transcode: true, streams: true, userCards: true, graphCards: true } },
    onEvent: (e) => events.push(e),
  });
  node.start();
  lb.flush();
  const backfill = backfillPlanTaskOf({ projectId: 'p1', projectRev: 7, clips: ['c-light'] });
  page.send({ type: 'task.publish', tasks: [backfill], reqId: 'bf-1' });
  for (let i = 0; i < 200 && !events.some((e) => e.type === 'plan-split'); i++) {
    lb.flush();
    await new Promise((r) => setImmediate(r));
    node.tick();
    now += 250;
  }
  assert.deepEqual(plans, [backfill.id], 'the node claimed the prerender retry plan task');
  const derived = nodeOut.filter((m) => m.type === 'task.publish').flatMap((m) => m.tasks);
  assert.ok(derived.length > 0, 'Fine-grained tasks were split out');
  assert.ok(derived.every((t) => t.input.clipId === 'c-light'), 'only cut the clips in the manifest (cards classified as heavy on this machine are not in this batch)');
  assert.ok(derived.every((t) => t.kind === 'snapshot'), 'prerender retry does not cut track streams');
  assert.ok(derived.every((t) => t.priority === 'backfill'), 'fine-grained tasks are also marked backfill');
  assert.ok(derived.every((t) => t.source.derivedFrom === backfill.id));
  assert.equal(derived.length, 2, '90 frames are cut into two segments of 60 frames each');
  // Page only publishes, does not claim: it never sent node.hello, and the queue has no node for it
  assert.ok(!q.describe().nodes.some((n) => n.nodeId === 'page'));
  node.stop();

  // Same splitPlan: normal tier (without lane) still gets integer rank as before
  const normal = splitPlan({ ...contextWithLight(), planTask: { id: 'plan:p1@7', source: { projectId: 'p1', projectRev: 7 } }, envFingerprint: FP, codeVersion: CV });
  assert.ok(normal.every((t) => Number.isInteger(t.priority)));
});

test('C10A-L17-Q6 the pipeline\'s prerender retry registration: merged into the prerender set and matched by content identity; regular plans and track streams do not carry the prerender retry clips', async () => {
  const { FramePipeline } = await import('../frame-pipeline.mjs');
  const control = (clipId, label) => ({ clipId, snapshotKey: `snap-${label}`, contentKey: `ck-${label}`, tier: 'shared' });
  const entry = { key: 'e1', project: { id: 'doc-1' }, cardPlan: [control('c-heavy', 'h'), control('c-light', 'l')], basePrerenderSet: new Set(['c-heavy']) };
  entry.prerenderSet = entry.basePrerenderSet;
  const other = { key: 'e2', project: { id: 'doc-1' }, cardPlan: [control('c-heavy', 'h'), control('c-light', 'l')], basePrerenderSet: new Set(['c-heavy']) };
  other.prerenderSet = other.basePrerenderSet;
  const edited = { key: 'e3', project: { id: 'doc-1' }, cardPlan: [control('c-heavy', 'h'), control('c-light', 'l2')], basePrerenderSet: new Set(['c-heavy']) };
  edited.prerenderSet = edited.basePrerenderSet;
  const layerMaps = [];
  const pipe = Object.create(FramePipeline.prototype);
  pipe.entries = new Map([['e1', entry], ['e2', other], ['e3', edited]]);
  pipe.publishLayerMap = (e) => { layerMaps.push(e.key); return true; };

  assert.equal(pipe.prerenderPicked(entry, 'c-light'), false);
  assert.equal(pipe.addBackfill(entry, ['c-light']), 1);
  assert.equal(pipe.prerenderPicked(entry, 'c-light'), true, 'it is in the prerender set');
  assert.equal(pipe.prerenderPicked(other, 'c-light'), true, 'another entry of the same project and the same content also carries it (whichever entry writes the layer table lists it)');
  assert.equal(pipe.prerenderPicked(edited, 'c-light'), false, 'edited content does not count: the new content has no output, and the page will send a prerender retry again');
  assert.equal(pipe.streamPicked(entry, 'c-light'), false, 'track streams are only given to cards classified as heavy on this machine');
  assert.equal(pipe.streamPicked(entry, 'c-heavy'), true);
  assert.deepEqual(layerMaps, ['e1'], 'the layer table is written once after registration');
  assert.equal(pipe.addBackfill(entry, ['c-light']), 0, 'repeated registration does not write again');
  // Prerender retry clips remain after recalculating the set (new cost record)
  entry.prerenderSet = entry.basePrerenderSet;
  pipe.applyBackfill(entry);
  assert.equal(pipe.prerenderPicked(entry, 'c-light'), true);
});
