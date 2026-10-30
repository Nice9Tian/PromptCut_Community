/**
 * 剪辑段里的卡逐张产轨道流(`src/kernel/cutFlatten.mjs`;用户 2026-10-21 定)。跑:node --test server/test/cut-flatten-streams.test.mjs
 *
 * 钉死:
 *   - 卡片计划(`CardFrameCache.plan`)里剪辑段里的卡各有自己的控件,id 是 `<段 id>~<卡的片段 id>`,不走整帧 PNG 那一支;
 *   - 流的划分:独立卡各一条 `solo: 'flat'` 的单卡流(不并组流),从嵌套场景最早挂上的那一帧回放;依赖下层的卡不出流;
 *   - 键:改被引用剪辑里一张卡只改那张卡的流键;同一剪辑引用两次各自一条;成本键随实例不变(同一张卡只测一次);
 *   - 隔离工程带着剪辑段链;
 *   - 没有剪辑段的项目:图、控件、流与改动前逐字相同。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';
import { flatPlanProject, withFlatNodes, FLAT_SEP } from '../../src/kernel/cutFlatten.mjs';
import { mountFrameOf } from '../../src/render/frameWindow.mjs';
import { CardFrameCache } from '../card-cache.mjs';
import { planStreams, isolatedStreamProject } from '../frame-stream.mjs';

const getCard = id => (id ? { id, defaults: {} } : undefined);
const card = (id, cardId, start, end, extra = {}) => ({ id, cardId, start, end, params: { text: id }, ...extra });
const seg = (id, cutId, start, end, extra = {}) => ({ id, cardId: '', cutId, start, end, params: {}, ...extra });

function project({ heavyText = 'h', second = false } = {}) {
  return {
    id: 'p', name: 'p', width: 1280, height: 720, fps: 30, duration: 10, themeId: 'default', media: [], cardNodes: [], activeCutId: 'A',
    tracks: [
      { id: 'ta', clips: [seg('S', 'B', 2, 6, { cutOffset: 1, frame: { x: 160, y: 90, w: 640, h: 360 } })] },
      ...(second ? [{ id: 'tb', clips: [seg('S3', 'B', 6, 8, { cutOffset: 0 })] }] : []),
      { id: 'tc', clips: [card('top', 'punch-pill', 0, 10)] },
    ],
    cuts: [
      { id: 'A', name: '剪辑1' },
      { id: 'B', name: '剪辑2', duration: 8, transitions: [], tracks: [
        { id: 'b1', clips: [card('H', 'punch-pill', 0, 8, { params: { text: heavyText }, frame: { x: 0, y: 0, w: 400, h: 200 } })] },
        { id: 'b2', clips: [card('G', 'blur-text', 0, 8)] },
        { id: 'b3', clips: [card('L', 'r6-stateful', 3, 4)] },
      ] },
    ],
  };
}

function planOf(p) {
  const flat = flatPlanProject(p);
  const graph = withFlatNodes(flat, projectCardGraph(flat, getCard));
  const cache = new CardFrameCache({ root: '.', project: p, envFingerprint: 'fp' });
  const controls = cache.plan({ graph, sourceVersions: { 'punch-pill': 'builtin:pp', 'blur-text': 'builtin:bt', 'r6-stateful': 'builtin:r6' }, environment: {} });
  return { graph, controls };
}
const everything = () => true;
const streamsOf = (p, controls) => planStreams({ project: p, cardPlan: controls }, { envFingerprint: 'fp', picked: everything });

test('卡片计划:剪辑段里的卡各有控件,不走整帧 PNG', () => {
  const { controls } = planOf(project());
  const ids = controls.map(c => c.clipId);
  for (const id of ['top', `S${FLAT_SEP}H`, `S${FLAT_SEP}G`, `S${FLAT_SEP}L`]) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('S'), '段本身没有控件');
  const H = controls.find(c => c.clipId === `S${FLAT_SEP}H`);
  assert.equal(H.cacheable, false);
  assert.equal(controls.find(c => c.clipId === 'top').cacheable, true);
  // 露出窗口 [2, 6):第 60 帧起 120 帧
  assert.equal(H.sampling.firstFrame, 60);
  assert.equal(H.count, 120);
});

test('流:独立卡各一条 solo flat 的单卡流,从嵌套场景挂上那一帧回放;依赖下层的卡不出流', () => {
  const p = project();
  const { controls } = planOf(p);
  const specs = streamsOf(p, controls);
  const H = specs.find(s => s.topClipId === `S${FLAT_SEP}H`);
  assert.ok(H, '重卡 H 有流');
  assert.equal(H.solo, 'flat');
  assert.equal(H.kind, 'card');
  assert.equal(H.plane, 'local');
  assert.deepEqual(H.clipIds, [`S${FLAT_SEP}H`]);
  assert.equal(H.firstFrame, 60);
  assert.equal(H.mountFrame, mountFrameOf({ start: 1 }, 30), '嵌套场景最早从 max(0, 段起点 − 偏移) 挂上');
  assert.ok(!specs.some(s => s.clipIds.includes(`S${FLAT_SEP}G`)), '依赖下层的卡(blur-text)不出流');
  assert.ok(!specs.some(s => s.kind === 'group' && s.clipIds.some(id => id.includes(FLAT_SEP))), '不并组流');
  // 隔离工程:顶层只剩段 S(去掉框),剪辑 B 里只剩 H(框摆到截图位置)
  const iso = isolatedStreamProject(p, H);
  const shown = iso.tracks.filter(t => !t.hidden).flatMap(t => t.clips);
  assert.deepEqual(shown.map(c => c.id), ['S']);
  assert.equal(shown[0].frame, undefined);
  const inner = iso.cuts.find(c => c.id === 'B').tracks.filter(t => !t.hidden).flatMap(t => t.clips);
  assert.deepEqual(inner.map(c => c.id), ['H']);
  assert.deepEqual(inner[0].frame, { x: H.offset.x, y: H.offset.y, w: 400, h: 200, anchor: [0, 0] });
});

test('键:改被引用剪辑里一张卡只改它的流键;成本键各实例相同;同一剪辑引用两次各自一条', () => {
  const a = planOf(project());
  const b = planOf(project({ heavyText: 'changed' }));
  const key = (plan, id) => plan.controls.find(c => c.clipId === id);
  assert.notEqual(key(a, `S${FLAT_SEP}H`).streamMemberKey, key(b, `S${FLAT_SEP}H`).streamMemberKey);
  assert.equal(key(a, `S${FLAT_SEP}L`).streamMemberKey, key(b, `S${FLAT_SEP}L`).streamMemberKey);
  assert.equal(key(a, 'top').streamMemberKey, key(b, 'top').streamMemberKey);
  const p2 = project({ second: true });
  const two = planOf(p2);
  const specs = streamsOf(p2, two.controls);
  const h1 = specs.find(s => s.topClipId === `S${FLAT_SEP}H`), h3 = specs.find(s => s.topClipId === `S3${FLAT_SEP}H`);
  assert.ok(h1 && h3);
  assert.notEqual(h1.streamKey, h3.streamKey, '露出窗口不同,各自一条');
  // 成本键:同一张卡同样长度时与实例无关(这里 H 在两个实例里都露出 4 秒 / 2 秒,长度不同成本键本来就不同 —— 换同样长度再比)
  const lenEq = project({ second: true });
  lenEq.tracks[1].clips[0] = seg('S3', 'B', 6, 10, { cutOffset: 1 });
  const k = planOf(lenEq).controls;
  assert.equal(k.find(c => c.clipId === `S${FLAT_SEP}H`).costKey, k.find(c => c.clipId === `S3${FLAT_SEP}H`).costKey);
  assert.notEqual(k.find(c => c.clipId === `S${FLAT_SEP}H`).streamMemberKey, k.find(c => c.clipId === `S3${FLAT_SEP}H`).streamMemberKey);
});

test('没有剪辑段的项目:摊平视图、图、控件、流与不摊时逐字相同', () => {
  const p = project();
  p.tracks = [p.tracks[1]];
  assert.equal(flatPlanProject(p), p);
  const raw = projectCardGraph(p, getCard);
  const g = withFlatNodes(p, raw);
  assert.equal(g, raw);
  const cache = new CardFrameCache({ root: '.', project: p, envFingerprint: 'fp' });
  const value = { graph: raw, sourceVersions: { 'punch-pill': 'builtin:pp' }, environment: {} };
  const controls = cache.plan(value);
  assert.equal(JSON.stringify(controls), JSON.stringify(cache.plan({ ...value, graph: projectCardGraph(p, getCard) })));
  const specs = streamsOf(p, controls);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].solo, undefined);
});
