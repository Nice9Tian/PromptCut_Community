/**
 * 卡片级指纹锁：队列这一侧（契约 `docs/plan/render-queue-contract.md` F.1 与 F.7，测试表 F.5 的 Q1～Q9、F.7 第 6 条的 Q10、Q11）。
 * 跑：node --experimental-test-module-mocks --test server/test/card-lock-queue.test.mjs
 *
 * 只照契约 F.1 以及它改动 / 引用的 A.4～A.8、A.10 写，不看实现。只经 A.3 的公开接口驱动
 * （connect / handle / tick / describe），`describe().locks` 是 F.1 新增的公开诊断。
 *
 * 约定：
 *   - `lockKeyOf` 是 F.1 新增的出口，用命名空间引入（`queueIndex.lockKeyOf`），它还不存在时只有用到它的
 *     那条用例失败，不连累整个文件；`card.lock` 在不在 `PUBLISHER_TYPES` 里同理，从 `messages.mjs` 读。
 *   - F.1 写的「`DONE_TTL_MS`」就是 A.2 的 `DONE_TTL`（F.7 第 3 条），取缺省值 600 000；锁回收用严格大于。
 *   - 结果键按 B.1 的公式自己算（`resultKeyOf`），任务 id 按 A.4 自己算，不借实现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as queueIndex from '../render-queue/index.mjs';
import * as queueMessages from '../render-queue/messages.mjs';
import { createQueueHarness, makeTaskInput, T0 } from './fake-render-queue-env.mjs';

const { createRenderQueue } = queueIndex;

const LEASE = 30_000;
const TTL = 600_000;          // A.2 的 DONE_TTL（F.1 称 DONE_TTL_MS）

const FP_A = 'aaaaaaaaaaaaaaaa';
const FP_B = 'bbbbbbbbbbbbbbbb';
const FP_C = 'cccccccccccccccc';

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const rk = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);

/**
 * 一张卡某个环境的一段快照任务：`input.contentKey = ck`、`requires.envFingerprint = fp`、
 * `resultKey = resultKeyOf(ck, fp)`（和 splitPlan 出的形状一致）。
 */
function snap(ck, fp, from = 0, { to = from + 59, projectId = 'p1', kind = 'snapshot', requires, input, ...rest } = {}) {
  return makeTaskInput({
    projectId, kind, resultKey: rk(ck, fp), range: [from, to],
    input: input ?? { clipId: `clip-${ck}`, contentKey: ck },
    requires: requires ?? { envFingerprint: fp },
    ...rest,
  });
}
const stream = (sk, fp, from = 0, extra = {}) => snap(sk, fp, from, { to: from + 7, kind: 'stream', ...extra });

/** 发布方 p（u1）、q（u1）、节点 a / a2（指纹 A）、b（指纹 B）、watch 者 w（pc，指纹 C；M6c X3 之前是 host） */
function setup(options = {}) {
  const h = createQueueHarness(createRenderQueue, options);
  h.publisher('p', 'pub-p');
  h.publisher('q', 'pub-q');
  h.node('a', 'node-A', { hello: { envFingerprint: FP_A } });
  h.node('a2', 'node-A2', { hello: { envFingerprint: FP_A } });
  h.node('b', 'node-B', { hello: { envFingerprint: FP_B } });
  h.node('w', 'node-W', { profile: 'pc', hello: { envFingerprint: FP_C } });   // M6c X3：host 的 watch 'all' 只收摘要，watch 者改用 pc（原为 host）
  h.bus.clear();
  return h;
}

const locks = h => h.describe().locks;
const lockOf = (h, lockKey) => locks(h).find(l => l.lockKey === lockKey) ?? null;
const claimOk = (h, conn, id, expectVersion) => h.claim(conn, id, expectVersion).one(conn, 'task.claimed');
const published = (out, conn) => out.one(conn, 'task.published').results;
const cardLock = (h, conn, fields) => h.handle(conn, { type: 'card.lock', ...fields });
/** F.1：takeover 是 TaskInput 上的可选字段（逐个任务带），splitPlan 也是给每个任务加 takeover: true（F.2） */
const tk = (tasks, v = true) => tasks.map(t => ({ ...t, takeover: v }));
/** M7 契约 D2（`docs/plan/m7-contract.md` 第 13 节）给 card-locked 的回包加了 lockIdleMs / lockedByProfile / lockUndone；这里只比 F.7 定的那几项 */
const f7 = r => { if (r == null) return r; const { lockIdleMs, lockedByProfile, lockUndone, ...rest } = r; return rest; };

/* ================================================================== lockKeyOf */

test('Q0 lockKeyOf（F.1「锁键」）：snapshot / stream 且 contentKey 是非空字符串时为 `${kind}:${contentKey}`，其余为 null', () => {
  const { lockKeyOf } = queueIndex;
  assert.equal(typeof lockKeyOf, 'function', 'index.mjs 要转出 lockKeyOf');
  assert.equal(lockKeyOf({ kind: 'snapshot', input: { contentKey: 'ck1' } }), 'snapshot:ck1');
  assert.equal(lockKeyOf({ kind: 'stream', input: { contentKey: 'sk1' } }), 'stream:sk1');
  assert.equal(lockKeyOf({ kind: 'snapshot', input: { contentKey: 'entry/ck1' } }), 'snapshot:entry/ck1', '本地档的内容键带 entryKey/');
  // 任务视图照样认
  const t = snap('ck9', FP_A);
  assert.equal(lockKeyOf(t), 'snapshot:ck9');
  for (const [label, task] of [
    ['plan', { kind: 'plan', input: { contentKey: 'x' } }],
    ['没有 input', { kind: 'snapshot' }],
    ['input 为 null', { kind: 'snapshot', input: null }],
    ['没有 contentKey', { kind: 'snapshot', input: { clipId: 'c' } }],
    ['空串', { kind: 'stream', input: { contentKey: '' } }],
    ['数字', { kind: 'snapshot', input: { contentKey: 5 } }],
    ['未知 kind', { kind: 'other', input: { contentKey: 'x' } }],
  ]) assert.equal(lockKeyOf(task), null, label);
});

