/**
 * M7-T：队列侧的 D1（双份出键：先认领者得卡、建锁时作废另一份）与 D2（锁闲置：回包带 lockIdleMs / lockedByProfile，
 * 续约刷新 touchedAt）。依据：`docs/plan/m7-contract.md` 第 3.3、3.4 节与第 13 节裁定；`render-queue-contract.md` F.1、I 节。
 * 假设见 `m7-kit.mjs` 的 K4、K5；实现不在时整组 skip。
 * 跑：node --experimental-test-module-mocks --test server/test/m7-queue-lock.test.mjs
 *
 * 全部用假时钟（`createQueueHarness`），没有真实计时断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createQueueHarness } from './fake-render-queue-env.mjs';
import { snapTask, queueDualGate, lockIdleGate, gateOpts } from './m7-kit.mjs';

const OWN = '1111111111111111';     // 切分方（pc / host）的指纹
const BR = '2222222222222222';      // 纯浏览器的指纹
const THIRD = '3333333333333333';
const CK = 'ck-motion-1';
const USER = 'zoe@devA';

/** 一张卡的双份：每段两份（OWN、BR），都 input.dual；浏览器那份带 bake 与 compositing */
function dualPair(seg, { contentKey = CK } = {}) {
  return [
    snapTask({ contentKey, fp: OWN, seg, input: { dual: true } }),
    snapTask({ contentKey, fp: BR, seg, input: { dual: true, bake: { count: 120, sampling: { firstFrame: 0 } } } }),
  ];
}

/** pc（OWN）、本人的纯浏览器（BR）、页面发布方；都 watch p1 */
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
  assert.equal(m?.type, 'task.claimed', `${conn} 认领 ${task.id}：${JSON.stringify(m)}`);
  return m;
}

/* ================================================================== D1 */

test('D1 浏览器先认领：建锁时同锁键、异指纹、dual 的 open 任务全部作废（failed / superseded，attempts 不变），浏览器那几段照常', gateOpts(queueDualGate()), () => {
  const h = rig();
  const [own0, br0] = dualPair(0);
  const [own1, br1] = dualPair(1);
  const pub = h.publish('page', [own0, br0, own1, br1]);
  for (const r of pub.one('page', 'task.published').results) assert.equal(r.error, undefined, JSON.stringify(r));

  const c = claimOk(h, 'br', br0);
  for (const t of [own0, own1]) {
    const s = stateOf(h, t.id);
    assert.equal(s.state, 'failed', `${t.id} 应作废：${JSON.stringify(s)}`);
    assert.equal(s.lastError, 'superseded');
    assert.equal(s.attempts, 0, '作废不计失败次数');
  }
  assert.equal(stateOf(h, br0.id).state, 'claimed');
  assert.equal(stateOf(h, br1.id).state, 'open', '浏览器那一份的其余段照常 open');

  // 作废的没人认领过：不发 lease-lost
  assert.equal(h.bus.ofType('task.lease-lost').length, 0, '作废的 dual 任务没人认领，不发 lease-lost');
  // pc 再也认领不到切分方那一份
  const again = h.claim('pc', own1.id, stateOf(h, own1.id).version).last('pc', ['task.claimed', 'task.claim-rejected']);
  assert.equal(again.type, 'task.claim-rejected', JSON.stringify(again));

  // 浏览器做完两段：每个任务恰好一次 task.done（作废的没有）
  h.complete('br', br0.id, c.token, { v: 1 });
  const c1 = claimOk(h, 'br', br1);
  h.complete('br', br1.id, c1.token, { v: 1 });
  const done = h.bus.of('page', 'task.done').map((m) => m.id).sort();
  assert.deepEqual(done, [br0.id, br1.id].sort(), `task.done 只给浏览器那两段、各一次：${JSON.stringify(done)}`);
});

test('D1 切分方先认领：浏览器那一份全部作废，浏览器此后看不见、认领不到', gateOpts(queueDualGate()), () => {
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
  // 浏览器节点收到过这两段的撤回（hidden 或 failed 都算）
  const closed = new Set(h.bus.of('br', 'task.closed').map((m) => m.id));
  assert.ok(closed.has(br0.id) && closed.has(br1.id), `浏览器应收到撤回：${JSON.stringify([...closed])}`);
});

