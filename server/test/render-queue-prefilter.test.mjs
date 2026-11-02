/**
 * M5b queue part: node fingerprint prefiltering, lock change targeted delta, rejection rate limiting
 * (contract `docs/plan/render-queue-contract.md` section I, test case table I.8 V1-V3, K1-K6).
 * Run: node --experimental-test-module-mocks --test server/test/render-queue-prefilter.test.mjs
 *
 * Written strictly against contract section I and referenced sections A, B.5, D.3, and F, without
 * looking at implementation. Queue is driven only via A.3 public interfaces
 * (connect / handle / tick / describe), and node sessions are driven only via B.5 public interfaces.
 *
 * Conventions:
 *   - For test cases with "filter on / off" comparisons, run each scenario once with
 *     `constants: { PREFILTER: true }` and once with `{ PREFILTER: false }`, writing raw numbers
 *     from both runs into test output using `t.diagnostic` (I.8).
 *   - Lock key `snapshot:<contentKey>` (F.1); result keys calculated manually per B.1 formula,
 *     task ids calculated manually per A.4, without relying on implementation.
 *   - Fingerprints use 16-character lowercase hex fake values; nodes all use `host` to prevent
 *     heavy policies or pure browser user filtering from mixing in.
 *   - K1-K3 use D.3 loopback (`fake-loopback-transport.mjs`) to connect the real queue with B.5
 *     sessions, driven by fake clock, with no network started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as queueIndex from '../render-queue/index.mjs';
import { createNodeSession } from '../render-node/session.mjs';
import { createQueueHarness, makeTaskInput, createFakeClock, T0 } from './fake-render-queue-env.mjs';
import { createLoopback } from './fake-loopback-transport.mjs';

const { createRenderQueue } = queueIndex;

const FP_A = 'aaaaaaaaaaaaaaaa';
const FP_B = 'bbbbbbbbbbbbbbbb';
const FP_C = 'cccccccccccccccc';
const SWEEP = 5_000;          // Default value of SWEEP_INTERVAL_MS from A.2
const RENEW = 10_000;         // Default value of RENEW_INTERVAL_MS from A.2
const LEASE = 30_000;         // Default value of LEASE_MS from A.2 (only for populating leaseUntil in handwritten responses)
const MODES = [false, true]; // PREFILTER off (control group) runs first, on (experimental group) runs second: control group numbers can always be written to output first
const modeName = on => (on ? 'Filter on' : 'Filter off');

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const rk = (contentKey, fp) => sha256(`${contentKey}\n${fp ?? ''}`);

/**
 * A snapshot task for a segment of a card in an environment: `input.contentKey = ck`,
 * `requires.envFingerprint = fp` (without fingerprint when `fp` is null),
 * `resultKey = resultKeyOf(ck, fp)` (consistent shape with splitPlan output).
 */
function snap(ck, fp, seg = 0, { segLen = 60, projectId = 'p1', priority, contentKey = true } = {}) {
  const from = seg * segLen;
  return makeTaskInput({
    projectId, kind: 'snapshot', resultKey: rk(ck, fp), range: [from, from + segLen - 1],
    input: contentKey ? { clipId: `clip-${ck}`, contentKey: ck } : { clipId: `clip-${ck}` },
    requires: fp ? { envFingerprint: fp } : {},
    weight: { class: 'medium', estMs: null, frames: segLen },
    ...(priority !== undefined ? { priority } : {}),
  });
}

const ids = list => list.map(t => t.id).sort();
const sorted = list => [...list].sort();
const countBy = list => list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());

/* ================================================================== Queue unit test helpers */

function harness(prefilter, extra = {}) {
  return createQueueHarness(createRenderQueue, { constants: { PREFILTER: prefilter, ...extra } });
}
/** Check in and watch 'all'; hello omits envFingerprint when fp is null. Return task ids in queue.snapshot received in this step. */
function joinNode(h, conn, nodeId, fp) {
  // M6c X3: host's watch 'all' receives only summaries; full visibility needed here, node switched
  // to pc (originally host)
  const out = h.node(conn, nodeId, { profile: 'pc', hello: fp ? { envFingerprint: fp } : {} });
  return ids(out.one(conn, 'queue.snapshot').tasks);
}
const cardLock = (h, conn, fields) => h.handle(conn, { type: 'card.lock', kind: 'snapshot', ...fields });
function publishOk(h, conn, tasks) {
  const out = h.publish(conn, tasks);
  const results = out.one(conn, 'task.published').results;
  for (const r of results) assert.equal(r.error, undefined, `Publishing ${r.id} should not error: ${JSON.stringify(r)}`);
  return out;
}
/** Task ids of task.opened sent to conn in a step (ascending). */
const openedIds = (out, conn) => sorted(out.of(conn, 'task.opened').map(m => m.task.id));
const closedOf = (out, conn) => out.of(conn, 'task.closed');

/* ================================================================== V1 */

test('V1 A node sees tasks with a different fingerprint in neither queue.snapshot nor task.opened; nodes without a fingerprint still see everything as before', t => {
  for (const on of MODES) {
    const h = harness(on);
    h.publisher('p', 'pub-p');
    // No contentKey: no lock key, tests only rule 1 (fingerprint match)
    const tA = snap('v1a', FP_A, 0, { contentKey: false });
    const tB = snap('v1b', FP_B, 0, { contentKey: false });
    const t0 = snap('v1n', null, 0, { contentKey: false });
    publishOk(h, 'p', [tA, tB, t0]);

    const snapA = joinNode(h, 'a', 'node-A', FP_A);
    const snapB = joinNode(h, 'b', 'node-B', FP_B);
    const snapN = joinNode(h, 'n', 'node-N', null);
    t.diagnostic(`${modeName(on)}: snapshot count a=${snapA.length} b=${snapB.length} n=${snapN.length}`);

    // Publish after node checks in: inspect recipients of task.opened
    const tA2 = snap('v1a', FP_A, 1, { contentKey: false });
    const tB2 = snap('v1b', FP_B, 1, { contentKey: false });
    const t02 = snap('v1n', null, 1, { contentKey: false });
    const out = publishOk(h, 'p', [tA2, tB2, t02]);
    t.diagnostic(`${modeName(on)}: task.opened count a=${out.of('a', 'task.opened').length} b=${out.of('b', 'task.opened').length} n=${out.of('n', 'task.opened').length}`);

    const all = ids([tA, tB, t0]), all2 = ids([tA2, tB2, t02]);
    assert.deepEqual(snapN, all, `${modeName(on)}: a node without a fingerprint sees the whole snapshot`);
    assert.deepEqual(openedIds(out, 'n'), all2, `${modeName(on)}: a node without a fingerprint receives every task.opened`);
    if (on) {
      assert.deepEqual(snapA, ids([tA, t0]), 'Filter on: the snapshot of node A has only tasks with fingerprint A and tasks without a fingerprint');
      assert.deepEqual(snapB, ids([tB, t0]), 'Filter on: the snapshot of node B has only tasks with fingerprint B and tasks without a fingerprint');
      assert.deepEqual(openedIds(out, 'a'), ids([tA2, t02]));
      assert.deepEqual(openedIds(out, 'b'), ids([tB2, t02]));
    } else {
      assert.deepEqual(snapA, all, 'Filter off: everything is visible, same as before this section');
      assert.deepEqual(snapB, all);
      assert.deepEqual(openedIds(out, 'a'), all2);
      assert.deepEqual(openedIds(out, 'b'), all2);
    }

    // Recipients of task.taken / task.closed likewise follow visibility (I.2, last paragraph)
    const c = h.claim('b', tB2.id, 1);
    const claimed = c.one('b', 'task.claimed');
    const takenA = c.of('a', 'task.taken').length, takenN = c.of('n', 'task.taken').length;
    const d = h.complete('b', tB2.id, claimed.token, { ranges: [[60, 119]] });
    const closedA = d.of('a', 'task.closed').length, closedN = d.of('n', 'task.closed').length;
    t.diagnostic(`${modeName(on)}: B task claimed/completed, a receives taken=${takenA} closed=${closedA}; n receives taken=${takenN} closed=${closedN}`);
    assert.equal(takenN, 1, 'n can see it and receives task.taken');
    assert.equal(closedN, 1, 'n can see it and receives task.closed');
    assert.equal(takenA, on ? 0 : 1, `${modeName(on)}: task.taken of node A`);
    assert.equal(closedA, on ? 0 : 1, `${modeName(on)}: task.closed of node A`);
  }
});