/* ================================================================== Q1 */

test('Q1 首次认领建锁（source: claim），同指纹的其余段照常认领、只刷新 touchedAt', () => {
  const h = setup();
  const t1 = snap('ck1', FP_A, 0), t2 = snap('ck1', FP_A, 60), t3 = snap('ck1', FP_A, 120);
  h.publish('p', [t1, t2, t3]);
  assert.deepEqual(locks(h), [], '发布（没带 takeover）不建锁，等第一次认领');

  claimOk(h, 'a', t1.id, 1);
  assert.deepEqual(locks(h), [{ lockKey: 'snapshot:ck1', envFingerprint: FP_A, source: 'claim', since: T0, touchedAt: T0 }]);

  h.clock.advance(1000);
  const c2 = claimOk(h, 'a2', t2.id, 1);
  assert.equal(c2.id, t2.id, '同指纹的另一个节点照常认领');
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { lockKey: 'snapshot:ck1', envFingerprint: FP_A, source: 'claim', since: T0, touchedAt: T0 + 1000 },
    '同指纹认领只刷新 touchedAt，since / source 不变');

  h.clock.advance(1000);
  claimOk(h, 'a', t3.id, 1);
  assert.equal(lockOf(h, 'snapshot:ck1').touchedAt, T0 + 2000);
  assert.equal(locks(h).length, 1);
});

test('Q1 补充：流任务同样建锁（锁键 stream:<contentKey>）；快照与流即使内容键相同也是两把锁', () => {
  const h = setup();
  const s = stream('same', FP_A, 0), k = snap('same', FP_B, 0);
  h.publish('p', [s, k]);
  claimOk(h, 'a', s.id, 1);
  claimOk(h, 'b', k.id, 1);
  assert.deepEqual(locks(h).map(l => [l.lockKey, l.envFingerprint, l.source]), [
    ['snapshot:same', FP_B, 'claim'], ['stream:same', FP_A, 'claim'],
  ]);
});

test('Q1 补充：完成锁键为 L 的任务刷新 L 的 touchedAt', () => {
  const h = setup();
  const t1 = snap('ck1', FP_A, 0);
  h.publish('p', [t1]);
  const c = claimOk(h, 'a', t1.id, 1);
  h.clock.advance(5000);
  h.complete('a', t1.id, c.token, { ranges: [[0, 59]] });
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { lockKey: 'snapshot:ck1', envFingerprint: FP_A, source: 'claim', since: T0, touchedAt: T0 + 5000 });
});

/* ================================================================== Q2 */

test('Q2 锁在 X 上时，同一 contentKey 的 Y 指纹任务认领被拒 card-locked（带 lockedBy: X），版本不变、不广播', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0), y = snap('ck1', FP_B, 0);
  h.publish('p', [x, y]);
  claimOk(h, 'a', x.id, 1);
  h.bus.clear();

  const out = h.claim('b', y.id, 1);
  const r = out.one('b', 'task.claim-rejected');
  assert.deepEqual([r.id, r.reason, r.state, r.version, r.lockedBy], [y.id, 'card-locked', 'open', 1, FP_A]);
  assert.deepEqual(out.conns(), ['b'], '被拒只回给认领者，不广播');
  const t = h.task(y.id);
  assert.deepEqual([t.state, t.version, t.attempts, t.claim], ['open', 1, 0, null], '版本、状态不变');
  assert.deepEqual(lockOf(h, 'snapshot:ck1').envFingerprint, FP_A, '锁不变');
  assert.equal(lockOf(h, 'snapshot:ck1').touchedAt, T0, '被拒的认领不刷新锁');
});

test('Q2 补充：card-locked 在 taken 之后、stale 之前判（第 3a 步）', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0), y = snap('ck1', FP_B, 0);
  h.publish('p', [x, y]);
  claimOk(h, 'a', x.id, 1);
  // expectVersion 不对：第 4 步 stale 在 3a 之后，所以仍回 card-locked
  const r = h.claim('b', y.id, 7).one('b', 'task.claim-rejected');
  assert.deepEqual([r.reason, r.state, r.version, r.lockedBy], ['card-locked', 'open', 1, FP_A]);
  // 不存在的任务：第 1 步 gone 最先
  assert.equal(h.claim('b', snap('ck1', FP_B, 600).id, 1).one('b', 'task.claim-rejected').reason, 'gone');
  // 锁指纹与任务指纹相同时 stale 照旧
  const x2 = snap('ck1', FP_A, 60);
  h.publish('p', [x2]);
  assert.equal(h.claim('a2', x2.id, 5).one('a2', 'task.claim-rejected').reason, 'stale');
});

