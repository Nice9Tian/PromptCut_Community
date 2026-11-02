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

test('Q0 lockKeyOf (F.1 "lock key"): for snapshot / stream with a non-empty string contentKey it is `${kind}:${contentKey}`, otherwise null', () => {
  const { lockKeyOf } = queueIndex;
  assert.equal(typeof lockKeyOf, 'function', 'index.mjs must re-export lockKeyOf');
  assert.equal(lockKeyOf({ kind: 'snapshot', input: { contentKey: 'ck1' } }), 'snapshot:ck1');
  assert.equal(lockKeyOf({ kind: 'stream', input: { contentKey: 'sk1' } }), 'stream:sk1');
  assert.equal(lockKeyOf({ kind: 'snapshot', input: { contentKey: 'entry/ck1' } }), 'snapshot:entry/ck1', 'the content key of the local tier carries entryKey/');
  // 任务视图照样认
  const t = snap('ck9', FP_A);
  assert.equal(lockKeyOf(t), 'snapshot:ck9');
  for (const [label, task] of [
    ['plan', { kind: 'plan', input: { contentKey: 'x' } }],
    ['no input', { kind: 'snapshot' }],
    ['input is null', { kind: 'snapshot', input: null }],
    ['no contentKey', { kind: 'snapshot', input: { clipId: 'c' } }],
    ['empty string', { kind: 'stream', input: { contentKey: '' } }],
    ['number', { kind: 'snapshot', input: { contentKey: 5 } }],
    ['unknown kind', { kind: 'other', input: { contentKey: 'x' } }],
  ]) assert.equal(lockKeyOf(task), null, label);
});

/* ================================================================== Q1 */

test('Q1 the first claim creates the lock (source: claim), the remaining segments with the same fingerprint are claimed as usual and only refresh touchedAt', () => {
  const h = setup();
  const t1 = snap('ck1', FP_A, 0), t2 = snap('ck1', FP_A, 60), t3 = snap('ck1', FP_A, 120);
  h.publish('p', [t1, t2, t3]);
  assert.deepEqual(locks(h), [], 'publishing (without takeover) creates no lock, wait for the first claim');

  claimOk(h, 'a', t1.id, 1);
  assert.deepEqual(locks(h), [{ lockKey: 'snapshot:ck1', envFingerprint: FP_A, source: 'claim', since: T0, touchedAt: T0 }]);

  h.clock.advance(1000);
  const c2 = claimOk(h, 'a2', t2.id, 1);
  assert.equal(c2.id, t2.id, 'another node with the same fingerprint claims as usual');
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { lockKey: 'snapshot:ck1', envFingerprint: FP_A, source: 'claim', since: T0, touchedAt: T0 + 1000 },
    'a claim with the same fingerprint only refreshes touchedAt, since / source unchanged');

  h.clock.advance(1000);
  claimOk(h, 'a', t3.id, 1);
  assert.equal(lockOf(h, 'snapshot:ck1').touchedAt, T0 + 2000);
  assert.equal(locks(h).length, 1);
});

test('Q1 addendum: stream tasks create locks too (lock key stream:<contentKey>); a snapshot and a stream are two separate locks even when their content keys are the same', () => {
  const h = setup();
  const s = stream('same', FP_A, 0), k = snap('same', FP_B, 0);
  h.publish('p', [s, k]);
  claimOk(h, 'a', s.id, 1);
  claimOk(h, 'b', k.id, 1);
  assert.deepEqual(locks(h).map(l => [l.lockKey, l.envFingerprint, l.source]), [
    ['snapshot:same', FP_B, 'claim'], ['stream:same', FP_A, 'claim'],
  ]);
});

test('Q1 addendum: completing a task whose lock key is L refreshes the touchedAt of L', () => {
  const h = setup();
  const t1 = snap('ck1', FP_A, 0);
  h.publish('p', [t1]);
  const c = claimOk(h, 'a', t1.id, 1);
  h.clock.advance(5000);
  h.complete('a', t1.id, c.token, { ranges: [[0, 59]] });
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { lockKey: 'snapshot:ck1', envFingerprint: FP_A, source: 'claim', since: T0, touchedAt: T0 + 5000 });
});

