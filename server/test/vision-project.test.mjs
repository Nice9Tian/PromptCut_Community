import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateClip } from '../vision-project.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';

const project = {
  width: 64, height: 64, fps: 30, duration: 2,
  media: [{ id: 'a', kind: 'image', url: 'a.png' }, { id: 'b', kind: 'image', url: 'b.png' }],
  cardNodes: [{ id: 'mix-node', adapter: 'card', cardId: 'mix', kind: 'transition', params: {}, inputs: { A: { nodeId: '@clip/a/source' }, B: { nodeId: '@clip/b/source' } } }],
  tracks: [
    { id: 'top', clips: [{ id: 'a', mediaId: 'a', start: 0, end: 2 }, { id: 'target', cardId: 'mix', nodeId: 'mix-node', start: 0, end: 2 }] },
    { id: 'bottom', clips: [{ id: 'b', mediaId: 'b', start: 0, end: 2 }] },
  ],
};
// 审阅表是静态的:同一个 cardId 只有一种 compositing,两条路各注入一份查表函数,
// 不往生产审阅表 (src/cards/capabilities.json) 里塞 fixture 卡。
const independent = () => ({ compositing: 'independent' });
const unreviewed = () => undefined;

test('clip-only vision retains same-track and cross-track graph inputs in a legacy project', () => {
  const original = structuredClone(project);
  const isolated = isolateClip(project, 'target', { preserveContext: true, capabilities: independent });
  const graph = projectCardGraph(isolated.project);
  assert.ok(graph.nodes.some(node => node.id === '@clip/a/source'));
  assert.ok(graph.nodes.some(node => node.id === '@clip/b/source'));
  assert.deepEqual(isolated.project.tracks.filter(track => !track.hidden).flatMap(track => track.clips.map(clip => clip.id)), ['target']);
  assert.deepEqual(isolated.project.media, project.media);
  assert.equal(new Set(isolated.project.tracks.map(track => track.id)).size, isolated.project.tracks.length);
  assert.deepEqual(project, original);
});
test('context-dependent vision retains the lower scene while hiding upper outputs', () => {
  // 审阅表里没有这张卡 = unknown,按最保守的一条走:下层场景一起渲。
  const input = structuredClone(project);
  input.tracks.unshift({ id: 'above', clips: [{ id: 'cover', start: 0, end: 2 }] });
  const isolated = isolateClip(input, 'target', { preserveContext: true, capabilities: unreviewed });
  assert.equal(isolated.context, true);
  assert.deepEqual(isolated.project.tracks.filter(track => !track.hidden).flatMap(track => track.clips.map(clip => clip.id)), ['a', 'target', 'b']);
  assert.equal(isolateClip(input, 'missing'), null);
});

// ── 真的审阅表(不注入查表函数):登记的记号怎么影响「单看这一段」 ──
// 有节点的片段才查表(没有节点的普通卡片段一律带下层,和表无关)。
const withNode = (cardId) => ({
  width: 64, height: 64, fps: 30, duration: 2, media: [],
  cardNodes: [{ id: 'n', adapter: 'card', cardId, kind: 'animation', params: {}, inputs: {} }],
  tracks: [
    { id: 'top', clips: [{ id: 'target', cardId, nodeId: 'n', start: 0, end: 2 }] },
    { id: 'bottom', clips: [{ id: 'below', cardId: 'odometer', start: 0, end: 2 }] },
  ],
});
test('审阅表里登记成独立卡的(含渲染重构「丁」补登记的四张)单看时不带下层', () => {
  for (const cardId of ['av-pulse', 'sound-notification', 'sound-keyboard', 'probe-slow', 'caption-track', 'particles-snow']) {
    const isolated = isolateClip(withNode(cardId), 'target', { preserveContext: true });
    assert.equal(isolated.context, false, cardId);
    assert.deepEqual(isolated.project.tracks.filter(track => !track.hidden).flatMap(track => track.clips.map(clip => clip.id)), ['target'], cardId);
  }
});
test('登记成下层依赖、故意不审(unknown)、由部件推导(fromParts)的,以及表里没有的,单看时照旧带下层', () => {
  for (const cardId of ['blur-text', 'r6-unknown', 'probe-css', 'probe-motion-js', 'composite', 'not-in-table']) {
    const isolated = isolateClip(withNode(cardId), 'target', { preserveContext: true });
    assert.equal(isolated.context, true, cardId);
    assert.deepEqual(isolated.project.tracks.filter(track => !track.hidden).flatMap(track => track.clips.map(clip => clip.id)), ['target', 'below'], cardId);
  }
});