test('Q2 补充：锁只按锁键拦，别的卡、别的 kind 不受影响', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0), other = snap('ck2', FP_B, 0), otherKind = stream('ck1', FP_B, 0);
  h.publish('p', [x, other, otherKind]);
  claimOk(h, 'a', x.id, 1);
  claimOk(h, 'b', other.id, 1);
  claimOk(h, 'b', otherKind.id, 1);
});

/* ================================================================== Q3 */

test('Q3 card.lock：没锁得锁（source: lock）；同指纹 granted 并刷新；不同指纹不带 takeover → granted: false、锁不变', () => {
  const h = setup();
  let out = cardLock(h, 'p', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A, reqId: 'r1' });
  let m = out.one('p', 'card.locked');
  assert.deepEqual([m.lockKey, m.envFingerprint, m.granted, m.reqId], ['snapshot:ck1', FP_A, true, 'r1']);
  assert.equal(typeof m.epoch, 'string', '出站消息带 epoch（A.11）');
  assert.deepEqual(out.conns(), ['p'], '回包只给发来的连接');
  assert.deepEqual(locks(h), [{ lockKey: 'snapshot:ck1', envFingerprint: FP_A, source: 'lock', since: T0, touchedAt: T0 }]);

  h.clock.advance(2000);
  m = cardLock(h, 'q', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A, reqId: 7 }).one('q', 'card.locked');
  assert.deepEqual([m.lockKey, m.envFingerprint, m.granted, m.reqId], ['snapshot:ck1', FP_A, true, 7]);
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { lockKey: 'snapshot:ck1', envFingerprint: FP_A, source: 'lock', since: T0, touchedAt: T0 + 2000 });

  h.clock.advance(2000);
  const before = h.describe();
  for (const takeover of [undefined, false]) {
    m = cardLock(h, 'q', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_B, ...(takeover === undefined ? {} : { takeover }) }).one('q', 'card.locked');
    assert.deepEqual([m.lockKey, m.envFingerprint, m.granted], ['snapshot:ck1', FP_A, false], `takeover ${takeover}：回处理后锁上的指纹`);
  }
  assert.deepEqual(h.describe(), before, '被拒的 card.lock 什么都不改（touchedAt 也不刷新）');

  // stream 同样可以锁
  m = cardLock(h, 'p', { kind: 'stream', contentKey: 'sk1', envFingerprint: FP_B }).one('p', 'card.locked');
  assert.deepEqual([m.lockKey, m.envFingerprint, m.granted], ['stream:sk1', FP_B, true]);
  assert.equal(lockOf(h, 'stream:sk1').source, 'lock');
});

test('Q3 card.lock 建的锁同样拦认领', () => {
  const h = setup();
  const y = snap('ck1', FP_B, 0);
  h.publish('p', [y]);
  cardLock(h, 'q', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A });
  const r = h.claim('b', y.id, 1).one('b', 'task.claim-rejected');
  assert.deepEqual([r.reason, r.lockedBy], ['card-locked', FP_A]);
});

test('Q3 card.lock 格式错误 → 整条 bad-message（带 reqId），状态不变', () => {
  const h = setup();
  cardLock(h, 'p', { kind: 'snapshot', contentKey: 'held', envFingerprint: FP_A });
  const before = h.describe();
  const good = { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A };
  const cases = [
    [{ ...good, kind: 'plan' }, 'kind 是 plan'],
    [{ ...good, kind: undefined }, '缺 kind'],
    [{ ...good, kind: 'Snapshot' }, 'kind 大小写不对'],
    [{ ...good, contentKey: '' }, 'contentKey 空串'],
    [{ ...good, contentKey: 42 }, 'contentKey 不是字符串'],
    [{ ...good, contentKey: undefined }, '缺 contentKey'],
    [{ ...good, envFingerprint: '' }, 'envFingerprint 空串'],
    [{ ...good, envFingerprint: undefined }, '缺 envFingerprint'],
    [{ ...good, envFingerprint: 1234 }, 'envFingerprint 不是字符串'],
    [{ ...good, takeover: 'yes' }, 'takeover 不是布尔'],
    [{ ...good, takeover: 1 }, 'takeover 是数字'],
    [{ ...good, contentKey: 'held', envFingerprint: FP_B, takeover: 'true' }, '想接手但 takeover 不是布尔'],
  ];
  for (const [fields, why] of cases) {
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const out = cardLock(h, 'p', { ...clean, reqId: `bad-${why}` });
    const e = out.one('p', 'error');
    assert.equal(e.reason, 'bad-message', why);
    assert.equal(e.reqId, `bad-${why}`, `${why}：回包带 reqId`);
    assert.equal(out.of('p', 'card.locked').length, 0, `${why}：不回 card.locked`);
    assert.deepEqual(h.describe(), before, `${why}：状态不变`);
  }
});

test('Q3 card.lock 在 PUBLISHER_TYPES 里；没发过 publisher.hello 的连接发它回 not-registered（A.5），不建锁', () => {
  assert.ok(queueMessages.PUBLISHER_TYPES instanceof Set);
  assert.ok(queueMessages.PUBLISHER_TYPES.has('card.lock'), 'card.lock 只有发布连接能发');
  assert.ok(!queueMessages.NODE_TYPES.has('card.lock'));

  const h = setup();
  // 只发过 node.hello 的连接
  let out = cardLock(h, 'a', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A, reqId: 'n1' });
  let e = out.one('a', 'error');
  assert.deepEqual([e.reason, e.reqId], ['not-registered', 'n1']);
  // 什么都没发过的连接
  h.connect('bare');
  out = cardLock(h, 'bare', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A });
  e = out.one('bare', 'error');
  assert.equal(e.reason, 'not-registered');
  assert.deepEqual(locks(h), []);
  // 先格式、后角色（A.10a）
  out = cardLock(h, 'bare', { kind: 'nope', contentKey: 'ck1', envFingerprint: FP_A });
  assert.equal(out.one('bare', 'error').reason, 'bad-message');
});

