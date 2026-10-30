import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCardDefinition, selectedCardStyle, validateCardGraph, projectCardGraph } from './cardGraph.mjs';

/** 素材效果卡 = 注册表里写了 `card` / `audio` 的普通 CardDef。测试里直接写成对象,
 * 用一个 getCard 桩喂给 projectCardGraph —— 仓库里没有「注册」函数,真卡是文件。 */
const invert = {
  id: 'invert', name: '反色', description: '把输入整幅反色', source: 'user',
  kind: 'filter', frameMode: 'direct', defaults: { amount: .5 }, controls: [],
  card: (sources, t, params) => ({ type: 'glsl', fragment: 'void main(){outColor=texture(u_input0,v_uv);}',
    inputs: [sources.source.at()], uniforms: { amount: params.amount } }),
};
const tone = {
  id: 'tone', name: '增益', description: '按增益缩放输入采样', source: 'user',
  kind: 'audio', frameMode: 'direct', defaults: { gain: 1 }, controls: [],
  audio: async (sources, range, params) => (await sources.source.block(range.start, range.count)).map(v => v * params.gain),
};
const registry = { invert, tone };
const getCard = id => registry[id];

test('definitions only accept the two live languages and style use remains optional', () => {
  const def = normalizeCardDefinition({ id: 'tint', language: 'tsx', kind: 'filter', need_prerendering: false });
  assert.equal(def.compositing, 'unknown');
  const style = { color: '#fff', font: 'sans' };
  assert.deepEqual(selectedCardStyle(def, style), style);
  assert.deepEqual(selectedCardStyle({ ...def, styleKeys: [] }, style), {});
  assert.deepEqual(selectedCardStyle({ ...def, styleKeys: ['color'] }, style), { color: '#fff' });
  // Python 归档之后 language 只剩 tsx / builtin
  assert.throws(() => normalizeCardDefinition({ id: 'tint', language: 'ruby', kind: 'filter' }), /invalid language/);
  assert.throws(() => normalizeCardDefinition({ id: 'tint', language: 'tsx', kind: 'nope' }), /invalid kind/);
});

test('multi-input graph batches independent work and rejects cycles and missing inputs', () => {
  const nodes = [
    { id: 'a', adapter: 'media' }, { id: 'b', adapter: 'media' },
    { id: 'mix', adapter: 'card', cardId: 'invert', kind: 'transition', inputs: { A: { nodeId: 'a', offset: 2 }, B: 'b' } },
  ];
  const graph = validateCardGraph({ nodes, outputs: ['mix'] });
  assert.deepEqual(graph.levels, [['a', 'b'], ['mix']]);
  assert.deepEqual(graph.nodes[2].inputs.A, { nodeId: 'a', offset: 2, rate: 1 });
  assert.deepEqual(nodes[2].inputs.A, { nodeId: 'a', offset: 2 });
  assert.throws(() => validateCardGraph({ nodes: [{ id: 'a', adapter: 'card', inputs: { source: 'b' } }], outputs: ['a'] }), /missing input/);
  assert.throws(() => validateCardGraph({ nodes: nodes.map(n => n.id === 'a' ? { ...n, inputs: { source: 'mix' } } : n), outputs: ['mix'] }), /cycle/);
});

test('a deleted clip drops its edge into missingInputs instead of killing the whole graph', () => {
  const graph = validateCardGraph({ nodes: [
    { id: 'kept', adapter: 'media' },
    { id: 'filter', adapter: 'card', cardId: 'invert', kind: 'filter', inputs: { source: '@clip/gone/source', extra: 'kept' } },
  ], outputs: ['filter'] });
  const node = graph.nodes.find(n => n.id === 'filter');
  assert.deepEqual(node.missingInputs, ['source']);
  assert.deepEqual(Object.keys(node.inputs), ['extra']);
  // 丢边发生在算 dependencies 之前,所以它照常进 level、不会被当成环
  assert.deepEqual(graph.levels, [['kept'], ['filter']]);
});

