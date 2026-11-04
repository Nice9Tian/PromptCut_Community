/**
 * M7-T: D1 on the queue side (dual key emission: first claimant gets the card, invalidates the other
 * copy upon lock creation) and D2 (idle lock: response includes lockIdleMs / lockedByProfile, lease
 * renewal refreshes touchedAt). Basis: `docs/plan/m7-contract.md` Sections 3.3 and 3.4 and Section 13
 * ruling; `render-queue-contract.md` Sections F.1 and I. Assumptions see K4 and K5 in `m7-kit.mjs`;
 * skip the entire group when implementation is absent.
 * Run: node --experimental-test-module-mocks --test server/test/m7-queue-lock.test.mjs
 *
 * All use fake timers (`createQueueHarness`), with no real timing assertions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createQueueHarness } from './fake-render-queue-env.mjs';
import { snapTask, queueDualGate, lockIdleGate, gateOpts } from './m7-kit.mjs';

const OWN = '1111111111111111';     // Fingerprint of the splitter (pc / host)
const BR = '2222222222222222';      // Fingerprint of pure browser
const THIRD = '3333333333333333';
const CK = 'ck-motion-1';
const USER = 'zoe@devA';

/** Dual copies of a card: two copies per segment (OWN, BR), both with input.dual; browser copy includes bake and compositing */
function dualPair(seg, { contentKey = CK } = {}) {
  return [
    snapTask({ contentKey, fp: OWN, seg, input: { dual: true } }),
    snapTask({ contentKey, fp: BR, seg, input: { dual: true, bake: { count: 120, sampling: { firstFrame: 0 } } } }),
  ];
}

/** pc (OWN), user's own pure browser (BR), and page publisher; all watch p1 */
function rig(constants = {}) {
  const h = createQueueHarness(createRenderQueue, { constants });
  h.publisher('page', 'pub-page', { userId: USER });
  h.node('pc', 'n-pc', { profile: 'pc', userId: 'rig@pc', watch: ['p1'], hello: { envFingerprint: OWN } });
  h.node('br', 'n-br', { profile: 'browser', userId: USER, watch: ['p1'], hello: { envFingerprint: BR } });
  return h;
}
const stateOf = (h, id) => h.task(id);
function claimOk(h, conn, task) {
  const out = h.claim(conn, task.id, h.task(task.id).version);
  const m = out.last(conn, ['task.claimed', 'task.claim-rejected']);
  assert.equal(m?.type, 'task.claimed', `${conn} claims ${task.id}: ${JSON.stringify(m)}`);
  return m;
}

/* ================================================================== D1 */

test('D1 browser claims first: when the lock is created, all open dual tasks with the same lock key and a different fingerprint are invalidated (failed / superseded, attempts unchanged), and the browser\'s segments proceed as usual', gateOpts(queueDualGate()), () => {
  const h = rig();
  const [own0, br0] = dualPair(0);
  const [own1, br1] = dualPair(1);
  const pub = h.publish('page', [own0, br0, own1, br1]);
  for (const r of pub.one('page', 'task.published').results) assert.equal(r.error, undefined, JSON.stringify(r));

  const c = claimOk(h, 'br', br0);
  for (const t of [own0, own1]) {
    const s = stateOf(h, t.id);
    assert.equal(s.state, 'failed', `${t.id} should be invalidated: ${JSON.stringify(s)}`);
    assert.equal(s.lastError, 'superseded');
    assert.equal(s.attempts, 0, 'Invalidation is not counted as a failed attempt');
  }
  assert.equal(stateOf(h, br0.id).state, 'claimed');
  assert.equal(stateOf(h, br1.id).state, 'open', 'The remaining segments of the browser\'s copy stay open as usual');

  // Invalidated task was never claimed: do not send lease-lost
  assert.equal(h.bus.ofType('task.lease-lost').length, 0, 'Nobody claimed the invalidated dual task, so no lease-lost is sent');
  // pc can no longer claim the splitter's copy
  const again = h.claim('pc', own1.id, stateOf(h, own1.id).version).last('pc', ['task.claimed', 'task.claim-rejected']);
  assert.equal(again.type, 'task.claim-rejected', JSON.stringify(again));

  // Browser finishes two segments: exactly one task.done per task (none for invalidated ones)
  h.complete('br', br0.id, c.token, { v: 1 });
  const c1 = claimOk(h, 'br', br1);
  h.complete('br', br1.id, c1.token, { v: 1 });
  const done = h.bus.of('page', 'task.done').map((m) => m.id).sort();
  assert.deepEqual(done, [br0.id, br1.id].sort(), `task.done goes only to the browser's two segments, once each: ${JSON.stringify(done)}`);
});

