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
const modeName = on => (on ? '过滤开' : '过滤关');

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
  for (const r of results) assert.equal(r.error, undefined, `发布 ${r.id} 不应出错：${JSON.stringify(r)}`);
  return out;
}
/** 某一步里发给 conn 的 task.opened 的任务 id（升序）。 */
const openedIds = (out, conn) => sorted(out.of(conn, 'task.opened').map(m => m.task.id));
const closedOf = (out, conn) => out.of(conn, 'task.closed');

/* ================================================================== V1 */

test('V1 指纹不同的任务，节点在 queue.snapshot 和 task.opened 里都看不见；不带指纹的节点照旧都看得见', t => {
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
    t.diagnostic(`${modeName(on)} snapshot 条数 a=${snapA.length} b=${snapB.length} n=${snapN.length}`);

    // 节点报到之后发布：看 task.opened 的收件人
    const tA2 = snap('v1a', FP_A, 1, { contentKey: false });
    const tB2 = snap('v1b', FP_B, 1, { contentKey: false });
    const t02 = snap('v1n', null, 1, { contentKey: false });
    const out = publishOk(h, 'p', [tA2, tB2, t02]);
    t.diagnostic(`${modeName(on)} task.opened 条数 a=${out.of('a', 'task.opened').length} b=${out.of('b', 'task.opened').length} n=${out.of('n', 'task.opened').length}`);

    const all = ids([tA, tB, t0]), all2 = ids([tA2, tB2, t02]);
    assert.deepEqual(snapN, all, `${modeName(on)}：不带指纹的节点 snapshot 全看得见`);
    assert.deepEqual(openedIds(out, 'n'), all2, `${modeName(on)}：不带指纹的节点 task.opened 全收到`);
    if (on) {
      assert.deepEqual(snapA, ids([tA, t0]), '过滤开：A 节点 snapshot 只有 A 指纹与不带指纹的任务');
      assert.deepEqual(snapB, ids([tB, t0]), '过滤开：B 节点 snapshot 只有 B 指纹与不带指纹的任务');
      assert.deepEqual(openedIds(out, 'a'), ids([tA2, t02]));
      assert.deepEqual(openedIds(out, 'b'), ids([tB2, t02]));
    } else {
      assert.deepEqual(snapA, all, '过滤关：和本节之前一样都看得见');
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
    t.diagnostic(`${modeName(on)} B 任务被认领/完成：a 收 taken=${takenA} closed=${closedA}；n 收 taken=${takenN} closed=${closedN}`);
    assert.equal(takenN, 1, 'n 看得见，收到 task.taken');
    assert.equal(closedN, 1, 'n 看得见，收到 task.closed');
    assert.equal(takenA, on ? 0 : 1, `${modeName(on)}：A 节点的 task.taken`);
    assert.equal(closedA, on ? 0 : 1, `${modeName(on)}：A 节点的 task.closed`);
  }
});

/* ================================================================== V2 */

test('V2 锁在别的指纹上时，节点看不见这个锁键下带指纹的任务；锁在自己的指纹上时看得见；不带指纹的任务不受锁限制（I.10 第 1 条）', t => {
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
    t.diagnostic(`${modeName(on)} 锁定后发布的 task.opened：a=${openedIds(out, 'a').length} b=${openedIds(out, 'b').length} n=${openedIds(out, 'n').length}`);

    const all = ids([tA1, tN1, tA2, tN2]);
    assert.deepEqual(snapN, all, `${modeName(on)}：不带指纹的节点，第 2 条不生效，全看得见`);
    assert.deepEqual(openedIds(out, 'n'), ids([tN1b, tA2b]));
    if (on) {
      assert.deepEqual(snapA, ids([tN1, tA2, tN2]), '过滤开：A 节点看不见锁在 B 上的 ck1 里 A 指纹的任务；不带指纹的不受锁限制；锁在自己指纹上的 ck2 看得见');
      assert.deepEqual(snapB, ids([tN1, tN2]), '过滤开：B 节点只看得见不带指纹的任务（A 指纹的被第 1 条挡住）');
      assert.deepEqual(openedIds(out, 'a'), ids([tN1b, tA2b]));
      assert.deepEqual(openedIds(out, 'b'), ids([tN1b]));
    } else {
      assert.deepEqual(snapA, all, '过滤关：都看得见');
      assert.deepEqual(snapB, all);
      assert.deepEqual(openedIds(out, 'a'), ids([tN1b, tA2b]));
      assert.deepEqual(openedIds(out, 'b'), ids([tN1b, tA2b]));
    }
  }
});