/* ================================================================== V2 */

test('V2 When the lock is on another fingerprint, a node cannot see the tasks with a fingerprint under this lock key; when the lock is on its own fingerprint, it can; tasks without a fingerprint are not restricted by the lock (I.10 clause 1)', t => {
  for (const on of MODES) {
    const h = harness(on);
    h.publisher('p', 'pub-p');
    // ck1 locked to B: task tA1 with fingerprint A (published before the lock) and tN1 without fingerprint
    // ck2 locked to A: task tA2 with fingerprint A and tN2 without fingerprint
    const tA1 = snap('v2-ck1', FP_A, 0), tN1 = snap('v2-ck1', null, 0);
    const tA2 = snap('v2-ck2', FP_A, 0), tN2 = snap('v2-ck2', null, 0);
    publishOk(h, 'p', [tA1, tN1, tA2, tN2]);
    assert.equal(cardLock(h, 'p', { contentKey: 'v2-ck1', envFingerprint: FP_B }).one('p', 'card.locked').granted, true);
    assert.equal(cardLock(h, 'p', { contentKey: 'v2-ck2', envFingerprint: FP_A }).one('p', 'card.locked').granted, true);

    const snapA = joinNode(h, 'a', 'node-A', FP_A);
    const snapB = joinNode(h, 'b', 'node-B', FP_B);
    const snapN = joinNode(h, 'n', 'node-N', null);
    t.diagnostic(`${modeName(on)} snapshot a=${JSON.stringify(snapA.length)} b=${snapB.length} n=${snapN.length}`);

    // Publishing after locking: tasks without fingerprint do not participate in the lock (F.1) and
    // are still created; those with the same fingerprint are also created as usual
    const tN1b = snap('v2-ck1', null, 1), tA2b = snap('v2-ck2', FP_A, 1);
    const out = publishOk(h, 'p', [tN1b, tA2b]);
    t.diagnostic(`${modeName(on)}: task.opened published after locking: a=${openedIds(out, 'a').length} b=${openedIds(out, 'b').length} n=${openedIds(out, 'n').length}`);

    const all = ids([tA1, tN1, tA2, tN2]);
    assert.deepEqual(snapN, all, `${modeName(on)}: for a node without a fingerprint, clause 2 does not apply and everything is visible`);
    assert.deepEqual(openedIds(out, 'n'), ids([tN1b, tA2b]));
    if (on) {
      assert.deepEqual(snapA, ids([tN1, tA2, tN2]), 'Filter on: node A cannot see the tasks with fingerprint A in ck1, which is locked to B; tasks without a fingerprint are not restricted by the lock; ck2, locked to its own fingerprint, is visible');
      assert.deepEqual(snapB, ids([tN1, tN2]), 'Filter on: node B sees only tasks without a fingerprint (those with fingerprint A are blocked by clause 1)');
      assert.deepEqual(openedIds(out, 'a'), ids([tN1b, tA2b]));
      assert.deepEqual(openedIds(out, 'b'), ids([tN1b]));
    } else {
      assert.deepEqual(snapA, all, 'Filter off: everything is visible');
      assert.deepEqual(snapB, all);
      assert.deepEqual(openedIds(out, 'a'), ids([tN1b, tA2b]));
      assert.deepEqual(openedIds(out, 'b'), ids([tN1b, tA2b]));
    }
  }
});

/* ================================================================== V3 */

test('V3 The lock moves from X to Y (takeover): node X receives a withdrawal (hidden / card-locked, based on visibility before the change), node Y receives task.opened, other nodes receive 0 messages; the claimant receives lease-lost', t => {
  for (const on of MODES) {
    const h = harness(on);
    h.publisher('p', 'pub-p');
    // Same card: tX with fingerprint X (open) and tXc (claimed by x2), tY with fingerprint Y
    // (published before the lock), tN without fingerprint (does not participate in the lock);
    // another card other locked to X, unaffected
    const tX = snap('v3', FP_A, 0), tXc = snap('v3', FP_A, 1), tY = snap('v3', FP_B, 0), tN = snap('v3', null, 0);
    const oX = snap('v3-other', FP_A, 0);
    publishOk(h, 'p', [tX, tXc, tY, tN, oX]);
    cardLock(h, 'p', { contentKey: 'v3', envFingerprint: FP_A });
    cardLock(h, 'p', { contentKey: 'v3-other', envFingerprint: FP_A });
    joinNode(h, 'x', 'node-X', FP_A);
    joinNode(h, 'x2', 'node-X2', FP_A);
    joinNode(h, 'y', 'node-Y', FP_B);
    joinNode(h, 'z', 'node-Z', FP_C);
    const claimedXc = h.claim('x2', tXc.id, 1).one('x2', 'task.claimed');

    const out = cardLock(h, 'p', { contentKey: 'v3', envFingerprint: FP_B, takeover: true });
    const locked = out.one('p', 'card.locked');
    assert.equal(locked.granted, true);
    assert.equal(locked.envFingerprint, FP_B);
    const summary = conn => out.of(conn).map(m => `${m.type}:${m.id ?? m.task?.id}:${m.state ?? ''}:${m.reason ?? ''}`);
    t.diagnostic(`${modeName(on)}: takeover step, messages: x=${out.of('x').length} y=${out.of('y').length} z=${out.of('z').length}`);
    t.diagnostic(`${modeName(on)}: x received ${JSON.stringify(summary('x'))}`);
    t.diagnostic(`${modeName(on)}: y received ${JSON.stringify(summary('y'))}`);

    const hidden = out.ofType('task.closed').filter(e => e.message.state === 'hidden');
    // tX is invalidated by takeover (F.1: superseded → failed)
    assert.equal(h.task(tX.id).state, 'failed');
    assert.equal(h.task(tX.id).lastError, 'superseded');
    // Claimant receives lease-lost superseded per F.1 (identical for both toggles)
    const lost = out.of('x2', 'task.lease-lost');
    assert.deepEqual(lost.map(m => [m.id, m.token, m.reason]), [[tXc.id, claimedXc.token, 'superseded']], 'x2 gets exactly one lease-lost superseded');
    assert.equal(h.task(tXc.id).state, 'failed');
    // tN without fingerprint does not participate in the lock: no one receives messages about it
    assert.ok(!out.messages().some(m => (m.id ?? m.task?.id) === tN.id), 'A task without a fingerprint is not affected by the lock change');
    assert.ok(!out.messages().some(m => (m.id ?? m.task?.id) === oX.id), 'Other cards are not affected');
    const aboutTXc = m => (m.id ?? m.task?.id) === tXc.id;
    if (on) {
      // tX is open: per visibility before the change, nodes with fingerprint X (x, x2) receive
      // hidden / card-locked (I.10 item 2), and do not receive failed separately.
      // Claimed tXc is not open; the contract only specifies lease-lost for the claimant, so no
      // assertions are made here for task.closed on other nodes regarding it
      for (const conn of ['x', 'x2']) {
        const rest = out.of(conn).filter(m => !aboutTXc(m) && m.type !== 'task.lease-lost');
        assert.deepEqual(rest.map(m => [m.type, m.id, m.state, m.reason]), [['task.closed', tX.id, 'hidden', 'card-locked']],
          `${conn} gets exactly one hidden withdrawal for tX and receives nothing else`);
        assert.ok(!out.of(conn).some(m => m.type === 'task.opened'), `${conn} does not receive a backfill`);
      }
      assert.deepEqual(out.of('y').map(m => [m.type, m.task?.id]), [['task.opened', tY.id]], 'Node Y receives only the backfill for tY');
      assert.equal(out.of('z').length, 0, 'Other nodes get 0 messages');
    } else {
      assert.equal(hidden.length, 0, 'Filter off: no hidden');
      assert.equal(out.ofType('task.opened').length, 0, 'Filter off: visibility is unchanged, no backfill');
      for (const conn of ['x', 'y', 'z']) {
        assert.deepEqual(sorted(closedOf(out, conn).map(m => `${m.id}|${m.state}`)), sorted([`${tX.id}|failed`, `${tXc.id}|failed`]),
          `Filter off: ${conn} receives failed for tX and tXc as in F.1`);
      }
    }
  }
});

