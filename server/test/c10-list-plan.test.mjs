/**
 * C10 contract Section 7, Section 18, Clause 9 [ruling]: manifest plans published by online pages,
 * and modifications to M6c X4 (numbered C10-LP-…).
 *
 *   LP1 Manifest plan shape: `plan:<projectId>@<projectRev>#clips:<sig>`, carries clip manifest and
 *       normal tier; `requires` does not carry envFingerprint / preferNode, may only carry
 *       codeVersion; same manifest gets same key; inbound validation (normal tier, non-empty
 *       manifest, valid signature)
 *   LP2 Queue: host can claim plan with manifest (manifest plan, prerender retry plan); desktop plan
 *       without manifest claimed 0 times by host (X4 preserved); browser never claims
 *   LP3 Node-side rule 6: host allows plan with manifest, skips desktop plan
 *   LP4 Standalone host claims manifest plan: splits with its own fingerprint; clips in manifest
 *       treated as heavy cards, do not split streams, fine-grained tasks in normal tier; cards
 *       locked to other fingerprints emit tasks under locked fingerprint (per-card fingerprint lock
 *       takes effect as before)
 *
 * Run: node --test server/test/c10-list-plan.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue, clipsPlanTaskOf, backfillPlanTaskOf, isListPlan, isClipsPlan, isBackfillPlan, priorityBand } from '../render-queue/index.mjs';
import { parseInbound } from '../render-queue/messages.mjs';
import { planTaskOf } from '../render-node/split.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';

const FP_A = 'aaaaaaaaaaaaaaaa';
const FP_B = 'bbbbbbbbbbbbbbbb';
const CV = 'c0de5a';

test('C10-LP1 shape of the manifest plan and inbound validation', () => {
  const a = clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips: ['c2', 'c1', 'c1'] });
  const b = clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips: ['c1', 'c2'] });
  assert.equal(a.id, b.id, 'The same manifest gets the same key');
  assert.match(a.id, /^plan:p1@3#clips:[0-9a-z]+$/);
  assert.equal(a.resultKey, a.id.slice('plan:'.length));
  assert.deepEqual(a.input.clips, ['c1', 'c2']);
  assert.equal(a.priority, 'normal');
  assert.equal(priorityBand(a.priority), 'normal');
  assert.deepEqual(a.requires, {}, 'Does not carry envFingerprint or preferNode');
  assert.deepEqual(clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips: ['x'], codeVersion: CV }).requires, { codeVersion: CV });
  assert.ok(isClipsPlan(a) && isListPlan(a) && !isBackfillPlan(a));
  const bf = backfillPlanTaskOf({ projectId: 'p1', projectRev: 3, clips: ['c1', 'c2'] });
  assert.ok(isListPlan(bf) && !isClipsPlan(bf));
  assert.notEqual(bf.id, a.id, 'The prerender retry plan and the manifest plan each use their own key');
  assert.ok(!isListPlan(planTaskOf({ projectId: 'p1', projectRev: 3 })));

  const parse = (task) => parseInbound({ type: 'task.publish', tasks: [task] });
  assert.equal(parse(a).ok, true);
  assert.equal(parse({ ...a, priority: 0 }).ok, true, 'An integer is also the normal tier');
  assert.equal(parse({ ...a, priority: 'backfill' }).ok, false, 'Prerender retry uses a #backfill: key');
  assert.equal(parse({ ...a, input: {} }).ok, false);
  assert.equal(parse({ ...a, input: { clips: [] } }).ok, false);
  assert.equal(parse({ ...a, resultKey: 'p1@3#clips:BAD!', id: 'plan:p1@3#clips:BAD!' }).ok, false);
  // Old rules for prerender retry plans remain unchanged
  assert.equal(parse({ ...bf, priority: 'normal' }).ok, false);
});

/** Directly drive queue: one connection each for page (publisher), pc, host, and browser */
function scene() {
  let now = 1_000;
  const inbox = new Map();
  const q = createRenderQueue({ now: () => now, send: (connId, msg) => { if (!inbox.has(connId)) inbox.set(connId, []); inbox.get(connId).push(msg); }, epoch: 'e1' });
  q.connect('page', { userId: 'member' });
  q.handle('page', { type: 'publisher.hello', publisherId: 'PAGE' });
  q.connect('pc', { userId: 'creator' });
  q.handle('pc', { type: 'node.hello', nodeId: 'PC', profile: 'pc', envFingerprint: FP_A, codeVersions: [CV] });
  q.connect('host', { userId: 'host-user' });
  q.handle('host', { type: 'node.hello', nodeId: 'HOST', profile: 'host', envFingerprint: FP_B, codeVersions: [CV] });
  q.connect('br', { userId: 'member' });
  q.handle('br', { type: 'node.hello', nodeId: 'BR', profile: 'browser', envFingerprint: FP_A, codeVersions: [CV] });
  const take = (connId) => { const list = inbox.get(connId) ?? []; inbox.set(connId, []); return list; };
  const publish = (task) => { q.handle('page', { type: 'task.publish', tasks: [task], reqId: `r${++now}` }); return take('page').find((m) => m.type === 'task.published').results[0]; };
  const claim = (conn, id) => { q.handle(conn, { type: 'task.claim', id, expectVersion: 1, reqId: `c${++now}` }); return take(conn).find((m) => m.type === 'task.claimed' || m.type === 'task.claim-rejected'); };
  return { q, take, publish, claim, advance: (ms) => { now += ms; } };
}

