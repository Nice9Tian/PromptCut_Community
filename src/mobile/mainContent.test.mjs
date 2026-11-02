/**
 * Main content of mobile app mini timeline (the two-step extraction at the top of `mainContent.ts`):
 * blocks can be extracted for any project shape, blocks exist at both ends, only one block at any
 * moment, blocks ordered by time, current-frame marker conversion does not break. Task brief
 * `docs/plan/mobile-thumbstrip-task.md` acceptance checks 1-4.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainClipsOf, mainTrackOf, planReorder, timeAtCardPos, cardPosAtTime } from './mainContent.ts';

const media = [
  { id: 'mv', kind: 'video', name: 'Waves.mp4', url: 'x' },
  { id: 'mi', kind: 'image', name: 'Group photo.jpg', url: 'y' },
  { id: 'ma', kind: 'audio', name: 'Guitar.mp3', url: 'z' },
];
const project = (tracks, transitions = []) => ({ version: 1, name: 'p', width: 1920, height: 1080, fps: 30, duration: 30, themeId: 'm', media, tracks, transitions, cuts: [{ id: 'k1', name: 'Intro' }] });
const clip = (id, start, end, extra = {}) => ({ id, cardId: 'c', start, end, params: {}, ...extra });
const vid = (id, start, end, extra = {}) => clip(id, start, end, { cardId: '', mediaId: 'mv', ...extra });
const span = (cs) => cs.map((c) => [c.id, c.start, c.end]);

/**
 * Invariants that must hold for every shape: non-empty, first block starts from visible content
 * start, last block extends to end, ordered by time, non-overlapping (except for two crossfading
 * clips)
 */
function shapeOk(p, label, { overlapOk = false } = {}) {
  const m = mainClipsOf(p);
  assert.ok(m.length > 0, `${label}: should not be empty`);
  const vis = p.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips).filter((c) => c.mediaId !== 'ma');
  assert.equal(m[0].start, Math.min(...vis.map((c) => c.start)), `${label}: the first block starts at the earliest visible content`);
  assert.equal(Math.max(...m.map((c) => c.end)), Math.max(...vis.map((c) => c.end)), `${label}: the last block extends to the end`);
  for (let i = 1; i < m.length; i++) {
    assert.ok(m[i].start >= m[i - 1].start, `${label}: sorted by time`);
    if (!overlapOk) assert.ok(m[i].start >= m[i - 1].end - 1e-6, `${label}: only one block at any moment`);
  }
  // Current frame marker: endpoints fall on first block start and last block end; middle conversion
  // is round-trip consistent
  assert.equal(timeAtCardPos(m, 0), m[0].start);
  assert.equal(timeAtCardPos(m, m.length), m[m.length - 1].end);
  if (!overlapOk) {
    for (const c of m) {
      const mid = (c.start + c.end) / 2;
      assert.ok(Math.abs(timeAtCardPos(m, cardPosAtTime(m, mid)) - mid) < 1e-9, `${label}: the midpoint of ${c.id} converts back and forth consistently`);
    }
  }
  return m;
}

test('MCA1 Card clips only: stacked cards are taken as "the longest clip at this moment", and only one block is kept at any moment', () => {
  const p = project([
    { id: 't1', name: 'x', clips: [clip('title', 0, 2), clip('sub', 5, 6)] },
    { id: 't2', name: 'Bottom', clips: [clip('bg', 0, 8)] },
  ]);
  const m = shapeOk(p, 'Cards only');
  assert.deepEqual(span(m), [['bg', 0, 8]], 'The 8-second background card underneath covers the entire span, and the text card above does not show through');
});

test('MCA2 Card clips only, one after another on different tracks: all are joined in time order', () => {
  const p = project([
    { id: 't1', name: 'Upper', clips: [clip('b', 3, 5)] },
    { id: 't2', name: 'Lower', clips: [clip('a', 0, 3), clip('c', 5, 9)] },
  ]);
  assert.deepEqual(span(shapeOk(p, 'Card relay')), [['a', 0, 3], ['b', 3, 5], ['c', 5, 9]]);
});

test('MCA3 Only one clip: a video clip, a card clip and a very short card clip are all picked up', () => {
  assert.deepEqual(span(shapeOk(project([{ id: 't', name: 's', clips: [vid('v', 0, 4)] }]), 'One video clip')), [['v', 0, 4]]);
  assert.deepEqual(span(shapeOk(project([{ id: 't', name: 's', clips: [clip('k', 0, 4)] }]), 'One card clip')), [['k', 0, 4]]);
  assert.deepEqual(span(shapeOk(project([{ id: 't', name: 's', clips: [clip('k', 0, 0.2)] }]), '0.2-second card')), [['k', 0, 0.2]]);
  assert.deepEqual(mainClipsOf(project([{ id: 't', name: 's', clips: [] }])), [], 'Empty when there are no clips at all (the title row prompts to add media)');
});