/* ================================================================== Q4 */

/**
 * 锁在 A 上：T1 done、T2 被 a2 认领、T3 open（p 和 p2 都订阅）；另有别的卡的 A 任务 O、同卡的 B 任务 Yb（open）。
 */
function takeoverScene(options) {
  const h = setup(options);
  h.publisher('p2', 'pub-p2');
  const t1 = snap('ck1', FP_A, 0), t2 = snap('ck1', FP_A, 60), t3 = snap('ck1', FP_A, 120);
  const o = snap('ck2', FP_A, 0);
  h.publish('p', [t1, t2, t3, o]);
  h.publish('p2', [t3]);
  const c1 = claimOk(h, 'a', t1.id, 1);
  h.complete('a', t1.id, c1.token, { ranges: [[0, 59]] });
  const c2 = claimOk(h, 'a2', t2.id, 1);
  h.clock.advance(3000);
  h.bus.clear();
  return { h, t1, t2, t3, o, c2 };
}

function assertSuperseded(h, out, { t1, t2, t3, o, c2 }, now, newFp) {
  // T1 done 不动
  const v1 = h.task(t1.id);
  assert.deepEqual([v1.state, v1.version], ['done', 3], 'done 的任务不动');
  // T2 claimed → failed(superseded)，原认领者先收 lease-lost
  const v2 = h.task(t2.id);
  assert.deepEqual([v2.state, v2.version, v2.attempts, v2.lastError, v2.claim, v2.finishedAt], ['failed', 3, 0, 'superseded', null, now],
    'claimed 的任务：version+1、failed、attempts 不变、lastError superseded、claim 清空');
  const ll = out.one('a2', 'task.lease-lost');
  assert.deepEqual([ll.id, ll.token, ll.reason], [t2.id, c2.token, 'superseded']);
  // T3 open → failed(superseded)
  const v3 = h.task(t3.id);
  assert.deepEqual([v3.state, v3.version, v3.attempts, v3.lastError, v3.finishedAt], ['failed', 2, 0, 'superseded', now]);
  // 订阅者收 task.failed
  for (const [conn, ids] of [['p', [t2.id, t3.id]], ['p2', [t3.id]]]) {
    const failed = out.of(conn, 'task.failed');
    assert.deepEqual(failed.map(m => m.id).sort(), [...ids].sort(), `${conn} 收到的 task.failed`);
    for (const m of failed) assert.equal(m.error, 'superseded');
  }
  // watch 者收 task.closed { state: failed }
  for (const conn of ['a', 'b', 'w']) {
    const closed = out.of(conn, 'task.closed').filter(m => m.id === t2.id || m.id === t3.id);
    assert.deepEqual(closed.map(m => [m.id, m.state]).sort(), [[t2.id, 'failed'], [t3.id, 'failed']].sort(), `${conn} 收到的 task.closed`);
  }
  // 别的卡不动
  const vo = h.task(o.id);
  assert.deepEqual([vo.state, vo.version], ['open', 1], '别的锁键的任务不动');
  // 锁转给新指纹
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { lockKey: 'snapshot:ck1', envFingerprint: newFp, source: 'takeover', since: now, touchedAt: now });
  assert.equal(lockOf(h, 'snapshot:ck2'), null, '别的卡没有被牵连出锁');
}

test('Q4 带 takeover 发布：锁转给新指纹；旧指纹 open 的进 failed(superseded)，claimed 的认领者收 lease-lost，订阅者收 task.failed；done 不动', () => {
  const scene = takeoverScene();
  const { h, t2, c2 } = scene;
  const y1 = snap('ck1', FP_B, 0), y2 = snap('ck1', FP_B, 60);
  const now = h.now();
  // 顺带让 ck2 有一把锁（别的锁键不受影响）
  claimOk(h, 'a', scene.o.id, 1);
  h.bus.clear();
  const out = h.publish('q', tk([y1, y2], true));
  const results = published(out, 'q');
  assert.deepEqual(results.map(r => [r.id, r.state, r.created]), [[y1.id, 'open', true], [y2.id, 'open', true]]);
  for (const r of results) assert.equal('lockedBy' in r, false, '接手之后锁就是自己的，不带 lockedBy');

  // ck2 的任务此刻是 claimed（上面认领了），不受 ck1 接手影响
  const vo = h.task(scene.o.id);
  assert.deepEqual([vo.state, vo.claim.nodeId], ['claimed', 'node-A']);
  const a = h.task(scene.t1.id);
  assert.equal(a.state, 'done');
  // 其余断言（o 这里换成「claimed 不动」，单独核过了，跳过 assertSuperseded 里 o 的 open 检查）
  const v2 = h.task(t2.id);
  assert.deepEqual([v2.state, v2.lastError, v2.attempts], ['failed', 'superseded', 0]);
  const ll = out.one('a2', 'task.lease-lost');
  assert.deepEqual([ll.id, ll.token, ll.reason], [t2.id, c2.token, 'superseded']);
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { lockKey: 'snapshot:ck1', envFingerprint: FP_B, source: 'takeover', since: now, touchedAt: now });
  assert.equal(lockOf(h, 'snapshot:ck2').envFingerprint, FP_A);

  // 新指纹的节点能认领；原认领者拿旧令牌完成 → 令牌不符
  claimOk(h, 'b', y1.id, 1);
  const late = h.complete('a2', t2.id, c2.token, { ranges: [[60, 119]] });
  assert.equal(late.one('a2', 'task.lease-lost').reason, 'token');
  assert.equal(h.task(t2.id).state, 'failed');
});