test('C10-LP2 queue: a plan host with a manifest can claim; a desktop plan host claims 0 times; browser never claims', () => {
  const s = scene();
  const clips = clipsPlanTaskOf({ projectId: 'p1', projectRev: 1, clips: ['c1'], codeVersion: CV });
  assert.equal(s.publish(clips).created, true);
  assert.equal(s.claim('br', clips.id).reason, 'plan-profile', 'browser does not claim the plan');
  const got = s.claim('host', clips.id);
  assert.equal(got.type, 'task.claimed', `host claims the manifest plan:${JSON.stringify(got)}`);

  const bf = backfillPlanTaskOf({ projectId: 'p1', projectRev: 1, clips: ['c2'] });
  s.publish(bf);
  assert.equal(s.claim('host', bf.id).type, 'task.claimed', 'host claims the prerender retry plan');

  // Desktop plan (without manifest, with preferNode): X4 as before, host is plan-profile both inside and outside window
  const desk = planTaskOf({ projectId: 'p2', projectRev: 1, codeVersion: CV, envFingerprint: FP_A, preferNode: 'PC' });
  s.publish(desk);
  let hostClaims = 0;
  for (const wait of [0, 6_000, 60_000]) {
    s.advance(wait);
    const r = s.claim('host', desk.id);
    if (r.type === 'task.claimed') hostClaims++;
    else assert.equal(r.reason, 'plan-profile');
  }
  assert.equal(hostClaims, 0, 'Desktop plan: host claims 0 times');
  assert.equal(s.claim('pc', desk.id).type, 'task.claimed', 'The desktop plan still goes to pc');
});

test('C10-LP3 node-side rule 6: host lets a plan with a manifest through and skips a desktop plan', () => {
  const host = { profile: 'host', envFingerprint: FP_B, codeVersions: [CV], capabilities: { userCards: true } };
  const view = (t) => ({ ...t, source: { ...t.source, userId: 'u1' } });
  assert.deepEqual(checkClaimable(view(clipsPlanTaskOf({ projectId: 'p', projectRev: 1, clips: ['a'] })), host), { ok: true });
  assert.deepEqual(checkClaimable(view(backfillPlanTaskOf({ projectId: 'p', projectRev: 1, clips: ['a'] })), host), { ok: true });
  assert.deepEqual(checkClaimable(view(planTaskOf({ projectId: 'p', projectRev: 1 })), host), { ok: false, rule: 6, reason: 'plan-on-host' });
  // codeVersion of manifest plan checked as before
  const wrong = view(clipsPlanTaskOf({ projectId: 'p', projectRev: 1, clips: ['a'], codeVersion: 'other' }));
  assert.equal(checkClaimable(wrong, host).reason, 'code-version');
  assert.equal(checkClaimable(view(clipsPlanTaskOf({ projectId: 'p', projectRev: 1, clips: ['a'] })), { ...host, profile: 'browser', userId: 'u1' }).reason, 'plan-on-browser');
});

/** PlanContext for splitting: two shared tier cards (c-free unlocked, c-locked locked to FP_A), one stream */
function context() {
  const control = (clipId, ck) => ({
    clipId, cardId: 'card', key: `png-${clipId}`, snapshotKey: resultKeyOf(ck, FP_B), contentKey: ck, tier: 'shared',
    capabilities: { frameMode: 'stateful', compositing: 'independent' }, cacheable: true, count: 60,
    sampling: { firstFrame: 0, fps: { numerator: 30, denominator: 1 }, phase: { numerator: 0, denominator: 1 } },
  });
  return {
    entryKey: 'entry-1',
    cardPlan: [control('c-free', 'ck-free'.padEnd(64, '0')), control('c-locked', 'ck-lock'.padEnd(64, '0')), control('c-other', 'ck-other'.padEnd(64, '0'))],
    prerenderSet: new Set(['c-other']),
    streams: [{ streamKey: 'stream-1', contentKey: 'stream-1', topClipId: 'c-other', firstSegment: 0, lastSegment: 3 }],
    anchorFrames: [0],
    cardSourceVersions: {},
    weightOf: () => ({ class: 'heavy', estMs: null }),
  };
}

