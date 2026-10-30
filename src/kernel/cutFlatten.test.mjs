// 剪辑段的摊平视图(`cutFlatten.mjs`):剪辑段里的卡逐张进计划一侧。跑:node --test src/kernel/cutFlatten.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAT_SEP, flatPlanProject, flatInfoOf, isFlatClipId, isolatedFlatProject, withFlatNodes } from './cutFlatten.mjs';

const card = (id, start, end, extra = {}) => ({ id, cardId: 'punch-pill', params: { text: id }, start, end, ...extra });

/** 激活剪辑 A 上:一张顶层卡 T、剪辑段 S(2～6 秒,偏移 1)引用 B;B 里一张重卡 H(0～10)、一张轻卡 L(3～4)、剪辑段 S2 引用 C;C 里一张卡 X */
function fixture() {
  return {
    id: 'p', width: 1920, height: 1080, fps: 30, duration: 10, activeCutId: 'A',
    media: [], cardNodes: [],
    tracks: [
      { id: 't1', clips: [card('T', 0, 10)] },
      { id: 't2', clips: [{ id: 'S', cardId: '', cutId: 'B', cutOffset: 1, start: 2, end: 6, frame: { x: 100, y: 50, w: 960, h: 540 } }] },
    ],
    cuts: [
      { id: 'A', name: '剪辑1' },
      { id: 'B', name: '剪辑2', duration: 8, tracks: [
        { id: 'b1', clips: [card('H', 0, 10, { frame: { x: 0, y: 0, w: 800, h: 400 } }), card('L', 3, 4)] },
        { id: 'b2', clips: [{ id: 'S2', cardId: '', cutId: 'C', cutOffset: 0, start: 4, end: 5 }] },
        { id: 'b3', hidden: true, clips: [card('Z', 0, 8)] },
      ] },
      { id: 'C', name: '剪辑3', duration: 5, tracks: [{ id: 'c1', clips: [card('X', 0, 5)] }] },
    ],
  };
}

test('没有剪辑段的项目原样回同一个对象', () => {
  const p = { tracks: [{ id: 't', clips: [card('a', 0, 1)] }], cuts: [{ id: 'A' }], activeCutId: 'A' };
  assert.equal(flatPlanProject(p), p);
  assert.equal(withFlatNodes(p, { nodes: [{ id: '@clip/a/source' }], outputs: [] }).nodes[0].flat, undefined);
});

test('剪辑段换成里面的卡:平移、截到露出窗口、任意深度、带 lead 与链', () => {
  const p = fixture();
  const flat = flatPlanProject(p);
  assert.equal(flatPlanProject(p), flat, '同一份项目记忆化');
  assert.equal(flatPlanProject(flat), flat, '摊平视图再摊一次还是它自己');
  const clips = new Map(flat.tracks.flatMap((t) => t.clips.map((c) => [c.id, { c, t }])));
  assert.ok(!clips.has('S'), '段本身不在摊平视图里');
  assert.ok(clips.has('T'));
  // shift = 2 − 1 = 1:H 在父时间 [1, 11),露出窗口 [2, 6)
  const H = clips.get(`S${FLAT_SEP}H`).c;
  assert.deepEqual([H.start, H.end], [2, 6]);
  assert.equal(flatInfoOf(H).lead, 1);
  assert.equal(flatInfoOf(H).mount, 1);
  assert.deepEqual(H.frame, { x: 0, y: 0, w: 800, h: 400 }, '框照里面片段原样');
  assert.deepEqual(flatInfoOf(H).chain.map((s) => s.id), ['S']);
  const L = clips.get(`S${FLAT_SEP}L`).c;
  assert.deepEqual([L.start, L.end, flatInfoOf(L).lead], [4, 5, 0]);
  // S2 在父时间 [5, 6),C 的 X 在那里露出 [5, 6)
  const X = clips.get(`S${FLAT_SEP}S2${FLAT_SEP}X`).c;
  assert.deepEqual([X.start, X.end, flatInfoOf(X).lead], [5, 6, 0]);
  assert.deepEqual(flatInfoOf(X).chain.map((s) => s.id), ['S', 'S2']);
  assert.ok(isFlatClipId(X.id) && !isFlatClipId('T'));
  assert.ok(!clips.has(`S${FLAT_SEP}Z`), '隐藏序列不摊');
  // 画家顺序:虚拟序列插在段所在序列的位置(t1 之下、t2 剩下的片段之上)
  const order = flat.tracks.map((t) => t.id);
  assert.equal(order[0], 't1');
  assert.equal(order[order.length - 1], 't2');
});

