/**
 * M5b 队列部分：按节点指纹前置过滤、锁变更定向增量、拒绝限流（契约 `docs/plan/render-queue-contract.md` I 节，
 * 用例表 I.8 的 V1～V3、K1～K6）。
 * 跑：node --experimental-test-module-mocks --test server/test/render-queue-prefilter.test.mjs
 *
 * 只照契约 I 节以及它引用的 A、B.5、D.3、F 节写，不看实现。队列只经 A.3 的公开接口驱动
 * （connect / handle / tick / describe），节点会话只经 B.5 的公开接口驱动。
 *
 * 约定：
 *   - 有「过滤开 / 关」对比的用例，同一场景用 `constants: { PREFILTER: true }` 与 `{ PREFILTER: false }` 各跑一遍，
 *     两遍的原始数字都用 `t.diagnostic` 写进测试输出（I.8）。
 *   - 锁键 `snapshot:<contentKey>`（F.1）；结果键按 B.1 的公式自己算，任务 id 按 A.4 自己算，不借实现。
 *   - 指纹用 16 位小写十六进制的假值；节点都用 `host`，免得重度策略、纯浏览器按用户过滤掺进来。
 *   - K1～K3 用 D.3 的环回（`fake-loopback-transport.mjs`）把真队列和 B.5 的会话接起来，假时钟驱动，不起网络。
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
const SWEEP = 5_000;          // A.2 的 SWEEP_INTERVAL_MS 缺省值
const RENEW = 10_000;         // A.2 的 RENEW_INTERVAL_MS 缺省值
const LEASE = 30_000;         // A.2 的 LEASE_MS 缺省值（只给手写回包填 leaseUntil）
const MODES = [false, true]; // PREFILTER 关（对照组）先跑、开（实验组）后跑：对照组的数字总能先写进输出
const modeName = on => (on ? 'Filter on' : 'Filter off');

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const rk = (contentKey, fp) => sha256(`${contentKey}\n${fp ?? ''}`);

/**
 * 一张卡某个环境的一段快照任务：`input.contentKey = ck`、`requires.envFingerprint = fp`
 * （`fp` 为 null 时不带指纹）、`resultKey = resultKeyOf(ck, fp)`（和 splitPlan 出的形状一致）。
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

/* ================================================================== 队列单测的小工具 */

