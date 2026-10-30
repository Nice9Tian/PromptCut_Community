/**
 * M8 规模复测探针 `scripts/probes/m8-scale-probe.mjs` 的纯逻辑（计划 `docs/plan/m8-plan.md` 第 2.2 节 K1-X、I1-X）：
 * 任务表、节点账本、K1 / K2 / I1 / I2 判据、D4 对照组的加载钩子。不起网络（钩子那条起一个 node 子进程）。
 * 跑：node --test server/test/m8-scale.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FP, resolveFingerprint, k1Plan, k1CardsOf, createK1Ledger, judgeK1, parseRange, i1ProjectId, i1SpaceOf, i1Tasks, i1ProjectOfId,
  createI1Ledger, sumPerTask, judgeI1, judgeI2, writePrefilterOffHook,
} from '../../scripts/probes/m8-scale-probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('M8S-1 resolveFingerprint：X / Y 取两种测试指纹，16 位十六进制原样，其余回 null', () => {
  assert.match(FP.X, /^[0-9a-f]{16}$/);
  assert.notEqual(FP.X, FP.Y);
  assert.equal(resolveFingerprint('X'), FP.X);
  assert.equal(resolveFingerprint('Y'), FP.Y);
  assert.equal(resolveFingerprint('0123456789abcdef'), '0123456789abcdef');
  assert.equal(resolveFingerprint('Z'), null);
  assert.equal(resolveFingerprint('0123456789ABCDEF'), null);
  assert.equal(resolveFingerprint(null), null);
});

test('M8S-2 k1Plan：20 张卡 × 2 指纹 × 5 段 = 200；一半死一半活；每个节点看来一半的卡锁在别的指纹上', () => {
  const p = k1Plan({ run: 'r1', queueProject: 'q', cards: 20, segments: 5 });
  assert.equal(p.tasks.length, 200);
  assert.equal(p.dead.length, 100);
  assert.equal(p.live.length, 100);
  assert.equal(p.locks.length, 20);
  assert.equal(p.locks.filter((l) => l.fp === FP.X).length, 10);
  assert.equal(new Set(p.tasks.map((t) => t.id)).size, 200, '任务 id 不重复');
  for (const t of p.tasks) {
    const i = p.info[t.id];
    assert.equal(t.requires.envFingerprint, i.fp);
    assert.equal(i.dead, i.fp !== i.lockFp);
    assert.match(t.id, /^snapshot:m8sc-r1-k1-c\d\d-[XY]:\d+-\d+$/);
    assert.equal(t.input.contentKey, p.locks[i.card].contentKey, '锁键来自 input.contentKey');
    assert.equal(t.source.projectId, 'q');
  }
  // 每种指纹的节点：本指纹的死任务 50 个（它锁定前能看见、锁定后应被撤回），活任务 50 个
  for (const fp of [FP.X, FP.Y]) {
    assert.equal(p.dead.filter((id) => p.info[id].fp === fp).length, 50);
    assert.equal(p.live.filter((id) => p.info[id].fp === fp).length, 50);
  }
  assert.equal(k1CardsOf(200, 5), 20);
  assert.throws(() => k1CardsOf(190, 5), RangeError);
  assert.throws(() => k1Plan({ run: 'r', queueProject: 'q', cards: 3 }), RangeError);
});

/** 用 k1Plan 的一张卡造消息 */
function k1Fixture() {
  const p = k1Plan({ run: 'r', queueProject: 'q', cards: 2, segments: 2 });
  // 卡 0 锁 X、卡 1 锁 Y
  const deadX = p.dead.filter((id) => p.info[id].fp === FP.X);   // 卡 1 的 X 段（锁在 Y 上）
  const deadY = p.dead.filter((id) => p.info[id].fp === FP.Y);   // 卡 0 的 Y 段（锁在 X 上）
  const liveX = p.live.filter((id) => p.info[id].fp === FP.X);
  const liveY = p.live.filter((id) => p.info[id].fp === FP.Y);
  return { p, deadX, deadY, liveX, liveY };
}
const opened = (id) => ({ type: 'task.opened', task: { id } });

