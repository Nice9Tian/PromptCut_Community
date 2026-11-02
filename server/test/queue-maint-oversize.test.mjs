/**
 * 任务 E（`claude/queue-maint`）：执行器按本机快照库的超限记录标 `snapshotOversize`，切分据此不给纯浏览器另出一份。
 * 出处：`docs/archive/agent-reports/AGENT-rq-m7-node.md`「没做成的」第 3 条、`REPORT-M7.md` 第 11 节第 2 行。
 *
 *   QM-E-01 本机快照库里这张卡（本机指纹的键）记过超限帧：执行器交给切分的 control 标上，切分只出切分方那一份；
 *           没有记录的卡照旧出两份（切分方 + 浏览器）
 *   QM-E-02 超限记录在锁定方指纹的键下（这张卡锁在别的环境上，本机拉过它的结果）同样标
 *   QM-E-03 标在整张卡上：只有一帧超限，整张卡的每一段都不给浏览器
 *   QM-E-04 不标的情形：本地档、画布卡（切分本来不给浏览器）、读不到快照库（测试替身、库坏了）—— cardPlan 原样（同一个数组）
 *   QM-E-05 每次切分现读、不改缓存：同一版项目先切一次（没记录）、本机渲出超限帧后再切一次就标上；缓存里的 control 不变
 *   QM-E-06 跨机器：记录只在本机快照库里。另一台没渲过、没拉过这张卡的切分方不标，浏览器照旧拿到一份；
 *           那台一旦拉回这张卡的结果（落盘走同一个写入口，超限照样判出来记下），下一次切分就标
 *
 * 跑：node --test server/test/queue-maint-oversize.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrerenderExecutor, markSnapshotOversize } from '../prerender-executor.mjs';
import { SnapshotStore, DOM_SNAPSHOT_LIMIT } from '../snapshot-store.mjs';
import { splitPlan, planTaskOf } from '../render-node/split.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const rk = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);
const P = 'pppppppppppppppp';   // 切分方（本机）
const B = 'bbbbbbbbbbbbbbbb';   // 浏览器
const X = 'xxxxxxxxxxxxxxxx';   // 锁定方（第三种环境）
const CV = 'c0de5a';
const SMALL = '<div>ok</div>';
const BIG = `<div>${'x'.repeat(DOM_SNAPSHOT_LIMIT + 16)}</div>`;

function control(clipId, { tier = 'shared', canvasHeavy = false, count = 120 } = {}) {
  const contentKey = `ck-${clipId}`;
  return {
    key: `png-${clipId}`, snapshotKey: rk(contentKey, P), contentKey, tier, clipId, cardId: 'punch-pill', nodeId: `n:${clipId}`,
    capabilities: { frameMode: 'stateful', compositing: 'independent', ...(canvasHeavy ? { canvasHeavy: true } : {}) },
    start: 0, end: count / 30, count, compositing: 'independent', envFingerprint: P,
    sampling: { firstFrame: 0, fps: { numerator: 30, denominator: 1 }, phase: { numerator: 0, denominator: 1 } },
  };
}

async function tempStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qm-oversize-'));
  return { store: new SnapshotStore(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
/** 本机快照库里给这个键落几帧（走生产的唯一写入口：写文件 → 判体积 → 并 index） */
const commit = (store, key, frames) => store.commitSnapshots({ tier: 'shared', key, clipId: 'c', capabilities: {}, items: frames.map(([localFrame, html]) => ({ localFrame, html })) });