function harness(prefilter, extra = {}) {
  return createQueueHarness(createRenderQueue, { constants: { PREFILTER: prefilter, ...extra } });
}
/** 报到并 watch 'all'；fp 为 null 时 hello 不带 envFingerprint。回这一步收到的 queue.snapshot 里的任务 id。 */
function joinNode(h, conn, nodeId, fp) {
  // M6c X3：host 的 watch 'all' 只收摘要；这里要的是全量可见性，节点改用 pc（原为 host）
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
/** 某一步里发给 conn 的 task.opened 的任务 id（升序）。 */
const openedIds = (out, conn) => sorted(out.of(conn, 'task.opened').map(m => m.task.id));
const closedOf = (out, conn) => out.of(conn, 'task.closed');

/* ================================================================== V1 */

test('V1 A node sees tasks with a different fingerprint in neither queue.snapshot nor task.opened; nodes without a fingerprint still see everything as before', t => {
  for (const on of MODES) {
    const h = harness(on);
    h.publisher('p', 'pub-p');
    // 没有 contentKey：没有锁键，只考第 1 条（指纹相符）
    const tA = snap('v1a', FP_A, 0, { contentKey: false });
    const tB = snap('v1b', FP_B, 0, { contentKey: false });
    const t0 = snap('v1n', null, 0, { contentKey: false });
    publishOk(h, 'p', [tA, tB, t0]);

    const snapA = joinNode(h, 'a', 'node-A', FP_A);
    const snapB = joinNode(h, 'b', 'node-B', FP_B);
    const snapN = joinNode(h, 'n', 'node-N', null);
    t.diagnostic(`${modeName(on)}: snapshot count a=${snapA.length} b=${snapB.length} n=${snapN.length}`);

    // 节点报到之后发布：看 task.opened 的收件人
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

    // task.taken / task.closed 的收件人同样按可见性（I.2 末段）
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
    // ck1 锁在 B 上：A 指纹的任务 tA1（锁之前发布的）与不带指纹的 tN1
    // ck2 锁在 A 上：A 指纹的任务 tA2 与不带指纹的 tN2
    const tA1 = snap('v2-ck1', FP_A, 0), tN1 = snap('v2-ck1', null, 0);
    const tA2 = snap('v2-ck2', FP_A, 0), tN2 = snap('v2-ck2', null, 0);
    publishOk(h, 'p', [tA1, tN1, tA2, tN2]);
    assert.equal(cardLock(h, 'p', { contentKey: 'v2-ck1', envFingerprint: FP_B }).one('p', 'card.locked').granted, true);
    assert.equal(cardLock(h, 'p', { contentKey: 'v2-ck2', envFingerprint: FP_A }).one('p', 'card.locked').granted, true);

    const snapA = joinNode(h, 'a', 'node-A', FP_A);
    const snapB = joinNode(h, 'b', 'node-B', FP_B);
    const snapN = joinNode(h, 'n', 'node-N', null);
    t.diagnostic(`${modeName(on)} snapshot a=${JSON.stringify(snapA.length)} b=${snapB.length} n=${snapN.length}`);

    // 锁定之后再发布：不带指纹的任务不参与锁（F.1），照建；同指纹的也照建
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
    // 同一张卡：X 指纹的 tX（open）与 tXc（被 x2 认领着）、Y 指纹的 tY（锁之前发布）、不带指纹的 tN（不参与锁）；
    // 另一张卡 other 锁在 X 上，不受影响
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
    // tX 被接手作废（F.1：superseded → failed）
    assert.equal(h.task(tX.id).state, 'failed');
    assert.equal(h.task(tX.id).lastError, 'superseded');
    // 认领者照 F.1 收 lease-lost superseded（两种开关一样）
    const lost = out.of('x2', 'task.lease-lost');
    assert.deepEqual(lost.map(m => [m.id, m.token, m.reason]), [[tXc.id, claimedXc.token, 'superseded']], 'x2 gets exactly one lease-lost superseded');
    assert.equal(h.task(tXc.id).state, 'failed');
    // 不带指纹的 tN 不参与锁：谁都收不到关于它的消息
    assert.ok(!out.messages().some(m => (m.id ?? m.task?.id) === tN.id), 'A task without a fingerprint is not affected by the lock change');
    assert.ok(!out.messages().some(m => (m.id ?? m.task?.id) === oX.id), 'Other cards are not affected');
    const aboutTXc = m => (m.id ?? m.task?.id) === tXc.id;
    if (on) {
      // tX 是 open：按变更前的可见性，X 指纹的节点（x、x2）收到 hidden / card-locked（I.10 第 2 条），不再另收 failed。
      // 被认领着的 tXc 不是 open，契约只规定认领者的 lease-lost，这里不对别的节点关于它的 task.closed 下断言
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
    h.node('e', 'node-E', { profile: 'pc', hello: { envFingerprint: '' } });   // 空串等同于没带（第 7 条）；M6c X3：原为 host

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
    // 两种开关都照常认领的
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
    for (let i = 0; i < 11; i++) one(foreign[i].id);     // 11 次指纹不符
    for (let i = 0; i < 10; i++) one(dead.id);           // 10 次 card-locked，共 21 次
    one(foreign[11].id);                                  // 第 22 次
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

/* ================================================================== 环回 × 会话的场景台（K1～K3） */

/** 固定种子的伪随机数（mulberry32），[0, 1)。 */
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
  profile: 'pc', userId: 'u1', envFingerprint: fp, codeVersions: ['cv1'], cardSourceVersions: {},   // M6c X3：原为 host（host 的 watch 'all' 只收摘要）
  capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 16_000 },
});

/**
 * 一个真队列、一条环回、一个发布方、若干 B.5 会话。`groups: [{ name, fp, count }]`。
 * 每步：时钟前进 → 队列 tick → 投递 → 节点报进度 / 报完成 → 投递 → 全部会话 tick → 投递。
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
  /** 从某个游标起的投递记录。 */
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

/** 投递记录的统计：认领数、card-locked 拒绝、throttled。 */
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

/* ------------------------------------------------------------------ K1 / K2 的场景 */

/**
 * 两种指纹各 4 个节点；20 张卡，每张卡两种指纹各 5 段（共 200 个任务）。
 * 卡 0～9 锁在 A 上，卡 10～19 锁在 B 上：每个节点看来都有一半的卡被另一种指纹锁住。
 * 顺序：节点报到 → 先发布「锁之后会被别的指纹锁住」的那 100 个任务（死任务：锁之前还能建，F.7）
 * → `card.lock` 20 张卡 → 再发布与锁同指纹的 100 个任务（活任务）→ 跑到活任务全部完成。
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
  // 不匹配的节点（节点指纹 ≠ 卡的锁指纹）收到已锁卡任务的 task.opened（锁定之后）
  const openedMismatch = log.filter(e => e.dir === 'out' && e.message.type === 'task.opened'
    && nodeFp.has(e.connId) && info.get(e.message.task.id) && nodeFp.get(e.connId) !== info.get(e.message.task.id).lockFp).length;
  const openedTotal = log.filter(e => e.dir === 'out' && e.message.type === 'task.opened' && nodeFp.has(e.connId)).length;
  // 锁定那一步：每个节点收到的 hidden 撤回
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
    // 活任务全部完成，每个恰好一次 task.done
    assert.deepEqual(sorted([...r.doneCount.keys()]), ids(r.live), `${modeName(on)}: all live tasks completed, and only those`);
    for (const [id, c] of r.doneCount) assert.equal(c, 1, `${id} received ${c} task.done messages`);
    assert.equal(r.rig.failedMsgs().length, 0, 'No task failed');
    // 死任务（锁在别的指纹上）从没被认领过
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
      // I.3（新建锁）：锁定前看得见、锁定后看不见的，就是本指纹、锁在别的指纹上的死任务
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
    // 转移的卡优先级低：接手之前不会被认领，保证接手那一刻它们都是 open
    const movingY = moving.flatMap(ck => [0, 1].map(s => snap(ck, FP_B, s, { priority: 0 })));
    const movingX = moving.flatMap(ck => [0, 1].map(s => snap(ck, FP_A, s, { priority: 0 })));
    const sX = stableX.flatMap(ck => [0, 1, 2].map(s => snap(ck, FP_A, s, { priority: 10 })));
    const sY = stableY.flatMap(ck => [0, 1, 2].map(s => snap(ck, FP_B, s, { priority: 10 })));

    rig.start();
    rig.publish(movingY);                           // 锁之前发布（此后锁在 X 上，它们是死任务）
    for (const ck of [...moving, ...stableX]) rig.lock(ck, FP_A);
    for (const ck of stableY) rig.lock(ck, FP_B);
    rig.lb.flush();
    rig.publish([...movingX, ...sX, ...sY]);
    for (let i = 0; i < 3; i++) rig.step();         // 运行中

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

    // 跑到完成：两张稳定卡组与转移后的 Y 任务各恰好一次 task.done；X 的转移任务作废
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
    // 转移后的 Y 任务只由 Y 节点做
    const doneBy = new Map(rig.nodes.flatMap(n => n.completed.map(id => [id, n.group])));
    for (const id of movingYIds) assert.equal(doneBy.get(id), 'Y', `${id} should be completed by node Y`);
    const stats = claimStats(rig.since(m));
    t.diagnostic(`${modeName(on)}: after the takeover, claims=${stats.claims} card-locked=${stats.cardLocked}`);
  }
});

/* ================================================================== K4 */

/** K4 的场景：rogue（A）无视过滤反复认领锁在 B 上的死任务；a2（A）、b（B）是正常节点。 */
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

      // 限流期间：认领可认领的任务也回 throttled，不看任务状态、不改状态；不存在的任务同样 throttled
      const r1 = rejectOf(h.claim('rogue', liveA[0].id, 1), 'rogue');
      assert.deepEqual([r1.id, r1.reason], [liveA[0].id, 'throttled']);
      assert.equal(h.task(liveA[0].id).state, 'open');
      assert.equal(h.task(liveA[0].id).version, 1);
      const gone = rejectOf(h.claim('rogue', 'snapshot:nope:0-59', 1), 'rogue');
      assert.deepEqual([gone.id, gone.reason], ['snapshot:nope:0-59', 'throttled']);
      assert.equal(connInfo(h, 'node-rogue').cardLockedRejects, 21, 'throttled is not counted in the card-locked count');

      // 其它节点不受影响：同一周期里照常认领；它自己的 card-locked 单独计数
      const a2 = h.claim('a2', liveA[1].id, 1);
      assert.equal(a2.one('a2', 'task.claimed').id, liveA[1].id);
      assert.equal(rejectOf(h.claim('a2', dead.id, 1), 'a2').reason, 'card-locked');
      assert.equal(h.claim('b', liveB[0].id, 1).one('b', 'task.claimed').id, liveB[0].id);
      assert.deepEqual([connInfo(h, 'node-a2').cardLockedRejects, connInfo(h, 'node-a2').throttled], [1, false]);
      assert.deepEqual([connInfo(h, 'node-b').cardLockedRejects, connInfo(h, 'node-b').throttled], [0, false]);

      // 下一次 tick() 后恢复
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
  cardLock(h, 'p', { contentKey: 'k5', envFingerprint: FP_A });               // 新建
  const c = h.claim('a', tasks[0].id, 1).one('a', 'task.claimed');
  h.complete('a', tasks[0].id, c.token, { ranges: [[0, 59]] });
  cardLock(h, 'p', { contentKey: 'k5', envFingerprint: FP_B, takeover: true }); // 接手
  h.tick();
  const snapA = joinNode(h, 'a2', 'node-A2', FP_A);

  assert.equal(h.describe().prefilter, false);
  const all = h.bus.all();
  const hidden = all.ofType('task.closed').filter(e => e.message.state === 'hidden' || e.message.reason === 'card-locked');
  t.diagnostic(`Filter off: among all ${all.count} messages, ${hidden.length} are hidden`);
  assert.equal(hidden.length, 0, 'Filter off: no hidden messages');
  assert.equal(all.ofType('task.claim-rejected').filter(e => e.message.reason === 'throttled').length, 0);
  // 过滤关：新连上的 A 节点看得见全部 open 任务（B 指纹的、锁在 B 上的都在）
  const openIds = h.describe().tasks.filter(x => x.state === 'open').map(x => x.id).sort();
  assert.deepEqual(snapA, openIds);
});