test('M8S-3 K1 账本（过滤开的样子）：死任务先可见、锁定时撤回不算 K2；收到第一条活任务之前的拒绝记竞态窗口，之后记稳态', () => {
  const { p, deadX, liveX } = k1Fixture();
  const L = createK1Ledger({ name: 'n', nodeFp: FP.X, info: p.info });
  L.onMessage({ type: 'queue.snapshot', tasks: [] });
  for (const id of deadX) L.onMessage(opened(id));
  L.onMessage({ type: 'task.claim-rejected', id: deadX[0], reason: 'card-locked' });   // 竞态窗口
  for (const id of deadX) L.onMessage({ type: 'task.closed', id, state: 'hidden', reason: 'card-locked' });
  for (const id of liveX) L.onMessage(opened(id));
  for (const id of liveX) L.onMessage({ type: 'task.claimed', id });
  L.onMessage({ type: 'task.claim-rejected', id: liveX[0], reason: 'taken' });           // 稳态，但不是 card-locked
  const t = L.tally();
  assert.equal(t.openedMismatch, 0);
  assert.equal(t.cardLockedRace, 1);
  assert.equal(t.cardLockedSteady, 0);
  assert.equal(t.claims, liveX.length + 2);
  assert.equal(t.claimed, liveX.length);
  assert.equal(t.hidden, deadX.length);
  assert.equal(t.hiddenUnexpectedCount, 0);
  assert.equal(t.deadClaimed, 0);
  assert.deepEqual(t.rejected.steady, { taken: 1 });
  assert.equal(t.sawSteady, true);
});

test('M8S-4 K1 账本（过滤关的样子）：看得见别的指纹的活任务算 K2；稳态的 card-locked、撤回后再可见、认领到死任务都记下', () => {
  const { p, deadX, liveX, liveY } = k1Fixture();
  const L = createK1Ledger({ name: 'n', nodeFp: FP.X, info: p.info });
  for (const id of deadX) L.onMessage(opened(id));
  for (const id of [...liveX, ...liveY]) L.onMessage(opened(id));   // 过滤关：Y 的活任务也收到（锁在 Y 上，与本节点不符）
  L.onMessage({ type: 'task.claim-rejected', id: deadX[0], reason: 'card-locked' });
  L.onMessage({ type: 'task.claim-rejected', id: deadX[1], reason: 'card-locked' });
  let t = L.tally();
  assert.equal(t.openedMismatch, liveY.length);
  assert.equal(t.cardLockedSteady, 2);
  // 撤回后再可见（例如重连的 snapshot）算 K2；第二次可见也算
  L.onMessage({ type: 'task.closed', id: deadX[0], state: 'hidden' });
  L.onMessage({ type: 'queue.snapshot', tasks: [{ id: deadX[0] }, { id: deadX[1] }] });
  L.onMessage({ type: 'task.claimed', id: deadX[1] });
  L.onMessage({ type: 'task.closed', id: liveY[0], state: 'hidden' });   // 不该撤回的
  t = L.tally();
  assert.equal(t.openedMismatch, liveY.length + 2);
  assert.equal(t.deadClaimed, 1);
  assert.equal(t.hiddenUnexpectedCount, 1);
});

