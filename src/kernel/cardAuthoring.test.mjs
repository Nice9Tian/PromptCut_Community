import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCardDefinition, cloneCardClipInstance } from './cardAuthoring.mjs';
import { projectCardGraph } from './cardGraph.mjs';

/* Media effect cards in repository are src/cards/user/<id>.tsx files, definitions are always
 * taken from registry. In tests, three cards are written as plain objects using a getCard
 * stub as registry: same posture as passing src/kernel/registry on browser side. */
const invert = {
  id: 'invert', name: 'Invert colors', description: '', source: 'user', kind: 'filter', frameMode: 'direct',
  defaults: { amount: .5 }, controls: [],
  card: (sources, t, params) => ({ type: 'glsl', fragment: 'void main(){outColor=texture(u_input0,v_uv);}',
    inputs: [sources.source.at()], uniforms: { amount: params.amount } }),
};
const blur = { ...invert, id: 'blur', name: 'blur', defaults: { radius: 3 } };
const crossfade = {
  id: 'crossfade', name: 'crossfade', description: '', source: 'user', kind: 'transition', frameMode: 'direct',
  defaults: { duration: 1 }, controls: [],
  card: (sources, t, params) => ({ type: 'glsl', fragment: 'void main(){outColor=mix(texture(u_input0,v_uv),texture(u_input1,v_uv),progress);}',
    inputs: [sources.A.at(), sources.B.at()], uniforms: { progress: t / params.duration } }),
};
const tone = {
  id: 'tone', name: 'Gain', description: '', source: 'user', kind: 'audio', frameMode: 'direct',
  defaults: { gain: 1 }, controls: [],
  audio: async (sources, range, params) => (await sources.source.block(range.start, range.count)).map(v => v * params.gain),
};
const textCard = { id: 'title', name: 'Title', description: '', source: 'native', defaults: {}, controls: [], Component: () => null };
const registry = { invert, blur, crossfade, tone, title: textCard };
const getCard = id => registry[id];

const base = () => ({
  width: 64, height: 64, fps: 10, duration: 2, media: [{ id: 'media', url: '/@media/a.png' }],
  tracks: [{ id: 'track', clips: [
    { id: 'a', mediaId: 'media', start: 0, end: 1 },
    { id: 'b', mediaId: 'media', start: 1, end: 2 },
    { id: 'dom', cardId: 'title', start: 0, end: 1, params: {} },
  ] }],
});

const clipOf = (project, id) => project.tracks.flatMap(t => t.clips).find(c => c.id === id);

test('One definition has independent instances; the clip gets cardId + nodeId, and params are also written into the clip', () => {
  const a = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'a-effect', params: { amount: .25 } }, getCard).project;
  const b = applyCardDefinition(a, { cardId: 'invert', clipId: 'b', nodeId: 'b-effect', params: { amount: .75 } }, getCard).project;
  const reopened = JSON.parse(JSON.stringify(b));
  const graph = projectCardGraph(reopened, getCard);
  assert.equal(reopened.cardDefinitions, undefined); // Definitions do not enter project JSON
  assert.equal(reopened.cardNodes.length, 2);
  assert.deepEqual(reopened.cardNodes.map(n => n.adapter), ['card', 'card']);
  assert.deepEqual(reopened.cardNodes.map(n => n.kind), ['filter', 'filter']);
  assert.deepEqual(reopened.cardNodes.map(n => n.params.amount), [.25, .75]);
  assert.equal(clipOf(reopened, 'a').cardId, 'invert');
  assert.deepEqual(clipOf(reopened, 'a').params, { amount: .25 }); // Not copying as-is means silently dropping parameters on screen
  assert.equal(graph.nodes.find(n => n.id === 'a-effect').inputs.source.nodeId, '@clip/a/source');
  assert.equal(graph.nodes.find(n => n.id === 'b-effect').inputs.source.nodeId, '@clip/b/source');
  assert.equal(base().cardNodes, undefined);
});

test('Applying two cards to the same clip in a row: the second card\'s input connects to the first card\'s output automatically, not to the self-referencing composite source', () => {
  const first = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'n1' }, getCard).project;
  const second = applyCardDefinition(first, { cardId: 'blur', clipId: 'a', nodeId: 'n2' }, getCard).project;
  assert.equal(clipOf(second, 'a').nodeId, 'n2');
  assert.equal(clipOf(second, 'a').cardId, 'blur');
  assert.deepEqual(second.cardNodes.find(n => n.id === 'n2').inputs.source, { nodeId: 'n1', offset: 0, rate: 1 });
  assert.deepEqual(second.cardNodes.find(n => n.id === 'n1').inputs.source, { nodeId: '@clip/a/source', offset: 0, rate: 1 });
  // The fallback cannot insert another source pointing to this card itself (clip.cardId is already
  // the media effect card id at this point)
  assert.equal(Object.keys(second.cardNodes.find(n => n.id === 'n2').inputs).length, 1);
});

test('Passing the current clip.nodeId edits this instance in place: no chaining, no cycle thrown, and if inputs is not passed the old upstream edges are inherited', () => {
  const first = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'n1' }, getCard).project;
  const edited = applyCardDefinition(first, { cardId: 'invert', clipId: 'a', nodeId: 'n1', params: { amount: .9 } }, getCard).project;
  assert.equal(edited.cardNodes.length, 1);
  assert.deepEqual(edited.cardNodes[0].inputs.source, { nodeId: '@clip/a/source', offset: 0, rate: 1 });
  assert.equal(edited.cardNodes[0].params.amount, .9);
  assert.doesNotThrow(() => projectCardGraph(edited, getCard));
});