test('C10-LP4 a standalone host claims the manifest plan: splits with its own fingerprint, splits only the clips in the manifest, does not split streams, normal tier; locked cards produce tasks by the lock\'s fingerprint', async () => {
  let now = 5_000;
  const lb = createLoopback();
  const q = createRenderQueue({ now: () => now, send: lb.queueSend, epoch: 'e1' });
  lb.attach(q);
  // First someone locks snapshot of c-locked to FP_A (desktop node produced it)
  const locker = lb.connect('locker', { userId: 'creator' });
  locker.send({ type: 'publisher.hello', publisherId: 'LOCKER' });
  const lockedCk = 'ck-lock'.padEnd(64, '0');
  const lockedTask = {
    id: `snapshot:${resultKeyOf(lockedCk, FP_A)}:0-59`, kind: 'snapshot', tier: 'shared', resultKey: resultKeyOf(lockedCk, FP_A),
    range: { unit: 'localFrame', from: 0, to: 59 }, source: { projectId: 'p0', projectRev: 1 },
    input: { clipId: 'c-locked', contentKey: lockedCk }, weight: { class: 'heavy', estMs: null, frames: 60 },
    requires: { envFingerprint: FP_A, codeVersion: CV },
  };
  locker.send({ type: 'task.publish', tasks: [lockedTask], reqId: 'lock-1' });
  // Lock established on first claim (F.1): desktop node (FP_A) claims it
  locker.send({ type: 'node.hello', nodeId: 'LOCKER-NODE', profile: 'pc', envFingerprint: FP_A, codeVersions: [CV] });
  locker.send({ type: 'task.claim', id: lockedTask.id, expectVersion: 1, reqId: 'claim-1' });
  lb.flush();
  // Page only publishes
  const page = lb.connect('page', { userId: 'member' });
  page.send({ type: 'publisher.hello', publisherId: 'PAGE' });
  lb.flush();
  // Standalone render host: host tier, fingerprint FP_B (differs from environments of both locking party and page)
  const raw = lb.connect('host', { userId: 'host-user' });
  const out = [];
  const endpoint = { send: (m) => { out.push(m); raw.send(m); }, onMessage: (h) => raw.onMessage(h) };
  const plans = [];
  const executor = { async plan(task) { plans.push(task.id); return context(); }, render: () => new Promise(() => {}) };
  const sink = { has: async () => false, put: async () => ({ complete: true }) };
  const events = [];
  const node = createLocalNode({
    nodeId: 'HOST', endpoint, now: () => now, random: () => 0, codeVersion: CV, executor, sink, maxConcurrent: 1, projects: ['p1'],
    node: { profile: 'host', envFingerprint: FP_B, codeVersions: [CV], cardSourceVersions: {}, capabilities: { userCards: true, graphCards: false } },
    onEvent: (e) => events.push(e),
  });
  node.start();
  lb.flush();
  const plan = clipsPlanTaskOf({ projectId: 'p1', projectRev: 2, clips: ['c-free', 'c-locked'], codeVersion: CV });
  page.send({ type: 'task.publish', tasks: [plan], reqId: 'pub-1' });
  for (let i = 0; i < 400 && !events.some((e) => e.type === 'plan-split'); i++) {
    lb.flush();
    await new Promise((r) => setImmediate(r));
    node.tick();
    now += 250;
  }
  assert.deepEqual(plans, [plan.id], 'host claimed the manifest plan');
  const derived = out.filter((m) => m.type === 'task.publish').flatMap((m) => m.tasks);
  const byClip = (id) => derived.filter((t) => t.input.clipId === id);
  assert.ok(derived.length > 0, 'Fine-grained tasks were split out');
  assert.ok(derived.every((t) => t.kind === 'snapshot'), 'Streams are not split');
  assert.ok(derived.every((t) => t.input.clipId !== 'c-other'), 'Only the clips in the manifest are split (classified as heavy locally; clips not in the manifest are not split)');
  assert.ok(derived.every((t) => priorityBand(t.priority) === 'normal'), 'Fine-grained tasks are in the normal tier');
  assert.ok(derived.every((t) => t.source.derivedFrom === plan.id));
  const free = byClip('c-free');
  assert.ok(free.length > 0 && free.every((t) => t.requires.envFingerprint === FP_B && t.resultKey === resultKeyOf('ck-free'.padEnd(64, '0'), FP_B)), 'Unlocked cards use the host\'s own fingerprint');
  const locked = byClip('c-locked').filter((t) => t.requires.envFingerprint === FP_A);
  assert.ok(locked.length > 0, `Locked cards produce tasks by the lock's fingerprint instead:${JSON.stringify(byClip('c-locked').map((t) => t.requires.envFingerprint))}`);
  assert.ok(locked.every((t) => t.resultKey === resultKeyOf(lockedCk, FP_A)));
  lb.flush();
  assert.equal(q.describe().tasks.find((t) => t.id === plan.id)?.state, 'done', 'The plan is done');
  node.stop();
});
