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
// The review table is static: the same cardId has only one compositing; each of the two paths
// injects a lookup function, without stuffing fixture cards into the production review table
// (src/cards/capabilities.json).
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
  // Card not in the review table = unknown, follow the most conservative path:
  // render lower-layer scenes together.
  const input = structuredClone(project);
  input.tracks.unshift({ id: 'above', clips: [{ id: 'cover', start: 0, end: 2 }] });
  const isolated = isolateClip(input, 'target', { preserveContext: true, capabilities: unreviewed });
  assert.equal(isolated.context, true);
  assert.deepEqual(isolated.project.tracks.filter(track => !track.hidden).flatMap(track => track.clips.map(clip => clip.id)), ['a', 'target', 'b']);
  assert.equal(isolateClip(input, 'missing'), null);
});

// ── Real review table (no injected lookup function): how registered marks affect "viewing this segment alone" ──
// Only clips with nodes check the table (plain card clips without nodes always include lower layers,
// regardless of the table).
const withNode = (cardId) => ({
  width: 64, height: 64, fps: 30, duration: 2, media: [],
  cardNodes: [{ id: 'n', adapter: 'card', cardId, kind: 'animation', params: {}, inputs: {} }],
  tracks: [
    { id: 'top', clips: [{ id: 'target', cardId, nodeId: 'n', start: 0, end: 2 }] },
    { id: 'bottom', clips: [{ id: 'below', cardId: 'odometer', start: 0, end: 2 }] },
  ],
});
test('Cards registered as standalone cards in the review table (including the four registered afterwards in render refactor "Ding") do not include the lower layers when viewed alone', () => {
  for (const cardId of ['av-pulse', 'sound-notification', 'sound-keyboard', 'probe-slow', 'caption-track', 'particles-snow']) {
    const isolated = isolateClip(withNode(cardId), 'target', { preserveContext: true });
    assert.equal(isolated.context, false, cardId);
    assert.deepEqual(isolated.project.tracks.filter(track => !track.hidden).flatMap(track => track.clips.map(clip => clip.id)), ['target'], cardId);
  }
});
test('Those registered as lower-layer dependencies, deliberately not reviewed (unknown), derived from parts (fromParts), and those not in the table still include the lower layers when viewed alone', () => {
  for (const cardId of ['blur-text', 'r6-unknown', 'probe-css', 'probe-motion-js', 'composite', 'not-in-table']) {
    const isolated = isolateClip(withNode(cardId), 'target', { preserveContext: true });
    assert.equal(isolated.context, true, cardId);
    assert.deepEqual(isolated.project.tracks.filter(track => !track.hidden).flatMap(track => track.clips.map(clip => clip.id)), ['target', 'below'], cardId);
  }
});