/* ================================================================== Q2 */

test('Q2 when the lock is on X, a claim for a task with fingerprint Y and the same contentKey is rejected with card-locked (carrying lockedBy: X), the version is unchanged and nothing is broadcast', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0), y = snap('ck1', FP_B, 0);
  h.publish('p', [x, y]);
  claimOk(h, 'a', x.id, 1);
  h.bus.clear();

  const out = h.claim('b', y.id, 1);
  const r = out.one('b', 'task.claim-rejected');
  assert.deepEqual([r.id, r.reason, r.state, r.version, r.lockedBy], [y.id, 'card-locked', 'open', 1, FP_A]);
  assert.deepEqual(out.conns(), ['b'], 'a rejection is sent only to the claimant and is not broadcast');
  const t = h.task(y.id);
  assert.deepEqual([t.state, t.version, t.attempts, t.claim], ['open', 1, 0, null], 'version and state unchanged');
  assert.deepEqual(lockOf(h, 'snapshot:ck1').envFingerprint, FP_A, 'the lock is unchanged');
  assert.equal(lockOf(h, 'snapshot:ck1').touchedAt, T0, 'a rejected claim does not refresh the lock');
});

test('Q2 addendum: card-locked is judged after taken and before stale (step 3a)', () => {
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

test('Q2 addendum: the lock blocks only by lock key; other cards and other kinds are unaffected', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0), other = snap('ck2', FP_B, 0), otherKind = stream('ck1', FP_B, 0);
  h.publish('p', [x, other, otherKind]);
  claimOk(h, 'a', x.id, 1);
  claimOk(h, 'b', other.id, 1);
  claimOk(h, 'b', otherKind.id, 1);
});

/* ================================================================== Q3 */

test('Q3 card.lock: with no lock it obtains the lock (source: lock); the same fingerprint is granted and refreshed; a different fingerprint without takeover → granted: false, lock unchanged', () => {
  const h = setup();
  let out = cardLock(h, 'p', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A, reqId: 'r1' });
  let m = out.one('p', 'card.locked');
  assert.deepEqual([m.lockKey, m.envFingerprint, m.granted, m.reqId], ['snapshot:ck1', FP_A, true, 'r1']);
  assert.equal(typeof m.epoch, 'string', 'outbound messages carry epoch (A.11)');
  assert.deepEqual(out.conns(), ['p'], 'the reply goes only to the connection that sent the request');
  assert.deepEqual(locks(h), [{ lockKey: 'snapshot:ck1', envFingerprint: FP_A, source: 'lock', since: T0, touchedAt: T0 }]);

  h.clock.advance(2000);
  m = cardLock(h, 'q', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A, reqId: 7 }).one('q', 'card.locked');
  assert.deepEqual([m.lockKey, m.envFingerprint, m.granted, m.reqId], ['snapshot:ck1', FP_A, true, 7]);
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { lockKey: 'snapshot:ck1', envFingerprint: FP_A, source: 'lock', since: T0, touchedAt: T0 + 2000 });

  h.clock.advance(2000);
  const before = h.describe();
  for (const takeover of [undefined, false]) {
    m = cardLock(h, 'q', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_B, ...(takeover === undefined ? {} : { takeover }) }).one('q', 'card.locked');
    assert.deepEqual([m.lockKey, m.envFingerprint, m.granted], ['snapshot:ck1', FP_A, false], `takeover ${takeover}: replies with the fingerprint on the lock after processing`);
  }
  assert.deepEqual(h.describe(), before, 'a rejected card.lock changes nothing (touchedAt is not refreshed either)');

  // stream 同样可以锁
  m = cardLock(h, 'p', { kind: 'stream', contentKey: 'sk1', envFingerprint: FP_B }).one('p', 'card.locked');
  assert.deepEqual([m.lockKey, m.envFingerprint, m.granted], ['stream:sk1', FP_B, true]);
  assert.equal(lockOf(h, 'stream:sk1').source, 'lock');
});