test('old effects and graph cards appear in one graph with ordered outputs', () => {
  const project = {
    cardNodes: [{ id: 'gc', adapter: 'card', cardId: 'invert', kind: 'filter', params: { amount: .25 }, inputs: { source: '@clip/media/source' } }],
    media: [{ id: 'm', url: 'image.png' }], filters: [{ id: 'f', ops: [{ kind: 'blur', value: 2 }] }],
    tracks: [
      { id: 'top', clips: [{ id: 'custom', cardId: 'invert', nodeId: 'gc', start: 5, end: 6, params: { amount: .9 } }] },
      { id: 'bottom', clips: [{ id: 'media', mediaId: 'm', start: 0, end: 10, filter: { id: 'f' }, emphasis: { shadow: true } }] },
    ],
  };
  const graph = projectCardGraph(project, getCard);
  assert.deepEqual(graph.outputs.map(out => out.clipId), ['media', 'custom']);
  assert.ok(graph.nodes.some(n => n.adapter === 'filter'));
  assert.ok(graph.nodes.some(n => n.adapter === 'emphasis'));
  assert.ok(graph.nodes.some(n => n.adapter === 'card'));
  assert.equal(graph.nodes.find(n => n.id === 'gc').inputs.source.nodeId, '@clip/media/source');
  // 素材效果卡片段不再合成 chrome 基节点:它的输出就是它自己那个节点
  assert.equal(graph.nodes.find(n => n.id === '@clip/custom/source'), undefined);
  // 片段指向的那个节点以 clip.params 为准(右栏改参数动的就是它)
  assert.deepEqual(graph.nodes.find(n => n.id === 'gc').params, { amount: .9 });
  // 定义带着 frameMode: 'direct',所以能力不是兜底的 stateful
  assert.equal(graph.nodes.find(n => n.id === 'gc').capabilities.frameMode, 'direct');
  assert.equal(graph.abi, 1);
  assert.equal(graph.definitions, undefined);
});

test('a panel-dropped graph clip renders through a synthesized node and a deleted card never fails the graph', () => {
  const project = { media: [], tracks: [{ id: 't', clips: [
    { id: 'dropped', cardId: 'invert', start: 0, end: 2, params: { amount: .75 } },
    { id: 'orphan', cardId: 'vanished', nodeId: 'gone-node', start: 2, end: 3, params: {} },
  ] }], cardNodes: [{ id: 'gone-node', adapter: 'card', cardId: 'vanished', kind: 'filter', params: {}, inputs: {} }] };
  const graph = projectCardGraph(project, getCard);
  const synthesized = graph.nodes.find(n => n.id === '@clip/dropped/card');
  assert.equal(synthesized.adapter, 'card');
  assert.equal(synthesized.kind, 'filter');
  assert.deepEqual(synthesized.params, { amount: .75 });
  // 用户卡文件被删:能力留 unknown,整份图照样算得出来
  const orphan = graph.nodes.find(n => n.id === 'gone-node');
  assert.equal(orphan.capabilities.compositing, 'unknown');
  assert.equal(orphan.capabilities.need_prerendering, true);
});

test('audio graph card nodes carry their kind so node-only consumers can see it', () => {
  const project = { media: [{ id: 'm', url: 'a.mp4' }], tracks: [{ id: 't', clips: [
    { id: 'clip', mediaId: 'm', nodeId: 'an', start: 0, end: 2 },
  ] }], cardNodes: [{ id: 'an', adapter: 'card', cardId: 'tone', kind: 'audio', params: { gain: 2 }, inputs: { source: '@clip/clip/source' } }] };
  const graph = projectCardGraph(project, getCard);
  assert.equal(graph.nodes.find(n => n.id === 'an').kind, 'audio');
  // 素材段照常有自己的 source 节点(音频卡挂在它上面)
  assert.ok(graph.nodes.some(n => n.id === '@clip/clip/source' && n.adapter === 'media'));
});