test('MCA4 There are gaps between clips: if another clip lies in a gap, fill it in, taking only the part that falls inside the gap; if a gap has nothing in it, leave it', () => {
  const p = project([
    { id: 't1', name: 'Upper', clips: [clip('intro', 0, 3), clip('mid', 5, 9), clip('outro', 11, 14)] },
    { id: 't2', name: 'Lower', clips: [vid('v1', 2, 6), vid('v2', 8, 12)] },
  ]);
  const m = shapeOk(p, 'Gap');
  assert.deepEqual(span(m), [['intro', 0, 2], ['v1', 2, 6], ['mid', 6, 8], ['v2', 8, 12], ['outro', 12, 14]]);
  assert.equal(mainTrackOf(p).id, 't2');
  // Gaps with nothing to fill: do not fill, keep gaps between blocks as before (marker falling in
  // a gap counts as start of next clip)
  const bare = project([{ id: 't', name: 's', clips: [vid('a', 0, 2), vid('b', 5, 7)] }]);
  assert.deepEqual(span(mainClipsOf(bare)), [['a', 0, 2], ['b', 5, 7]]);
  // Filled-in video clip has its start trimmed, in point moves back accordingly, thumbnail is
  // taken from first frame of this slice
  const pip = project([
    { id: 't1', name: 'Upper', clips: [vid('over', 0, 6, { mediaOffset: 1 })] },
    { id: 't2', name: 'Lower', clips: [vid('main', 0, 3)] },
  ]);
  const over = mainClipsOf(pip).find((c) => c.id === 'over');
  assert.deepEqual([over.start, over.end, over.mediaOffset], [3, 6, 4]);
  assert.equal(pip.tracks[0].clips[0].start, 0, 'clip in the project was not modified');
});

test('MCA5 gaps shorter than the gate are not filled; clips that are audio or on hidden tracks are not filled', () => {
  const p = project([
    { id: 'th', name: 'H', hidden: true, clips: [clip('hid', 4, 10)] },
    { id: 'ta', name: 'A', clips: [clip('music', 0, 12, { cardId: '', mediaId: 'ma' })] },
    { id: 't1', name: 'Upper', clips: [clip('blip', 4, 4.3), clip('tail', 10, 12)] },
    { id: 't2', name: 'Lower', clips: [vid('a', 0, 4), vid('b', 4.3, 10)] },
  ]);
  assert.deepEqual(span(mainClipsOf(p)), [['a', 0, 4], ['b', 4.3, 10], ['tail', 10, 12]]);
});

test('MCA6 with equal duration, pick the lower track; the longer one takes priority', () => {
  const tie = project([
    { id: 't1', name: 'Upper', clips: [clip('up', 0, 3)] },
    { id: 't2', name: 'Lower', clips: [clip('down', 0, 3)] },
  ]);
  assert.deepEqual(span(mainClipsOf(tie)), [['down', 0, 3]]);
  const longer = project([
    { id: 't1', name: 'Upper', clips: [clip('long', 0, 5)] },
    { id: 't2', name: 'Lower', clips: [clip('short', 0, 3)] },
  ]);
  assert.deepEqual(span(mainClipsOf(longer)), [['long', 0, 5]]);
});

test('MCA7 with a transition: the clip after a dissolve still counts; a dissolve with only cards also yields both clips', () => {
  const p = project([
    { id: 't1', name: 'Upper', clips: [vid('v2', 3.5, 7)] },
    { id: 't2', name: 'Lower', clips: [vid('v1', 0, 4)] },
  ], [{ id: 'x', kind: 'crossfade', aId: 'v1', bId: 'v2', dur: 0.5 }]);
  assert.deepEqual(span(shapeOk(p, 'video dissolve', { overlapOk: true })), [['v1', 0, 4], ['v2', 3.5, 7]]);
  const cards = project([
    { id: 't1', name: 'Upper', clips: [clip('k2', 2.5, 6)] },
    { id: 't2', name: 'Lower', clips: [clip('k1', 0, 3)] },
  ], [{ id: 'x', kind: 'crossfade', aId: 'k1', bId: 'k2', dur: 0.5 }]);
  assert.deepEqual(span(shapeOk(cards, 'card dissolve')), [['k1', 0, 3], ['k2', 3, 6]]);
});