/* ================================================================== V4 */

test('V4 Claiming a task with a mismatched fingerprint returns fingerprint-mismatch (I.10 clause 4); tasks without a fingerprint, with an empty fingerprint, and plan tasks are not checked; with the filter off, claims work as before', t => {
  for (const on of MODES) {
    const h = harness(on);
    h.publisher('p', 'pub-p');
    const tB = snap('v4b', FP_B, 0, { contentKey: false });
    const tB2 = snap('v4b', FP_B, 1, { contentKey: false });
    const tN = snap('v4n', null, 0, { contentKey: false });
    const tE = makeTaskInput({ projectId: 'p1', kind: 'snapshot', resultKey: rk('v4e', 'empty'), range: [0, 59], input: { clipId: 'c' }, requires: { envFingerprint: '' } });
    const plan = makeTaskInput({ projectId: 'p1', projectRev: 7, kind: 'plan', requires: { envFingerprint: FP_B } });
    publishOk(h, 'p', [tB, tB2, tN, tE, plan]);
    joinNode(h, 'a', 'node-A', FP_A);
    h.node('e', 'node-E', { profile: 'pc', hello: { envFingerprint: '' } });   // Empty string is equivalent to omitting it (item 7); M6c X3: originally host

    const r = h.claim('a', tB.id, 1);
    const outcome = r.of('a', 'task.claimed').length ? 'claimed' : r.one('a', 'task.claim-rejected').reason;
    t.diagnostic(`${modeName(on)}: node A claims a task with fingerprint B: ${outcome}`);
    if (on) {
      const rej = r.one('a', 'task.claim-rejected');
      assert.deepEqual([rej.id, rej.reason, rej.state, rej.version], [tB.id, 'fingerprint-mismatch', 'open', 1]);
      assert.deepEqual([h.task(tB.id).state, h.task(tB.id).version], ['open', 1], 'A rejection does not change the state');
      assert.equal(r.of('e', 'task.taken').length, 0);
    } else {
      assert.equal(outcome, 'claimed', 'Filter off: claims work as before');
    }
    // Claims proceed as usual under both toggles
    assert.equal(h.claim('a', tN.id, 1).one('a', 'task.claimed').id, tN.id, 'Task without a fingerprint: not checked');
    assert.equal(h.claim('a', tE.id, 1).one('a', 'task.claimed').id, tE.id, 'The task\'s fingerprint is an empty string: same as having none');
    assert.equal(h.claim('a', plan.id, 1).one('a', 'task.claimed').id, plan.id, 'Plan tasks are not checked for fingerprint');
    assert.equal(h.claim('e', tB2.id, 1).one('e', 'task.claimed').id, tB2.id, 'The node\'s fingerprint is an empty string: same as having none');
  }
});

test('V4 supplement: fingerprint-mismatch and card-locked count toward throttling together', t => {
  for (const on of MODES) {
    const h = harness(on);
    h.publisher('p', 'pub-p');
    const dead = snap('v4-locked', FP_A, 0);
    publishOk(h, 'p', [dead]);
    cardLock(h, 'p', { contentKey: 'v4-locked', envFingerprint: FP_B });
    const foreign = Array.from({ length: 12 }, (_, i) => snap('v4-foreign', FP_B, i, { contentKey: false }));
    const mine = snap('v4-mine', FP_A, 0, { contentKey: false });
    publishOk(h, 'p', [...foreign, mine]);
    joinNode(h, 'a', 'node-A', FP_A);

    const reasons = [];
    const one = id => { const out = h.claim('a', id, 1); reasons.push(out.of('a', 'task.claimed').length ? 'claimed' : out.one('a', 'task.claim-rejected').reason); };
    for (let i = 0; i < 11; i++) one(foreign[i].id);     // 11 fingerprint mismatches
    for (let i = 0; i < 10; i++) one(dead.id);           // 10 card-locked, 21 in total
    one(foreign[11].id);                                  // 22nd time
    one(mine.id);
    t.diagnostic(`${modeName(on)}: ${JSON.stringify(Object.fromEntries(countBy(reasons)))}, last two ${JSON.stringify(reasons.slice(-2))}`);
    if (on) {
      assert.deepEqual(reasons, [...Array(11).fill('fingerprint-mismatch'), ...Array(10).fill('card-locked'), 'throttled', 'throttled'],
        'After the two kinds of rejection exceed 20 in total, throttled is returned');
      assert.equal(h.nodeInfo('node-A').throttled, true);
      h.tick();
      assert.equal(h.claim('a', mine.id, 1).one('a', 'task.claimed').id, mine.id, 'Recovers after tick');
    } else {
      assert.deepEqual(reasons, [...Array(11).fill('claimed'), ...Array(10).fill('card-locked'), 'claimed', 'claimed'], 'Filter off: no rejection by fingerprint, no throttling');
    }
  }
});

test('V4 supplement: the session treats fingerprint-mismatch as taken, drops this candidate and does not retry', () => {
  const s = sessionHarness({ maxConcurrent: 1 });
  const [v0, v1] = [sView('v4s-a'), sView('v4s-b')];
  s.session.receive({ type: 'queue.snapshot', epoch: E, tasks: [v0, v1] });
  const c = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c.length, 1);
  s.session.receive({ type: 'task.claim-rejected', epoch: E, id: c[0].id, reason: 'fingerprint-mismatch', state: 'open', version: 1 });
  assert.ok(!s.session.known().some(v => v.id === c[0].id), 'The candidate is dropped');
  const next = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(next.length, 1, 'The in-flight claim is cleared, so the next one is claimed immediately');
  assert.notEqual(next[0].id, c[0].id);
});

