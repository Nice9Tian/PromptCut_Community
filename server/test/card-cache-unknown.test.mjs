/**
 * 未知卡片(预渲染间的注册表里查不到定义的卡片段)不进卡片计划(`CardFrameCache.plan()`),预渲染进程不为它排任何活。
 * 跑:node --test server/test/card-cache-unknown.test.mjs
 *
 *   CU-01 同一个项目带或不带一个未知卡片段:其余片段的控件(`key` / `contentKey` / `snapshotKey` / `cacheContentKey` /
 *         `costKey` / 结果键)逐字相同;未知卡片段没有控件
 *   CU-02 未知卡当别的卡的输入(素材效果卡滤镜吃它的输出):那张卡照常有控件,键与不跳过时逐字相同
 *   CU-03 预渲染集合(`prerenderSetOfPlan`,两条路:没有成本记录按声明、有成本记录按分派表)不含未知卡片段;
 *         不带 `unknownClipIds`(旧行为)时它按「没有定义」的缺省能力(stateful、要预渲染)判重 —— 这就是修掉的副作用
 *   CU-04 接线:导出页的 `__pcCardPlan` 带上 `unknownClipIds`(注册表的 `unknownCardClipIds`)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CardFrameCache } from '../card-cache.mjs';
import { prerenderSetOfPlan } from '../prerender-set.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FP = '0123456789abcdef';
const Component = () => null;
const DEFS = {
  'known-a': { id: 'known-a', name: 'A', defaults: { text: 'a' }, controls: [], frameMode: 'stateful', Component },
  'known-b': { id: 'known-b', name: 'B', defaults: { n: 1 }, controls: [], frameMode: 'direct', Component },
  gfx: { id: 'gfx', name: '滤镜', kind: 'filter', defaults: { amount: 0.5 }, controls: [], card: () => ({}) },
};
const getCard = (id) => DEFS[id];

function project({ unknown = false, consumer = false } = {}) {
  const tracks = [
    { id: 't-a', name: 'a', clips: [{ id: 'a', cardId: 'known-a', start: 0, end: 2, params: {} }] },
    { id: 't-b', name: 'b', clips: [{ id: 'b', cardId: 'known-b', start: 1, end: 3, params: {}, frame: { x: 10, y: 20, w: 320, h: 180 } }] },
  ];
  if (unknown) tracks.push({ id: 't-x', name: 'x', clips: [{ id: 'x', cardId: 'nobody', start: 0, end: 4, params: { text: 'hi' } }] });
  const p = { version: 1, id: 'p', name: 'p', width: 640, height: 360, fps: 30, duration: 4, media: [], tracks };
  if (consumer) {
    // 素材效果卡滤镜吃未知卡片段的输出(`@clip/x/source`),另一个片段 f 指向这个滤镜节点
    p.cardNodes = [{ id: 'n-f', adapter: 'card', cardId: 'gfx', kind: 'filter', inputs: { source: { nodeId: '@clip/x/source' } }, params: { amount: 0.5 } }];
    tracks.push({ id: 't-f', name: 'f', clips: [{ id: 'f', nodeId: 'n-f', start: 0, end: 4, params: { amount: 0.5 } }] });
  }
  return p;
}

const unknownOf = (p) => p.tracks.flatMap((t) => t.clips).filter((c) => c.cardId && !DEFS[c.cardId]).map((c) => c.id).sort();
function browserPlan(p, withUnknown = true) {
  return {
    graph: projectCardGraph(p, getCard),
    sourceVersions: { 'known-a': 'builtin:va', 'known-b': 'builtin:vb', gfx: 'builtin:vg' },
    environment: { width: p.width, height: p.height, fps: p.fps, theme: undefined, fontFingerprint: 'f' },
    ...(withUnknown ? { unknownClipIds: unknownOf(p) } : {}),
  };
}
function planOf(p, withUnknown = true) {
  const cache = new CardFrameCache({ root: os.tmpdir(), project: p, envFingerprint: FP });
  return cache.plan(browserPlan(p, withUnknown));
}
const keysOf = (c) => ({ clipId: c.clipId, key: c.key, contentKey: c.contentKey, snapshotKey: c.snapshotKey, cacheContentKey: c.cacheContentKey,
  costKey: c.costKey, resultKey: resultKeyOf(c.contentKey, c.envFingerprint), start: c.start, end: c.end, count: c.count });
const byClip = (plan) => Object.fromEntries(plan.map((c) => [c.clipId, keysOf(c)]));

test('CU-01 带或不带一个未知卡片段:其余片段的键逐字相同;未知卡片段没有控件', () => {
  const without = byClip(planOf(project()));
  const withX = byClip(planOf(project({ unknown: true })));
  assert.deepEqual(Object.keys(without).sort(), ['a', 'b']);
  assert.deepEqual(Object.keys(withX).sort(), ['a', 'b'], '未知卡片段 x 不出控件');
  assert.deepEqual(withX, without, '其余片段 key / contentKey / snapshotKey / cacheContentKey / costKey / 结果键逐字相同');
  for (const c of Object.values(withX)) for (const k of ['key', 'contentKey', 'snapshotKey', 'resultKey']) assert.match(c[k], /^[0-9a-f]+/, `${c.clipId}.${k}`);
  // 不跳过(旧行为)时 x 有控件、别的卡也照旧:跳过只少了 x 这一项
  const old = byClip(planOf(project({ unknown: true }), false));
  assert.deepEqual(Object.keys(old).sort(), ['a', 'b', 'x']);
  const { x: _x, ...rest } = old;
  assert.deepEqual(rest, withX);
});

test('CU-02 未知卡当别的卡的输入:那张卡照常有控件,键与不跳过时逐字相同', () => {
  const p = project({ unknown: true, consumer: true });
  const skipped = byClip(planOf(p));
  const old = byClip(planOf(p, false));
  assert.ok(skipped.f, '吃未知卡输出的片段 f 照常有控件');
  assert.equal(skipped.x, undefined, '未知卡片段自己没有控件');
  assert.deepEqual(skipped.f, old.f, 'f 的键逐字不变');
  assert.deepEqual(skipped.a, old.a);
  assert.deepEqual(skipped.b, old.b);
});

test('CU-03 预渲染集合不含未知卡片段(没有成本记录、有成本记录两条路);旧行为按缺省能力判重', () => {
  const p = project({ unknown: true });
  const plan = planOf(p);
  const old = planOf(p, false);
  // 没有成本记录:按声明兜底
  assert.equal(prerenderSetOfPlan(old, { fps: 30, costs: [] }).has('x'), true, '旧行为:没有定义按 stateful / 要预渲染判重(修掉的副作用)');
  assert.equal(prerenderSetOfPlan(plan, { fps: 30, costs: [] }).has('x'), false, '没有成本记录:不含未知卡片段');
  // 有成本记录(别的卡测过,未知卡没有记录):按分派表
  const costs = plan.map((c) => ({ identityKey: c.costKey, fps: 30, device: 'd', measuredAt: 1, stepMs: 0.3, kind: 'random', catchUpMs: 0.3, seekOk: true, seekMs: 0.3 }));
  assert.equal(prerenderSetOfPlan(old, { fps: 30, costs }).has('x'), true, '旧行为:没有记录按声明判重');
  const set = prerenderSetOfPlan(plan, { fps: 30, costs });
  assert.equal(set.has('x'), false, '有成本记录:不含未知卡片段');
  assert.equal(set.has('a') || set.has('b'), false, '别的卡照常按记录判轻');
});

test('CU-04 接线:导出页的 __pcCardPlan 带上 unknownClipIds', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ExportView.tsx'), 'utf8');
  const at = src.indexOf('window.__pcCardPlan = () =>');
  const body = src.slice(at, src.indexOf('window.__pcClipFrameModes', at));
  assert.match(body, /unknownClipIds: \[\.\.\.unknownCardClipIds\((?:proj|flat)\.tracks\.flatMap\(\(track\) => track\.clips\)\)\]\.sort\(\)/);
});
