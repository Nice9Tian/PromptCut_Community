import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardMountedAt, planFrameWindow, framesInWindow } from './frameWindow.mjs';
import { cardFrameMode, clipFrameMode, cardCapabilities } from '../kernel/frameMode.mjs';

test('late preview replays only the active cards, independent of preceding timeline length', () => {
  const clips = [
    { id: 'expired', cardId: 'particles', start: 0, end: 299 },
    { id: 'top', cardId: 'title', start: 300, end: 303 },
    { id: 'bottom', cardId: 'graph', start: 299, end: 304 },
    { id: 'future', cardId: 'title', start: 304, end: 310 },
    { id: 'video', mediaId: 'v', start: 0, end: 900 },
  ];
  assert.deepEqual(planFrameWindow(clips, [3010], 10), { startFrame: 2990, endFrame: 3010, clipIds: ['top', 'bottom'], replayClipIds: ['top', 'bottom'], ranges: [[2990, 3010]] });
  const shifted = clips.map(c => ({ ...c, start: c.start + 3600, end: c.end + 3600 }));
  assert.equal(planFrameWindow(shifted, [39010], 10).startFrame, 38990);
});
test('media-only frames seek immediately and ended cards are excluded', () => {
  assert.deepEqual(planFrameWindow([{ id: 'done', cardId: 'x', start: 0, end: 600 }], [18000], 30), {
    startFrame: 18000, endFrame: 18000, clipIds: [], replayClipIds: [], ranges: [[18000, 18000]],
  });
});
test('the first replay frame matches Stage pre-mount boundaries at different frame rates', () => {
  for (const fps of [10, 24, 30, 60]) for (const start of [0, 1, 1.05, 10.05, 300.017]) {
    const clip = { id: 'x', cardId: 'x', start, end: start + 1 };
    const frame = Math.ceil((start + 0.1) * fps);
    const plan = planFrameWindow([clip], [frame], fps);
    assert.ok(cardMountedAt(clip, plan.startFrame / fps));
    if (plan.startFrame > 0) assert.equal(cardMountedAt(clip, (plan.startFrame - 1) / fps), false);
  }
});
test('a batch keeps all requested cards without pulling unrelated cards into the pass', () => {
  const clips = [
    { id: 'a', cardId: 'x', start: 10, end: 11 },
    { id: 'unrelated', cardId: 'x', start: 11, end: 12 },
    { id: 'b', cardId: 'x', start: 12, end: 13 },
  ];
  assert.deepEqual(planFrameWindow(clips, [124, 103, 124], 30), { startFrame: 103, endFrame: 124, clipIds: [], replayClipIds: [], ranges: [[103, 103], [124, 124]] });
  assert.deepEqual(planFrameWindow(clips, [124, 103, 124], 10), { startFrame: 100, endFrame: 124, clipIds: ['a', 'b'], replayClipIds: ['a', 'b'], ranges: [[100, 103], [120, 124]] });
});
test('only stateful cards contribute replay history; direct batches skip all gaps', () => {
  const clips = [{ id: 'paper', cardId: 'paper', start: 0, end: 900 }, { id: 'caption', cardId: 'caption', start: 0, end: 900 }];
  const direct = planFrameWindow(clips, [18000, 12000, 18000], 30, () => 'direct');
  assert.equal(direct.startFrame, 12000);
  assert.deepEqual(direct.replayClipIds, []);
  assert.deepEqual([...framesInWindow(direct.ranges)], [12000, 18000]);
  clips.push({ id: 'motion', cardId: 'motion', start: 599, end: 602 });
  const mixed = planFrameWindow(clips, [18000], 30, c => c.id === 'motion' ? 'stateful' : 'direct');
  assert.deepEqual(mixed.replayClipIds, ['motion']);
  assert.equal(mixed.startFrame, 17969);
});
test('unknown React wrappers retain history; static legacy cards and explicit direct cards can seek', () => {
  assert.equal(cardFrameMode(), 'stateful');
  assert.equal(cardFrameMode({ Component() {} }), 'stateful');
  const paper = { lifecycle: { settleMs: 0, after: 'hold' } };
  assert.equal(cardFrameMode(paper), 'direct');
  assert.equal(cardFrameMode({ ...paper, frameMode: 'stateful' }), 'stateful');
  assert.equal(cardFrameMode({ frameMode: 'direct' }), 'direct');
  assert.equal(clipFrameMode({ parts: [{}] }, { frameMode: 'direct' }), 'stateful');
});