/* =================================================== Loopback × session scenario harness (K1-K3) */

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

const nodeDesc = fp => Object.freeze({
  profile: 'pc', userId: 'u1', envFingerprint: fp, codeVersions: ['cv1'], cardSourceVersions: {},   // M6c X3: originally host (watch 'all' on host only receives summaries)
  capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 16_000 },
});

/**
 * A real queue, one loopback, one publisher, several B.5 sessions. `groups: [{ name, fp, count }]`.
 * Each step: advance clock → queue tick → delivery → nodes report progress / completion →
 * delivery → all sessions tick → delivery.
 */
function createRig({ prefilter, groups, workMs = n => 1_000 + (n % 4) * 250, maxConcurrent = 2 }) {
  const clock = createFakeClock(T0);
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, constants: { PREFILTER: prefilter }, epoch: 'epoch-prefilter' });
  lb.attach(queue);
  const principal = { userId: 'u1', tenantId: 't1' };

  const pub = lb.connect('conn-pub', principal);
  const pubInbox = [];
  pub.onMessage(m => pubInbox.push(m));
  pub.send({ type: 'publisher.hello', publisherId: 'P' });

  let started = 0;
  const nodes = [];
  for (const g of groups) {
    for (let i = 0; i < g.count; i++) {
      const nodeId = `${g.name}${i}`;
      const connId = `conn-${nodeId}`;
      const ep = lb.connect(connId, principal);
      const rec = { nodeId, connId, fp: g.fp, group: g.name, work: new Map(), started: [], completed: [], lost: [] };
      rec.session = createNodeSession({
        nodeId, node: nodeDesc(g.fp), now: clock.now, random: seeded(nodes.length * 31 + 7), maxConcurrent,
        send: m => ep.send(m),
        onTask: (task, { token }) => {
          rec.started.push(task.id);
          rec.work.set(task.id, { token, startedAt: clock.now(), finishAt: clock.now() + workMs(started++) });
        },
        onLost: (id, reason) => { rec.lost.push({ id, reason }); rec.work.delete(id); },
      });
      ep.onMessage(m => rec.session.receive(m));
      nodes.push(rec);
    }
  }
  const byConn = new Map(nodes.map(n => [n.connId, n]));

  let reqSeq = 0;
  function publish(tasks) {
    const reqId = `pub-${++reqSeq}`;
    pub.send({ type: 'task.publish', reqId, tasks });
    lb.flush();
    const reply = pubInbox.find(m => m.type === 'task.published' && m.reqId === reqId);
    assert.ok(reply, 'Publish should get a reply');
    for (const r of reply.results) assert.equal(r.error, undefined, `Publishing ${r.id} should not error: ${JSON.stringify(r)}`);
    return reply.results;
  }
  function lock(contentKey, fp, takeover) {
    pub.send({ type: 'card.lock', kind: 'snapshot', contentKey, envFingerprint: fp, ...(takeover ? { takeover: true } : {}) });
  }
  function start() {
    for (const n of nodes) n.session.start();
    lb.flush();
  }
  function step(ms = 250) {
    clock.advance(ms);
    queue.tick();
    lb.flush();
    for (const n of nodes) {
      for (const [id, w] of [...n.work]) {
        if (clock.now() >= w.finishAt) {
          n.work.delete(id);
          n.completed.push(id);
          n.session.complete(id, { ranges: [[0, 59]] });
        } else {
          n.session.progress(id, Math.floor((clock.now() - w.startedAt) / 50));
        }
      }
    }
    lb.flush();
    for (const n of nodes) n.session.tick();
    lb.flush();
  }
  const idle = () => nodes.every(n => n.work.size === 0 && n.session.held().length === 0);
  const doneIds = () => pubInbox.filter(m => m.type === 'task.done').map(m => m.id);
  const failedMsgs = () => pubInbox.filter(m => m.type === 'task.failed');
  /** Delivery records starting from a cursor. */
  const mark = () => lb.log().length;
  const since = m => lb.log().slice(m);
  function runUntil(expectDone, maxSteps = 3_000) {
    const want = new Set(expectDone);
    let steps = 0;
    for (; steps < maxSteps; steps++) {
      const got = new Set(doneIds());
      if ([...want].every(id => got.has(id)) && idle()) break;
      step();
    }
    return steps;
  }
  return { clock, lb, queue, pub, pubInbox, nodes, byConn, publish, lock, start, step, idle, doneIds, failedMsgs, mark, since, runUntil };
}

/** Delivery record statistics: claim count, card-locked rejections, throttled. */
function claimStats(log) {
  const claims = log.filter(e => e.dir === 'in' && e.message.type === 'task.claim').length;
  const rejects = log.filter(e => e.dir === 'out' && e.message.type === 'task.claim-rejected');
  const byReason = countBy(rejects.map(e => e.message.reason));
  return {
    claims,
    cardLocked: byReason.get('card-locked') ?? 0,
    throttled: byReason.get('throttled') ?? 0,
    taken: byReason.get('taken') ?? 0,
    stale: byReason.get('stale') ?? 0,
  };
}

/* ------------------------------------------------------------------ K1 / K2 scenarios */

/**
 * 4 nodes for each of the two fingerprints; 20 cards, each card has 5 segments for each of the
 * two fingerprints (200 tasks in total).
 * Cards 0-9 are locked to A, cards 10-19 are locked to B: from each node's perspective, half
 * the cards are locked by the other fingerprint.
 * Order: nodes check in → first publish the 100 tasks that "will be locked by another fingerprint
 * after locking" (dead tasks: can still be created before locking, F.7) → `card.lock` 20 cards →
 * then publish the 100 tasks with the same fingerprint as the lock (live tasks) → run until all
 * live tasks are completed.
 */
const K1_CARDS = 20, K1_SEGS = 5;
const k1Card = i => `k1-card-${String(i).padStart(2, '0')}`;
const k1LockFp = i => (i < K1_CARDS / 2 ? FP_A : FP_B);