test('被引用剪辑变短:超出总时长的部分不露出', () => {
  const p = fixture();
  p.cuts[1].duration = 3; // shift 1:剪辑时间 3 → 父时间 4
  const H = flatPlanProject(p).tracks.flatMap((t) => t.clips).find((c) => c.id === `S${FLAT_SEP}H`);
  assert.deepEqual([H.start, H.end], [2, 4]);
});

test('悬空、成环的段不摊,不抛', () => {
  const p = fixture();
  p.tracks[1].clips[0].cutId = 'NOPE';
  assert.ok(!flatPlanProject(p).tracks.flatMap((t) => t.clips).some((c) => isFlatClipId(c.id)));
  const q = fixture();
  q.cuts[2].tracks[0].clips.push({ id: 'BACK', cardId: '', cutId: 'B', start: 0, end: 1 });
  const ids = flatPlanProject(q).tracks.flatMap((t) => t.clips).map((c) => c.id);
  assert.ok(!ids.some((id) => id.includes('BACK')));
});

test('只改被引用剪辑里的一张卡:只有那张卡的虚拟片段变', () => {
  const a = flatPlanProject(fixture());
  const p = fixture();
  p.cuts[1].tracks[0].clips[1] = { ...p.cuts[1].tracks[0].clips[1], params: { text: 'changed' } };
  const b = flatPlanProject(p);
  const of = (flat, id) => JSON.stringify(flat.tracks.flatMap((t) => t.clips).find((c) => c.id === id));
  assert.equal(of(a, `S${FLAT_SEP}H`), of(b, `S${FLAT_SEP}H`));
  assert.notEqual(of(a, `S${FLAT_SEP}L`), of(b, `S${FLAT_SEP}L`));
});

test('同一被引用剪辑引用两次:各实例各自 id、各自露出窗口', () => {
  const p = fixture();
  p.tracks.push({ id: 't3', clips: [{ id: 'S3', cardId: '', cutId: 'B', cutOffset: 0, start: 7, end: 9 }] });
  const ids = flatPlanProject(p).tracks.flatMap((t) => t.clips).map((c) => c.id);
  assert.ok(ids.includes(`S${FLAT_SEP}H`) && ids.includes(`S3${FLAT_SEP}H`));
});

test('withFlatNodes 给虚拟片段的基节点补 flat;隔离工程只留链上的段与目标卡', () => {
  const p = fixture();
  const flat = flatPlanProject(p);
  const id = `S${FLAT_SEP}S2${FLAT_SEP}X`;
  const graph = withFlatNodes(flat, { nodes: [{ id: `@clip/${id}/source`, clipId: id }, { id: '@clip/T/source', clipId: 'T' }], outputs: [] });
  assert.equal(graph.nodes[0].flat.lead, 0);
  assert.deepEqual(graph.nodes[0].flat.chain.map((s) => s.id), ['S', 'S2']);
  assert.equal(graph.nodes[1].flat, undefined);
  const iso = isolatedFlatProject(p, id, (c) => ({ ...c, frame: { x: 10, y: 20, w: 1, h: 1 } }));
  const visible = (tracks) => tracks.filter((t) => !t.hidden).flatMap((t) => t.clips.map((c) => c.id));
  assert.deepEqual(visible(iso.tracks), ['S']);
  const S = iso.tracks.find((t) => !t.hidden).clips[0];
  assert.equal(S.frame, undefined, '段去掉框,嵌套场景 1:1');
  assert.equal(S.cutOffset, 1);
  assert.deepEqual(visible(iso.cuts.find((c) => c.id === 'B').tracks), ['S2']);
  assert.deepEqual(visible(iso.cuts.find((c) => c.id === 'C').tracks), ['X']);
  assert.deepEqual(iso.cuts.find((c) => c.id === 'C').tracks.find((t) => !t.hidden).clips[0].frame, { x: 10, y: 20, w: 1, h: 1 });
  assert.equal(p.tracks[1].clips[0].frame.w, 960, '不改原项目');
  assert.equal(isolatedFlatProject(p, 'T'), null);
});