test('K5 Constants and diagnostics (I.1, I.7): PREFILTER defaults to on, THROTTLE_REJECTS is 20, environment variable names; the new fields of describe', t => {
  const { QUEUE_DEFAULTS, QUEUE_ENV } = queueIndex;
  assert.equal(QUEUE_DEFAULTS.PREFILTER, true);
  assert.equal(QUEUE_DEFAULTS.THROTTLE_REJECTS, 20);
  assert.equal(QUEUE_ENV.PREFILTER, 'PROMPTCUT_QUEUE_PREFILTER');
  assert.equal(QUEUE_ENV.THROTTLE_REJECTS, 'PROMPTCUT_QUEUE_THROTTLE_REJECTS');

  const h = createQueueHarness(createRenderQueue);   // 不给 constants：缺省开
  joinNode(h, 'a', 'node-A', FP_A);
  const d = h.describe();
  t.diagnostic(`Default describe().prefilter=${d.prefilter}; nodes[0]=${JSON.stringify(d.nodes[0])}`);
  assert.equal(d.prefilter, true);
  assert.equal(d.nodes[0].cardLockedRejects, 0);
  assert.equal(d.nodes[0].throttled, false);
  assert.equal(harness(false).describe().prefilter, false);
});

/* ================================================================== K6 */