test('Q3 a lock created by card.lock blocks claims too', () => {
  const h = setup();
  const y = snap('ck1', FP_B, 0);
  h.publish('p', [y]);
  cardLock(h, 'q', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A });
  const r = h.claim('b', y.id, 1).one('b', 'task.claim-rejected');
  assert.deepEqual([r.reason, r.lockedBy], ['card-locked', FP_A]);
});

test('Q3 a malformed card.lock → the whole message gets bad-message (with reqId), state unchanged', () => {
  const h = setup();
  cardLock(h, 'p', { kind: 'snapshot', contentKey: 'held', envFingerprint: FP_A });
  const before = h.describe();
  const good = { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A };
  const cases = [
    [{ ...good, kind: 'plan' }, 'kind is plan'],
    [{ ...good, kind: undefined }, 'missing kind'],
    [{ ...good, kind: 'Snapshot' }, 'kind has the wrong case'],
    [{ ...good, contentKey: '' }, 'contentKey is an empty string'],
    [{ ...good, contentKey: 42 }, 'contentKey is not a string'],
    [{ ...good, contentKey: undefined }, 'missing contentKey'],
    [{ ...good, envFingerprint: '' }, 'envFingerprint is an empty string'],
    [{ ...good, envFingerprint: undefined }, 'missing envFingerprint'],
    [{ ...good, envFingerprint: 1234 }, 'envFingerprint is not a string'],
    [{ ...good, takeover: 'yes' }, 'takeover is not a boolean'],
    [{ ...good, takeover: 1 }, 'takeover is a number'],
    [{ ...good, contentKey: 'held', envFingerprint: FP_B, takeover: 'true' }, 'wants to take over but takeover is not a boolean'],
  ];
  for (const [fields, why] of cases) {
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const out = cardLock(h, 'p', { ...clean, reqId: `bad-${why}` });
    const e = out.one('p', 'error');
    assert.equal(e.reason, 'bad-message', why);
    assert.equal(e.reqId, `bad-${why}`, `${why}: the reply carries reqId`);
    assert.equal(out.of('p', 'card.locked').length, 0, `${why}: no card.locked reply`);
    assert.deepEqual(h.describe(), before, `${why}: state unchanged`);
  }
});

test('Q3 card.lock is in PUBLISHER_TYPES; a connection that has not sent publisher.hello gets not-registered (A.5) when it sends it, and no lock is created', () => {
  assert.ok(queueMessages.PUBLISHER_TYPES instanceof Set);
  assert.ok(queueMessages.PUBLISHER_TYPES.has('card.lock'), 'only publisher connections can send card.lock');
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
  assert.deepEqual([v1.state, v1.version], ['done', 3], 'done tasks untouched');
  // T2 claimed → failed(superseded)，原认领者先收 lease-lost
  const v2 = h.task(t2.id);
  assert.deepEqual([v2.state, v2.version, v2.attempts, v2.lastError, v2.claim, v2.finishedAt], ['failed', 3, 0, 'superseded', null, now],
    'claimed tasks: version+1, failed, attempts unchanged, lastError superseded, claim cleared');
  const ll = out.one('a2', 'task.lease-lost');
  assert.deepEqual([ll.id, ll.token, ll.reason], [t2.id, c2.token, 'superseded']);
  // T3 open → failed(superseded)
  const v3 = h.task(t3.id);
  assert.deepEqual([v3.state, v3.version, v3.attempts, v3.lastError, v3.finishedAt], ['failed', 2, 0, 'superseded', now]);
  // 订阅者收 task.failed
  for (const [conn, ids] of [['p', [t2.id, t3.id]], ['p2', [t3.id]]]) {
    const failed = out.of(conn, 'task.failed');
    assert.deepEqual(failed.map(m => m.id).sort(), [...ids].sort(), `task.failed received by ${conn}`);
    for (const m of failed) assert.equal(m.error, 'superseded');
  }
  // watch 者收 task.closed { state: failed }
  for (const conn of ['a', 'b', 'w']) {
    const closed = out.of(conn, 'task.closed').filter(m => m.id === t2.id || m.id === t3.id);
    assert.deepEqual(closed.map(m => [m.id, m.state]).sort(), [[t2.id, 'failed'], [t3.id, 'failed']].sort(), `task.closed received by ${conn}`);
  }
  // 别的卡不动
  const vo = h.task(o.id);
  assert.deepEqual([vo.state, vo.version], ['open', 1], 'tasks with other lock keys untouched');
  // 锁转给新指纹
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { lockKey: 'snapshot:ck1', envFingerprint: newFp, source: 'takeover', since: now, touchedAt: now });
  assert.equal(lockOf(h, 'snapshot:ck2'), null, 'no lock was created for other cards as a side effect');
}

