/**
 * 兼容旁路(`--media=ffmpeg`)遇到剪辑段里的视频 / 图片:改走缺省的完整整帧路线(`server/bakery/export.mjs` 的
 * `cutSegmentsHaveVisualMedia`,`mechanism/rendering.md`「剪辑段」兼容旁路一条)。
 *
 * 跑:node --test server/test/cut-segment-export-mode.test.mjs
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
    { id: 'A', name: '剪辑1' },
    { id: 'B', name: '剪辑2', duration: 5, transitions: [], tracks: [{ id: 'tb', hidden, clips: childClips }] },
    { id: 'C', name: '剪辑3', duration: 5, transitions: [], tracks: [{ id: 'tc', clips: [{ id: 's2', cardId: '', cutId: 'B', start: 0, end: 5, params: {} }] }] },
  ],
});

test('剪辑段里有视频或图片(任意深度)才改走完整整帧;只有卡、只有声音、序列隐藏、没有剪辑段都照旧走旁路', () => {
  assert.equal(cutSegmentsHaveVisualMedia(project([{ id: 'c', cardId: '', mediaId: 'v', start: 0, end: 5, params: {} }])), true);
  assert.equal(cutSegmentsHaveVisualMedia(project([{ id: 'c', cardId: '', mediaId: 'i', start: 0, end: 5, params: {} }], { deep: true })), true, '两层嵌套也算');
  assert.equal(cutSegmentsHaveVisualMedia(project([{ id: 'c', cardId: 'punch-pill', start: 0, end: 5, params: {} }])), false, '只有卡');
  assert.equal(cutSegmentsHaveVisualMedia(project([{ id: 'c', cardId: '', mediaId: 'a', start: 0, end: 5, params: {} }])), false, '只有声音');
  assert.equal(cutSegmentsHaveVisualMedia(project([{ id: 'c', cardId: '', mediaId: 'v', start: 0, end: 5, params: {} }], { hidden: true })), false, '隐藏的序列不出画面');
  assert.equal(cutSegmentsHaveVisualMedia({ media, tracks: [{ id: 't', clips: [{ id: 'm', cardId: '', mediaId: 'v', start: 0, end: 5 }] }] }), false, '没有剪辑段:激活剪辑里的素材照旧由旁路合成');
  assert.equal(cutSegmentsHaveVisualMedia(null), false);
});