/* ================================================================== V3 */

test('V3 锁从 X 转到 Y（接手）：X 节点收到撤回（hidden / card-locked，按变更前的可见性），Y 节点收到 task.opened，其它节点 0 条；认领者收 lease-lost', t => {
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
    t.diagnostic(`${modeName(on)} 接手这一步 x=${out.of('x').length} 条 y=${out.of('y').length} 条 z=${out.of('z').length} 条`);
    t.diagnostic(`${modeName(on)} x 收到 ${JSON.stringify(summary('x'))}`);
    t.diagnostic(`${modeName(on)} y 收到 ${JSON.stringify(summary('y'))}`);

    const hidden = out.ofType('task.closed').filter(e => e.message.state === 'hidden');
    // tX 被接手作废（F.1：superseded → failed）
    assert.equal(h.task(tX.id).state, 'failed');
    assert.equal(h.task(tX.id).lastError, 'superseded');
    // 认领者照 F.1 收 lease-lost superseded（两种开关一样）
    const lost = out.of('x2', 'task.lease-lost');
    assert.deepEqual(lost.map(m => [m.id, m.token, m.reason]), [[tXc.id, claimedXc.token, 'superseded']], 'x2 恰好一条 lease-lost superseded');
    assert.equal(h.task(tXc.id).state, 'failed');
    // 不带指纹的 tN 不参与锁：谁都收不到关于它的消息
    assert.ok(!out.messages().some(m => (m.id ?? m.task?.id) === tN.id), '不带指纹的任务不受锁变更影响');
    assert.ok(!out.messages().some(m => (m.id ?? m.task?.id) === oX.id), '别的卡不受影响');
    const aboutTXc = m => (m.id ?? m.task?.id) === tXc.id;
    if (on) {
      // tX 是 open：按变更前的可见性，X 指纹的节点（x、x2）收到 hidden / card-locked（I.10 第 2 条），不再另收 failed。
      // 被认领着的 tXc 不是 open，契约只规定认领者的 lease-lost，这里不对别的节点关于它的 task.closed 下断言
      for (const conn of ['x', 'x2']) {
        const rest = out.of(conn).filter(m => !aboutTXc(m) && m.type !== 'task.lease-lost');
        assert.deepEqual(rest.map(m => [m.type, m.id, m.state, m.reason]), [['task.closed', tX.id, 'hidden', 'card-locked']],
          `${conn} 对 tX 恰好一条 hidden 撤回，别的什么都不收`);
        assert.ok(!out.of(conn).some(m => m.type === 'task.opened'), `${conn} 不收补发`);
      }
      assert.deepEqual(out.of('y').map(m => [m.type, m.task?.id]), [['task.opened', tY.id]], 'Y 节点只收到 tY 的补发');
      assert.equal(out.of('z').length, 0, '其它节点 0 条');
    } else {
      assert.equal(hidden.length, 0, '过滤关：没有 hidden');
      assert.equal(out.ofType('task.opened').length, 0, '过滤关：可见性没变，不补发');
      for (const conn of ['x', 'y', 'z']) {
        assert.deepEqual(sorted(closedOf(out, conn).map(m => `${m.id}|${m.state}`)), sorted([`${tX.id}|failed`, `${tXc.id}|failed`]),
          `过滤关：${conn} 照 F.1 收到 tX、tXc 的 failed`);
      }
    }
  }
});