const stormCache = new Map();
function runStorm(prefilter) {
  if (stormCache.has(prefilter)) return stormCache.get(prefilter);
  const rig = createRig({ prefilter, groups: [{ name: 'A', fp: FP_A, count: 4 }, { name: 'B', fp: FP_B, count: 4 }] });
  const info = new Map();   // taskId → { card, fp, lockFp }
  const live = [], dead = [];
  for (let i = 0; i < K1_CARDS; i++) {
    for (const fp of [FP_A, FP_B]) {
      for (let s = 0; s < K1_SEGS; s++) {
        const task = snap(k1Card(i), fp, s);
        info.set(task.id, { card: i, fp, lockFp: k1LockFp(i) });
        (fp === k1LockFp(i) ? live : dead).push(task);
      }
    }
  }
  rig.start();
  rig.publish(dead);
  const beforeLock = rig.mark();
  for (let i = 0; i < K1_CARDS; i++) rig.lock(k1Card(i), k1LockFp(i));
  rig.lb.flush();
  const lockLog = rig.since(beforeLock);
  const lockedReplies = rig.pubInbox.filter(m => m.type === 'card.locked');
  assert.equal(lockedReplies.length, K1_CARDS);
  for (const m of lockedReplies) assert.equal(m.granted, true, `Lock ${m.lockKey} should be granted`);

  const afterLock = rig.mark();
  rig.publish(live);
  const steps = rig.runUntil(ids(live));
  const log = rig.since(afterLock);

  const nodeFp = new Map(rig.nodes.map(n => [n.connId, n.fp]));
  // Mismatched nodes (node fingerprint != card's lock fingerprint) receive task.opened for tasks
  // of locked cards (after locking)
  const openedMismatch = log.filter(e => e.dir === 'out' && e.message.type === 'task.opened'
    && nodeFp.has(e.connId) && info.get(e.message.task.id) && nodeFp.get(e.connId) !== info.get(e.message.task.id).lockFp).length;
  const openedTotal = log.filter(e => e.dir === 'out' && e.message.type === 'task.opened' && nodeFp.has(e.connId)).length;
  // At the locking step: hidden retractions received by each node
  const hiddenAtLock = new Map(rig.nodes.map(n => [n.connId, sorted(lockLog
    .filter(e => e.dir === 'out' && e.connId === n.connId && e.message.type === 'task.closed' && e.message.state === 'hidden')
    .map(e => e.message.id))]));
  const hiddenTotal = [...hiddenAtLock.values()].reduce((s, l) => s + l.length, 0);

  const result = {
    rig, info, live, dead, steps, stats: claimStats(log), openedMismatch, openedTotal, hiddenAtLock, hiddenTotal,
    doneCount: countBy(rig.doneIds()), view: rig.queue.describe(),
  };
  stormCache.set(prefilter, result);
  return result;
}

/* ================================================================== K1 */

test('K1 Two fingerprints with 4 nodes each, 200 tasks, half of the cards locked to the other fingerprint: with the filter on, card-locked occurs 0 times in steady state; the filter-off run is the control', t => {
  for (const on of MODES) {
    const r = runStorm(on);
    const { stats } = r;
    t.diagnostic(`${modeName(on)}: steps=${r.steps} claims=${stats.claims} card-locked=${stats.cardLocked} throttled=${stats.throttled} taken=${stats.taken} stale=${stats.stale} live tasks completed=${[...r.doneCount.keys()].length}/${r.live.length}`);

    assert.deepEqual(r.rig.lb.errors(), [], 'The endpoint handler threw no exception');
    assert.deepEqual(r.rig.lb.nonJson(), [], 'Every message survives a JSON round trip');
    // All live tasks completed, each with exactly one task.done
    assert.deepEqual(sorted([...r.doneCount.keys()]), ids(r.live), `${modeName(on)}: all live tasks completed, and only those`);
    for (const [id, c] of r.doneCount) assert.equal(c, 1, `${id} received ${c} task.done messages`);
    assert.equal(r.rig.failedMsgs().length, 0, 'No task failed');
    // Dead tasks (locked to another fingerprint) have never been claimed
    const byId = new Map(r.view.tasks.map(x => [x.id, x]));
    for (const d of r.dead) {
      assert.equal(byId.get(d.id)?.state, 'open', `${d.id} should still be open`);
      assert.equal(byId.get(d.id)?.version, 1, `${d.id} was never claimed`);
    }
    for (const n of r.rig.nodes) assert.deepEqual(n.lost, [], `${n.nodeId} should not lose claims`);

    if (on) {
      assert.equal(stats.cardLocked, 0, 'Filter on: 0 card-locked rejections in steady state');
      assert.ok(stats.cardLocked <= stats.claims * 0.01, 'Filter on: rejections within the race window do not exceed 1% of the total claims');
      assert.equal(stats.throttled, 0);
    } else {
      assert.ok(stats.cardLocked > 0, 'Filter off: the control group should show card-locked rejections (otherwise the scenario is meaningless)');
      assert.equal(stats.throttled, 0, 'Filter off: throttling is off too');
    }
  }
  const on = runStorm(true).stats, off = runStorm(false).stats;
  t.diagnostic(`Comparison: card-locked filter on ${on.cardLocked} / filter off ${off.cardLocked}; claims filter on ${on.claims} / filter off ${off.claims}`);
});

/* ================================================================== K2 */

test('K2 Same scenario as K1: with the filter on, mismatched nodes receive 0 task.opened for tasks of locked cards; what is withdrawn at lock time is exactly the dead tasks of this fingerprint', t => {
  for (const on of MODES) {
    const r = runStorm(on);
    t.diagnostic(`${modeName(on)}: ${r.openedTotal} task.opened after locking, ${r.openedMismatch} of them to mismatched nodes; ${r.hiddenTotal} hidden withdrawals at lock time`);
    if (on) {
      assert.equal(r.openedMismatch, 0, 'Filter on: mismatched nodes receive 0 task.opened for tasks of locked cards');
      // I.3 (new lock): what is visible before locking and invisible after locking are dead tasks with
      // this fingerprint locked to another fingerprint
      for (const n of r.rig.nodes) {
        const expect = ids(r.dead.filter(d => r.info.get(d.id).fp === n.fp));
        assert.deepEqual(r.hiddenAtLock.get(n.connId), expect, `The tasks withdrawn from ${n.nodeId} at lock time should be exactly the dead tasks of this fingerprint`);
      }
    } else {
      assert.ok(r.openedMismatch > 0, 'Filter off: mismatched nodes in the control group still receive task.opened');
      assert.equal(r.hiddenTotal, 0, 'Filter off: no hidden');
    }
  }
});

/* ================================================================== K3 */