test('D1 作废的任务不再占 MAX_TASKS_PER_PROJECT：作废后能发布新任务', gateOpts(queueDualGate()), () => {
  const h = rig({ MAX_TASKS_PER_PROJECT: 2 });
  const [own0, br0] = dualPair(0);
  h.publish('page', [own0, br0]);
  const full = h.publish('page', [snapTask({ contentKey: 'ck-2', fp: OWN })]).one('page', 'task.published').results[0];
  assert.equal(full.error, 'limit', `对照：满了应回 limit：${JSON.stringify(full)}`);
  claimOk(h, 'br', br0);
  const next = h.publish('page', [snapTask({ contentKey: 'ck-3', fp: OWN })]).one('page', 'task.published').results[0];
  assert.equal(next.error, undefined, `浏览器那份作废了切分方那份，应腾出名额：${JSON.stringify(next)}`);
});

test('D1 不带 dual 的任务行为不变：建锁时异指纹的 open 任务留着（只被锁挡住）', gateOpts(queueDualGate()), () => {
  const h = rig();
  const a = snapTask({ contentKey: CK, fp: OWN, seg: 0 });
  const b = snapTask({ contentKey: CK, fp: BR, seg: 0 });
  h.publish('page', [a, b]);
  claimOk(h, 'br', b);
  assert.equal(stateOf(h, a.id).state, 'open', '不带 dual 的不作废');
  assert.equal(stateOf(h, a.id).lastError, null);
});

test('D1 只作废同锁键的：另一张卡的 dual 任务不受影响；同指纹的 dual 任务也不受影响', gateOpts(queueDualGate()), () => {
  const h = rig();
  const [own0, br0] = dualPair(0);
  const [ownX, brX] = dualPair(0, { contentKey: 'ck-other' });
  const [, br1] = dualPair(1);
  h.publish('page', [own0, br0, ownX, brX, br1]);
  claimOk(h, 'br', br0);
  assert.equal(stateOf(h, own0.id).state, 'failed');
  assert.equal(stateOf(h, ownX.id).state, 'open', '别的卡的切分方那份不动');
  assert.equal(stateOf(h, brX.id).state, 'open', '别的卡的浏览器那份不动');
  assert.equal(stateOf(h, br1.id).state, 'open', '同锁键同指纹的不动');
});

test('D1 卡锁在第三种环境上：两份都发不进来（card-locked 回 lockedBy），不因 dual 放宽', gateOpts(queueDualGate()), () => {
  const h = rig();
  h.node('third', 'n-third', { profile: 'pc', userId: 'x@y', watch: ['p1'], hello: { envFingerprint: THIRD } });
  const z = snapTask({ contentKey: CK, fp: THIRD, seg: 5 });
  h.publish('page', [z]);
  claimOk(h, 'third', z);
  const results = h.publish('page', dualPair(0)).one('page', 'task.published').results;
  for (const r of results) assert.deepEqual([r.error, r.lockedBy], ['card-locked', THIRD], JSON.stringify(r));
});

/* ================================================================== D2 */

test('D2 认领被锁挡回：回包带 lockIdleMs（此刻 − touchedAt）与 lockedByProfile（建锁的节点的 profile）', gateOpts(lockIdleGate()), () => {
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

test('D2 发布被锁拒建：results[i] 带 lockIdleMs 与 lockedByProfile；pc 建的锁报 pc', gateOpts(lockIdleGate()), () => {
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

test('D2 续约（task.progress）刷新 touchedAt：产出中的锁不显得闲置；停了之后闲置时长照常增长', gateOpts(lockIdleGate()), () => {
  const h = rig();
  const br = snapTask({ contentKey: CK, fp: BR, seg: 0 });
  h.publish('page', [br]);
  const c = claimOk(h, 'br', br);
  const t0 = h.now();
  h.clock.advance(20_000);
  h.progress('br', br.id, c.token, 10);
  const lock = h.describe().locks.find((l) => l.lockKey === `snapshot:${CK}`);
  assert.equal(lock.touchedAt, t0 + 20_000, `续约应刷新 touchedAt：${JSON.stringify(lock)}`);
  // 进度不变的续约也刷新（续约 = 还在产出）
  h.clock.advance(10_000);
  h.progress('br', br.id, c.token, 10);
  assert.equal(h.describe().locks.find((l) => l.lockKey === `snapshot:${CK}`).touchedAt, t0 + 30_000);

  h.clock.advance(31_000);
  const r = h.publish('page', [snapTask({ contentKey: CK, fp: OWN, seg: 2 })]).one('page', 'task.published').results[0];
  assert.equal(r.lockIdleMs, 31_000, JSON.stringify(r));
});

test('D2 闲置超过 30 s 后切分方带 takeover 重发：锁转给切分方，浏览器那份作废（原有 F.7 行为，回归）', gateOpts(lockIdleGate()), () => {
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
