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

test('MC1 main track = the bottom-most track holding video/image/cut segments; cards and audio do not count as main content', () => {
  const p = project([
    { id: 't1', name: '上', clips: [clip('card', 0, 3, { cardId: 'title' })] },
    { id: 't2', name: 'Medium', clips: [clip('v1', 0, 4, { mediaId: 'mv' }), clip('i1', 4, 6, { mediaId: 'mi' }), clip('k', 6, 9, { cutId: 'k1' })] },
    { id: 't3', name: '下', clips: [clip('a1', 0, 9, { mediaId: 'ma' })] },
  ]);
  assert.equal(mainTrackOf(p).id, 't2');
  assert.deepEqual(mainClipsOf(p).map((c) => c.id), ['v1', 'i1', 'k']);
  assert.deepEqual(mainClipsOf(p).map((c) => clipKind(p, c)), ['video', 'image', 'cut']);
  assert.equal(mainTotal(mainClipsOf(p)), 9);
});

test('MC2 with no video/image/cut segments: the main track is the bottom-most one, and card clips fill in as main content (user decision, 2026-10-23); empty when there are no clips at all', () => {
  const p = project([{ id: 't1', name: '上', clips: [clip('card', 0, 3, { cardId: 'title' })] }, { id: 't2', name: '下', clips: [] }]);
  assert.equal(mainTrackOf(p).id, 't2');
  assert.deepEqual(mainClipsOf(p).map((c) => c.id), ['card']);
  assert.deepEqual(mainClipsOf(project([{ id: 't', name: 's', clips: [] }])), []);
});

test('MC3 the clip after a crossfade moved to another track still counts as main content; boundary transitions are recognized in the order dissolve → fade out → fade in', () => {
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

test('MC4 reorder: keep gaps, and when durations differ later positions shift along; reject when hitting another clip or a transition lock', () => {
  const p = project([{ id: 't', name: 's', clips: [clip('a', 0, 2, { mediaId: 'mv' }), clip('b', 3, 7, { mediaId: 'mv' }), clip('c', 7, 8, { mediaId: 'mi' })] }]);
  assert.deepEqual(planReorder(p, ['b', 'a', 'c']), { moves: [{ id: 'b', start: 0 }, { id: 'a', start: 5 }] });
  assert.deepEqual(planReorder(p, ['a', 'b', 'c']), { moves: [] });
  // 结尾那段卡片(0.5 秒,不短于空档门槛)补进了主要内容,换顺序时它留在原位
  const crowded = project([{ id: 't', name: 's', clips: [clip('a', 0, 2, { mediaId: 'mv' }), clip('b', 2, 6, { mediaId: 'mv' }), clip('card', 6, 6.5, { cardId: 'x' })] }]);
  assert.deepEqual(planReorder(crowded, ['b', 'a', 'card']), { moves: [{ id: 'b', start: 0 }, { id: 'a', start: 4 }] }, '4+2 exactly fills 0~6, no collision with the card');
  // 卡片短于空档门槛,不补进来,换顺序时仍会撞到它
  const tight = project([{ id: 't', name: 's', clips: [clip('a', 0, 2, { mediaId: 'mv' }), clip('card', 2, 2.3, { cardId: 'x' }), clip('b', 2.3, 6.3, { mediaId: 'mv' })] }]);
  assert.deepEqual(mainClipsOf(tight).map((c) => c.id), ['a', 'b']);
  assert.ok('error' in planReorder(tight, ['b', 'a']));
  const locked = project([{ id: 't', name: 's', clips: [clip('a', 0, 2, { mediaId: 'mv', fadeIn: 0.6 }), clip('b', 2, 4, { mediaId: 'mv' })] }], [{ id: 'f', kind: 'fadeIn', aId: 'a', dur: 0.6 }]);
  assert.ok('error' in planReorder(locked, ['b', 'a']));
  assert.ok('error' in planReorder(p, ['a', 'b']), 'order is missing a clip');
});

test('MC5 current frame marker: in-card ratio ⇄ project time, and a gap between two clips counts as the start of the next clip', () => {
  const cs = [clip('a', 0, 2), clip('b', 3, 7)];
  assert.equal(timeAtCardPos(cs, 0.5), 1);
  assert.equal(timeAtCardPos(cs, 1.25), 4);
  assert.equal(timeAtCardPos(cs, 9), 7);
  assert.equal(cardPosAtTime(cs, 1), 0.5);
  assert.equal(cardPosAtTime(cs, 2.5), 1);
  assert.equal(cardPosAtTime(cs, 5), 1.5);
  assert.equal(cardPosAtTime(cs, 8), 2);
});

test('ZM1 pixels per second clamped to 6~120; fit-to-width leaves margins; tick interval varies with scale', () => {
  assert.equal(clampPx(1), PX_MIN);
  assert.equal(clampPx(500), PX_MAX);
  assert.equal(fitPx(330, 24), (330 - TL_PAD - 12) / 24);
  assert.equal(fitPx(330, 1000), PX_MIN);
  assert.equal(rulerStep(120), 0.5);
  assert.equal(rulerStep(22), 2);
  assert.equal(rulerStep(6), 10);
});

test('ZM2 zooming around a point: the time under that point stays the same before and after zooming', () => {
  const px = 20, sl = 100, ax = 150;
  const before = (sl + ax - TL_PAD) / px;
  const r = zoomAround(px, sl, ax, px * 1.25);
  assert.equal(r.px, 25);
  assert.ok(Math.abs((r.scrollLeft + ax - TL_PAD) / r.px - before) < 1e-9);
  assert.equal(playheadX(20, 100, 10), 10 * 20 + TL_PAD - 100);
  assert.equal(zoomAround(20, 0, TL_PAD, 16).scrollLeft, 0, 'position under second 0 stays the same');
  assert.equal(zoomAround(20, 0, 0, 40).scrollLeft, 0, 'does not scroll negative');
});
