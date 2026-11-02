/**
 * K 节验收里 `planPipelines` 的算例，逐条照抄（`docs/archive/restructure_planning/r2-r7-task.md` 的 K2 与 K 节验收）。
 * 数都按 `fps = 30`、`B = 1000 / 30 × 70% = 23.333 ms`、`DEAD_MS = 0.3` 算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CATCHUP_STEPS_PER_BEAT, DEAD_MS, budgetOf, clipCostIndex, clipWeight, pipelineAt, planPipelines } from './pipelinePlan.mjs';
import { resolveTuning } from './pipelineTuning.mjs';

const FPS = 30;
const B = budgetOf(FPS);

/** 一段卡片段 + 它的成本记录。`record: null` = 还没测过（走声明兜底） */
const card = (id, start, end, record, frameMode = 'stateful') => ({ id, start, end, record, frameMode });

/** 把一串 `card()` 变成 `planPipelines` 的四个入参 */
function scene(cards, fps = FPS) {
  const project = { version: 1, name: 'p', width: 1920, height: 1080, fps, duration: 60, themeId: 'midnight',
    tracks: [{ id: 'tr', name: 'tr', clips: cards.map((c) => ({ id: c.id, cardId: `card-${c.id}`, start: c.start, end: c.end, params: {} })) }] };
  const costs = [], identityKeys = {}, frameModes = {};
  for (const c of cards) {
    identityKeys[c.id] = `key-${c.id}`;
    frameModes[c.id] = c.frameMode;
    if (c.record) costs.push({ identityKey: `key-${c.id}`, fps, device: 'test', measuredAt: 1, demoted: false, ...c.record });
  }
  return { project, costs, fps, opts: { identityKeys, frameModes } };
}

const plan = (cards, fps = FPS, extra = {}) => {
  const s = scene(cards, fps);
  return planPipelines(s.project, s.costs, s.fps, { ...s.opts, ...extra });
};

/** 随机访问卡的记录 */
const direct = (stepMs) => ({ kind: 'random', stepMs, inlineMs: 0, rasterMs: 0, serializeMs: 0, catchUpMs: 0 });
/** 推帧卡的记录 */
const stepped = (stepMs, catchUpMs, over = {}) => ({ kind: 'stepped', stepMs, inlineMs: 0, rasterMs: 0, serializeMs: 0, catchUpMs, ...over });

const ids = (set) => [...set];

/* ------------------------------------------------------------------ 贪心 */