test('Q4 publishing with takeover: the lock moves to the new fingerprint; open tasks of the old fingerprint go to failed(superseded), the claimant of claimed ones receives lease-lost, subscribers receive task.failed; done tasks untouched', () => {
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
  for (const r of results) assert.equal('lockedBy' in r, false, 'after a takeover the lock is its own and carries no lockedBy');

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

test('Q4 publishing with takeover (full check): state, messages, lock', () => {
  const scene = takeoverScene({ constants: { PREFILTER: false } });
  const { h } = scene;
  const now = h.now();
  const out = h.publish('q', tk([snap('ck1', FP_B, 0)], true));
  assertSuperseded(h, out, scene, now, FP_B);
  // 已经 failed 的旧任务再认领：第 3 步 taken 先于 3a
  const r = h.claim('a', scene.t3.id, 2).one('a', 'task.claim-rejected');
  assert.deepEqual([r.reason, r.state], ['taken', 'failed']);
});

test('Q4 card.lock with takeover also takes over (shared with publishing): granted: true, unfinished tasks of the old fingerprint are invalidated', () => {
  const scene = takeoverScene({ constants: { PREFILTER: false } });
  const { h } = scene;
  const now = h.now();
  const out = cardLock(h, 'q', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_B, takeover: true, reqId: 'tk' });
  const m = out.one('q', 'card.locked');
  assert.deepEqual([m.lockKey, m.envFingerprint, m.granted, m.reqId], ['snapshot:ck1', FP_B, true, 'tk']);
  assertSuperseded(h, out, scene, now, FP_B);
});

test('Q4 addendum: at takeover, tasks with the same fingerprint as the new lock are not invalidated; when a third fingerprint takes over again, the tasks of the previous owner are the ones invalidated', () => {
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

test('Q4 addendum: the same fingerprint with takeover (the lock is already its own) only refreshes touchedAt and invalidates no tasks', () => {
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

test('Q5 publishing an existing task without takeover while the lock is on another fingerprint: merges as usual, results[i].lockedBy is the lock fingerprint; lock unchanged (for tasks that do not exist see Q10)', () => {
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
  assert.deepEqual(results[2], { id: same.id, state: 'open', version: 1, created: true }, 'the same fingerprint carries no lockedBy');
  assert.deepEqual(results[3], { id: free.id, state: 'open', version: 1, created: true }, 'unlocked ones carry no lockedBy');
  assert.ok(h.task(y1.id).subscribers.includes('pub-q'), 'merged per A.7.1: the subscriber joins this publisher');
  assert.deepEqual(lockOf(h, 'snapshot:ck1'), { ...before, touchedAt: T0 + 100 }, 'the task with the same fingerprint refreshed touchedAt, fingerprint unchanged');
  assert.equal(lockOf(h, 'snapshot:ck2'), null, 'no lock + no takeover: no lock is created');

  // takeover: false 同不带
  results = published(h.publish('p', tk([y1], false)), 'p');
  assert.deepEqual(f7(results[0]), { id: y1.id, state: 'open', version: 1, created: false, lockedBy: FP_A });
  assert.equal(lockOf(h, 'snapshot:ck1').envFingerprint, FP_A);
  // 合并进来的异指纹任务仍然认领不了
  assert.equal(h.claim('b', y1.id, 1).one('b', 'task.claim-rejected').reason, 'card-locked');
});

/* ================================================================== Q10（F.7 第 1、4 条） */

test('Q10 creation rejection: the lock is on another fingerprint, no takeover, and the table has no task with the same id → not created, results[i] = { id, error: card-locked, lockedBy }; the other items in the same message proceed as usual', () => {
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
  assert.deepEqual(m.results[1], { id: other.id, state: 'open', version: 1, created: true }, 'other cards are created as usual');
  assert.deepEqual(m.results[2], { id: same.id, state: 'open', version: 1, created: true }, 'the same fingerprint is created as usual');
  assert.deepEqual(m.results[3], { id: y2.id, state: 'open', version: 1, created: true }, 'a stream is a different lock (stream:ck1, unlocked)');
  assert.equal(h.task(y1.id), null, 'a task whose creation was rejected is not in the table');
  const opened = out.ofType('task.opened').map(e => e.message.task.id);
  assert.ok(!opened.includes(y1.id), 'task.opened is not broadcast for a rejected creation');
  assert.ok(opened.includes(other.id));
  assert.equal(lockOf(h, 'snapshot:ck1').envFingerprint, lockBefore.envFingerprint, 'the lock is unchanged');
  assert.equal(lockOf(h, 'snapshot:ck1').source, 'claim');

  // 锁上的指纹换了（被接手），lockedBy 跟着换
  cardLock(h, 'p', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_C, takeover: true });
  const again = published(h.publish('q', [y1]), 'q');
  assert.deepEqual(f7(again[0]), { id: y1.id, error: 'card-locked', lockedBy: FP_C });
});

test('Q10 addendum: an item that was not created because of limit gets no lock handling at all (F.7 item 4)', () => {
  const h = setup({ constants: { MAX_TASKS_PER_PROJECT: 1 } });
  const first = snap('k0', FP_A, 0);
  h.publish('p', [first]);
  // 项目已满：带 takeover 的新任务因 limit 没建 → 不建锁
  const r = published(h.publish('q', tk([snap('k1', FP_B, 0)], true)), 'q');
  assert.equal(r[0].error, 'limit');
  assert.equal(lockOf(h, 'snapshot:k1'), null, 'an item over limit creates no lock');
  // 已锁在别的指纹上时：limit 的项不接手、锁不变
  cardLock(h, 'p', { kind: 'snapshot', contentKey: 'k2', envFingerprint: FP_A });
  const r2 = published(h.publish('q', tk([snap('k2', FP_B, 0)], true)), 'q');
  assert.equal(r2[0].error, 'limit');
  assert.deepEqual([lockOf(h, 'snapshot:k2').envFingerprint, lockOf(h, 'snapshot:k2').source], [FP_A, 'lock']);
});

/* ================================================================== Q11（F.7 第 2 条） */

test('Q11 publishing with takeover when there is no lock: creates a lock (source: takeover) and invalidates open tasks with the same lock key but a different fingerprint; same fingerprint and other cards untouched', () => {
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
    assert.deepEqual([v.state, v.version, v.attempts, v.lastError, v.finishedAt], ['failed', 2, 0, 'superseded', now], `${t.id} invalidated`);
  }
  assert.deepEqual(out.of('p', 'task.failed').map(m => [m.id, m.error]).sort(), [[x1.id, 'superseded'], [x2.id, 'superseded']].sort(),
    'subscribers receive task.failed');
  for (const conn of ['a', 'a2', 'b', 'w']) {
    assert.deepEqual(out.of(conn, 'task.closed').filter(m => m.id === x1.id || m.id === x2.id).map(m => [m.id, m.state]).sort(),
      [[x1.id, 'failed'], [x2.id, 'failed']].sort(), `${conn} receives task.closed`);
  }
  assert.deepEqual([h.task(sameFp.id).state, h.task(sameFp.id).version], ['open', 1], 'same fingerprint untouched');
  assert.deepEqual([h.task(otherCard.id).state, h.task(otherCard.id).version], ['open', 1], 'other cards untouched');
  assert.equal(lockOf(h, 'snapshot:ck2'), null);
  // 此后 A 指纹的新任务发布被拒建
  assert.equal(published(h.publish('p', [snap('ck1', FP_A, 180)]), 'p')[0].error, 'card-locked');
  // B 指纹的照常认领
  claimOk(h, 'b', y.id, 1);
});

/* ================================================================== Q6 */

test('Q6 a task takeover that is not a boolean → the whole message gets bad-message, state unchanged; when it is a boolean it is not stored in the task, TaskView unchanged', () => {
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
    assert.deepEqual(h.describe(), before, `takeover = ${JSON.stringify(takeover)}: state unchanged (no task created, no takeover)`);
  }
  // 合法的布尔：任务里不存 takeover
  const y = snap('ck1', FP_B, 60);
  const out = h.publish('q', tk([y], true));
  const opened = out.ofType('task.opened').map(e => e.message.task).filter(t => t.id === y.id);
  assert.ok(opened.length > 0, 'watchers receive task.opened');
  for (const t of opened) assert.equal('takeover' in t, false, 'TaskView does not contain takeover');
  const c = claimOk(h, 'b', y.id, 1);
  assert.equal('takeover' in c.task, false);
  assert.deepEqual(Object.keys(c.task).sort(),
    ['attempts', 'id', 'input', 'kind', 'priority', 'range', 'requires', 'resultKey', 'source', 'state', 'tier', 'version', 'weight'].sort(),
    'the fields of TaskView match A.4');
});

/* ================================================================== Q7 */

test('Q7 lock reclamation: delete only when no task references it any more and now - touchedAt > DONE_TTL (F.7 item 3, strictly greater; the item 5 sweep runs after the TTL deletes tasks)', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0);
  h.publish('p', [x]);
  const c = claimOk(h, 'a', x.id, 1);
  h.clock.advance(1000);
  h.complete('a', x.id, c.token, { ranges: [[0, 59]] });
  const done = T0 + 1000;
  assert.equal(lockOf(h, 'snapshot:ck1').touchedAt, done);

  h.at(done + TTL);
  assert.ok(h.task(x.id), 'a done task is still there exactly at the TTL boundary (deleted only when strictly greater)');
  assert.ok(lockOf(h, 'snapshot:ck1'), 'still referenced by a task: the lock is not deleted');

  h.at(done + TTL + 1);
  assert.equal(h.task(x.id), null, 'the TTL deleted the task');
  assert.equal(lockOf(h, 'snapshot:ck1'), null, 'in the same tick: the task is deleted and touchedAt is old enough → the lock is deleted');
});

