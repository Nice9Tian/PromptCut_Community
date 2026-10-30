/**
 * 多项目模式的展开（`server/render-node/expand.mjs`；机制 `mechanism/rendering.md`「多项目模式的做法」第一条）。
 * 跑：npm test -- server/test/multi-project-expand.test.mjs（纯逻辑）
 *
 *   MPE1  只留这几帧上挂着的片段（含挂载提前量）；序列一条不删、留下的片段一个字不改；项目级设置原样
 *   MPE2  依赖：素材效果卡带上节点与它的输入片段；转场带上前后两段；剪辑段带上被引用剪辑里同一时刻的片段
 *   MPE3  素材与效果库：只留用到的；参数里按 id、哈希、地址引用的素材都算
 *   MPE4  「一张卡的一段」：整段里挂过的片段都留（含下层），点名的卡一定留
 *   MPE5  看画面请求：各接口要的帧、点名的卡；认不出的不展开
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandProject, lookNeed, expandLookBody, CARD_MOUNT_LEAD } from '../render-node/expand.mjs';
import { CARD_MOUNT_LEAD as STAGE_MOUNT_LEAD } from '../../src/render/frameWindow.mjs';

const H1 = '1'.repeat(64), H2 = '2'.repeat(64), H3 = '3'.repeat(64), H4 = '4'.repeat(64);
function demo() {
  return {
    id: 'p', name: 'demo', width: 640, height: 360, fps: 30, duration: 20, themeId: 'dark', style: { font: 'x' }, camera3dFov: 40,
    media: [
      { id: 'v1', kind: 'video', hash: H1, url: `/@media/${H1}` },
      { id: 'v2', kind: 'video', hash: H2, url: `/@media/${H2}` },
      { id: 'img', kind: 'image', hash: H3, url: `/@media/${H3}` },
      { id: 'unused', kind: 'image', hash: H4, url: `/@media/${H4}` },
    ],
    filters: [{ id: 'f1', kind: 'blur' }, { id: 'f-unused', kind: 'sepia' }],
    pixelMaps: [{ id: 'pm-unused', source: { mediaId: 'unused' } }],
    cardNodes: [
      { id: 'n-fx', adapter: 'card', cardId: 'user-fx', inputs: { source: { nodeId: '@clip/src/source' } } },
      { id: 'n-orphan', adapter: 'card', cardId: 'orphan-card', inputs: {} },
    ],
    transitions: [{ id: 'tr', kind: 'dissolve', aId: 'va', bId: 'vb', dur: 1 }],
    tracks: [
      { id: 'video', clips: [
        { id: 'va', mediaId: 'v1', cardId: '', start: 0, end: 5, params: {}, filter: { id: 'f1', params: {} } },
        { id: 'vb', mediaId: 'v2', cardId: '', start: 4, end: 9, params: {} },
      ] },
      { id: 'src-track', hidden: true, clips: [{ id: 'src', mediaId: 'img', cardId: '', start: 12, end: 14, params: {} }] },
      { id: 'cards', clips: [
        { id: 'c-early', cardId: 'title', start: 0, end: 2, params: { text: 'a' } },
        { id: 'c-mid', cardId: 'user-card', start: 2.5, end: 3.5, params: { image: `/@media/${H3}` } },
        { id: 'c-late', cardId: 'title', start: 10, end: 11, params: {} },
        { id: 'fx', cardId: 'user-fx', nodeId: 'n-fx', start: 6, end: 8, params: {} },
      ] },
      { id: 'seg-track', clips: [{ id: 'seg', cutId: 'cut-b', cardId: '', start: 15, end: 19, cutOffset: 1, params: {} }] },
    ],
    cuts: [
      { id: 'cut-a', name: 'A' },
      { id: 'cut-b', name: 'B', duration: 10, tracks: [{ id: 'b1', clips: [
        { id: 'b-early', cardId: 'title', start: 0, end: 1.5, params: {} },
        { id: 'b-hit', cardId: 'inner-card', start: 2, end: 4, params: {} },
        { id: 'b-late', cardId: 'title', start: 8, end: 9, params: {} },
      ] }] },
      { id: 'cut-c', name: 'C', duration: 3, tracks: [{ id: 'c1', clips: [{ id: 'c-only', cardId: 'title', start: 0, end: 3, params: {} }] }] },
    ],
    activeCutId: 'cut-a',
  };
}
const ids = (project) => project.tracks.flatMap((t) => t.clips.map((c) => c.id));

test('MPE1 只留这几帧上挂着的片段；序列不删、片段原样、项目级设置原样', () => {
  const p = demo();
  const before = structuredClone(p);
  const r = expandProject(p, { times: [1] });
  console.log('[MPE1] t=1 留下', r.clipIds.join(','), '｜卡', r.cardIds.join(','), '｜素材', r.mediaIds.join(','));
  assert.deepEqual(p, before, '不改入参');
  assert.deepEqual(ids(r.project), ['va', 'vb', 'c-early'], 'vb 不在这一刻，但和 va 有转场，跟着留');
  assert.deepEqual(r.project.tracks.map((t) => t.id), ['video', 'src-track', 'cards', 'seg-track'], '序列一条不删、次序不变');
  assert.strictEqual(r.project.tracks[0].clips[0], p.tracks[0].clips[0], '留下的片段就是原来那个对象，一个字不改');
  for (const k of ['id', 'name', 'width', 'height', 'fps', 'duration', 'themeId', 'style', 'camera3dFov', 'activeCutId']) assert.deepEqual(r.project[k], p[k], `项目级设置 ${k} 原样`);
  // 挂载提前量：2.5 起的卡在 2.45 已经挂上；再多放一帧（超集）
  assert.ok(expandProject(p, { times: [2.46] }).clipIds.includes('c-mid'), '提前量之内算挂着');
  assert.ok(!expandProject(p, { times: [2.3] }).clipIds.includes('c-mid'), '离起点超过提前量加一帧的不留');
  assert.equal(CARD_MOUNT_LEAD, STAGE_MOUNT_LEAD, '挂载提前量与舞台的同一个数');
  // 帧号与时刻等价
  assert.deepEqual(expandProject(p, { frames: [30] }).clipIds, expandProject(p, { times: [1] }).clipIds);
});

test('MPE2 依赖：素材效果卡的输入、转场的两段、剪辑段里同一时刻的片段', () => {
  const p = demo();
  // 6.5 秒：素材效果卡 fx 挂着，它的输入是隐藏序列里 12 秒处的 src（不在这一刻）
  const fx = expandProject(p, { times: [6.5] });
  console.log('[MPE2] t=6.5 留下', fx.clipIds.join(','), '｜节点', fx.nodeIds.join(','));
  assert.ok(fx.clipIds.includes('fx') && fx.clipIds.includes('src'), '输入片段跟着留');
  assert.deepEqual(fx.nodeIds, ['n-fx'], '只留走得到的节点，没用到的节点不留');
  assert.ok(fx.cardIds.includes('user-fx') && !fx.cardIds.includes('orphan-card'));
  // vb 在 6.5 挂着，它和 va 有转场：va 跟着留，转场记录也留
  assert.ok(fx.clipIds.includes('va') && fx.clipIds.includes('vb'));
  assert.deepEqual(fx.project.transitions.map((t) => t.id), ['tr']);
  // 只要了 1 秒（va 在、vb 不在）：转场把 vb 带上
  assert.ok(expandProject(p, { times: [1] }).project.transitions.length === 1);
  assert.deepEqual(expandProject(p, { times: [10.5] }).project.transitions, [], '两段都不在的转场不留');
  // 剪辑段：父时间 16 → 段里 16 - 15 + 1 = 2 秒，挂着 b-hit
  const seg = expandProject(p, { times: [16] });
  console.log('[MPE2] t=16 留下', seg.clipIds.join(','), '｜剪辑', seg.cutIds.join(','));
  assert.ok(seg.clipIds.includes('seg') && seg.clipIds.includes('b-hit'));
  assert.ok(!seg.clipIds.includes('b-early') && !seg.clipIds.includes('b-late'));
  const b = seg.project.cuts.find((c) => c.id === 'cut-b');
  assert.deepEqual(b.tracks[0].clips.map((c) => c.id), ['b-hit']);
  assert.deepEqual(seg.project.cuts.find((c) => c.id === 'cut-c').tracks[0].clips, [], '没被引用的剪辑里的片段不留（条目在）');
  assert.deepEqual(seg.cutIds, ['cut-b']);
});

test('MPE3 素材与效果库只留用到的；参数里按地址引用的素材也算', () => {
  const p = demo();
  const r = expandProject(p, { times: [3] }); // va（滤镜 f1、素材 v1）、c-mid（参数里引用 img 的地址）
  console.log('[MPE3] t=3 素材', r.mediaIds.join(','), '｜滤镜', r.project.filters.map((f) => f.id).join(','));
  assert.deepEqual(r.mediaIds, ['v1', 'v2', 'img'], 'v2 是转场带上的 vb 的素材');
  assert.deepEqual(r.project.filters.map((f) => f.id), ['f1']);
  assert.deepEqual(r.project.pixelMaps, []);
  assert.ok(!r.mediaIds.includes('unused'));
});

test('MPE4 一张卡的一段：整段里挂过的都留（含下层）；点名的一定留', () => {
  const p = demo();
  const r = expandProject(p, { spans: [[2.5, 3.5]], clipIds: ['c-mid'] });
  assert.deepEqual(r.clipIds.sort(), ['c-mid', 'va', 'vb'].sort(), '这一段里挂过的下层（va）跟着留，va 的转场带上 vb');
  // 点名的片段不在要的时间里也留
  assert.ok(expandProject(p, { times: [0.5], clipIds: ['c-late'] }).clipIds.includes('c-late'));
  // 点名的剪辑段：整段露出来的窗口都取（段 15～19、从被引用剪辑的第 1 秒起 → 段里 1～5 秒；8 秒起的 b-late 露不出来）
  const seg = expandProject(p, { times: [0], clipIds: ['seg'] });
  assert.ok(seg.clipIds.includes('b-early') && seg.clipIds.includes('b-hit'));
  assert.ok(!seg.clipIds.includes('b-late'));
});

test('MPE5 看画面请求：要的帧与点名的卡；认不出的不展开', () => {
  const p = demo();
  assert.deepEqual(lookNeed('/api/vision/snapshot', { project: p, t: 1 }).need.clipIds, []);
  // times：夹到时长内，原时刻与实际渲的那一帧都算
  const many = lookNeed('/api/vision/snapshot', { project: p, times: [1, 99] }).need.times;
  assert.ok(many.includes(1) && many.some((x) => Math.abs(x - (20 * 30 - 1) / 30) < 1e-9), '超出时长的按最后一帧');
  // 点名片段、不给时刻：取这一段的中点（与工作进程一致）
  assert.deepEqual(lookNeed('/api/vision/snapshot', { project: p, clipId: 'c-mid' }).need, { times: [3, 3], clipIds: ['c-mid'] });
  assert.equal(lookNeed('/api/vision/snapshot', { project: p, clipId: 'nope' }), null, '没有这个片段：原样转发，让工作进程回话');
  assert.deepEqual(lookNeed('/api/vision/bake', { project: p, clipId: 'c-mid' }).need, { spans: [[2.5, 3.5]], clipIds: ['c-mid'] });
  assert.equal(lookNeed('/api/ai/visual', { tool: 'get_gif', clipId: 'c-mid', after: p }).key, 'after');
  assert.equal(lookNeed('/api/ai/visual', { tool: 'see_frames', images: [] }), null);
  assert.equal(lookNeed('/api/ai/visual/render', { key: 'abc' }), null);
  const { body, expanded } = expandLookBody('/api/cards/layout', { project: p, t: 1, clipIds: ['c-late'] });
  assert.deepEqual(ids(body.project).sort(), ['c-early', 'c-late', 'va', 'vb'].sort());
  assert.equal(expanded.clipIds.length, 4);
  const same = { project: p, nothing: true };
  assert.strictEqual(expandLookBody('/api/whatever', same).body, same);
});