/** 会话单测：手写队列回包（形状照 A.6 / A.7）。 */
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
  // 先认领一个并持有（用来看续约）
  const c0 = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c0.length, 1);
  const first = [v0, v1, v2].find(v => v.id === c0[0].id);
  s.session.receive(claimedMsg(first, 2, s.now));
  const heldAt = s.now;

  // 9 秒后发第二个认领，回 throttled
  s.set(heldAt + 9_000);
  const c1 = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c1.length, 1, 'The second claim is sent');
  const candidate = c1[0].id;
  s.session.receive({ type: 'task.claim-rejected', epoch: E, id: candidate, reason: 'throttled' });
  const throttledAt = s.now;
  assert.ok(s.session.known().some(v => v.id === candidate), 'A throttled candidate is not removed from the local view');

  // 退避期间：续约照发，不发认领
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

  // 别的请求（内容库、发布）的错误回包：带 reqId，不是认领的回包
  s.session.receive({ type: 'error', epoch: E, reqId: 'lib-1', reason: 'bad-message', detail: 'x' });
  s.session.receive({ type: 'error', epoch: E, reqId: 7, reason: 'not-registered' });
  assert.equal(s.tick().filter(m => m.type === 'task.claim').length, 0, 'The claim is still in flight after an error with a reqId, so no second one is sent');
  s.session.receive(claimedMsg(first, 2, s.now));
  assert.deepEqual(started, [first.id], 'The claim reply is handled as usual');
  assert.deepEqual(s.session.held().map(x => x.id), [first.id]);

  // 不带 reqId 的 error：照清在飞
  const c2 = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c2.length, 1, 'The second claim is sent (maxConcurrent 2)');
  s.session.receive({ type: 'error', epoch: E, reason: 'bad-message', detail: 'y' });
  const c3 = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c3.length, 1, 'An error without a reqId clears the in-flight claim, and the next tick claims again');
});
