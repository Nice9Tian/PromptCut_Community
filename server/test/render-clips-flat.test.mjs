/**
 * 云端 Agent 写入后要发布的片段收进剪辑段里的卡(`server/agent/service/render-clips.mjs`)。跑:node --test server/test/render-clips-flat.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderClipPicker, renderClipsOf } from '../agent/service/render-clips.mjs';
import { renderableClips } from '../agent/service/render-request.mjs';
import * as kernel from '../../src/kernel/cutFlatten.mjs';

const card = (id, start, end, extra = {}) => ({ id, cardId: 'punch-pill', params: { text: id }, start, end, ...extra });
const seg = (id, cutId, start, end, extra = {}) => ({ id, cardId: '', cutId, start, end, ...extra });

function project({ innerText = 'h', extra = [] } = {}) {
  return {
    id: 'p', width: 1280, height: 720, fps: 30, duration: 10, activeCutId: 'A', media: [{ id: 'm', kind: 'video' }],
    tracks: [
      { id: 'ta', clips: [seg('S', 'B', 0, 4), seg('S2', 'B', 5, 9)] },
      { id: 'tb', clips: [card('top', 0, 10)] },
    ],
    cuts: [
      { id: 'A', name: 'Cut 1' },
      { id: 'B', name: 'Cut 2', duration: 8, tracks: [
        { id: 'b1', clips: [card('H', 0, 8, { params: { text: innerText } }), ...extra] },
        { id: 'b2', clips: [seg('SC', 'C', 0, 8), { id: 'v', cardId: 'video', mediaId: 'm', start: 0, end: 8 }] },
      ] },
      { id: 'C', name: 'Cut 3', duration: 8, tracks: [{ id: 'c1', clips: [card('X', 0, 8)] }] },
    ],
  };
}

test('a project without cut segments: identical to renderableClips item by item', () => {
  const p = { tracks: [{ id: 't', clips: [card('a', 0, 1), card('b', 1, 2), { id: 'v', cardId: 'video', start: 0, end: 1 }] }] };
  assert.deepEqual(renderClipsOf(p, ['a', 'v'], { kernel }), renderableClips(p, ['a', 'v']));
  const picker = createRenderClipPicker(kernel);
  assert.deepEqual(picker.pick(p, ['b']), ['b']);
});

test('cards written into a referenced cut: both instances are collected (at any depth); media is not collected', () => {
  const p = project();
  const before = renderClipsOf(project(), [], { kernel, before: null });
  assert.ok(before.includes('S~H') && before.includes('S2~H') && before.includes('S~SC~X'), 'with no previous signature table, collect everything');
  assert.ok(!before.some((id) => id.endsWith('~v')), 'media clips are not collected');
  const picker = createRenderClipPicker(kernel);
  picker.prime(p);
  assert.deepEqual(picker.pick(p, ['H']).sort(), ['S2~H', 'S~H']);
  assert.deepEqual(picker.pick(p, ['X']).sort(), ['S2~SC~X', 'S~SC~X']);
  assert.deepEqual(picker.pick(p, ['top']), ['top']);
});

test('changes in ops that cannot name a clip id (switching the active cut, a whole-cut rewrite of another cut): worked out by comparing the signatures of the flattened view', () => {
  const picker = createRenderClipPicker(kernel);
  picker.prime(project());
  // 剪辑2 里那张卡改了文字,这次写入报上来的片段 id 是空的
  assert.deepEqual(picker.pick(project({ innerText: 'changed' }), []).sort(), ['S2~H', 'S~H']);
  // 剪辑2 里新加一张卡
  const added = picker.pick(project({ innerText: 'changed', extra: [card('N', 1, 3)] }), []);
  assert.deepEqual(added.sort(), ['S2~N', 'S~N']);
  // 没变:什么都不收
  assert.deepEqual(picker.pick(project({ innerText: 'changed', extra: [card('N', 1, 3)] }), []), []);
});