/* ================================================================== V4 */

test('V4 认领指纹不符的任务回 fingerprint-mismatch（I.10 第 4 条）；不带指纹、空指纹、plan 任务不查；过滤关照旧认领', t => {
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
    t.diagnostic(`${modeName(on)} A 节点认领 B 指纹的任务：${outcome}`);
    if (on) {
      const rej = r.one('a', 'task.claim-rejected');
      assert.deepEqual([rej.id, rej.reason, rej.state, rej.version], [tB.id, 'fingerprint-mismatch', 'open', 1]);
      assert.deepEqual([h.task(tB.id).state, h.task(tB.id).version], ['open', 1], '被拒不改状态');
      assert.equal(r.of('e', 'task.taken').length, 0);
    } else {
      assert.equal(outcome, 'claimed', '过滤关：照旧认领');
    }
    // 两种开关都照常认领的
    assert.equal(h.claim('a', tN.id, 1).one('a', 'task.claimed').id, tN.id, '任务不带指纹：不查');
    assert.equal(h.claim('a', tE.id, 1).one('a', 'task.claimed').id, tE.id, '任务的指纹是空串：等同于没带');
    assert.equal(h.claim('a', plan.id, 1).one('a', 'task.claimed').id, plan.id, 'plan 任务不查指纹');
    assert.equal(h.claim('e', tB2.id, 1).one('e', 'task.claimed').id, tB2.id, '节点的指纹是空串：等同于没带');
  }
});

test('V4 补充：fingerprint-mismatch 和 card-locked 一起计入限流', t => {
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
    t.diagnostic(`${modeName(on)}：${JSON.stringify(Object.fromEntries(countBy(reasons)))}，最后两次 ${JSON.stringify(reasons.slice(-2))}`);
    if (on) {
      assert.deepEqual(reasons, [...Array(11).fill('fingerprint-mismatch'), ...Array(10).fill('card-locked'), 'throttled', 'throttled'],
        '两种拒绝合计超过 20 次后回 throttled');
      assert.equal(h.nodeInfo('node-A').throttled, true);
      h.tick();
      assert.equal(h.claim('a', mine.id, 1).one('a', 'task.claimed').id, mine.id, 'tick 之后恢复');
    } else {
      assert.deepEqual(reasons, [...Array(11).fill('claimed'), ...Array(10).fill('card-locked'), 'claimed', 'claimed'], '过滤关：不按指纹拒、不限流');
    }
  }
});

