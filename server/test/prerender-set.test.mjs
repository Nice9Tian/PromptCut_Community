import test from 'node:test';
import assert from 'node:assert/strict';

import { planInputsOfControls, pickLatestCosts, prerenderSetOf, prerenderSetOfPlan } from '../prerender-set.mjs';
import { planPipelines, clipCostIndex } from '../../src/render/pipelinePlan.mjs';
import { cardCostKey } from '../../src/render/cardCostKey.mjs';

/**
 * K2 末条：两端不交换分派表，只同步 `costs`。所以**同一份输入必须在两端算出逐字段相同的表**。
 *
 * 页面那一端的入口是 `clipCostIndex(project, graph, sourceVersionOf)`（`src/editor/costIdentity.ts`
 * 里包了一层拿源码版本）；预渲染进程那一端是 `card-cache.mjs` 的 `plan()` 顺手算的
 * `control.costKey` → `planInputsOfControls`。这一组测试钉的就是「这两条路算出同一张表」。
 */

const fps = 30;

/** 一张卡的 graph 节点（形状照 `cardGraph.mjs` 合成出来的那份：带 clipId / cardId / capabilities） */
const nodeOf = (clipId, cardId, caps) => ({
  id: `n:${clipId}`, clipId, cardId, definitionId: `def:${cardId}`, inputs: {},
  params: { text: cardId }, capabilities: caps,
});

const clips = [
  { id: 'a', cardId: 'motion', nodeId: 'n:a', start: 0, end: 6 },
  { id: 'b', cardId: 'lottie', nodeId: 'n:b', start: 2, end: 20 },
  { id: 'c', cardId: 'title', nodeId: 'n:c', start: 4, end: 8 },
];
const caps = {
  a: { frameMode: 'stateful', compositing: 'independent' },
  b: { frameMode: 'stateful', compositing: 'independent' },
  c: { frameMode: 'direct', compositing: 'independent' },
};
const project = { fps, tracks: [{ id: 'tr', clips }] };
const graph = { nodes: clips.map((c) => nodeOf(c.id, c.cardId, caps[c.id])) };
const sourceVersions = { motion: 'builtin:11', lottie: 'builtin:22', title: 'builtin:33' };
const sourceVersionOf = (node) => sourceVersions[node.cardId] ?? null;

/** 预渲染进程那一端：`card-cache.mjs` 的 `plan()` 会往 control 上写这两项 */
const controls = clips.map((clip) => {
  const node = graph.nodes.find((n) => n.clipId === clip.id);
  return {
    clipId: clip.id, nodeId: node.id, start: clip.start, end: clip.end,
    costKey: cardCostKey(node, sourceVersionOf(node), fps, Math.max(1, Math.round((clip.end - clip.start) * fps))),
    frameMode: caps[clip.id].frameMode, capabilities: caps[clip.id],
  };
});

const costs = [
  // 6 秒、每拍 1 ms 的 Motion 卡：catchUpMs 180 > B，180 / (4 × 1) = 45 拍 ≤ 60 → 各位置都轻、走 (b)
  { identityKey: controls[0].costKey, device: 'dev', fps, stepMs: 1, stepMaxMs: 2, inlineMs: 0, rasterMs: 0, serializeMs: 0,
    catchUpMs: 180, kind: 'stepped', vtOk: true, seekOk: false, seekMs: null, demoted: false, measuredAt: 10 },
  // 18 秒、每拍 1 ms：catchUpMs 540，540 / 4 = 135 拍 > 60 → 各位置都重、整段进预渲染集合
  { identityKey: controls[1].costKey, device: 'dev', fps, stepMs: 1, stepMaxMs: 2, inlineMs: 0, rasterMs: 0, serializeMs: 0,
    catchUpMs: 540, kind: 'stepped', vtOk: false, seekOk: false, seekMs: null, demoted: false, measuredAt: 10 },
  // 随机访问卡
  { identityKey: controls[2].costKey, device: 'dev', fps, stepMs: 2, inlineMs: 0, rasterMs: 0, serializeMs: 0,
    catchUpMs: 0, kind: 'random', demoted: false, measuredAt: 10 },
];