test('framework-only legacy declarations retain history until time access is declared', () => {
  const clips = [
    { id: 'caption', cardId: 'caption', start: 0, end: 900, params: {} },
    { id: 'particles', cardId: 'particles', start: 599, end: 602, params: {} },
  ];
  const old = { caption: { frameMode: 'react' }, particles: { frameMode: 'non-react' } };
  const current = { caption: { frameMode: 'stateful' }, particles: { frameMode: 'stateful' } };
  for (const clip of clips) assert.equal(clipFrameMode(clip, old[clip.cardId]), clipFrameMode(clip, current[clip.cardId]));
  const plan = defs => planFrameWindow(clips, [18015], 30, clip => clipFrameMode(clip, defs[clip.cardId]));
  assert.deepEqual(plan(old), plan(current));
  assert.deepEqual(plan(old).replayClipIds, ['caption', 'particles']);
  // The exported planner also accepts old callbacks without losing history.
  assert.deepEqual(planFrameWindow(clips, [18015], 30, clip => old[clip.cardId].frameMode), plan(current));
});

test('explicit stateful declarations override static fallback, including old projects', () => {
  const paper = { lifecycle: { settleMs: 0, after: 'hold' } };
  for (const frameMode of ['stateful', 'non-react']) assert.equal(cardFrameMode({ ...paper, frameMode }), 'stateful');
  for (const frameMode of ['direct']) {
    assert.equal(cardFrameMode({ frameMode }), 'direct');
    assert.equal(clipFrameMode({ parts: [{}] }, { frameMode }), 'stateful');
  }
  assert.equal(cardFrameMode({ frameMode: 'unknown' }), 'stateful');
  assert.equal(cardFrameMode({ timing() { throw new Error('broken declaration'); } }), 'stateful');
});

test('prerendering and independent compositing remain separate for all four combinations', () => {
  // A0.2:independent 的唯一权威是审阅表 src/cards/capabilities.json,所以这里用真的卡 id ——
  // punch-pill 表里是 independent,blur-text 是 belowDependent(毛玻璃)。
  for (const need_prerendering of [true, false]) for (const [id, independent] of [['blur-text', false], ['punch-pill', true]]) {
    const caps = cardCapabilities({ id, need_prerendering });
    assert.equal(caps.need_prerendering, need_prerendering);
    assert.equal(caps.independentCache, independent);
  }
  // 源码里写 compositing: 'independent' 一律不作数:审阅表里没有这张卡就是 unknown
  assert.equal(cardCapabilities({ id: 'no-such-card', compositing: 'independent' }).compositing, 'unknown');
  assert.equal(cardCapabilities({ id: 'no-such-card', compositing: 'context' }).compositing, 'context');
  assert.equal(cardCapabilities({ frameMode: 'direct' }).independentCache, false);
  assert.equal(cardCapabilities({ frameMode: 'direct', need_prerendering: true }).need_prerendering, true);
  assert.equal(cardFrameMode({ frameMode: 'react' }), 'stateful');
  assert.equal(cardFrameMode({ frameMode: 'react', need_prerendering: false }), 'direct');
});

test('mountFrameOf is the single mount formula: first frame not earlier than start - lead, exact comparisons', async () => {
  const { mountFrameOf, CARD_MOUNT_LEAD } = await import('./frameWindow.mjs');
  for (const fps of [10, 24, 25, 30, 60]) for (const start of [0, 0.02, 1, 1.05, 2, 10.05, 29 / 30, 300.017]) {
    const clip = { id: 'x', cardId: 'x', start, end: start + 1 };
    const n = mountFrameOf(clip, fps);
    assert.ok(Number.isSafeInteger(n) && n >= 0);
    assert.ok(n / fps >= start - CARD_MOUNT_LEAD, `fps=${fps} start=${start}: frame ${n} mounts before the lead`);
    if (n > 0) assert.ok((n - 1) / fps < start - CARD_MOUNT_LEAD, `fps=${fps} start=${start}: frame ${n - 1} already mounted`);
    assert.equal(planFrameWindow([clip], [n + 3], fps).startFrame, n, 'planFrameWindow must start at the same frame');
  }
  // 1.05 - 0.05 = 1 exactly in floating point? Whatever it is, Stage and planner agree by construction.
  assert.equal(mountFrameOf({ start: 1.05, end: 2 }, 30), 30);
  assert.equal(mountFrameOf({ start: 0, end: 2 }, 30), 0);
});