test('Q4 带 takeover 发布（全量核对）：状态、消息、锁', () => {
  const scene = takeoverScene({ constants: { PREFILTER: false } });
  const { h } = scene;
  const now = h.now();
  const out = h.publish('q', tk([snap('ck1', FP_B, 0)], true));
  assertSuperseded(h, out, scene, now, FP_B);
  // 已经 failed 的旧任务再认领：第 3 步 taken 先于 3a
  const r = h.claim('a', scene.t3.id, 2).one('a', 'task.claim-rejected');
  assert.deepEqual([r.reason, r.state], ['taken', 'failed']);
});

test('Q4 card.lock 带 takeover 同样接手（与发布共用）：granted: true，旧指纹未完成的任务作废', () => {
  const scene = takeoverScene({ constants: { PREFILTER: false } });
  const { h } = scene;
  const now = h.now();
  const out = cardLock(h, 'q', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_B, takeover: true, reqId: 'tk' });
  const m = out.one('q', 'card.locked');
  assert.deepEqual([m.lockKey, m.envFingerprint, m.granted, m.reqId], ['snapshot:ck1', FP_B, true, 'tk']);
  assertSuperseded(h, out, scene, now, FP_B);
});

test('Q4 补充：接手时与新锁同指纹的任务不作废；再被第三种指纹接手，作废的是上一任的', () => {
  const h = setup();
  const a0 = snap('ck1', FP_A, 0), b0 = snap('ck1', FP_B, 0), b1 = snap('ck1', FP_B, 60);
  h.publish('p', [a0, b0]);
  claimOk(h, 'a', a0.id, 1);                          // 锁 A
  h.publish('q', tk([b1], true));            // B 接手：a0 作废，b0（B 指纹、open）不动
  assert.deepEqual([h.task(a0.id).state, h.task(a0.id).lastError], ['failed', 'superseded']);
  assert.deepEqual([h.task(b0.id).state, h.task(b0.id).version], ['open', 1]);
  assert.deepEqual([h.task(b1.id).state, h.task(b1.id).version], ['open', 1]);
  // 第三种指纹 C 用 card.lock 接手：B 的两个 open 作废
  const out = cardLock(h, 'p', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_C, takeover: true });
  assert.equal(out.one('p', 'card.locked').granted, true);
  for (const t of [b0, b1]) assert.deepEqual([h.task(t.id).state, h.task(t.id).lastError], ['failed', 'superseded'], t.id);
  assert.equal(lockOf(h, 'snapshot:ck1').envFingerprint, FP_C);
});

test('Q4 补充：同指纹带 takeover（锁已经是自己的）只刷新 touchedAt，不作废任何任务', () => {
  const h = setup();
  const a0 = snap('ck1', FP_A, 0), a1 = snap('ck1', FP_A, 60);
  h.publish('p', [a0]);
  claimOk(h, 'a', a0.id, 1);
  h.clock.advance(500);
  const out = h.publish('q', tk([a1], true));
  assert.equal(out.ofType('task.failed').length, 0);
  assert.equal(h.task(a0.id).state, 'claimed');
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { lockKey: 'snapshot:ck1', envFingerprint: FP_A, source: 'claim', since: T0, touchedAt: T0 + 500 });
});

/* ================================================================== Q5 */

test('Q5 不带 takeover、锁在别的指纹上时发布已存在的任务：照常合并，results[i].lockedBy 是锁指纹；锁不变（不存在的见 Q10）', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0);
  const y1 = snap('ck1', FP_B, 0), y2 = snap('ck1', FP_B, 60);
  // y1 / y2 在锁建起来之前就发布了（两个节点几乎同时切分的情形）
  h.publish('p', [x, y1, y2]);
  claimOk(h, 'a', x.id, 1);
  const before = lockOf(h, 'snapshot:ck1');
  h.clock.advance(100);

  const same = snap('ck1', FP_A, 60), free = snap('ck2', FP_B, 0);
  let results = published(h.publish('q', [y1, y2, same, free]), 'q');
  assert.deepEqual(f7(results[0]), { id: y1.id, state: 'open', version: 1, created: false, lockedBy: FP_A });
  assert.deepEqual(f7(results[1]), { id: y2.id, state: 'open', version: 1, created: false, lockedBy: FP_A });
  assert.deepEqual(results[2], { id: same.id, state: 'open', version: 1, created: true }, '同指纹不带 lockedBy');
  assert.deepEqual(results[3], { id: free.id, state: 'open', version: 1, created: true }, '没锁的不带 lockedBy');
  assert.ok(h.task(y1.id).subscribers.includes('pub-q'), '照 A.7.1 合并：订阅者加入本发布方');
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { ...before, touchedAt: T0 + 100 }, '同指纹的那个任务刷新了 touchedAt，指纹不变');
  assert.equal(lockOf(h, 'snapshot:ck2'), null, '没锁 + 不带 takeover：不建锁');

  // takeover: false 同不带
  results = published(h.publish('p', tk([y1], false)), 'p');
  assert.deepEqual(f7(results[0]), { id: y1.id, state: 'open', version: 1, created: false, lockedBy: FP_A });
  assert.equal(lockOf(h, 'snapshot:ck1').envFingerprint, FP_A);
  // 合并进来的异指纹任务仍然认领不了
  assert.equal(h.claim('b', y1.id, 1).one('b', 'task.claim-rejected').reason, 'card-locked');
});