test('两端对同一输入算出逐字段相同的表', () => {
  // 页面那一端
  const pageIndex = clipCostIndex(project, graph, sourceVersionOf);
  const pagePlan = planPipelines(project, costs, fps, { ...pageIndex });
  // 预渲染进程那一端
  const { project: synth, identityKeys, frameModes } = planInputsOfControls(controls, fps);
  const serverPlan = planPipelines(synth, costs, fps, { identityKeys, frameModes });

  // 键本身先对上 —— 表相同但键不同只是两边都没命中记录
  assert.deepEqual(identityKeys, pageIndex.identityKeys);
  assert.deepEqual(frameModes, pageIndex.frameModes);
  // 逐字段:JSON 之后逐字节相同(集合建的时候就按 clipId 排过序)
  const wire = (plan) => JSON.stringify({
    segments: plan.segments.map((s) => ({ fromSec: s.fromSec, toSec: s.toSec, heavy: [...s.heavy], light: [...s.light] })),
    prerenderSet: [...plan.prerenderSet],
  });
  assert.equal(wire(serverPlan), wire(pagePlan));
});

test('预渲染集合就是 planPipelines 的那一份,不再按声明兜底', () => {
  const set = prerenderSetOfPlan(controls, { fps, costs, tuning: null });
  // 18 秒那张超了追帧上界 → 各位置都重、整段在集合里;6 秒那张走 (b)、各位置都轻 → 不在
  assert.deepEqual([...set].sort(), ['b']);
  // 按声明兜底的老口径会把两张 stateful 卡都算进去 —— 这一条就是「接上了真的」的判据
  const declared = prerenderSetOfPlan(controls, { fps, costs: [], tuning: null });
  assert.deepEqual([...declared].sort(), ['a', 'b']);
});

test('一条记录都没有时按声明兜底(和接上 planPipelines 之前一致)', () => {
  const set = prerenderSetOf(project, [], fps, (clip) => caps[clip.id]);
  assert.deepEqual([...set].sort(), ['a', 'b']);
});

test('K6 降级:costs 里写上 demoted 之后,那张卡进预渲染集合', () => {
  const demoted = costs.map((r) => (r.identityKey === controls[0].costKey ? { ...r, capped: true, demoted: true } : r));
  const set = prerenderSetOfPlan(controls, { fps, costs: demoted, tuning: null });
  assert.deepEqual([...set].sort(), ['a', 'b']);
});

test('同一个 identityKey 有多台 device 时取 measuredAt 最新的那一条', () => {
  const two = [
    { identityKey: 'k', device: 'old', measuredAt: 1, stepMs: 99 },
    { identityKey: 'k', device: 'new', measuredAt: 2, stepMs: 1 },
  ];
  const picked = pickLatestCosts(two);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].device, 'new');
});

test('3D 模式 (includeLightCardsFor3D / view3d) 将独立轻卡也纳入 prerenderSet', () => {
  // 原本 6 秒那张 'a' 走 (b) 轻管线、'c' 是 direct 轻卡，只有 'b' 进 prerenderSet
  const setNormal = prerenderSetOfPlan(controls, { fps, costs, tuning: null });
  assert.deepEqual([...setNormal].sort(), ['b']);

  // 开启 3D 模式后，'a' 和 'c' 是 independent 卡，均纳入 prerenderSet
  const set3D = prerenderSetOfPlan(controls, { fps, costs, tuning: null, includeLightCardsFor3D: true });
  assert.deepEqual([...set3D].sort(), ['a', 'b', 'c']);

  // 通过 prerenderSetOf 传入 view3d 同样生效
  const set3DDirect = prerenderSetOf(project, costs, fps, (clip) => caps[clip.id], { view3d: true });
  assert.deepEqual([...set3DDirect].sort(), ['a', 'b', 'c']);
});

