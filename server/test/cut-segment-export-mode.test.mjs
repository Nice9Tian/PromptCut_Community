/**
 * Compatibility bypass (`--media=ffmpeg`) encountering video / images in cut segments: switches to
 * default full-frame route (`cutSegmentsHaveVisualMedia` in `server/bakery/export.mjs`,
 * `mechanism/rendering.md` "cut segment" compatibility bypass item).
 *
 * Run: node --test server/test/cut-segment-export-mode.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutSegmentsHaveVisualMedia } from '../bakery/export.mjs';

const media = [
  { id: 'v', kind: 'video', url: '/@media/v.mp4' },
  { id: 'i', kind: 'image', url: '/@media/i.png' },
  { id: 'a', kind: 'audio', url: '/@media/a.wav' },
];
const project = (childClips, { hidden = false, deep = false } = {}) => ({
  media, duration: 10, activeCutId: 'A',
  tracks: [{ id: 't', clips: [{ id: 's', cardId: '', cutId: deep ? 'C' : 'B', start: 0, end: 5, params: {} }] }],
  cuts: [
    { id: 'A', name: 'Cut 1' },
    { id: 'B', name: 'Cut 2', duration: 5, transitions: [], tracks: [{ id: 'tb', hidden, clips: childClips }] },
    { id: 'C', name: 'Cut 3', duration: 5, transitions: [], tracks: [{ id: 'tc', clips: [{ id: 's2', cardId: '', cutId: 'B', start: 0, end: 5, params: {} }] }] },
  ],
});

test('Only when a cut segment contains video or images (at any depth) does it switch to the full-frame path; only cards, only audio, a hidden track, or no cut segment all still take the bypass', () => {
  assert.equal(cutSegmentsHaveVisualMedia(project([{ id: 'c', cardId: '', mediaId: 'v', start: 0, end: 5, params: {} }])), true);
  assert.equal(cutSegmentsHaveVisualMedia(project([{ id: 'c', cardId: '', mediaId: 'i', start: 0, end: 5, params: {} }], { deep: true })), true, 'Two levels of nesting also count');
  assert.equal(cutSegmentsHaveVisualMedia(project([{ id: 'c', cardId: 'punch-pill', start: 0, end: 5, params: {} }])), false, 'Cards only');
  assert.equal(cutSegmentsHaveVisualMedia(project([{ id: 'c', cardId: '', mediaId: 'a', start: 0, end: 5, params: {} }])), false, 'Audio only');
  assert.equal(cutSegmentsHaveVisualMedia(project([{ id: 'c', cardId: '', mediaId: 'v', start: 0, end: 5, params: {} }], { hidden: true })), false, 'A hidden track produces no picture');
  assert.equal(cutSegmentsHaveVisualMedia({ media, tracks: [{ id: 't', clips: [{ id: 'm', cardId: '', mediaId: 'v', start: 0, end: 5 }] }] }), false, 'No cut segment: media in the active cut is still composited by the bypass');
  assert.equal(cutSegmentsHaveVisualMedia(null), false);
});