test('V4 补充：会话把 fingerprint-mismatch 当 taken，丢掉这个候选、不重试', () => {
  const s = sessionHarness({ maxConcurrent: 1 });
  const [v0, v1] = [sView('v4s-a'), sView('v4s-b')];
  s.session.receive({ type: 'queue.snapshot', epoch: E, tasks: [v0, v1] });
  const c = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c.length, 1);
  s.session.receive({ type: 'task.claim-rejected', epoch: E, id: c[0].id, reason: 'fingerprint-mismatch', state: 'open', version: 1 });
  assert.ok(!s.session.known().some(v => v.id === c[0].id), '候选被丢掉');
  const next = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(next.length, 1, '在飞已清，立即认领下一个');
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
    assert.ok(reply, '发布应当有回包');
    for (const r of reply.results) assert.equal(r.error, undefined, `发布 ${r.id} 不应出错：${JSON.stringify(r)}`);
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
  for (const m of lockedReplies) assert.equal(m.granted, true, `锁 ${m.lockKey} 应当得到`);

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

test('K1 两种指纹各 4 个节点、200 个任务、一半的卡被另一种指纹锁住：过滤开稳态 card-locked 0 次；过滤关作对照', t => {
  for (const on of MODES) {
    const r = runStorm(on);
    const { stats } = r;
    t.diagnostic(`${modeName(on)} 步数=${r.steps} 认领=${stats.claims} card-locked=${stats.cardLocked} throttled=${stats.throttled} taken=${stats.taken} stale=${stats.stale} 活任务完成=${[...r.doneCount.keys()].length}/${r.live.length}`);

    assert.deepEqual(r.rig.lb.errors(), [], '端点处理器没有抛异常');
    assert.deepEqual(r.rig.lb.nonJson(), [], '每条消息都能 JSON 往返');
    // 活任务全部完成，每个恰好一次 task.done
    assert.deepEqual(sorted([...r.doneCount.keys()]), ids(r.live), `${modeName(on)}：恰好活任务全部完成`);
    for (const [id, c] of r.doneCount) assert.equal(c, 1, `${id} 收到 ${c} 条 task.done`);
    assert.equal(r.rig.failedMsgs().length, 0, '没有任务失败');
    // 死任务（锁在别的指纹上）从没被认领过
    const byId = new Map(r.view.tasks.map(x => [x.id, x]));
    for (const d of r.dead) {
      assert.equal(byId.get(d.id)?.state, 'open', `${d.id} 应当仍是 open`);
      assert.equal(byId.get(d.id)?.version, 1, `${d.id} 从没被认领`);
    }
    for (const n of r.rig.nodes) assert.deepEqual(n.lost, [], `${n.nodeId} 不应丢认领`);

    if (on) {
      assert.equal(stats.cardLocked, 0, '过滤开：稳态下 card-locked 拒绝 0 次');
      assert.ok(stats.cardLocked <= stats.claims * 0.01, '过滤开：竞态窗口内的拒绝不超过认领总数的 1%');
      assert.equal(stats.throttled, 0);
    } else {
      assert.ok(stats.cardLocked > 0, '过滤关：对照组应当出现 card-locked 拒绝（否则场景没有意义）');
      assert.equal(stats.throttled, 0, '过滤关：限流也关');
    }
  }
  const on = runStorm(true).stats, off = runStorm(false).stats;
  t.diagnostic(`对照：card-locked 过滤开 ${on.cardLocked} / 过滤关 ${off.cardLocked}；认领 过滤开 ${on.claims} / 过滤关 ${off.claims}`);
});

/* ================================================================== K2 */

test('K2 同 K1 场景：过滤开时不匹配的节点收到已锁卡任务的 task.opened 0 条；锁定时撤回的恰好是本指纹的死任务', t => {
  for (const on of MODES) {
    const r = runStorm(on);
    t.diagnostic(`${modeName(on)} 锁定后 task.opened 共 ${r.openedTotal} 条，其中给不匹配节点的 ${r.openedMismatch} 条；锁定时 hidden 撤回共 ${r.hiddenTotal} 条`);
    if (on) {
      assert.equal(r.openedMismatch, 0, '过滤开：不匹配的节点收到已锁卡任务的 task.opened 0 条');
      // I.3（新建锁）：锁定前看得见、锁定后看不见的，就是本指纹、锁在别的指纹上的死任务
      for (const n of r.rig.nodes) {
        const expect = ids(r.dead.filter(d => r.info.get(d.id).fp === n.fp));
        assert.deepEqual(r.hiddenAtLock.get(n.connId), expect, `${n.nodeId} 锁定时撤回的应当恰好是本指纹的死任务`);
      }
    } else {
      assert.ok(r.openedMismatch > 0, '过滤关：对照组里不匹配的节点照样收到 task.opened');
      assert.equal(r.hiddenTotal, 0, '过滤关：没有 hidden');
    }
  }
});

/* ================================================================== K3 */

test('K3 运行中把 20 张卡的锁从 X 转到 Y：X 节点只收到这 20 张卡的撤回，Y 节点只收到补发，其它节点 0 条；每个任务恰好一次 task.done', t => {
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
    for (const x of movingX) assert.equal(pre.tasks.find(v => v.id === x.id).state, 'open', `接手前 ${x.id} 应当 open`);
    assert.ok(pre.tasks.some(v => v.state === 'claimed'), '接手时已有任务在跑');

    const m = rig.mark();
    for (const ck of moving) rig.lock(ck, FP_B, true);
    rig.lb.flush();
    const log = rig.since(m).filter(e => e.dir === 'out');
    const toGroup = g => log.filter(e => rig.byConn.get(e.connId)?.group === g);
    const X = toGroup('X'), Y = toGroup('Y'), Z = toGroup('Z');
    t.diagnostic(`${modeName(on)} 接手这一步：X 节点共 ${X.length} 条、Y 节点共 ${Y.length} 条、Z 节点共 ${Z.length} 条`);
    t.diagnostic(`${modeName(on)} X 类型 ${JSON.stringify(Object.fromEntries(countBy(X.map(e => `${e.message.type}:${e.message.state ?? ''}`))))}；Y 类型 ${JSON.stringify(Object.fromEntries(countBy(Y.map(e => `${e.message.type}:${e.message.state ?? ''}`))))}`);

    const locked = rig.pubInbox.filter(x => x.type === 'card.locked' && x.envFingerprint === FP_B && moving.some(ck => x.lockKey === `snapshot:${ck}`));
    assert.equal(locked.length, 20, '20 次接手都有回包');
    for (const x of locked) assert.equal(x.granted, true);

    const movingXIds = ids(movingX), movingYIds = ids(movingY);
    const xNodes = rig.nodes.filter(n => n.group === 'X'), yNodes = rig.nodes.filter(n => n.group === 'Y');
    if (on) {
      for (const n of xNodes) {
        const mine = X.filter(e => e.connId === n.connId).map(e => e.message);
        assert.ok(mine.every(x => x.type === 'task.closed'), `${n.nodeId} 只收到撤回：${JSON.stringify(mine.map(x => x.type))}`);
        assert.deepEqual(sorted(mine.map(x => x.id)), movingXIds, `${n.nodeId} 恰好收到这 20 张卡的撤回，每个任务一条`);
        for (const x of mine) assert.deepEqual([x.state, x.reason], ['hidden', 'card-locked'], `${x.id} 的撤回应当是 hidden / card-locked（I.10 第 2 条）`);
      }
      for (const n of yNodes) {
        const mine = Y.filter(e => e.connId === n.connId).map(e => e.message);
        assert.ok(mine.every(x => x.type === 'task.opened'), `${n.nodeId} 只收到补发：${JSON.stringify(mine.map(x => x.type))}`);
        assert.deepEqual(sorted(mine.map(x => x.task.id)), movingYIds, `${n.nodeId} 恰好收到这 20 张卡的补发`);
      }
      assert.equal(Z.length, 0, '其它节点 0 条');
    } else {
      assert.equal(log.filter(e => e.message.type === 'task.opened').length, 0, '过滤关：不补发');
      assert.equal(log.filter(e => e.message.type === 'task.closed' && e.message.state === 'hidden').length, 0, '过滤关：没有 hidden');
      for (const n of rig.nodes) {
        const mine = log.filter(e => e.connId === n.connId).map(e => e.message);
        assert.deepEqual(sorted(mine.map(x => `${x.type}:${x.id}:${x.state}`)), movingXIds.map(id => `task.closed:${id}:failed`),
          `过滤关：${n.nodeId} 照 F.1 收到作废任务的 failed`);
      }
    }

    // 跑到完成：两张稳定卡组与转移后的 Y 任务各恰好一次 task.done；X 的转移任务作废
    const expectDone = [...sX, ...sY, ...movingY];
    const steps = rig.runUntil(ids(expectDone));
    const done = countBy(rig.doneIds());
    t.diagnostic(`${modeName(on)} 跑完步数=${steps} task.done=${rig.doneIds().length} task.failed=${rig.failedMsgs().length}`);
    assert.deepEqual(rig.lb.errors(), []);
    assert.deepEqual(sorted([...done.keys()]), ids(expectDone), `${modeName(on)}：完成的恰好是预期的任务`);
    for (const [id, c] of done) assert.equal(c, 1, `${id} 收到 ${c} 条 task.done`);
    const failed = countBy(rig.failedMsgs().map(x => x.id));
    assert.deepEqual(sorted([...failed.keys()]), movingXIds, '作废的恰好是 X 的转移任务');
    for (const x of rig.failedMsgs()) assert.equal(x.error, 'superseded');
    for (const [id, c] of failed) assert.equal(c, 1, `${id} 收到 ${c} 条 task.failed`);
    // 转移后的 Y 任务只由 Y 节点做
    const doneBy = new Map(rig.nodes.flatMap(n => n.completed.map(id => [id, n.group])));
    for (const id of movingYIds) assert.equal(doneBy.get(id), 'Y', `${id} 应当由 Y 节点完成`);
    const stats = claimStats(rig.since(m));
    t.diagnostic(`${modeName(on)} 接手之后：认领=${stats.claims} card-locked=${stats.cardLocked}`);
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

test('K4 一个节点无视过滤反复认领已锁卡：超过 20 次拒绝后回 throttled，其它节点不受影响；下一次 tick() 后恢复', t => {
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
    t.diagnostic(`${modeName(on)} rogue 30 次认领：${JSON.stringify(counts)}；describe：cardLockedRejects=${info?.cardLockedRejects} throttled=${info?.throttled}`);
    assert.equal(h.describe().prefilter, on, 'describe().prefilter');
    assert.equal(h.task(dead.id).version, 1, '死任务版本不变');

    if (on) {
      assert.deepEqual(reasons, [...Array(21).fill('card-locked'), ...Array(9).fill('throttled')],
        '过滤开：前 21 次（第 21 次使计数超过 20）是 card-locked，之后一律 throttled');
      assert.equal(info.cardLockedRejects, 21);
      assert.equal(info.throttled, true);

      // 限流期间：认领可认领的任务也回 throttled，不看任务状态、不改状态；不存在的任务同样 throttled
      const r1 = rejectOf(h.claim('rogue', liveA[0].id, 1), 'rogue');
      assert.deepEqual([r1.id, r1.reason], [liveA[0].id, 'throttled']);
      assert.equal(h.task(liveA[0].id).state, 'open');
      assert.equal(h.task(liveA[0].id).version, 1);
      const gone = rejectOf(h.claim('rogue', 'snapshot:nope:0-59', 1), 'rogue');
      assert.deepEqual([gone.id, gone.reason], ['snapshot:nope:0-59', 'throttled']);
      assert.equal(connInfo(h, 'node-rogue').cardLockedRejects, 21, 'throttled 不计入 card-locked 计数');

      // 其它节点不受影响：同一周期里照常认领；它自己的 card-locked 单独计数
      const a2 = h.claim('a2', liveA[1].id, 1);
      assert.equal(a2.one('a2', 'task.claimed').id, liveA[1].id);
      assert.equal(rejectOf(h.claim('a2', dead.id, 1), 'a2').reason, 'card-locked');
      assert.equal(h.claim('b', liveB[0].id, 1).one('b', 'task.claimed').id, liveB[0].id);
      assert.deepEqual([connInfo(h, 'node-a2').cardLockedRejects, connInfo(h, 'node-a2').throttled], [1, false]);
      assert.deepEqual([connInfo(h, 'node-b').cardLockedRejects, connInfo(h, 'node-b').throttled], [0, false]);

      // 下一次 tick() 后恢复
      h.tick();
      assert.deepEqual([connInfo(h, 'node-rogue').cardLockedRejects, connInfo(h, 'node-rogue').throttled], [0, false], 'tick() 清零');
      assert.deepEqual([connInfo(h, 'node-a2').cardLockedRejects, connInfo(h, 'node-a2').throttled], [0, false]);
      assert.equal(h.claim('rogue', liveA[0].id, 1).one('rogue', 'task.claimed').id, liveA[0].id, 'tick 之后 rogue 恢复认领');
      assert.equal(rejectOf(h.claim('rogue', dead.id, 1), 'rogue').reason, 'card-locked', 'tick 之后重新计数');
      assert.equal(connInfo(h, 'node-rogue').cardLockedRejects, 1);
    } else {
      assert.deepEqual(reasons, Array(30).fill('card-locked'), '过滤关：限流也关，全是 card-locked');
      assert.equal(info.throttled, false);
      assert.equal(h.claim('rogue', liveA[0].id, 1).one('rogue', 'task.claimed').id, liveA[0].id);
    }
  }
});

test('K4 补充：阈值取 constants.THROTTLE_REJECTS', t => {
  const { h, dead, liveA } = k4Setup(true, { THROTTLE_REJECTS: 3 });
  const reasons = Array.from({ length: 6 }, () => rejectOf(h.claim('rogue', dead.id, 1), 'rogue').reason);
  t.diagnostic(`THROTTLE_REJECTS=3：${JSON.stringify(reasons)}`);
  assert.deepEqual(reasons, ['card-locked', 'card-locked', 'card-locked', 'card-locked', 'throttled', 'throttled']);
  assert.equal(rejectOf(h.claim('rogue', liveA[0].id, 1), 'rogue').reason, 'throttled');
  h.tick();
  assert.equal(h.claim('rogue', liveA[0].id, 1).one('rogue', 'task.claimed').id, liveA[0].id);
});

/* ================================================================== K5 */

test('K5 过滤关：describe().prefilter === false，锁的新建、接手、不带指纹的任务都不产生 hidden 消息', t => {
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
  t.diagnostic(`过滤关：全部 ${all.count} 条消息里 hidden ${hidden.length} 条`);
  assert.equal(hidden.length, 0, '过滤关：没有 hidden 消息');
  assert.equal(all.ofType('task.claim-rejected').filter(e => e.message.reason === 'throttled').length, 0);
  // 过滤关：新连上的 A 节点看得见全部 open 任务（B 指纹的、锁在 B 上的都在）
  const openIds = h.describe().tasks.filter(x => x.state === 'open').map(x => x.id).sort();
  assert.deepEqual(snapA, openIds);
});

test('K5 常量与诊断（I.1、I.7）：PREFILTER 缺省开、THROTTLE_REJECTS 20、环境变量名；describe 的新字段', t => {
  const { QUEUE_DEFAULTS, QUEUE_ENV } = queueIndex;
  assert.equal(QUEUE_DEFAULTS.PREFILTER, true);
  assert.equal(QUEUE_DEFAULTS.THROTTLE_REJECTS, 20);
  assert.equal(QUEUE_ENV.PREFILTER, 'PROMPTCUT_QUEUE_PREFILTER');
  assert.equal(QUEUE_ENV.THROTTLE_REJECTS, 'PROMPTCUT_QUEUE_THROTTLE_REJECTS');

  const h = createQueueHarness(createRenderQueue);   // 不给 constants：缺省开
  joinNode(h, 'a', 'node-A', FP_A);
  const d = h.describe();
  t.diagnostic(`缺省 describe().prefilter=${d.prefilter}；nodes[0]=${JSON.stringify(d.nodes[0])}`);
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
  assert.equal(c1.length, 1, '第二个认领发出');
  const candidate = c1[0].id;
  s.session.receive({ type: 'task.claim-rejected', epoch: E, id: candidate, reason: 'throttled' });
  const throttledAt = s.now;
  assert.ok(s.session.known().some(v => v.id === candidate), 'throttled 的候选不从本地视图里删');

  // 退避期间：续约照发，不发认领
  s.set(heldAt + RENEW);
  assert.ok(s.now < throttledAt + sweep, '场景自检：续约到期时仍在退避期内');
  const during = s.tick();
  t.diagnostic(`SWEEP=${sweep} 退避中 t=+${s.now - throttledAt}：${JSON.stringify(types(during))}`);
  assert.deepEqual(types(during), ['task.progress'], '退避期间续约照发、不认领');
  assert.equal(during[0].id, first.id);
  s.set(throttledAt + sweep - 1);
  const edge = s.tick();
  t.diagnostic(`SWEEP=${sweep} t=+${sweep - 1}：${JSON.stringify(types(edge))}`);
  assert.equal(edge.filter(m => m.type === 'task.claim').length, 0, 'SWEEP_INTERVAL_MS 之内不认领');

  s.set(throttledAt + sweep);
  const after = s.tick();
  t.diagnostic(`SWEEP=${sweep} t=+${sweep}：${JSON.stringify(types(after))}`);
  const claims = after.filter(m => m.type === 'task.claim');
  assert.equal(claims.length, 1, '过了 SWEEP_INTERVAL_MS 恢复认领（在飞的认领已被清掉）');
  assert.ok([v0, v1, v2].some(v => v.id === claims[0].id) && claims[0].id !== first.id);
}

test('K6 会话：throttled 之后，在 SWEEP_INTERVAL_MS 内 tick() 不发认领，续约照发；过后恢复', t => {
  k6Run(t, sessionHarness(), SWEEP);
});

test('K6 补充：退避时长取 constants.SWEEP_INTERVAL_MS', t => {
  k6Run(t, sessionHarness({ constants: { SWEEP_INTERVAL_MS: 2_000 } }), 2_000);
});

test('K6 补充：task.closed { state: hidden } 和别的 task.closed 一样从本地视图移除', () => {
  const s = sessionHarness();
  const [v0, v1] = [sView('k6h-a'), sView('k6h-b')];
  s.session.receive({ type: 'queue.snapshot', epoch: E, tasks: [v0, v1] });
  s.session.receive({ type: 'task.closed', epoch: E, id: v0.id, state: 'hidden', reason: 'card-locked' });
  assert.deepEqual(s.session.known().map(v => v.id), [v1.id]);
  const claims = s.tick().filter(m => m.type === 'task.claim');
  assert.deepEqual(claims.map(m => m.id), [v1.id], '被撤回的任务不再认领');
});

test('K6 补充：start() 清掉 throttledUntil（I.10 第 6 条）', () => {
  const s = sessionHarness();
  const v0 = sView('k6s-a');
  s.session.receive({ type: 'queue.snapshot', epoch: E, tasks: [v0] });
  const c = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c.length, 1);
  s.session.receive({ type: 'task.claim-rejected', epoch: E, id: v0.id, reason: 'throttled' });
  assert.equal(s.tick().filter(m => m.type === 'task.claim').length, 0, '退避中');
  s.session.start();
  s.session.receive({ type: 'queue.snapshot', epoch: E, tasks: [v0] });
  assert.equal(s.tick().filter(m => m.type === 'task.claim').length, 1, 'start() 之后不再退避');
});

/* ================================================================== K7 */

test('K7 会话收到带 reqId 的 error 不清在飞的认领；不带 reqId 的照清（I.10 第 5 条）', () => {
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
  assert.equal(s.tick().filter(m => m.type === 'task.claim').length, 0, '带 reqId 的 error 之后认领仍在飞，不发第二条');
  s.session.receive(claimedMsg(first, 2, s.now));
  assert.deepEqual(started, [first.id], '认领回包照常处理');
  assert.deepEqual(s.session.held().map(x => x.id), [first.id]);

  // 不带 reqId 的 error：照清在飞
  const c2 = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c2.length, 1, '第二个认领发出（maxConcurrent 2）');
  s.session.receive({ type: 'error', epoch: E, reason: 'bad-message', detail: 'y' });
  const c3 = s.tick().filter(m => m.type === 'task.claim');
  assert.equal(c3.length, 1, '不带 reqId 的 error 清掉在飞，下一次 tick 重新认领');
});