/** 假管线：planForQueue 回固定上下文；快照库是真的 SnapshotStore */
function executorOver(store, cardPlan, { cardLocks } = {}) {
  const entry = { key: 'entry-1', cardPlan };
  let plans = 0;
  const pipeline = {
    planForQueue: async () => { plans++; return { entry, context: { entryKey: 'entry-1', cardPlan, ...(cardLocks ? { cardLocks } : {}) } }; },
    snapshots: () => store,
    queueHandles: () => true,
  };
  const exec = createPrerenderExecutor({ pipeline, projects: { get: async () => ({ tracks: [], duration: 4 }) } });
  return { exec, plans: () => plans };
}
const PLAN = planTaskOf({ projectId: 'proj-e', projectRev: 3 });
const split = (ctx) => splitPlan({
  ...ctx, planTask: PLAN, envFingerprint: P, codeVersion: CV, weightOf: () => ({ class: 'medium', estMs: null }), browserFingerprints: [B],
});
const fpsOf = (tasks, clipId) => [...new Set(tasks.filter((t) => t.input.clipId === clipId).map((t) => t.requires.envFingerprint))].sort();

test('QM-E-01 a card for which the local snapshot store has recorded an oversize frame is marked snapshotOversize, and splitting does not hand it to the browser; a card with no record is handed over as before', async () => {
  const { store, cleanup } = await tempStore();
  try {
    const a = control('a'), b = control('b');
    const idx = await commit(store, a.snapshotKey, [[0, SMALL], [1, BIG]]);
    assert.deepEqual(idx.oversize, [[1, 1]], 'fixture: frame 1 of a is oversize, recorded into oversize in index.json');
    await commit(store, b.snapshotKey, [[0, SMALL], [1, SMALL]]);
    const { exec } = executorOver(store, [a, b]);
    const ctx = await exec.plan(PLAN);
    assert.equal(ctx.cardPlan.find((c) => c.clipId === 'a').snapshotOversize, true);
    assert.equal('snapshotOversize' in ctx.cardPlan.find((c) => c.clipId === 'b'), false);
    const tasks = split(ctx);
    assert.deepEqual(fpsOf(tasks, 'a'), [P], 'a yields only the copy for the splitter');
    assert.deepEqual(fpsOf(tasks, 'b'), [B, P].sort(), 'b still has two copies');
    assert.ok(tasks.filter((t) => t.input.clipId === 'a').every((t) => !('dual' in t.input) && !('bake' in t.input)));
  } finally { await cleanup(); }
});

test('QM-E-02 an oversize record under the key of the lock holder fingerprint (the card is locked on another environment, and this machine has pulled its result) is marked all the same', async () => {
  const { store, cleanup } = await tempStore();
  try {
    const a = control('a');
    await commit(store, rk('ck-a', X), [[5, BIG]]);
    const lockKey = 'snapshot:ck-a';
    const { exec } = executorOver(store, [a], { cardLocks: new Map([[lockKey, X]]) });
    const ctx = await exec.plan(PLAN);
    assert.equal(ctx.cardPlan[0].snapshotOversize, true);
    // 普通对象形式的 cardLocks 一样认；锁在本机指纹上时只看本机的键
    const plain = await markSnapshotOversize({ snapshots: () => store }, { cardPlan: [a], cardLocks: { [lockKey]: X } });
    assert.deepEqual(plain.marked, ['a']);
    const own = await markSnapshotOversize({ snapshots: () => store }, { cardPlan: [a], cardLocks: { [lockKey]: P } });
    assert.deepEqual(own.marked, []);
  } finally { await cleanup(); }
});

test('QM-E-03 marked on the whole card: 120 frames in two segments, only frame 90 is oversize, and neither segment is given to the browser', async () => {
  const { store, cleanup } = await tempStore();
  try {
    const a = control('a', { count: 120 });
    await commit(store, a.snapshotKey, [[0, SMALL], [90, BIG]]);
    const { exec } = executorOver(store, [a]);
    const tasks = split(await exec.plan(PLAN));
    assert.deepEqual(tasks.map((t) => [t.range.from, t.requires.envFingerprint]), [[0, P], [60, P]]);
  } finally { await cleanup(); }
});