test('Q7 lock reclamation: a lock that no task references (created by card.lock) is judged by strictly greater: exactly DONE_TTL it is still kept, 1 ms more and it is deleted', () => {
  const h = setup();
  cardLock(h, 'p', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A });
  h.at(T0 + TTL - 1);
  assert.ok(lockOf(h, 'snapshot:ck1'), 'TTL - 1: kept');
  h.at(T0 + TTL);
  assert.ok(lockOf(h, 'snapshot:ck1'), 'exactly TTL: still kept (deleted only when strictly greater, consistent with A.8)');
  h.at(T0 + TTL + 1);
  assert.equal(lockOf(h, 'snapshot:ck1'), null, 'TTL + 1: deleted');
});

test('Q7 lock reclamation: not deleted while a task still references it, however long it has been; refreshing touchedAt postpones reclamation', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0);
  h.publish('p', [x]);
  cardLock(h, 'q', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A });
  h.at(T0 + 5 * TTL);
  assert.ok(h.task(x.id), 'open tasks do not expire');
  assert.ok(lockOf(h, 'snapshot:ck1'), 'referenced by an open task: the lock is not deleted');

  // 另一把没人引用的锁：中途刷新一次，按新的 touchedAt 算
  cardLock(h, 'q', { kind: 'stream', contentKey: 'sk', envFingerprint: FP_A });
  const t0 = h.now();
  h.at(t0 + TTL - 10);
  cardLock(h, 'q', { kind: 'stream', contentKey: 'sk', envFingerprint: FP_A });
  h.at(t0 + TTL + 10);
  assert.ok(lockOf(h, 'stream:sk'), 'refreshed: counted from the moment of the refresh');
  h.at(t0 + TTL - 10 + TTL);
  assert.ok(lockOf(h, 'stream:sk'), 'exactly TTL since the refresh: still kept');
  h.at(t0 + TTL - 10 + TTL + 1);
  assert.equal(lockOf(h, 'stream:sk'), null);
});