/* ================================================================== Q10（F.7 第 1、4 条） */

test('Q10 拒建：锁在别的指纹上、没带 takeover、表里没有同 id 任务 → 不建，results[i] = { id, error: card-locked, lockedBy }；同条消息的其它项照常', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0);
  h.publish('p', [x]);
  claimOk(h, 'a', x.id, 1);
  const lockBefore = lockOf(h, 'snapshot:ck1');
  h.bus.clear();

  const y1 = snap('ck1', FP_B, 0), other = snap('ck2', FP_B, 0), same = snap('ck1', FP_A, 60), y2 = stream('ck1', FP_B, 0);
  const out = h.publish('q', [y1, other, same, y2], { reqId: 'r10' });
  const m = out.one('q', 'task.published');
  assert.equal(m.reqId, 'r10');
  assert.deepEqual(f7(m.results[0]), { id: y1.id, error: 'card-locked', lockedBy: FP_A });
  assert.deepEqual(m.results[1], { id: other.id, state: 'open', version: 1, created: true }, '别的卡照常建');
  assert.deepEqual(m.results[2], { id: same.id, state: 'open', version: 1, created: true }, '同指纹照常建');
  assert.deepEqual(m.results[3], { id: y2.id, state: 'open', version: 1, created: true }, '流是另一把锁（stream:ck1，没锁）');
  assert.equal(h.task(y1.id), null, '拒建的任务不在表里');
  const opened = out.ofType('task.opened').map(e => e.message.task.id);
  assert.ok(!opened.includes(y1.id), '拒建的不广播 task.opened');
  assert.ok(opened.includes(other.id));
  assert.equal(lockOf(h, 'snapshot:ck1').envFingerprint, lockBefore.envFingerprint, '锁不变');
  assert.equal(lockOf(h, 'snapshot:ck1').source, 'claim');

  // 锁上的指纹换了（被接手），lockedBy 跟着换
  cardLock(h, 'p', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_C, takeover: true });
  const again = published(h.publish('q', [y1]), 'q');
  assert.deepEqual(f7(again[0]), { id: y1.id, error: 'card-locked', lockedBy: FP_C });
});

test('Q10 补充：因 limit 没建成的那一项不做任何锁处理（F.7 第 4 条）', () => {
  const h = setup({ constants: { MAX_TASKS_PER_PROJECT: 1 } });
  const first = snap('k0', FP_A, 0);
  h.publish('p', [first]);
  // 项目已满：带 takeover 的新任务因 limit 没建 → 不建锁
  const r = published(h.publish('q', tk([snap('k1', FP_B, 0)], true)), 'q');
  assert.equal(r[0].error, 'limit');
  assert.equal(lockOf(h, 'snapshot:k1'), null, 'limit 的项不建锁');
  // 已锁在别的指纹上时：limit 的项不接手、锁不变
  cardLock(h, 'p', { kind: 'snapshot', contentKey: 'k2', envFingerprint: FP_A });
  const r2 = published(h.publish('q', tk([snap('k2', FP_B, 0)], true)), 'q');
  assert.equal(r2[0].error, 'limit');
  assert.deepEqual([lockOf(h, 'snapshot:k2').envFingerprint, lockOf(h, 'snapshot:k2').source], [FP_A, 'lock']);
});

/* ================================================================== Q11（F.7 第 2 条） */

test('Q11 没锁时带 takeover 发布：建锁（source: takeover），同时作废锁键相同、指纹不同的 open 任务；同指纹、别的卡不动', () => {
  const h = setup({ constants: { PREFILTER: false } });
  // 两个节点几乎同时切分：A 的任务先发布（没人认领，没锁），B 带 takeover 发布
  const x1 = snap('ck1', FP_A, 0), x2 = snap('ck1', FP_A, 60), otherCard = snap('ck2', FP_A, 0), sameFp = snap('ck1', FP_B, 120);
  h.publish('p', [x1, x2, otherCard]);
  h.publish('q', [sameFp]);
  assert.deepEqual(locks(h), []);
  h.clock.advance(10);
  h.bus.clear();

  const y = snap('ck1', FP_B, 0);
  const now = h.now();
  const out = h.publish('q', tk([y], true));
  assert.deepEqual(published(out, 'q')[0], { id: y.id, state: 'open', version: 1, created: true });
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { lockKey: 'snapshot:ck1', envFingerprint: FP_B, source: 'takeover', since: now, touchedAt: now });

  for (const t of [x1, x2]) {
    const v = h.task(t.id);
    assert.deepEqual([v.state, v.version, v.attempts, v.lastError, v.finishedAt], ['failed', 2, 0, 'superseded', now], `${t.id} 作废`);
  }
  assert.deepEqual(out.of('p', 'task.failed').map(m => [m.id, m.error]).sort(), [[x1.id, 'superseded'], [x2.id, 'superseded']].sort(),
    '订阅者收到 task.failed');
  for (const conn of ['a', 'a2', 'b', 'w']) {
    assert.deepEqual(out.of(conn, 'task.closed').filter(m => m.id === x1.id || m.id === x2.id).map(m => [m.id, m.state]).sort(),
      [[x1.id, 'failed'], [x2.id, 'failed']].sort(), `${conn} 收到 task.closed`);
  }
  assert.deepEqual([h.task(sameFp.id).state, h.task(sameFp.id).version], ['open', 1], '同指纹的不动');
  assert.deepEqual([h.task(otherCard.id).state, h.task(otherCard.id).version], ['open', 1], '别的卡不动');
  assert.equal(lockOf(h, 'snapshot:ck2'), null);
  // 此后 A 指纹的新任务发布被拒建
  assert.equal(published(h.publish('p', [snap('ck1', FP_A, 180)]), 'p')[0].error, 'card-locked');
  // B 指纹的照常认领
  claimOk(h, 'b', y.id, 1);
});

