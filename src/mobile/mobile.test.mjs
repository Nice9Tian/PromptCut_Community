/**
 * 手机版界面的纯函数:主要内容(`mainContent.ts`)与完整时间轴缩放(`zoom.ts`)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainTrackOf, mainClipsOf, boundaryTransition, planReorder, timeAtCardPos, cardPosAtTime, mainTotal, clipKind } from './mainContent.ts';
import { clampPx, fitPx, rulerStep, zoomAround, playheadX, PX_MIN, PX_MAX, TL_PAD } from './zoom.ts';

const media = [
  { id: 'mv', kind: 'video', name: '海浪.mp4', url: 'x' },
  { id: 'mi', kind: 'image', name: '合照.jpg', url: 'y' },
  { id: 'ma', kind: 'audio', name: '吉他.mp3', url: 'z' },
];
const project = (tracks, transitions = []) => ({ version: 1, name: 'p', width: 1920, height: 1080, fps: 30, duration: 30, themeId: 'm', media, tracks, transitions, cuts: [{ id: 'k1', name: '片头' }] });
const clip = (id, start, end, extra = {}) => ({ id, cardId: '', start, end, params: {}, ...extra });

test('MC1 主轨 = 最底下那条放着视频/图片/剪辑段的序列;卡片、声音不算主要内容', () => {
  const p = project([
    { id: 't1', name: '上', clips: [clip('card', 0, 3, { cardId: 'title' })] },
    { id: 't2', name: '中', clips: [clip('v1', 0, 4, { mediaId: 'mv' }), clip('i1', 4, 6, { mediaId: 'mi' }), clip('k', 6, 9, { cutId: 'k1' })] },
    { id: 't3', name: '下', clips: [clip('a1', 0, 9, { mediaId: 'ma' })] },
  ]);
  assert.equal(mainTrackOf(p).id, 't2');
  assert.deepEqual(mainClipsOf(p).map((c) => c.id), ['v1', 'i1', 'k']);
  assert.deepEqual(mainClipsOf(p).map((c) => clipKind(p, c)), ['video', 'image', 'cut']);
  assert.equal(mainTotal(mainClipsOf(p)), 9);
});

test('MC2 没有视频/图片/剪辑段:主轨是最底下那条,卡片段补进主要内容(2026-10-23 用户定);一段都没有时为空', () => {
  const p = project([{ id: 't1', name: '上', clips: [clip('card', 0, 3, { cardId: 'title' })] }, { id: 't2', name: '下', clips: [] }]);
  assert.equal(mainTrackOf(p).id, 't2');
  assert.deepEqual(mainClipsOf(p).map((c) => c.id), ['card']);
  assert.deepEqual(mainClipsOf(project([{ id: 't', name: 's', clips: [] }])), []);
});

test('MC3 交叉溶解挪到别的序列上的后一段仍算主要内容;边界转场按 溶解 → 淡出 → 淡入 认', () => {
  const tr = { id: 'x1', kind: 'crossfade', aId: 'v1', bId: 'v2', dur: 0.5 };
  const p = project([
    { id: 't1', name: '上', clips: [clip('v2', 3.5, 7, { mediaId: 'mv' })] },
    { id: 't2', name: '下', clips: [clip('v1', 0, 4, { mediaId: 'mv' }), clip('v3', 7, 9, { mediaId: 'mi' })] },
  ], [tr, { id: 'f1', kind: 'fadeIn', aId: 'v3', dur: 0.6 }]);
  const m = mainClipsOf(p);
  assert.deepEqual(m.map((c) => c.id), ['v1', 'v2', 'v3']);
  assert.equal(boundaryTransition(p, m[0], m[1]).id, 'x1');
  assert.equal(boundaryTransition(p, m[1], m[2]).id, 'f1');
  const bare = project([{ id: 't', name: 's', clips: [clip('a', 0, 2, { mediaId: 'mv' }), clip('b', 2, 4, { mediaId: 'mv' })] }]);
  assert.equal(boundaryTransition(bare, ...mainClipsOf(bare)), null);
});

test('MC4 换顺序:保留空档,时长不同时后面的位置跟着移;撞到别的段或有转场锁时拒绝', () => {
  const p = project([{ id: 't', name: 's', clips: [clip('a', 0, 2, { mediaId: 'mv' }), clip('b', 3, 7, { mediaId: 'mv' }), clip('c', 7, 8, { mediaId: 'mi' })] }]);
  assert.deepEqual(planReorder(p, ['b', 'a', 'c']), { moves: [{ id: 'b', start: 0 }, { id: 'a', start: 5 }] });
  assert.deepEqual(planReorder(p, ['a', 'b', 'c']), { moves: [] });
  // 结尾那段卡片(0.5 秒,不短于空档门槛)补进了主要内容,换顺序时它留在原位
  const crowded = project([{ id: 't', name: 's', clips: [clip('a', 0, 2, { mediaId: 'mv' }), clip('b', 2, 6, { mediaId: 'mv' }), clip('card', 6, 6.5, { cardId: 'x' })] }]);
  assert.deepEqual(planReorder(crowded, ['b', 'a', 'card']), { moves: [{ id: 'b', start: 0 }, { id: 'a', start: 4 }] }, '4+2 正好排满 0～6,不撞卡片');
  // 卡片短于空档门槛,不补进来,换顺序时仍会撞到它
  const tight = project([{ id: 't', name: 's', clips: [clip('a', 0, 2, { mediaId: 'mv' }), clip('card', 2, 2.3, { cardId: 'x' }), clip('b', 2.3, 6.3, { mediaId: 'mv' })] }]);
  assert.deepEqual(mainClipsOf(tight).map((c) => c.id), ['a', 'b']);
  assert.ok('error' in planReorder(tight, ['b', 'a']));
  const locked = project([{ id: 't', name: 's', clips: [clip('a', 0, 2, { mediaId: 'mv', fadeIn: 0.6 }), clip('b', 2, 4, { mediaId: 'mv' })] }], [{ id: 'f', kind: 'fadeIn', aId: 'a', dur: 0.6 }]);
  assert.ok('error' in planReorder(locked, ['b', 'a']));
  assert.ok('error' in planReorder(p, ['a', 'b']), '顺序缺段');
});

test('MC5 当前帧标记:卡内比例 ⇄ 项目时间,两段之间的空档算下一段开头', () => {
  const cs = [clip('a', 0, 2), clip('b', 3, 7)];
  assert.equal(timeAtCardPos(cs, 0.5), 1);
  assert.equal(timeAtCardPos(cs, 1.25), 4);
  assert.equal(timeAtCardPos(cs, 9), 7);
  assert.equal(cardPosAtTime(cs, 1), 0.5);
  assert.equal(cardPosAtTime(cs, 2.5), 1);
  assert.equal(cardPosAtTime(cs, 5), 1.5);
  assert.equal(cardPosAtTime(cs, 8), 2);
});

test('ZM1 每秒像素夹在 6～120;适应宽度留边;刻度间隔随比例变', () => {
  assert.equal(clampPx(1), PX_MIN);
  assert.equal(clampPx(500), PX_MAX);
  assert.equal(fitPx(330, 24), (330 - TL_PAD - 12) / 24);
  assert.equal(fitPx(330, 1000), PX_MIN);
  assert.equal(rulerStep(120), 0.5);
  assert.equal(rulerStep(22), 2);
  assert.equal(rulerStep(6), 10);
});

test('ZM2 以某一点为中心缩放:缩放前后这一点对着的时间不变', () => {
  const px = 20, sl = 100, ax = 150;
  const before = (sl + ax - TL_PAD) / px;
  const r = zoomAround(px, sl, ax, px * 1.25);
  assert.equal(r.px, 25);
  assert.ok(Math.abs((r.scrollLeft + ax - TL_PAD) / r.px - before) < 1e-9);
  assert.equal(playheadX(20, 100, 10), 10 * 20 + TL_PAD - 100);
  assert.equal(zoomAround(20, 0, TL_PAD, 16).scrollLeft, 0, '第 0 秒对着的位置不变');
  assert.equal(zoomAround(20, 0, 0, 40).scrollLeft, 0, '不滚到负的');
});