test('D1 splitter claims first: the browser\'s copy is entirely invalidated, and the browser can no longer see or claim it afterwards', gateOpts(queueDualGate()), () => {
  const h = rig();
  const tasks = [...dualPair(0), ...dualPair(1)];
  h.publish('page', tasks);
  const [own0, br0, , br1] = tasks;
  claimOk(h, 'pc', own0);
  for (const t of [br0, br1]) {
    const s = stateOf(h, t.id);
    assert.deepEqual([s.state, s.lastError], ['failed', 'superseded'], JSON.stringify(s));
  }
  const r = h.claim('br', br1.id, stateOf(h, br1.id).version).last('br', ['task.claimed', 'task.claim-rejected']);
  assert.equal(r.type, 'task.claim-rejected', JSON.stringify(r));
  // Browser node has received revocations for both segments (both hidden and failed count)
  const closed = new Set(h.bus.of('br', 'task.closed').map((m) => m.id));
  assert.ok(closed.has(br0.id) && closed.has(br1.id), `The browser should receive the withdrawal: ${JSON.stringify([...closed])}`);
});

test('D1 invalidated tasks no longer count toward MAX_TASKS_PER_PROJECT: new tasks can be published after the invalidation', gateOpts(queueDualGate()), () => {
  const h = rig({ MAX_TASKS_PER_PROJECT: 2 });
  const [own0, br0] = dualPair(0);
  h.publish('page', [own0, br0]);
  const full = h.publish('page', [snapTask({ contentKey: 'ck-2', fp: OWN })]).one('page', 'task.published').results[0];
  assert.equal(full.error, 'limit', `Control: when full it should return limit: ${JSON.stringify(full)}`);
  claimOk(h, 'br', br0);
  const next = h.publish('page', [snapTask({ contentKey: 'ck-3', fp: OWN })]).one('page', 'task.published').results[0];
  assert.equal(next.error, undefined, `The browser's copy invalidated the splitter's copy, so a slot should be freed up: ${JSON.stringify(next)}`);
});

test('D1 the behavior of tasks without dual is unchanged: open tasks with a different fingerprint are kept when the lock is created (they are only blocked by the lock)', gateOpts(queueDualGate()), () => {
  const h = rig();
  const a = snapTask({ contentKey: CK, fp: OWN, seg: 0 });
  const b = snapTask({ contentKey: CK, fp: BR, seg: 0 });
  h.publish('page', [a, b]);
  claimOk(h, 'br', b);
  assert.equal(stateOf(h, a.id).state, 'open', 'Those without dual are not invalidated');
  assert.equal(stateOf(h, a.id).lastError, null);
});

test('D1 invalidates only those with the same lock key: dual tasks of another card are unaffected, and dual tasks with the same fingerprint are unaffected too', gateOpts(queueDualGate()), () => {
  const h = rig();
  const [own0, br0] = dualPair(0);
  const [ownX, brX] = dualPair(0, { contentKey: 'ck-other' });
  const [, br1] = dualPair(1);
  h.publish('page', [own0, br0, ownX, brX, br1]);
  claimOk(h, 'br', br0);
  assert.equal(stateOf(h, own0.id).state, 'failed');
  assert.equal(stateOf(h, ownX.id).state, 'open', 'The splitter\'s copy of another card is left alone');
  assert.equal(stateOf(h, brX.id).state, 'open', 'The browser\'s copy of another card is left alone');
  assert.equal(stateOf(h, br1.id).state, 'open', 'Those with the same lock key and the same fingerprint are left alone');
});

test('D1 the card is locked on a third kind of environment: neither copy can be published (card-locked returns lockedBy), and dual does not relax it', gateOpts(queueDualGate()), () => {
  const h = rig();
  h.node('third', 'n-third', { profile: 'pc', userId: 'x@y', watch: ['p1'], hello: { envFingerprint: THIRD } });
  const z = snapTask({ contentKey: CK, fp: THIRD, seg: 5 });
  h.publish('page', [z]);
  claimOk(h, 'third', z);
  const results = h.publish('page', dualPair(0)).one('page', 'task.published').results;
  for (const r of results) assert.deepEqual([r.error, r.lockedBy], ['card-locked', THIRD], JSON.stringify(r));
});

/* ================================================================== D2 */