test('K3 Moving the locks of 20 cards from X to Y during the run: node X receives only the withdrawals for these 20 cards, node Y receives only backfills, other nodes receive 0 messages; each task gets exactly one task.done', t => {
  for (const on of MODES) {
    const rig = createRig({ prefilter: on, groups: [{ name: 'X', fp: FP_A, count: 4 }, { name: 'Y', fp: FP_B, count: 4 }, { name: 'Z', fp: FP_C, count: 2 }] });
    const moving = Array.from({ length: 20 }, (_, i) => `k3-move-${String(i).padStart(2, '0')}`);
    const stableX = Array.from({ length: 10 }, (_, i) => `k3-sx-${i}`);
    const stableY = Array.from({ length: 10 }, (_, i) => `k3-sy-${i}`);
    // Transferred cards have low priority: they will not be claimed before takeover, ensuring they
    // are all open at the moment of takeover
    const movingY = moving.flatMap(ck => [0, 1].map(s => snap(ck, FP_B, s, { priority: 0 })));
    const movingX = moving.flatMap(ck => [0, 1].map(s => snap(ck, FP_A, s, { priority: 0 })));
    const sX = stableX.flatMap(ck => [0, 1, 2].map(s => snap(ck, FP_A, s, { priority: 10 })));
    const sY = stableY.flatMap(ck => [0, 1, 2].map(s => snap(ck, FP_B, s, { priority: 10 })));

    rig.start();
    rig.publish(movingY);                           // Published before locking (locked to X thereafter, they are dead tasks)
    for (const ck of [...moving, ...stableX]) rig.lock(ck, FP_A);
    for (const ck of stableY) rig.lock(ck, FP_B);
    rig.lb.flush();
    rig.publish([...movingX, ...sX, ...sY]);
    for (let i = 0; i < 3; i++) rig.step();         // Running

    const pre = rig.queue.describe();
    for (const x of movingX) assert.equal(pre.tasks.find(v => v.id === x.id).state, 'open', `${x.id} should be open before the takeover`);
    assert.ok(pre.tasks.some(v => v.state === 'claimed'), 'Some tasks are already running at the time of takeover');

    const m = rig.mark();
    for (const ck of moving) rig.lock(ck, FP_B, true);
    rig.lb.flush();
    const log = rig.since(m).filter(e => e.dir === 'out');
    const toGroup = g => log.filter(e => rig.byConn.get(e.connId)?.group === g);
    const X = toGroup('X'), Y = toGroup('Y'), Z = toGroup('Z');
    t.diagnostic(`${modeName(on)}: takeover step, ${X.length} messages in total for node X, ${Y.length} for node Y, ${Z.length} for node Z`);
    t.diagnostic(`${modeName(on)}: X types ${JSON.stringify(Object.fromEntries(countBy(X.map(e => `${e.message.type}:${e.message.state ?? ''}`))))}; Y types ${JSON.stringify(Object.fromEntries(countBy(Y.map(e => `${e.message.type}:${e.message.state ?? ''}`))))}`);

    const locked = rig.pubInbox.filter(x => x.type === 'card.locked' && x.envFingerprint === FP_B && moving.some(ck => x.lockKey === `snapshot:${ck}`));
    assert.equal(locked.length, 20, 'All 20 takeovers got a reply');
    for (const x of locked) assert.equal(x.granted, true);

    const movingXIds = ids(movingX), movingYIds = ids(movingY);
    const xNodes = rig.nodes.filter(n => n.group === 'X'), yNodes = rig.nodes.filter(n => n.group === 'Y');
    if (on) {
      for (const n of xNodes) {
        const mine = X.filter(e => e.connId === n.connId).map(e => e.message);
        assert.ok(mine.every(x => x.type === 'task.closed'), `${n.nodeId} received only withdrawals: ${JSON.stringify(mine.map(x => x.type))}`);
        assert.deepEqual(sorted(mine.map(x => x.id)), movingXIds, `${n.nodeId} received exactly the withdrawals for these 20 cards, one per task`);
        for (const x of mine) assert.deepEqual([x.state, x.reason], ['hidden', 'card-locked'], `The withdrawal for ${x.id} should be hidden / card-locked (I.10 clause 2)`);
      }
      for (const n of yNodes) {
        const mine = Y.filter(e => e.connId === n.connId).map(e => e.message);
        assert.ok(mine.every(x => x.type === 'task.opened'), `${n.nodeId} received only backfills: ${JSON.stringify(mine.map(x => x.type))}`);
        assert.deepEqual(sorted(mine.map(x => x.task.id)), movingYIds, `${n.nodeId} received exactly the backfills for these 20 cards`);
      }
      assert.equal(Z.length, 0, 'Other nodes get 0 messages');
    } else {
      assert.equal(log.filter(e => e.message.type === 'task.opened').length, 0, 'Filter off: no backfill');
      assert.equal(log.filter(e => e.message.type === 'task.closed' && e.message.state === 'hidden').length, 0, 'Filter off: no hidden');
      for (const n of rig.nodes) {
        const mine = log.filter(e => e.connId === n.connId).map(e => e.message);
        assert.deepEqual(sorted(mine.map(x => `${x.type}:${x.id}:${x.state}`)), movingXIds.map(id => `task.closed:${id}:failed`),
          `Filter off: ${n.nodeId} receives failed for the invalidated tasks as in F.1`);
      }
    }

    // Run to completion: two stable card groups and the transferred Y tasks each have exactly one
    // task.done; transferred tasks of X are invalidated
    const expectDone = [...sX, ...sY, ...movingY];
    const steps = rig.runUntil(ids(expectDone));
    const done = countBy(rig.doneIds());
    t.diagnostic(`${modeName(on)}: steps to finish=${steps} task.done=${rig.doneIds().length} task.failed=${rig.failedMsgs().length}`);
    assert.deepEqual(rig.lb.errors(), []);
    assert.deepEqual(sorted([...done.keys()]), ids(expectDone), `${modeName(on)}: exactly the expected tasks completed`);
    for (const [id, c] of done) assert.equal(c, 1, `${id} received ${c} task.done messages`);
    const failed = countBy(rig.failedMsgs().map(x => x.id));
    assert.deepEqual(sorted([...failed.keys()]), movingXIds, 'Exactly X\'s transferred tasks were invalidated');
    for (const x of rig.failedMsgs()) assert.equal(x.error, 'superseded');
    for (const [id, c] of failed) assert.equal(c, 1, `${id} received ${c} task.failed`);
    // Transferred Y tasks are executed only by Y nodes
    const doneBy = new Map(rig.nodes.flatMap(n => n.completed.map(id => [id, n.group])));
    for (const id of movingYIds) assert.equal(doneBy.get(id), 'Y', `${id} should be completed by node Y`);
    const stats = claimStats(rig.since(m));
    t.diagnostic(`${modeName(on)}: after the takeover, claims=${stats.claims} card-locked=${stats.cardLocked}`);
  }
});

/* ================================================================== K4 */

/**
 * Scenario for K4: rogue (A) ignores filtering and repeatedly claims dead tasks locked to B;
 * a2 (A) and b (B) are normal nodes.
 */
function k4Setup(on, extra = {}) {
  const h = harness(on, extra);
  h.publisher('p', 'pub-p');
  const dead = snap('k4-locked', FP_A, 0);
  publishOk(h, 'p', [dead]);
  cardLock(h, 'p', { contentKey: 'k4-locked', envFingerprint: FP_B });
  const liveA = [0, 1, 2, 3].map(s => snap('k4-free', FP_A, s));
  const liveB = [0, 1].map(s => snap('k4-freeb', FP_B, s));
  publishOk(h, 'p', [...liveA, ...liveB]);
  joinNode(h, 'rogue', 'node-rogue', FP_A);
  joinNode(h, 'a2', 'node-a2', FP_A);
  joinNode(h, 'b', 'node-b', FP_B);
  h.bus.clear();
  return { h, dead, liveA, liveB };
}
const connInfo = (h, nodeId) => h.nodeInfo(nodeId);
const rejectOf = (out, conn) => out.one(conn, 'task.claim-rejected');