/* ================================================================== Q6 */

test('Q6 任务的 takeover 不是布尔 → 整条 bad-message，状态不变；是布尔时不存进任务，TaskView 不变', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0);
  h.publish('p', [x]);
  claimOk(h, 'a', x.id, 1);
  const before = h.describe();
  for (const takeover of ['yes', 1, 0, {}, [], 'false']) {
    // 只有第二个任务的 takeover 不合法：整条不生效（第一个带合法 takeover 的也不接手）
    const out = h.publish('q', [{ ...snap('ck1', FP_B, 0), takeover: true }, { ...snap('ck3', FP_B, 0), takeover }], { reqId: 'bt' });
    const e = out.one('q', 'error');
    assert.deepEqual([e.reason, e.reqId], ['bad-message', 'bt'], `takeover = ${JSON.stringify(takeover)}`);
    assert.equal(out.of('q', 'task.published').length, 0);
    assert.deepEqual(h.describe(), before, `takeover = ${JSON.stringify(takeover)}：状态不变（不建任务、不接手）`);
  }
  // 合法的布尔：任务里不存 takeover
  const y = snap('ck1', FP_B, 60);
  const out = h.publish('q', tk([y], true));
  const opened = out.ofType('task.opened').map(e => e.message.task).filter(t => t.id === y.id);
  assert.ok(opened.length > 0, 'watch 者收到 task.opened');
  for (const t of opened) assert.equal('takeover' in t, false, 'TaskView 不含 takeover');
  const c = claimOk(h, 'b', y.id, 1);
  assert.equal('takeover' in c.task, false);
  assert.deepEqual(Object.keys(c.task).sort(),
    ['attempts', 'id', 'input', 'kind', 'priority', 'range', 'requires', 'resultKey', 'source', 'state', 'tier', 'version', 'weight'].sort(),
    'TaskView 的字段与 A.4 一致');
});

/* ================================================================== Q7 */

test('Q7 锁回收：没有任务再引用、且 now - touchedAt > DONE_TTL 才删（F.7 第 3 条严格大于；第 5 项扫描在 TTL 删任务之后）', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0);
  h.publish('p', [x]);
  const c = claimOk(h, 'a', x.id, 1);
  h.clock.advance(1000);
  h.complete('a', x.id, c.token, { ranges: [[0, 59]] });
  const done = T0 + 1000;
  assert.equal(lockOf(h, 'snapshot:ck1').touchedAt, done);

  h.at(done + TTL);
  assert.ok(h.task(x.id), 'done 任务在 TTL 边界上还在（严格大于才删）');
  assert.ok(lockOf(h, 'snapshot:ck1'), '还有任务引用：不删锁');

  h.at(done + TTL + 1);
  assert.equal(h.task(x.id), null, 'TTL 删掉了任务');
  assert.equal(lockOf(h, 'snapshot:ck1'), null, '同一次 tick 里：任务删了、touchedAt 也够老 → 锁删');
});

test('Q7 锁回收：没有任务引用的锁（card.lock 建的）按严格大于判：恰好 DONE_TTL 还留着，多 1 毫秒才删', () => {
  const h = setup();
  cardLock(h, 'p', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A });
  h.at(T0 + TTL - 1);
  assert.ok(lockOf(h, 'snapshot:ck1'), 'TTL - 1：留着');
  h.at(T0 + TTL);
  assert.ok(lockOf(h, 'snapshot:ck1'), '恰好 TTL：还留着（严格大于才删，与 A.8 一致）');
  h.at(T0 + TTL + 1);
  assert.equal(lockOf(h, 'snapshot:ck1'), null, 'TTL + 1：删');
});

test('Q7 锁回收：还有任务引用时不删，不论过了多久；刷新 touchedAt 会推迟回收', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0);
  h.publish('p', [x]);
  cardLock(h, 'q', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A });
  h.at(T0 + 5 * TTL);
  assert.ok(h.task(x.id), 'open 任务不过期');
  assert.ok(lockOf(h, 'snapshot:ck1'), 'open 任务引用着：锁不删');

  // 另一把没人引用的锁：中途刷新一次，按新的 touchedAt 算
  cardLock(h, 'q', { kind: 'stream', contentKey: 'sk', envFingerprint: FP_A });
  const t0 = h.now();
  h.at(t0 + TTL - 10);
  cardLock(h, 'q', { kind: 'stream', contentKey: 'sk', envFingerprint: FP_A });
  h.at(t0 + TTL + 10);
  assert.ok(lockOf(h, 'stream:sk'), '刷新过：从刷新那一刻起算');
  h.at(t0 + TTL - 10 + TTL);
  assert.ok(lockOf(h, 'stream:sk'), '距刷新恰好 TTL：还留着');
  h.at(t0 + TTL - 10 + TTL + 1);
  assert.equal(lockOf(h, 'stream:sk'), null);
});