test('D2 claim blocked by a lock: the response carries lockIdleMs (now - touchedAt) and lockedByProfile (the profile of the node that created the lock)', gateOpts(lockIdleGate()), () => {
  const h = rig();
  const own = snapTask({ contentKey: CK, fp: OWN, seg: 1 });
  const br = snapTask({ contentKey: CK, fp: BR, seg: 0 });
  h.publish('page', [own, br]);
  claimOk(h, 'br', br);
  h.clock.advance(5_000);
  const r = h.claim('pc', own.id, stateOf(h, own.id).version).last('pc', ['task.claimed', 'task.claim-rejected']);
  assert.equal(r.reason, 'card-locked', JSON.stringify(r));
  assert.equal(r.lockedBy, BR);
  assert.equal(r.lockIdleMs, 5_000, JSON.stringify(r));
  assert.equal(r.lockedByProfile, 'browser', JSON.stringify(r));
});

test('D2 publish refused by a lock: results[i] carries lockIdleMs and lockedByProfile; a lock created by pc reports pc', gateOpts(lockIdleGate()), () => {
  const h = rig();
  const br = snapTask({ contentKey: CK, fp: BR, seg: 0 });
  h.publish('page', [br]);
  claimOk(h, 'br', br);
  h.clock.advance(12_000);
  const r = h.publish('page', [snapTask({ contentKey: CK, fp: OWN, seg: 3 })]).one('page', 'task.published').results[0];
  assert.deepEqual([r.error, r.lockedBy, r.lockIdleMs, r.lockedByProfile], ['card-locked', BR, 12_000, 'browser'], JSON.stringify(r));

  const own = snapTask({ contentKey: 'ck-pc', fp: OWN, seg: 0 });
  h.publish('page', [own]);
  claimOk(h, 'pc', own);
  h.clock.advance(1_000);
  const r2 = h.publish('page', [snapTask({ contentKey: 'ck-pc', fp: BR, seg: 1 })]).one('page', 'task.published').results[0];
  assert.deepEqual([r2.error, r2.lockIdleMs, r2.lockedByProfile], ['card-locked', 1_000, 'pc'], JSON.stringify(r2));
});

test('D2 lease renewal (task.progress) refreshes touchedAt: a lock that is still producing does not look idle; once it stops, the idle time grows as usual', gateOpts(lockIdleGate()), () => {
  const h = rig();
  const br = snapTask({ contentKey: CK, fp: BR, seg: 0 });
  h.publish('page', [br]);
  const c = claimOk(h, 'br', br);
  const t0 = h.now();
  h.clock.advance(20_000);
  h.progress('br', br.id, c.token, 10);
  const lock = h.describe().locks.find((l) => l.lockKey === `snapshot:${CK}`);
  assert.equal(lock.touchedAt, t0 + 20_000, `Lease renewal should refresh touchedAt: ${JSON.stringify(lock)}`);
  // Lease renewal with unchanged progress also refreshes (renewal = still producing)
  h.clock.advance(10_000);
  h.progress('br', br.id, c.token, 10);
  assert.equal(h.describe().locks.find((l) => l.lockKey === `snapshot:${CK}`).touchedAt, t0 + 30_000);

  h.clock.advance(31_000);
  const r = h.publish('page', [snapTask({ contentKey: CK, fp: OWN, seg: 2 })]).one('page', 'task.published').results[0];
  assert.equal(r.lockIdleMs, 31_000, JSON.stringify(r));
});

test('D2 after more than 30 s idle, the splitter republishes with takeover: the lock moves to the splitter and the browser copy is voided (existing F.7 behavior, regression)', gateOpts(lockIdleGate()), () => {
  const h = rig();
  const br = snapTask({ contentKey: CK, fp: BR, seg: 0 });
  h.publish('page', [br]);
  claimOk(h, 'br', br);
  h.clock.advance(30_001);
  const probe = h.publish('page', [snapTask({ contentKey: CK, fp: OWN, seg: 0 })]).one('page', 'task.published').results[0];
  assert.ok(probe.lockIdleMs > 30_000, JSON.stringify(probe));
  const take = { ...snapTask({ contentKey: CK, fp: OWN, seg: 0 }), takeover: true };
  const r = h.publish('page', [take]).one('page', 'task.published').results[0];
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(h.describe().locks.find((l) => l.lockKey === `snapshot:${CK}`).envFingerprint, OWN);
  assert.equal(stateOf(h, br.id).lastError, 'superseded');
});