test('QM-E-04 cases that are not marked: local tier, canvas card, snapshot store unreadable; cardPlan is returned as is (the same array)', async () => {
  const { store, cleanup } = await tempStore();
  try {
    const local = control('l', { tier: 'local' }), canvas = control('c', { canvasHeavy: true });
    await commit(store, local.snapshotKey, [[0, BIG]]);
    await commit(store, canvas.snapshotKey, [[0, BIG]]);
    const ctx = { cardPlan: [local, canvas] };
    const r = await markSnapshotOversize({ snapshots: () => store }, ctx);
    assert.equal(r.cardPlan, ctx.cardPlan);
    assert.deepEqual(r.marked, []);
    for (const pipeline of [{}, { snapshots: () => null }, { snapshots: () => { throw new Error('the store is broken'); } },
      { snapshots: () => ({ snapshotIndex: async () => { throw new Error('cannot be read'); } }) }]) {
      const c2 = { cardPlan: [control('a')] };
      const out = await markSnapshotOversize(pipeline, c2);
      assert.equal(out.cardPlan, c2.cardPlan);
    }
    // 执行器没有快照库（测试替身）：plan 回的就是管线给的上下文本身
    const entry = { key: 'e', cardPlan: [control('a')] };
    const context = { cardPlan: entry.cardPlan };
    const exec = createPrerenderExecutor({ pipeline: { planForQueue: async () => ({ entry, context }) }, projects: { get: async () => ({ tracks: [], duration: 1 }) } });
    assert.equal(await exec.plan(PLAN), context);
  } finally { await cleanup(); }
});

test('QM-E-05 every split reads live and leaves the cache untouched: split the same version first (no record, given to the browser), and after this machine renders an oversize frame, splitting again marks it; the control in the cache is unchanged', async () => {
  const { store, cleanup } = await tempStore();
  try {
    const a = control('a');
    const { exec, plans } = executorOver(store, [a]);
    const first = await exec.plan(PLAN);
    assert.deepEqual(fpsOf(split(first), 'a'), [B, P].sort(), 'no record yet: still given to the browser');
    await commit(store, a.snapshotKey, [[7, BIG]]);
    const second = await exec.plan(PLAN);
    assert.equal(plans(), 1, 'the context of the same project version comes from the cache (the plan was not recomputed)');
    assert.equal(second.cardPlan[0].snapshotOversize, true, 'the oversize record is read live');
    assert.deepEqual(fpsOf(split(second), 'a'), [P]);
    assert.equal('snapshotOversize' in a, false, 'the control in the cache was not modified');
    assert.equal('snapshotOversize' in first.cardPlan[0], false);
  } finally { await cleanup(); }
});

test('QM-E-06 across machines: the record exists only in the local snapshot store; a splitter that has neither rendered nor pulled it does not mark (the browser still gets a copy); once the result is pulled back, it marks', async () => {
  const m1 = await tempStore(), m2 = await tempStore();
  try {
    const a = control('a');
    await commit(m1.store, a.snapshotKey, [[0, SMALL], [1, BIG]]);
    const on1 = await executorOver(m1.store, [a]).exec.plan(PLAN);
    const on2 = await executorOver(m2.store, [a]).exec.plan(PLAN);
    assert.equal(on1.cardPlan[0].snapshotOversize, true, 'the machine that rendered it marks it');
    assert.equal('snapshotOversize' in on2.cardPlan[0], false, 'the other one cannot get this record: not marked');
    assert.deepEqual(fpsOf(split(on2), 'a'), [B, P].sort(), 'so the browser still gets a copy (the oversize frames it produces are dropped just the same)');
    // 第二台从素材服务拉回这张卡的结果：applyResult 落盘走同一个写入口（commitSnapshots），超限在那台照样判出来记下
    await commit(m2.store, a.snapshotKey, [[0, SMALL], [1, BIG]]);
    const again = await executorOver(m2.store, [a]).exec.plan(PLAN);
    assert.equal(again.cardPlan[0].snapshotOversize, true);
  } finally { await m1.cleanup(); await m2.cleanup(); }
});