test('M8S-5 judgeK1：过滤开要求稳态 0、竞态 ≤ 节点数（lock-first 要 0）、K2 0；过滤关要求拒绝与 K2 都 > 0（对照组）；死任务两种模式都不许被认领', () => {
  const base = { claims: 200, claimed: 100, cardLockedRace: 0, cardLockedSteady: 0, openedMismatch: 0, hidden: 50, hiddenUnexpectedCount: 0, deadClaimed: 0 };
  let v = judgeK1({ prefilter: true, tallies: [base, base] });
  assert.equal(v.k1.ok, true);
  assert.equal(v.k2.ok, true);
  assert.equal(v.deadNeverClaimed.ok, true);
  assert.equal(v.totals.claims, 400);
  v = judgeK1({ prefilter: true, tallies: [{ ...base, cardLockedRace: 1, raceWindowMsMax: 3, raceWindowMs: 26 }, { ...base, cardLockedRace: 1 }] });
  assert.equal(v.k1.ok, true, '2 ≤ 2 个节点');
  assert.equal(v.k1.raceLimit, 2);
  assert.equal(v.k1.raceWindowMsMax, 26, '窗口时长只记录');
  v = judgeK1({ prefilter: true, tallies: [{ ...base, cardLockedRace: 2 }, { ...base, cardLockedRace: 1 }] });
  assert.equal(v.k1.ok, false, '3 > 2 个节点');
  v = judgeK1({ prefilter: true, tallies: [{ ...base, cardLockedRace: 1 }, base], order: 'lock-first' });
  assert.equal(v.k1.ok, false, 'lock-first 竞态也要 0');
  assert.equal(judgeK1({ prefilter: true, tallies: [base, base], order: 'lock-first' }).k1.ok, true);
  v = judgeK1({ prefilter: true, tallies: [{ ...base, cardLockedSteady: 1 }, base] });
  assert.equal(v.k1.ok, false, '稳态一次也不许');
  v = judgeK1({ prefilter: true, tallies: [{ ...base, openedMismatch: 1 }] });
  assert.equal(v.k2.ok, false);
  v = judgeK1({ prefilter: false, tallies: [{ ...base, cardLockedSteady: 200, openedMismatch: 50 }, { ...base, cardLockedRace: 200, openedMismatch: 50 }] });
  assert.equal(v.k1.ok, true);
  assert.equal(v.k1.cardLocked, 400);
  assert.equal(v.k2.ok, true);
  v = judgeK1({ prefilter: false, tallies: [base] });
  assert.equal(v.k1.ok, false, '对照组没有拒绝说明场景没起作用');
  v = judgeK1({ prefilter: false, tallies: [{ ...base, cardLockedSteady: 1, openedMismatch: 1, deadClaimed: 1 }] });
  assert.equal(v.deadNeverClaimed.ok, false);
  assert.equal(judgeK1({ prefilter: true, tallies: [] }).k1.ok, false, '没有节点不算过');
});