test('with 10 direct cards (1, 1, 2, 2, 3, 5, 8, 13, 21, 34 ms) the light pipeline is exactly the first 7', () => {
  const steps = [1, 1, 2, 2, 3, 5, 8, 13, 21, 34];
  // id 按权重升序命名，断言时一眼看得出装了哪几张
  const p = plan(steps.map((ms, i) => card(`c${i}`, 0, 4, direct(ms), 'direct')));
  assert.equal(p.segments.length, 1);
  assert.deepEqual(ids(p.segments[0].light), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  // Σ = 22 ms + 3 × 0.3 ms = 22.9 ≤ 23.333；加第 8 张就是 35 + 0.6 > B
  assert.ok(22 + 3 * DEAD_MS <= B && 35 + 2 * DEAD_MS > B);
  assert.deepEqual(ids(p.segments[0].heavy), ['c7', 'c8', 'c9']);
  assert.deepEqual(ids(p.prerenderSet), ['c7', 'c8', 'c9']);
});

test('when all cards are 30 ms the light pipeline is empty', () => {
  const p = plan([0, 1, 2].map((i) => card(`c${i}`, 0, 4, direct(30), 'direct')));
  assert.equal(p.segments[0].light.size, 0);
  assert.deepEqual(ids(p.segments[0].heavy), ['c0', 'c1', 'c2']);
  assert.deepEqual(ids(p.prerenderSet), ['c0', 'c1', 'c2']);
});

test('5 tier (b) cards at the same position fit only 4 (computing by raw stepMs would wrongly fit 5)', () => {
  // 6 秒、stepMs 1 ms 的 Motion 卡：catchUpMs = 180 ms，w = (1 + 4) × 1 = 5 ms
  const rec = stepped(1, 180, { seekOk: false });
  const p = plan([0, 1, 2, 3, 4].map((i) => card(`c${i}`, 0, 6, rec)));
  assert.equal(clipWeight({ ...rec }, 'stateful', FPS).w, 5);
  assert.equal(p.segments[0].light.size, 4, 'Σ w = 20 ≤ 23.3; adding the 5th gives 25 > B');
  assert.equal(p.segments[0].heavy.size, 1);
  assert.ok(20 + DEAD_MS <= B && 25 > B);
  // 按裸 stepMs（1 ms）算的话 5 × 1 = 5 ms，五张全装得下 —— 那一拍的真实成本是预算的一倍多
  assert.ok(5 * 1 < B);
});

/* ------------------------------------------------- capped / demoted / pinnedHeavy */

for (const flag of ['capped', 'demoted', 'pinnedHeavy']) {
  test(`cards with ${flag} are deduplicated at every position and are also in prerenderSet`, () => {
    const p = plan([
      card('heavy', 0, 4, { ...direct(1), [flag]: true }, 'direct'),
      card('cheap', 1, 2, direct(1), 'direct'),
    ]);
    // 边界 0 / 1 / 2 / 4 → 三个位置，`heavy` 在每一个位置都重
    assert.equal(p.segments.length, 3);
    for (const seg of p.segments) {
      assert.ok(seg.heavy.has('heavy'), `position [${seg.fromSec}, ${seg.toSec}) should be deduplicated`);
      assert.ok(!seg.light.has('heavy'));
    }
    assert.ok(p.prerenderSet.has('heavy'));
    assert.ok(!p.prerenderSet.has('cheap'), 'cheap cards on the same beat are still live-rendered as usual');
    assert.equal(pipelineAt(p, 'heavy', 1.5), 'heavy');
    assert.equal(pipelineAt(p, 'cheap', 1.5), 'light');
  });
}

/* ------------------------------------------------------------------ 推帧卡三档 */

test('a 6-second Motion card with stepMs 1 ms is light at every position, w = 5 ms, takes (b), and is not in prerenderSet', () => {
  const rec = stepped(1, 180, { seekOk: false });   // 180 帧 × 1 ms
  const w = clipWeight(rec, 'stateful', FPS);
  assert.equal(w.tier, 'catchup-b');
  assert.equal(w.w, (1 + CATCHUP_STEPS_PER_BEAT) * 1);
  assert.ok(180 > B, 'catchUpMs exceeds the one-beat budget, so it is not tier (a)');
  assert.ok(180 / (CATCHUP_STEPS_PER_BEAT * 1) <= 2 * FPS, '45 beats ≤ 60 beats, within the frame catch-up upper bound');

  const p = plan([card('motion', 0, 6, rec)]);
  for (const seg of p.segments) assert.ok(seg.light.has('motion'));
  assert.equal(p.prerenderSet.size, 0);
});

test('the same card changed to 10 seconds: heavy at every position, the whole segment is in prerenderSet', () => {
  const rec = stepped(1, 300, { seekOk: false });   // 300 帧 × 1 ms
  assert.equal(clipWeight(rec, 'stateful', FPS).tier, 'over-catchup');
  assert.ok(300 / CATCHUP_STEPS_PER_BEAT > 2 * FPS, '75 beats > 60 beats, exceeds the frame catch-up upper bound');

  const p = plan([card('motion', 0, 10, rec)]);
  for (const seg of p.segments) assert.ok(seg.heavy.has('motion'));
  assert.deepEqual(ids(p.prerenderSet), ['motion']);
});

test('short cards with catchUpMs ≤ B take tier (a), and the weight is stepMs', () => {
  const w = clipWeight(stepped(2, 20, { seekOk: false }), 'stateful', FPS);
  assert.equal(w.tier, 'catchup-a');
  assert.equal(w.w, 2);
});

/* ------------------------------------------------------------------ seekOk */

test('60-second particle card (seekOk: true, seekMs: null) is judged heavy at each position, and no position takes (a′)', () => {
  // 3600 帧 × 2 ms = 7200 ms：远超追帧上界（7200 / (4 × 2) = 900 拍 > 60）
  const rec = stepped(2, 7200, { seekOk: true, seekMs: null, vtOk: true });
  const w = clipWeight(rec, 'stateful', FPS);
  assert.equal(w.tier, 'over-catchup', 'unknown seekMs always follows the catch-up card rule, not a linear estimate');

  const p = plan([card('particles', 0, 60, rec)]);
  for (const seg of p.segments) assert.ok(seg.heavy.has('particles'));
  assert.deepEqual(ids(p.prerenderSet), ['particles']);
});

test('60-second pure CSS card (seekOk: true, seekMs ≤ B) is light at every position and not in prerenderSet', () => {
  const rec = stepped(1, 1800, { seekOk: true, seekMs: 3 });
  const w = clipWeight(rec, 'stateful', FPS);
  assert.equal(w.tier, 'seek');
  assert.equal(w.w, 1, 'tier (a′) weight is stepMs, no frame catch-up however long the segment is');

  const p = plan([card('css', 0, 60, rec)]);
  for (const seg of p.segments) assert.ok(seg.light.has('css'));
  assert.equal(p.prerenderSet.size, 0);
});

test('cards with seekMs > B fall back to the catch-up card rule; those with no seekOk record are treated as false', () => {
  assert.equal(clipWeight(stepped(1, 1800, { seekOk: true, seekMs: B + 1 }), 'stateful', FPS).tier, 'over-catchup');
  assert.equal(clipWeight(stepped(1, 1800, {}), 'stateful', FPS).tier, 'over-catchup');
  assert.equal(clipWeight(stepped(1, 1800, { seekOk: false, seekMs: 1 }), 'stateful', FPS).tier, 'over-catchup');
});

/* ------------------------------------------------------------------ 分段 */

test('segment boundaries are exactly the deduplicated union of all card in points / out points', () => {
  const p = plan([
    card('a', 0, 4, direct(1), 'direct'),
    card('b', 2, 4, direct(1), 'direct'),   // 出点和 a 重合，只留一个边界
    card('c', 2, 7.5, direct(1), 'direct'),
    card('d', 4, 7.5, direct(1), 'direct'),
  ]);
  assert.deepEqual(p.segments.map((s) => [s.fromSec, s.toSec]), [[0, 2], [2, 4], [4, 7.5]]);
  assert.deepEqual([...new Set(p.segments.flatMap((s) => [s.fromSec, s.toSec]))], [0, 2, 4, 7.5]);
});

test('media clips (only mediaId) take no part in segmentation or dispatch', () => {
  const s = scene([card('a', 0, 4, direct(1), 'direct')]);
  s.project.tracks.push({ id: 'v', name: 'v', clips: [{ id: 'm0', mediaId: 'mm', start: 1, end: 3, params: {} }] });
  const p = planPipelines(s.project, s.costs, s.fps, s.opts);
  assert.deepEqual(p.segments.map((x) => [x.fromSec, x.toSec]), [[0, 4]]);
  assert.ok(!p.prerenderSet.has('m0'));
});

test('a card judged heavy in segment 2 and light in segment 3 is in prerenderSet, while the hot stage in segment 3 treats it as a light card', () => {
  const p = plan([
    card('wide', 0, 3, direct(20), 'direct'),   // 铺满三个位置，w = 20
    card('x', 1, 2, direct(5), 'direct'),
    card('y', 1, 2, direct(5), 'direct'),
  ]);
  assert.deepEqual(p.segments.map((s) => [s.fromSec, s.toSec]), [[0, 1], [1, 2], [2, 3]]);
  assert.ok(p.segments[0].light.has('wide'), 'segment 1 has only it, 20 ≤ 23.3');
  assert.ok(p.segments[1].heavy.has('wide'), 'segment 2: after 5 + 5 fit, adding another 20 = 30 > B, so it is pushed out');
  assert.ok(p.segments[2].light.has('wide'));
  assert.deepEqual(ids(p.prerenderSet), ['wide'], 'judged heavy at any position means it goes into the prerender set');
  assert.equal(pipelineAt(p, 'wide', 0.5), 'light');
  assert.equal(pipelineAt(p, 'wide', 1.5), 'heavy');
  assert.equal(pipelineAt(p, 'wide', 2.5), 'light');
});

test('pipelineAt boundaries: right-open interval, returns light outside the positions', () => {
  const p = plan([card('a', 0, 2, direct(30), 'direct')]);
  assert.equal(pipelineAt(p, 'a', 0), 'heavy');
  assert.equal(pipelineAt(p, 'a', 1.999), 'heavy');
  assert.equal(pipelineAt(p, 'a', 2), 'light', 'this card is inactive after its out point');
  assert.equal(pipelineAt(p, 'a', -1), 'light');
  assert.equal(pipelineAt(p, 'nobody', 1), 'light');
});

/* ------------------------------------------------------------------ 可调系数 */

test('COST_SCALE changed from 1 to 2: cards whose cost was between B/2 and B are now judged heavy', () => {
  const rec = direct(15);   // B/2 = 11.67 < 15 < 23.33
  assert.ok(B / 2 < 15 && 15 < B);
  const one = [card('mid', 0, 4, rec, 'direct')];

  const p1 = plan(one, FPS, { tuning: { COST_SCALE: 1 } });
  assert.ok(p1.segments[0].light.has('mid'));
  assert.equal(p1.prerenderSet.size, 0);

  const p2 = plan(one, FPS, { tuning: { COST_SCALE: 2 } });
  assert.ok(p2.segments[0].heavy.has('mid'), '15 × 2 = 30 > B');
  assert.deepEqual(ids(p2.prerenderSet), ['mid']);
  assert.equal(clipWeight(rec, 'direct', FPS, { COST_SCALE: 2 }).tier, 'capped');
});

test('COST_SCALE also multiplies the greedy weight: a B/3 card no longer fits after scaling up', () => {
  const cards = [0, 1, 2].map((i) => card(`c${i}`, 0, 4, direct(7), 'direct'));
  assert.equal(plan(cards, FPS, { tuning: { COST_SCALE: 1 } }).segments[0].light.size, 3, '21 ≤ 23.3');
  assert.equal(plan(cards, FPS, { tuning: { COST_SCALE: 1.5 } }).segments[0].light.size, 2, '10.5 × 3 = 31.5 > B');
});

test('the frame catch-up upper bound is a ratio and does not change with COST_SCALE; but the boundary between (a) / (b) does', () => {
  const rec = stepped(1, 180, { seekOk: false });
  assert.equal(clipWeight(rec, 'stateful', FPS, { COST_SCALE: 2 }).tier, 'catchup-b', 'the ratio 180 / (4 × 1) is unchanged when both sides are scaled');
  assert.equal(clipWeight(rec, 'stateful', FPS, { COST_SCALE: 2 }).w, 10);
  // catchUpMs = 20 ms 的卡：×1 时 ≤ B 走 (a)，×2 时 40 > B 走 (b)
  const short = stepped(1, 20, { seekOk: false });
  assert.equal(clipWeight(short, 'stateful', FPS, { COST_SCALE: 1 }).tier, 'catchup-a');
  assert.equal(clipWeight(short, 'stateful', FPS, { COST_SCALE: 2 }).tier, 'catchup-b');
});

test('opts.deadMs only replaces the frame-switch cost of dead media (L4)', () => {
  const cards = [0, 1].map((i) => card(`c${i}`, 0, 4, direct(11.6), 'direct'));
  assert.equal(plan(cards).segments[0].light.size, 2, '23.2 ≤ 23.333');
  assert.equal(plan(cards, FPS, { deadMs: 5 }).segments[0].light.size, 2, 'when both cards are light there is no heavy card, and deadMs is not used');
  const withHeavy = [...cards, card('h', 0, 4, stepped(1, 1e6, { seekOk: false }))];
  assert.equal(plan(withHeavy, FPS, { deadMs: 0 }).segments[0].light.size, 2, 'with deadMs = 0 the heavy card takes no budget');
});

/* ------------------------------------------------------------------ unknown 卡 */

test('unknown cards take part in the greedy pass as usual, and DEAD_MS is counted the same way when judging heavy', () => {
  // 两张 11.6 ms 的轻卡：单独在一起 23.2 ≤ 23.333，都装得下
  const two = [0, 1].map((i) => card(`c${i}`, 0, 4, direct(11.6), 'direct'));
  assert.equal(plan(two).segments[0].light.size, 2);

  // 加一张必然判重的 unknown 卡（审阅表没覆盖到，按 belowDependent 处理）：
  // 它贴本地档快照的 0.3 ms 把第二张挤了出去
  const withUnknown = [...two, card('u', 0, 4, stepped(1, 7200, { seekOk: false }))];
  const p = plan(withUnknown);
  assert.equal(p.segments[0].light.size, 1, '23.2 + 0.3 = 23.5 > 23.333');
  assert.ok(p.segments[0].heavy.has('u'));
  assert.deepEqual(ids(p.prerenderSet), ['c1', 'u']);
});

test('when an unknown card is judged light it is live-rendered, no different from other cards', () => {
  const p = plan([card('u', 0, 4, stepped(2, 20, { seekOk: false })), card('a', 0, 4, direct(2), 'direct')]);
  assert.deepEqual(ids(p.segments[0].light), ['a', 'u']);
  assert.equal(p.prerenderSet.size, 0);
});

/* ------------------------------------------------------------------ 兜底 */

test('cards with no cost record fall back to the declaration: direct is treated as light, the rest as heavy', () => {
  const p = plan([card('d', 0, 4, null, 'direct'), card('s', 0, 4, null, 'stateful')]);
  assert.deepEqual(ids(p.segments[0].light), ['d']);
  assert.deepEqual(ids(p.segments[0].heavy), ['s']);
  assert.deepEqual(ids(p.prerenderSet), ['s']);
  assert.equal(clipWeight(null, 'direct', FPS).w, 0, 'we don\'t know yet how expensive it is, so it takes no budget for now');
  assert.equal(clipWeight(null, undefined, FPS).tier, 'declared-heavy', 'with no declaration either, treat as heavy');
});

test('identityKeys accepts a Map, and also a plain object', () => {
  const s = scene([card('a', 0, 4, direct(1), 'direct')]);
  const viaMap = planPipelines(s.project, s.costs, s.fps,
    { identityKeys: new Map([['a', 'key-a']]), frameModes: new Map([['a', 'direct']]) });
  assert.deepEqual(ids(viaMap.segments[0].light), ['a']);
});

/* ------------------------------------------------------------------ 两端同一张表 */

test('calling twice with the same input gives byte-identical output after serialization', () => {
  const cards = [
    card('zz', 0, 6, stepped(1, 180, { seekOk: false })),
    card('aa', 0, 4, direct(3), 'direct'),
    card('mm', 2, 9, stepped(2, 7200, { seekOk: true, seekMs: null })),
    card('nn', 1, 4, null, 'direct'),
    card('qq', 1, 9, direct(21), 'direct'),
  ];
  const dump = (p) => JSON.stringify({
    segments: p.segments.map((s) => ({ fromSec: s.fromSec, toSec: s.toSec, heavy: [...s.heavy], light: [...s.light] })),
    prerenderSet: [...p.prerenderSet],
  });
  const a = dump(plan(cards));
  const b = dump(plan(cards));
  assert.equal(a, b);
  // 轨道顺序换一换（两端的项目镜像可能不同序）也要一样：集合和候选表都按 clipId 排过
  const s = scene([...cards].reverse());
  assert.equal(dump(planPipelines(s.project, s.costs, s.fps, s.opts)), a);
  // 集合的迭代顺序本身就是排好的，不靠插入顺序
  for (const seg of plan(cards).segments) {
    assert.deepEqual([...seg.heavy], [...seg.heavy].sort());
    assert.deepEqual([...seg.light], [...seg.light].sort());
  }
});

test('planPipelines does not modify its arguments', () => {
  const s = scene([card('a', 0, 4, direct(1), 'direct'), card('b', 1, 3, direct(2), 'direct')]);
  const before = JSON.stringify([s.project, s.costs, s.opts]);
  planPipelines(s.project, s.costs, s.fps, s.opts);
  assert.equal(JSON.stringify([s.project, s.costs, s.opts]), before);
});

test('empty project / no card clips: no positions and no prerender set', () => {
  assert.deepEqual(planPipelines({ fps: 30, tracks: [] }, [], 30, {}), { segments: [], prerenderSet: new Set() });
  assert.deepEqual(planPipelines(null, null, 30, {}), { segments: [], prerenderSet: new Set() });
});

/* ------------------------------------------------------------------ 片段 → 节点 → 键 */

test('clipCostIndex looks up the node\'s identity key and declared frame mode by clip', () => {
  const project = { fps: 30, tracks: [{ id: 't', clips: [
    { id: 'c0', cardId: 'odometer', start: 0, end: 4, params: {} },
    { id: 'c1', mediaId: 'm', start: 0, end: 4 },
  ] }] };
  const graph = { nodes: [
    { id: '@clip/c0/source', adapter: 'chrome', cardId: 'odometer', clipId: 'c0', params: {}, inputs: {},
      capabilities: { frameMode: 'stateful', compositing: 'independent' } },
  ] };
  const index = clipCostIndex(project, graph, () => 'builtin:v1');
  assert.equal(typeof index.identityKeys.c0, 'string');
  assert.equal(index.frameModes.c0, 'stateful');
  assert.ok(!('c1' in index.identityKeys), 'media clips are not in the index');
  // 同一份输入算两次同一个键；换了源码版本就换键
  assert.equal(clipCostIndex(project, graph, () => 'builtin:v1').identityKeys.c0, index.identityKeys.c0);
  assert.notEqual(clipCostIndex(project, graph, () => 'builtin:v2').identityKeys.c0, index.identityKeys.c0);
});

test('resolveTuning is idempotent: passing an already-resolved copy into planPipelines changes nothing', () => {
  const t = resolveTuning({ COST_SCALE: 2 });
  const cards = [card('mid', 0, 4, direct(15), 'direct')];
  assert.deepEqual(ids(plan(cards, FPS, { tuning: t }).prerenderSet), ['mid']);
});

/* ------------------------------------------------------------------ 3D 模式与轻卡产流 (rr-bake3d-stream) */

test('3D mode (includeLightCardsFor3D / view3d) also puts standalone cards that would be judged light into prerenderSet, with scene-3d still excluded', () => {
  // c0: 1ms (判轻), c1: 2ms (判轻), c2: 30ms (判重)
  const cards = [
    card('c0', 0, 4, direct(1), 'direct'),
    card('c1', 0, 4, direct(2), 'direct'),
    card('c2', 0, 4, direct(30), 'direct'),
  ];
  // 默认情况下: c0, c1 进 light, 只有 c2 进 prerenderSet
  const pDefault = plan(cards, FPS);
  assert.deepEqual(ids(pDefault.segments[0].light), ['c0', 'c1']);
  assert.deepEqual(ids(pDefault.segments[0].heavy), ['c2']);
  assert.deepEqual(ids(pDefault.prerenderSet), ['c2']);

  // 打开 view3d: c0, c1 也进 prerenderSet, segments 内 light / heavy 仍保持原样
  const p3d = plan(cards, FPS, { view3d: true });
  assert.deepEqual(ids(p3d.segments[0].light), ['c0', 'c1']);
  assert.deepEqual(ids(p3d.segments[0].heavy), ['c2']);
  assert.deepEqual(ids(p3d.prerenderSet), ['c0', 'c1', 'c2']);

  // 加入 scene-3d 和非独立卡:
  // scene-3d 在 3D 视图里是真三维网格，除外；非独立卡 (belowDependent) 也除外
  const project = {
    version: 1, name: 'p', width: 1920, height: 1080, fps: FPS, duration: 60, themeId: 'midnight',
    tracks: [{
      id: 'tr', name: 'tr', clips: [
        { id: 'c0', cardId: 'punch-pill', start: 0, end: 4, params: {} },
        { id: 's3d', cardId: 'scene-3d', start: 0, end: 4, params: {} },
        { id: 'glass', cardId: 'glass-blur', start: 0, end: 4, params: {} },
      ],
    }],
  };
  const costs = [];
  const opts = {
    view3d: true,
    identityKeys: { c0: 'k-c0', s3d: 'k-s3d', glass: 'k-glass' },
    frameModes: { c0: 'direct', s3d: 'direct', glass: 'direct' },
    compositing: {
      'punch-pill': 'independent',
      'glass-blur': 'belowDependent',
    },
  };
  const pCaps = planPipelines(project, costs, FPS, opts);
  // c0 是 independent 且轻卡 -> 纳入 prerenderSet
  // s3d 是 scene-3d -> 排除
  // glass 是 belowDependent -> 排除
  assert.deepEqual(ids(pCaps.prerenderSet), ['c0']);
});