test('Priority of params overrides: the node stores one copy, and for the node a clip points to, clip.params wins in the graph', () => {
  const applied = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'n1', params: { amount: .25 } }, getCard).project;
  const outer = applyCardDefinition(applied, { cardId: 'blur', clipId: 'a', nodeId: 'n2', params: { radius: 5 } }, getCard).project;
  // Modifying parameters in the right rail changes clip.params
  clipOf(outer, 'a').params = { radius: 9 };
  const graph = projectCardGraph(outer, getCard);
  assert.deepEqual(graph.nodes.find(n => n.id === 'n2').params, { radius: 9 });
  assert.deepEqual(graph.nodes.find(n => n.id === 'n1').params, { amount: .25 }); // Inner layer retains the copy from card creation
});

test('One input of a transition card is the output of another media effect card, and the other input is a media clip', () => {
  const first = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'n1' }, getCard).project;
  const mixed = applyCardDefinition(first, { cardId: 'crossfade', trackId: 'track', start: 2, end: 3, newClipId: 'mix',
    nodeId: 'nmix', inputs: { A: { clipId: 'a' }, B: { clipId: 'b' } } }, getCard).project;
  const node = mixed.cardNodes.find(n => n.id === 'nmix');
  assert.equal(node.inputs.A.nodeId, 'n1'); // Media effect card clips map to their own output nodes
  assert.equal(node.inputs.B.nodeId, '@clip/b/source'); // Media clips as before
  assert.doesNotThrow(() => projectCardGraph(mixed, getCard));
});

test('A media effect card clip without a nodeId is first materialized into a proper node before it is referenced or applied to', () => {
  const project = base();
  project.tracks[0].clips.push({ id: 'dropped', cardId: 'invert', start: 2, end: 3, params: { amount: .4 } });
  const result = applyCardDefinition(project, { cardId: 'blur', clipId: 'dropped', nodeId: 'n2' }, getCard);
  const clip = clipOf(result.project, 'dropped');
  assert.equal(clip.nodeId, 'n2');
  assert.equal(result.project.cardNodes.length, 2);
  const inner = result.project.cardNodes.find(n => n.id !== 'n2');
  assert.equal(inner.adapter, 'card');
  assert.deepEqual(inner.params, { amount: .4 }); // Materialization uses the parameters on the clip
  assert.deepEqual(result.project.cardNodes.find(n => n.id === 'n2').inputs.source, { nodeId: inner.id, offset: 0, rate: 1 });
});

test('An audio media effect card writes only nodeId, not cardId; applying a visual media effect card to the same clip afterwards raises the error "duplicate the clip first"', () => {
  const withAudio = applyCardDefinition(base(), { cardId: 'tone', clipId: 'a', nodeId: 'na' }, getCard).project;
  assert.equal(clipOf(withAudio, 'a').cardId, undefined);
  assert.equal(clipOf(withAudio, 'a').nodeId, 'na');
  assert.equal(withAudio.cardNodes[0].kind, 'audio');
  assert.throws(() => applyCardDefinition(withAudio, { cardId: 'invert', clipId: 'a' }, getCard), /duplicate the clip first/);
  const withVisual = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'nv' }, getCard).project;
  assert.throws(() => applyCardDefinition(withVisual, { cardId: 'tone', clipId: 'a' }, getCard), /duplicate the clip first/);
});

test('DOM cards are not supported in the first version: applying onto a DOM card clip, or using a DOM card clip as input, both raise an error', () => {
  assert.throws(() => applyCardDefinition(base(), { cardId: 'invert', clipId: 'dom' }, getCard), /DOM card/);
  assert.throws(() => applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', inputs: { source: { clipId: 'dom' } } }, getCard), /DOM card/);
  assert.throws(() => applyCardDefinition(base(), { cardId: 'title', clipId: 'a' }, getCard), /existing card adapter/);
});

test('After deleting an input clip: the dangling @clip/ edge is moved into missingInputs, while other dangling inputs still throw', () => {
  const applied = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'n1' }, getCard).project;
  applied.tracks[0].clips = applied.tracks[0].clips.filter(c => c.id !== 'a');
  const graph = projectCardGraph(applied, getCard);
  assert.deepEqual(graph.nodes.find(n => n.id === 'n1').missingInputs, ['source']);
  applied.cardNodes[0].inputs = { source: { nodeId: 'not-a-node' } };
  assert.throws(() => projectCardGraph(applied, getCard), /missing input/);
});

test('split clone continues card time and compensates its own media edge', () => {
  const project = { cardNodes: [{ id: 'old', adapter: 'card', cardId: 'invert', kind: 'filter', params: { amount: 1 },
    inputs: { source: { nodeId: '@clip/a/source' }, external: { nodeId: '@clip/b/source', offset: 2 } } }] };
  const cloned = cloneCardClipInstance(project, 'a', 'copy', 'old', 2);
  assert.notEqual(cloned.nodeId, 'old');
  const node = cloned.project.cardNodes[1];
  assert.equal(node.cardId, 'invert');
  assert.equal(node.timeOffset, 2);
  assert.equal(node.inputs.source.nodeId, '@clip/copy/source');
  assert.equal(node.inputs.source.offset, -2);
  assert.equal(node.inputs.external.nodeId, '@clip/b/source');
  assert.equal(project.cardNodes.length, 1);
  // Other adapters are all returned as-is
  assert.equal(cloneCardClipInstance({ cardNodes: [{ id: 'x', adapter: 'chrome' }] }, 'a', 'copy', 'x').nodeId, 'x');
});