test('M8S-6 parseRange、i1ProjectId、i1SpaceOf、i1Tasks、i1ProjectOfId', () => {
  assert.deepEqual(parseRange('1-10'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(parseRange('3'), [3]);
  assert.deepEqual(parseRange('1-2, 5-6,2'), [1, 2, 5, 6]);
  for (const bad of ['', '0-3', '5-2', 'a', '1-']) assert.throws(() => parseRange(bad), RangeError, bad);
  assert.equal(i1ProjectId(1), 'i1p01');
  assert.equal(i1ProjectId(20), 'i1p20');
  assert.deepEqual([1, 2, 3, 4].map((k) => i1SpaceOf(k, 2)), [0, 1, 0, 1]);
  assert.deepEqual([1, 2, 3].map((k) => i1SpaceOf(k, 1)), [0, 0, 0]);
  const tasks = i1Tasks({ run: 'r9', projectId: 'i1p01', count: 3 });
  assert.equal(tasks.length, 3);
  assert.equal(new Set(tasks.map((t) => t.id)).size, 3);
  for (const t of tasks) {
    assert.equal(t.source.projectId, 'i1p01');
    assert.equal(i1ProjectOfId(t.id), 'i1p01');
  }
  assert.equal(i1ProjectOfId('snapshot:whatever:0-59'), null);
  assert.equal(i1ProjectOfId('garbage'), null);
});

test('M8S-7 I1 账本：A 节点逐任务记 opened / taken / closed(done)；非 A 节点收到任何 A 的消息都算 foreign', () => {
  const [t1, t2] = i1Tasks({ run: 'r', projectId: 'i1p01', count: 2 });
  const A = createI1Ledger({ name: 'a', own: 'i1p01', aProject: 'i1p01' });
  const B = createI1Ledger({ name: 'b', own: 'i1p02', aProject: 'i1p01' });
  for (const L of [A]) {
    L.onMessage({ type: 'queue.snapshot', tasks: [] });
    L.onMessage({ type: 'task.opened', task: t1 });
    L.onMessage({ type: 'task.taken', id: t1.id, version: 2 });
    L.onMessage({ type: 'task.closed', id: t1.id, state: 'done' });
    L.onMessage({ type: 'task.closed', id: t2.id, state: 'done' });   // opened / taken 被合并掉了
    L.onMessage({ type: 'task.claimed', id: t1.id });                 // 不是增量，不计
  }
  const a = A.tally();
  assert.equal(a.isA, true);
  assert.equal(a.foreign, 0);
  assert.equal(a.taskMsgs, 4);
  assert.deepEqual(a.perTask, { [t1.id]: [1, 1, 1], [t2.id]: [0, 0, 1] });
  B.onMessage({ type: 'task.closed', id: t1.id, state: 'done' });
  B.onMessage({ type: 'queue.snapshot', tasks: [{ id: t2.id, source: { projectId: 'i1p01' } }] });
  const b = B.tally();
  assert.equal(b.isA, false);
  assert.equal(b.foreign, 2);
  assert.deepEqual(b.foreignByType, { 'task.closed': 1, snapshot: 1 });
  assert.equal(b.perTask, undefined);
  assert.deepEqual(sumPerTask([a.perTask, { [t1.id]: [1, 0, 1] }, undefined]), { [t1.id]: [2, 1, 2], [t2.id]: [0, 0, 1] });
});

test('M8S-8 judgeI1：只要有 foreign 或非 A 节点收到任务消息就不过；没有非 A 节点也不算过', () => {
  const nodes = [
    { name: 'a0', own: 'i1p01', isA: true, taskMsgs: 1500, foreign: 0 },
    { name: 'b0', own: 'i1p02', isA: false, taskMsgs: 0, foreign: 0 },
  ];
  assert.equal(judgeI1(nodes, { aProject: 'i1p01' }).ok, true);
  assert.equal(judgeI1([{ ...nodes[0] }, { ...nodes[1], taskMsgs: 1, foreign: 1 }], { aProject: 'i1p01' }).ok, false);
  assert.equal(judgeI1([{ ...nodes[0], foreign: 1 }, nodes[1]], { aProject: 'i1p01' }).ok, false);
  assert.equal(judgeI1([nodes[0]], { aProject: 'i1p01' }).ok, false);
  const bad = judgeI1([nodes[0], { ...nodes[1], taskMsgs: 3 }], { aProject: 'i1p01' });
  assert.equal(bad.nonATaskMsgs, 3);
  assert.equal(bad.offenders[0].name, 'b0');
});

test('M8S-9 judgeI2：closed(done) 每任务恰好 = 连接数；opened、taken 少了只记合并偏差，多了不过', () => {
  const ids = ['t1', 't2'];
  assert.equal(judgeI2({ ids, perTask: { t1: [10, 9, 10], t2: [10, 9, 10] }, watchers: 10 }).ok, true);
  const coalesced = judgeI2({ ids, perTask: { t1: [8, 7, 10], t2: [10, 9, 10] }, watchers: 10 });
  assert.equal(coalesced.ok, true);
  assert.deepEqual(coalesced.coalesced, { openedShort: 2, takenShort: 2 });
  assert.equal(judgeI2({ ids, perTask: { t1: [10, 9, 9], t2: [10, 9, 10] }, watchers: 10 }).ok, false, '少一次 closed');
  assert.equal(judgeI2({ ids, perTask: { t1: [10, 9, 11], t2: [10, 9, 10] }, watchers: 10 }).ok, false, '多一次 closed');
  assert.equal(judgeI2({ ids, perTask: { t1: [11, 9, 10], t2: [10, 9, 10] }, watchers: 10 }).ok, false, '多一次 opened');
  assert.equal(judgeI2({ ids, perTask: { t1: [10, 10, 10], t2: [10, 9, 10] }, watchers: 10 }).ok, false, '认领者自己不该收 taken');
  assert.equal(judgeI2({ ids, perTask: { t1: [10, 9, 10] }, watchers: 10 }).ok, false, '缺一个任务');
  assert.equal(judgeI2({ ids: [], perTask: {}, watchers: 10 }).ok, false);
});

test('M8S-10 D4 加载钩子：挂上之后 constants.mjs 的 PREFILTER 缺省值变 false、打出凭证行；不挂时仍是 true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm8s-hook-'));
  try {
    const opt = writePrefilterOffHook(dir);
    const url = pathToFileURL(path.join(ROOT, 'server', 'render-queue', 'constants.mjs')).href;
    const code = `import(${JSON.stringify(url)}).then((m) => console.log(JSON.stringify({ prefilter: m.QUEUE_DEFAULTS.PREFILTER, lease: m.QUEUE_DEFAULTS.LEASE_MS })))`;
    const on = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    assert.equal(on.status, 0, on.stderr);
    assert.deepEqual(JSON.parse(on.stdout.trim()), { prefilter: true, lease: 30_000 });
    const off = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: opt } });
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(JSON.parse(off.stdout.trim()), { prefilter: false, lease: 30_000 }, '只改 PREFILTER');
    assert.match(off.stderr, /m8scale\.prefilter-off/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