test('Q7 补充：锁键仍被 failed（未过 TTL）的任务引用时也不删', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0);
  h.publish('p', [x]);
  claimOk(h, 'a', x.id, 1);
  cardLock(h, 'q', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_B, takeover: true });  // x → failed
  const t = h.now();
  assert.equal(h.task(x.id).state, 'failed');
  h.at(t + TTL);
  assert.ok(h.task(x.id), 'failed 任务 TTL 边界上还在');
  assert.ok(lockOf(h, 'snapshot:ck1'), '还被 failed 任务引用：不删');
  h.at(t + TTL + 1);
  assert.equal(h.task(x.id), null);
  assert.equal(lockOf(h, 'snapshot:ck1'), null);
});

/* ================================================================== Q8 */

test('Q8 describe().locks 的形状与排序（按 lockKey），返回深拷贝；新 epoch 的队列没有锁', () => {
  const h = setup();
  assert.deepEqual(h.describe().locks, [], '一开始是空数组');
  cardLock(h, 'p', { kind: 'stream', contentKey: 'zz', envFingerprint: FP_A });
  h.clock.advance(1);
  cardLock(h, 'p', { kind: 'snapshot', contentKey: 'bb', envFingerprint: FP_B });
  h.clock.advance(1);
  cardLock(h, 'p', { kind: 'snapshot', contentKey: 'aa', envFingerprint: FP_C });
  const list = h.describe().locks;
  assert.deepEqual(list.map(l => l.lockKey), ['snapshot:aa', 'snapshot:bb', 'stream:zz']);
  for (const l of list) {
    assert.deepEqual(Object.keys(l).sort(), ['envFingerprint', 'lockKey', 'since', 'source', 'touchedAt']);
  }
  assert.deepEqual(list[0], { lockKey: 'snapshot:aa', envFingerprint: FP_C, source: 'lock', since: T0 + 2, touchedAt: T0 + 2 });
  // 深拷贝
  list[0].envFingerprint = 'mutated';
  list.pop();
  assert.equal(h.describe().locks[0].envFingerprint, FP_C);
  assert.equal(h.describe().locks.length, 3);
  // 描述里的其它部分照旧（A.10）
  assert.ok(Array.isArray(h.describe().tasks) && Array.isArray(h.describe().nodes) && Array.isArray(h.describe().publishers));

  // 队列重启：新实例、新 epoch，锁只在内存里
  const h2 = createQueueHarness(createRenderQueue, { epoch: 'epoch-2', constants: { PREFILTER: false } });
  assert.deepEqual(h2.describe().locks, []);
  assert.equal(h2.describe().epoch, 'epoch-2');
  h2.publisher('p', 'pub-p');
  h2.node('b', 'node-B', { hello: { envFingerprint: FP_B } });
  const y = snap('bb', FP_A, 0);
  h2.publish('p', [y]);
  claimOk(h2, 'b', y.id, 1);   // 上一个实例里 bb 锁在 B 上，这里没有锁、谁先认领谁锁
  assert.deepEqual(h2.describe().locks.map(l => [l.lockKey, l.envFingerprint, l.source]), [['snapshot:bb', FP_A, 'claim']]);
});

/* ================================================================== Q9 */

test('Q9 没有 input.contentKey 或没有 requires.envFingerprint 的任务不建锁、不受锁影响', () => {
  const h = setup();
  cardLock(h, 'p', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A });
  const noFp = snap('ck1', FP_B, 0, { requires: {} });                                  // 有锁键、没锁指纹
  const emptyFp = snap('ck1', FP_B, 60, { requires: { envFingerprint: '' } });          // 锁指纹空串
  const noCk = snap('ck1', FP_B, 120, { input: { clipId: 'c' } });                       // 没锁键
  const emptyCk = snap('ck1', FP_B, 180, { input: { clipId: 'c', contentKey: '' } });   // 锁键空串
  const plan = makeTaskInput({ kind: 'plan', projectId: 'p1', projectRev: 3, requires: { envFingerprint: FP_B }, input: { contentKey: 'ck1' } });
  const tasks = [noFp, emptyFp, noCk, emptyCk];
  const results = published(h.publish('q', tk([...tasks, plan], true)), 'q');
  for (const r of results) assert.equal('lockedBy' in r, false, `${r.id} 不带 lockedBy`);
  assert.deepEqual(h.describe().locks.map(l => [l.lockKey, l.envFingerprint, l.source]), [['snapshot:ck1', FP_A, 'lock']],
    '带 takeover 也不接手、不建锁');
  for (const t of tasks) claimOk(h, 'b', t.id, 1);
  claimOk(h, 'w', plan.id, 1);
  assert.deepEqual(h.describe().locks.map(l => [l.lockKey, l.envFingerprint, l.source, l.touchedAt]), [['snapshot:ck1', FP_A, 'lock', T0]],
    '认领它们不建锁、不刷新锁');

  // 空表：这些任务认领都不建锁
  const h2 = setup();
  const more = [snap('k1', FP_A, 0, { requires: {} }), snap('k2', FP_A, 0, { input: { clipId: 'c' } })];
  h2.publish('p', more);
  for (const t of more) claimOk(h2, 'a', t.id, 1);
  assert.deepEqual(h2.describe().locks, []);
});