test('Q7 addendum: also not deleted while the lock key is still referenced by a failed task (TTL not yet passed)', () => {
  const h = setup();
  const x = snap('ck1', FP_A, 0);
  h.publish('p', [x]);
  claimOk(h, 'a', x.id, 1);
  cardLock(h, 'q', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_B, takeover: true });  // x → failed
  const t = h.now();
  assert.equal(h.task(x.id).state, 'failed');
  h.at(t + TTL);
  assert.ok(h.task(x.id), 'a failed task is still there exactly at the TTL boundary');
  assert.ok(lockOf(h, 'snapshot:ck1'), 'still referenced by a failed task: not deleted');
  h.at(t + TTL + 1);
  assert.equal(h.task(x.id), null);
  assert.equal(lockOf(h, 'snapshot:ck1'), null);
});

/* ================================================================== Q8 */

test('Q8 shape and ordering of describe().locks (by lockKey), returns a deep copy; a queue with a new epoch has no locks', () => {
  const h = setup();
  assert.deepEqual(h.describe().locks, [], 'an empty array at the start');
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

test('Q9 tasks without input.contentKey or without requires.envFingerprint create no lock and are not affected by locks', () => {
  const h = setup();
  cardLock(h, 'p', { kind: 'snapshot', contentKey: 'ck1', envFingerprint: FP_A });
  const noFp = snap('ck1', FP_B, 0, { requires: {} });                                  // 有锁键、没锁指纹
  const emptyFp = snap('ck1', FP_B, 60, { requires: { envFingerprint: '' } });          // 锁指纹空串
  const noCk = snap('ck1', FP_B, 120, { input: { clipId: 'c' } });                       // 没锁键
  const emptyCk = snap('ck1', FP_B, 180, { input: { clipId: 'c', contentKey: '' } });   // 锁键空串
  const plan = makeTaskInput({ kind: 'plan', projectId: 'p1', projectRev: 3, requires: { envFingerprint: FP_B }, input: { contentKey: 'ck1' } });
  const tasks = [noFp, emptyFp, noCk, emptyCk];
  const results = published(h.publish('q', tk([...tasks, plan], true)), 'q');
  for (const r of results) assert.equal('lockedBy' in r, false, `${r.id} carries no lockedBy`);
  assert.deepEqual(h.describe().locks.map(l => [l.lockKey, l.envFingerprint, l.source]), [['snapshot:ck1', FP_A, 'lock']],
    'even with takeover, no takeover happens and no lock is created');
  for (const t of tasks) claimOk(h, 'b', t.id, 1);
  claimOk(h, 'w', plan.id, 1);
  assert.deepEqual(h.describe().locks.map(l => [l.lockKey, l.envFingerprint, l.source, l.touchedAt]), [['snapshot:ck1', FP_A, 'lock', T0]],
    'claiming them creates no lock and refreshes no lock');

  // 空表：这些任务认领都不建锁
  const h2 = setup();
  const more = [snap('k1', FP_A, 0, { requires: {} }), snap('k2', FP_A, 0, { input: { clipId: 'c' } })];
  h2.publish('p', more);
  for (const t of more) claimOk(h2, 'a', t.id, 1);
  assert.deepEqual(h2.describe().locks, []);
});