test('K4 One node ignores the filter and repeatedly claims locked cards: after more than 20 rejections it gets throttled, other nodes are unaffected; it recovers after the next tick()', t => {
  for (const on of MODES) {
    const { h, dead, liveA, liveB } = k4Setup(on);
    const reasons = [];
    for (let i = 0; i < 30; i++) {
      const r = rejectOf(h.claim('rogue', dead.id, 1), 'rogue');
      assert.equal(r.id, dead.id);
      reasons.push(r.reason);
      if (r.reason === 'card-locked') assert.equal(r.lockedBy, FP_B);
    }
    const counts = Object.fromEntries(countBy(reasons));
    const info = connInfo(h, 'node-rogue');
    t.diagnostic(`${modeName(on)}: 30 claims by rogue: ${JSON.stringify(counts)}; describe: cardLockedRejects=${info?.cardLockedRejects} throttled=${info?.throttled}`);
    assert.equal(h.describe().prefilter, on, 'describe().prefilter');
    assert.equal(h.task(dead.id).version, 1, 'The dead task\'s version is unchanged');

    if (on) {
      assert.deepEqual(reasons, [...Array(21).fill('card-locked'), ...Array(9).fill('throttled')],
        'Filter on: the first 21 (the 21st pushes the count over 20) are card-locked, everything after that is throttled');
      assert.equal(info.cardLockedRejects, 21);
      assert.equal(info.throttled, true);

      // During rate limiting: claiming claimable tasks also returns throttled, without checking or
      // modifying task state; nonexistent tasks are likewise throttled
      const r1 = rejectOf(h.claim('rogue', liveA[0].id, 1), 'rogue');
      assert.deepEqual([r1.id, r1.reason], [liveA[0].id, 'throttled']);
      assert.equal(h.task(liveA[0].id).state, 'open');
      assert.equal(h.task(liveA[0].id).version, 1);
      const gone = rejectOf(h.claim('rogue', 'snapshot:nope:0-59', 1), 'rogue');
      assert.deepEqual([gone.id, gone.reason], ['snapshot:nope:0-59', 'throttled']);
      assert.equal(connInfo(h, 'node-rogue').cardLockedRejects, 21, 'throttled is not counted in the card-locked count');

      // Other nodes are unaffected: claiming as usual in the same period; its own card-locked is
      // counted separately
      const a2 = h.claim('a2', liveA[1].id, 1);
      assert.equal(a2.one('a2', 'task.claimed').id, liveA[1].id);
      assert.equal(rejectOf(h.claim('a2', dead.id, 1), 'a2').reason, 'card-locked');
      assert.equal(h.claim('b', liveB[0].id, 1).one('b', 'task.claimed').id, liveB[0].id);
      assert.deepEqual([connInfo(h, 'node-a2').cardLockedRejects, connInfo(h, 'node-a2').throttled], [1, false]);
      assert.deepEqual([connInfo(h, 'node-b').cardLockedRejects, connInfo(h, 'node-b').throttled], [0, false]);

      // Restored after the next tick()
      h.tick();
      assert.deepEqual([connInfo(h, 'node-rogue').cardLockedRejects, connInfo(h, 'node-rogue').throttled], [0, false], 'tick() resets to zero');
      assert.deepEqual([connInfo(h, 'node-a2').cardLockedRejects, connInfo(h, 'node-a2').throttled], [0, false]);
      assert.equal(h.claim('rogue', liveA[0].id, 1).one('rogue', 'task.claimed').id, liveA[0].id, 'rogue can claim again after tick');
      assert.equal(rejectOf(h.claim('rogue', dead.id, 1), 'rogue').reason, 'card-locked', 'Counting restarts after tick');
      assert.equal(connInfo(h, 'node-rogue').cardLockedRejects, 1);
    } else {
      assert.deepEqual(reasons, Array(30).fill('card-locked'), 'Filter off: throttling is off too, all are card-locked');
      assert.equal(info.throttled, false);
      assert.equal(h.claim('rogue', liveA[0].id, 1).one('rogue', 'task.claimed').id, liveA[0].id);
    }
  }
});

test('K4 supplement: the threshold comes from constants.THROTTLE_REJECTS', t => {
  const { h, dead, liveA } = k4Setup(true, { THROTTLE_REJECTS: 3 });
  const reasons = Array.from({ length: 6 }, () => rejectOf(h.claim('rogue', dead.id, 1), 'rogue').reason);
  t.diagnostic(`THROTTLE_REJECTS=3: ${JSON.stringify(reasons)}`);
  assert.deepEqual(reasons, ['card-locked', 'card-locked', 'card-locked', 'card-locked', 'throttled', 'throttled']);
  assert.equal(rejectOf(h.claim('rogue', liveA[0].id, 1), 'rogue').reason, 'throttled');
  h.tick();
  assert.equal(h.claim('rogue', liveA[0].id, 1).one('rogue', 'task.claimed').id, liveA[0].id);
});

/* ================================================================== K5 */

test('K5 Filter off: describe().prefilter === false, and lock creation, takeover and tasks without a fingerprint produce no hidden messages', t => {
  const h = harness(false);
  h.publisher('p', 'pub-p');
  joinNode(h, 'a', 'node-A', FP_A);
  joinNode(h, 'b', 'node-B', FP_B);
  joinNode(h, 'n', 'node-N', null);
  const tasks = [snap('k5', FP_A, 0), snap('k5', FP_B, 0), snap('k5', null, 0), snap('k5-2', FP_A, 0, { contentKey: false })];
  publishOk(h, 'p', tasks);
  cardLock(h, 'p', { contentKey: 'k5', envFingerprint: FP_A });               // Create
  const c = h.claim('a', tasks[0].id, 1).one('a', 'task.claimed');
  h.complete('a', tasks[0].id, c.token, { ranges: [[0, 59]] });
  cardLock(h, 'p', { contentKey: 'k5', envFingerprint: FP_B, takeover: true }); // Take over
  h.tick();
  const snapA = joinNode(h, 'a2', 'node-A2', FP_A);

  assert.equal(h.describe().prefilter, false);
  const all = h.bus.all();
  const hidden = all.ofType('task.closed').filter(e => e.message.state === 'hidden' || e.message.reason === 'card-locked');
  t.diagnostic(`Filter off: among all ${all.count} messages, ${hidden.length} are hidden`);
  assert.equal(hidden.length, 0, 'Filter off: no hidden messages');
  assert.equal(all.ofType('task.claim-rejected').filter(e => e.message.reason === 'throttled').length, 0);
  // Filter disabled: newly connected node A sees all open tasks (both fingerprint B and locked
  // to B are present)
  const openIds = h.describe().tasks.filter(x => x.state === 'open').map(x => x.id).sort();
  assert.deepEqual(snapA, openIds);
});

test('K5 Constants and diagnostics (I.1, I.7): PREFILTER defaults to on, THROTTLE_REJECTS is 20, environment variable names; the new fields of describe', t => {
  const { QUEUE_DEFAULTS, QUEUE_ENV } = queueIndex;
  assert.equal(QUEUE_DEFAULTS.PREFILTER, true);
  assert.equal(QUEUE_DEFAULTS.THROTTLE_REJECTS, 20);
  assert.equal(QUEUE_ENV.PREFILTER, 'PROMPTCUT_QUEUE_PREFILTER');
  assert.equal(QUEUE_ENV.THROTTLE_REJECTS, 'PROMPTCUT_QUEUE_THROTTLE_REJECTS');

  const h = createQueueHarness(createRenderQueue);   // Without constants: enabled by default
  joinNode(h, 'a', 'node-A', FP_A);
  const d = h.describe();
  t.diagnostic(`Default describe().prefilter=${d.prefilter}; nodes[0]=${JSON.stringify(d.nodes[0])}`);
  assert.equal(d.prefilter, true);
  assert.equal(d.nodes[0].cardLockedRejects, 0);
  assert.equal(d.nodes[0].throttled, false);
  assert.equal(harness(false).describe().prefilter, false);
});

/* ================================================================== K6 */