test('MCA8 with a nested cut segment: the cut segment is the main content, and cards before and after fill out to both ends', () => {
  const p = project([
    { id: 't1', name: 'Upper', clips: [clip('open', 0, 2), clip('end', 7, 9)] },
    { id: 't2', name: 'Lower', clips: [clip('k', 2, 7, { cardId: '', cutId: 'k1' })] },
  ]);
  assert.deepEqual(span(shapeOk(p, 'Cut segment')), [['open', 0, 2], ['k', 2, 7], ['end', 7, 9]]);
});

test('MCA9 reorder: filled-in clips (not on the main track, or only a slice taken) cannot move; clips on the main track move as usual', () => {
  const p = project([
    { id: 't1', name: 'Upper', clips: [clip('card', 4, 6)] },
    { id: 't2', name: 'Lower', clips: [vid('a', 0, 2), vid('b', 2, 4)] },
  ]);
  assert.deepEqual(mainClipsOf(p).map((c) => c.id), ['a', 'b', 'card']);
  assert.deepEqual(planReorder(p, ['b', 'a', 'card']), { moves: [{ id: 'b', start: 0 }, { id: 'a', start: 2 }] });
  assert.ok('error' in planReorder(p, ['card', 'a', 'b']));
});

test('MCA10 one long backing card can fill several gaps with a slice each, with chunks at both ends', () => {
  const p = project([
    { id: 't1', name: 'Upper', clips: [vid('v1', 2, 5), vid('v2', 7, 10)] },
    { id: 't2', name: 'Bottom', clips: [clip('bg', 0, 12)] },
  ]);
  assert.equal(mainTrackOf(p).id, 't1');
  assert.deepEqual(span(shapeOk(p, 'backing card')), [['bg', 0, 2], ['v1', 2, 5], ['bg', 5, 7], ['v2', 7, 10], ['bg', 10, 12]]);
});

test('MCA11 a speed change shortens a clip on the main track: the leftover gap is still filled with chunks, and the long card used to fill takes only that slice', () => {
  // Speed (claude/clip-speed, user decision, 2026-10-23): leaves a gap at the tail when shortened,
  // following clips do not move.
  // Here simulates b sped up from 4-10 to 4-7, leaving a 7-10 gap on the main track; an underlying
  // 0-10 card lies beneath.
  const p = project([
    { id: 't1', name: 'Bottom', clips: [clip('bg', 0, 10)] },
    { id: 't2', name: 'Main', clips: [vid('a', 0, 4), vid('b', 4, 7, { speed: 2 })] },
  ]);
  assert.equal(mainTrackOf(p).id, 't2');
  // The gap only fills that slice (7-10), not the entire 0-10; still only one block at any moment
  assert.deepEqual(span(shapeOk(p, 'speed change leaves gap')), [['a', 0, 4], ['b', 4, 7], ['bg', 7, 10]]);
});

test('MCA12 a speed change creates a gap in the middle of the main track: with no other track covering it, it stays empty, and both ends still have chunks', () => {
  // Also shortened leaving a gap, but with no card underneath: the gap cannot be filled,
  // block count remains unchanged, no error thrown, and both ends have blocks as usual
  const p = project([
    { id: 't1', name: 'Main', clips: [vid('a', 0, 4), vid('b', 4, 7, { speed: 2 }), vid('c', 10, 14)] },
  ]);
  assert.deepEqual(span(shapeOk(p, 'middle gap cannot be filled')), [['a', 0, 4], ['b', 4, 7], ['c', 10, 14]]);
});

test('MCA13 the gate for a short project is 5% of total length: seams smaller than the gate are not filled, only seams larger than the gate are', () => {
  // Total duration 4 seconds → gate min(0.5, 4×0.05) = 0.2 seconds.
  // A 0.1-second gap (error between two adjacent segments) should not produce fragmented blocks;
  // a 0.5-second gap (e.g. 1-second asset changed to 2×) should be filled.
  const tiny = project([
    { id: 't1', name: 'Bottom', clips: [clip('bg', 0, 4)] },
    { id: 't2', name: 'Main', clips: [vid('a', 0, 2), vid('b', 2.1, 4)] },
  ]);
  assert.deepEqual(span(shapeOk(tiny, 'short project · small seam')), [['a', 0, 2], ['b', 2.1, 4]]);

  const wide = project([
    { id: 't1', name: 'Bottom', clips: [clip('bg', 0, 4)] },
    { id: 't2', name: 'Main', clips: [vid('a', 0, 2), vid('b', 2.5, 4)] },
  ]);
  assert.deepEqual(span(shapeOk(wide, 'short project · large seam')), [['a', 0, 2], ['bg', 2, 2.5], ['b', 2.5, 4]]);
});