/** Session unit tests: hand-crafted queue responses (shaped according to A.6 / A.7). */
function sessionHarness(over = {}) {
  let t = 1_000;
  const sent = [];
  const session = createNodeSession({
    nodeId: 'node-1', node: nodeDesc(FP_A), send: m => sent.push(m), now: () => t, random: () => 0,
    maxConcurrent: 2, onTask: () => {}, onLost: () => {}, ...over,
  });
  session.start();
  sent.length = 0;
  return {
    session, sent,
    get now() { return t; },
    set: v => { t = v; },
    tick() { sent.length = 0; session.tick(); return sent.slice(); },
  };
}
function sView(name, version = 1) {
  return {
    id: `snapshot:${name}:0-59`, kind: 'snapshot', tier: 'shared', resultKey: name,
    range: { unit: 'localFrame', from: 0, to: 59 },
    source: { userId: 'u1', tenantId: 't1', projectId: 'p1', projectRev: 1, publisher: { id: 'P' }, publishedAt: 1, derivedFrom: null },
    input: {}, weight: { class: 'medium', estMs: null, frames: 60 }, requires: { envFingerprint: FP_A },
    priority: 10, state: 'open', version, attempts: 0,
  };
}
const E = 'epoch-k6';
const claimedMsg = (task, token, at) => ({
  type: 'task.claimed', epoch: E, id: task.id, token, version: token, leaseUntil: at + LEASE, task: { ...task, state: 'claimed', version: token },
});
const types = list => list.map(m => m.type);

function k6Run(t, s, sweep) {
  const [v0, v1, v2] = ['k6-a', 'k6-b', 'k6-c'].map(n => sView(n));
  s.session.receive({ type: 'queue.snapshot', epoch: E, tasks: [v0, v1, v2] });
  // Claim one first and hold it (used to observe lease renewals)
  const c0 = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c0.length, 1);
  const first = [v0, v1, v2].find(v => v.id === c0[0].id);
  s.session.receive(claimedMsg(first, 2, s.now));
  const heldAt = s.now;

  // Send second claim after 9 seconds, returns throttled
  s.set(heldAt + 9_000);
  const c1 = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c1.length, 1, 'The second claim is sent');
  const candidate = c1[0].id;
  s.session.receive({ type: 'task.claim-rejected', epoch: E, id: candidate, reason: 'throttled' });
  const throttledAt = s.now;
  assert.ok(s.session.known().some(v => v.id === candidate), 'A throttled candidate is not removed from the local view');

  // During backoff: lease renewals are sent as usual, claims are not sent
  s.set(heldAt + RENEW);
  assert.ok(s.now < throttledAt + sweep, 'Scenario self-check: still in the backoff period when the lease renewal is due');
  const during = s.tick();
  t.diagnostic(`SWEEP=${sweep} in backoff t=+${s.now - throttledAt}: ${JSON.stringify(types(during))}`);
  assert.deepEqual(types(during), ['task.progress'], 'During backoff, lease renewals are still sent and no claims are made');
  assert.equal(during[0].id, first.id);
  s.set(throttledAt + sweep - 1);
  const edge = s.tick();
  t.diagnostic(`SWEEP=${sweep} t=+${sweep - 1}: ${JSON.stringify(types(edge))}`);
  assert.equal(edge.filter(m => m.type === 'task.claim').length, 0, 'No claims within SWEEP_INTERVAL_MS');

  s.set(throttledAt + sweep);
  const after = s.tick();
  t.diagnostic(`SWEEP=${sweep} t=+${sweep}: ${JSON.stringify(types(after))}`);
  const claims = after.filter(m => m.type === 'task.claim');
  assert.equal(claims.length, 1, 'Claiming resumes once SWEEP_INTERVAL_MS has passed (the in-flight claim has been cleared)');
  assert.ok([v0, v1, v2].some(v => v.id === claims[0].id) && claims[0].id !== first.id);
}

test('K6 Session: after throttled, tick() sends no claims within SWEEP_INTERVAL_MS but still sends lease renewals; it recovers afterwards', t => {
  k6Run(t, sessionHarness(), SWEEP);
});

test('K6 supplement: the backoff duration comes from constants.SWEEP_INTERVAL_MS', t => {
  k6Run(t, sessionHarness({ constants: { SWEEP_INTERVAL_MS: 2_000 } }), 2_000);
});

test('K6 supplement: task.closed { state: hidden } is removed from the local view like any other task.closed', () => {
  const s = sessionHarness();
  const [v0, v1] = [sView('k6h-a'), sView('k6h-b')];
  s.session.receive({ type: 'queue.snapshot', epoch: E, tasks: [v0, v1] });
  s.session.receive({ type: 'task.closed', epoch: E, id: v0.id, state: 'hidden', reason: 'card-locked' });
  assert.deepEqual(s.session.known().map(v => v.id), [v1.id]);
  const claims = s.tick().filter(m => m.type === 'task.claim');
  assert.deepEqual(claims.map(m => m.id), [v1.id], 'Withdrawn tasks are no longer claimed');
});

test('K6 supplement: start() clears throttledUntil (I.10 clause 6)', () => {
  const s = sessionHarness();
  const v0 = sView('k6s-a');
  s.session.receive({ type: 'queue.snapshot', epoch: E, tasks: [v0] });
  const c = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c.length, 1);
  s.session.receive({ type: 'task.claim-rejected', epoch: E, id: v0.id, reason: 'throttled' });
  assert.equal(s.tick().filter(m => m.type === 'task.claim').length, 0, 'In backoff');
  s.session.start();
  s.session.receive({ type: 'queue.snapshot', epoch: E, tasks: [v0] });
  assert.equal(s.tick().filter(m => m.type === 'task.claim').length, 1, 'No backoff after start()');
});

/* ================================================================== K7 */

test('K7 When the session receives an error with a reqId it does not clear the in-flight claim; an error without a reqId still clears it (I.10 clause 5)', () => {
  const started = [];
  const s = sessionHarness({ onTask: task => started.push(task.id) });
  const [v0, v1, v2] = [sView('k7-a'), sView('k7-b'), sView('k7-c')];
  s.session.receive({ type: 'queue.snapshot', epoch: E, tasks: [v0, v1, v2] });
  const c = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c.length, 1);
  const first = [v0, v1, v2].find(v => v.id === c[0].id);

  // Error responses for other requests (content store, publish): carries reqId, not a claim
  // response
  s.session.receive({ type: 'error', epoch: E, reqId: 'lib-1', reason: 'bad-message', detail: 'x' });
  s.session.receive({ type: 'error', epoch: E, reqId: 7, reason: 'not-registered' });
  assert.equal(s.tick().filter(m => m.type === 'task.claim').length, 0, 'The claim is still in flight after an error with a reqId, so no second one is sent');
  s.session.receive(claimedMsg(first, 2, s.now));
  assert.deepEqual(started, [first.id], 'The claim reply is handled as usual');
  assert.deepEqual(s.session.held().map(x => x.id), [first.id]);

  // error without reqId: clears in-flight as usual
  const c2 = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c2.length, 1, 'The second claim is sent (maxConcurrent 2)');
  s.session.receive({ type: 'error', epoch: E, reason: 'bad-message', detail: 'y' });
  const c3 = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c3.length, 1, 'An error without a reqId clears the in-flight claim, and the next tick claims again');
});
