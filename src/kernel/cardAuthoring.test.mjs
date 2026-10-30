import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCardDefinition, cloneCardClipInstance } from './cardAuthoring.mjs';
import { projectCardGraph } from './cardGraph.mjs';

/* 素材效果卡在仓库里是 src/cards/user/<id>.tsx 文件,定义永远从注册表取。测试里把三张卡
 * 写成普通对象,用一个 getCard 桩当注册表 —— 和浏览器侧传 src/kernel/registry 同一姿势。 */
const invert = {
  id: 'invert', name: '反色', description: '', source: 'user', kind: 'filter', frameMode: 'direct',
  defaults: { amount: .5 }, controls: [],
  card: (sources, t, params) => ({ type: 'glsl', fragment: 'void main(){outColor=texture(u_input0,v_uv);}',
    inputs: [sources.source.at()], uniforms: { amount: params.amount } }),
};
const blur = { ...invert, id: 'blur', name: '模糊', defaults: { radius: 3 } };
const crossfade = {
  id: 'crossfade', name: '交叉溶解', description: '', source: 'user', kind: 'transition', frameMode: 'direct',
  defaults: { duration: 1 }, controls: [],
  card: (sources, t, params) => ({ type: 'glsl', fragment: 'void main(){outColor=mix(texture(u_input0,v_uv),texture(u_input1,v_uv),progress);}',
    inputs: [sources.A.at(), sources.B.at()], uniforms: { progress: t / params.duration } }),
};
const tone = {
  id: 'tone', name: '增益', description: '', source: 'user', kind: 'audio', frameMode: 'direct',
  defaults: { gain: 1 }, controls: [],
  audio: async (sources, range, params) => (await sources.source.block(range.start, range.count)).map(v => v * params.gain),
};
const textCard = { id: 'title', name: '标题', description: '', source: 'native', defaults: {}, controls: [], Component: () => null };
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

test('一张定义有各自独立的实例,片段拿到 cardId + nodeId,params 同时写进片段', () => {
  const a = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'a-effect', params: { amount: .25 } }, getCard).project;
  const b = applyCardDefinition(a, { cardId: 'invert', clipId: 'b', nodeId: 'b-effect', params: { amount: .75 } }, getCard).project;
  const reopened = JSON.parse(JSON.stringify(b));
  const graph = projectCardGraph(reopened, getCard);
  assert.equal(reopened.cardDefinitions, undefined); // 定义不进项目 JSON
  assert.equal(reopened.cardNodes.length, 2);
  assert.deepEqual(reopened.cardNodes.map(n => n.adapter), ['card', 'card']);
  assert.deepEqual(reopened.cardNodes.map(n => n.kind), ['filter', 'filter']);
  assert.deepEqual(reopened.cardNodes.map(n => n.params.amount), [.25, .75]);
  assert.equal(clipOf(reopened, 'a').cardId, 'invert');
  assert.deepEqual(clipOf(reopened, 'a').params, { amount: .25 }); // 不照抄就是画面上静默丢参数
  assert.equal(graph.nodes.find(n => n.id === 'a-effect').inputs.source.nodeId, '@clip/a/source');
  assert.equal(graph.nodes.find(n => n.id === 'b-effect').inputs.source.nodeId, '@clip/b/source');
  assert.equal(base().cardNodes, undefined);
});

test('同一片段连套两张:第二张的输入自动接第一张的输出,不接那个自指的合成源', () => {
  const first = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'n1' }, getCard).project;
  const second = applyCardDefinition(first, { cardId: 'blur', clipId: 'a', nodeId: 'n2' }, getCard).project;
  assert.equal(clipOf(second, 'a').nodeId, 'n2');
  assert.equal(clipOf(second, 'a').cardId, 'blur');
  assert.deepEqual(second.cardNodes.find(n => n.id === 'n2').inputs.source, { nodeId: 'n1', offset: 0, rate: 1 });
  assert.deepEqual(second.cardNodes.find(n => n.id === 'n1').inputs.source, { nodeId: '@clip/a/source', offset: 0, rate: 1 });
  // 兜底那条不能再塞一条指向本卡自己的 source(clip.cardId 这时已经是素材效果卡 id)
  assert.equal(Object.keys(second.cardNodes.find(n => n.id === 'n2').inputs).length, 1);
});

test('传当前 clip.nodeId 是原地改这个实例:不接链、不抛 cycle,没传 inputs 就继承旧的上游边', () => {
  const first = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'n1' }, getCard).project;
  const edited = applyCardDefinition(first, { cardId: 'invert', clipId: 'a', nodeId: 'n1', params: { amount: .9 } }, getCard).project;
  assert.equal(edited.cardNodes.length, 1);
  assert.deepEqual(edited.cardNodes[0].inputs.source, { nodeId: '@clip/a/source', offset: 0, rate: 1 });
  assert.equal(edited.cardNodes[0].params.amount, .9);
  assert.doesNotThrow(() => projectCardGraph(edited, getCard));
});

test('params 覆盖的优先级:节点存一份,片段指向的那个节点在图里以 clip.params 为准', () => {
  const applied = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'n1', params: { amount: .25 } }, getCard).project;
  const outer = applyCardDefinition(applied, { cardId: 'blur', clipId: 'a', nodeId: 'n2', params: { radius: 5 } }, getCard).project;
  // 右栏改参数改的是 clip.params
  clipOf(outer, 'a').params = { radius: 9 };
  const graph = projectCardGraph(outer, getCard);
  assert.deepEqual(graph.nodes.find(n => n.id === 'n2').params, { radius: 9 });
  assert.deepEqual(graph.nodes.find(n => n.id === 'n1').params, { amount: .25 }); // 内层保留建卡时那份
});

test('转场卡的一路输入是另一张素材效果卡的输出,另一路是素材段', () => {
  const first = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'n1' }, getCard).project;
  const mixed = applyCardDefinition(first, { cardId: 'crossfade', trackId: 'track', start: 2, end: 3, newClipId: 'mix',
    nodeId: 'nmix', inputs: { A: { clipId: 'a' }, B: { clipId: 'b' } } }, getCard).project;
  const node = mixed.cardNodes.find(n => n.id === 'nmix');
  assert.equal(node.inputs.A.nodeId, 'n1'); // 素材效果卡片段映射成它自己的输出节点
  assert.equal(node.inputs.B.nodeId, '@clip/b/source'); // 素材段照旧
  assert.doesNotThrow(() => projectCardGraph(mixed, getCard));
});

test('没有 nodeId 的素材效果卡片段在被引用 / 被套之前先物化成正式节点', () => {
  const project = base();
  project.tracks[0].clips.push({ id: 'dropped', cardId: 'invert', start: 2, end: 3, params: { amount: .4 } });
  const result = applyCardDefinition(project, { cardId: 'blur', clipId: 'dropped', nodeId: 'n2' }, getCard);
  const clip = clipOf(result.project, 'dropped');
  assert.equal(clip.nodeId, 'n2');
  assert.equal(result.project.cardNodes.length, 2);
  const inner = result.project.cardNodes.find(n => n.id !== 'n2');
  assert.equal(inner.adapter, 'card');
  assert.deepEqual(inner.params, { amount: .4 }); // 物化用的是片段上那份参数
  assert.deepEqual(result.project.cardNodes.find(n => n.id === 'n2').inputs.source, { nodeId: inner.id, offset: 0, rate: 1 });
});

test('音频素材效果卡只写 nodeId、不写 cardId;同一片段再套视觉素材效果卡报错「先复制片段」', () => {
  const withAudio = applyCardDefinition(base(), { cardId: 'tone', clipId: 'a', nodeId: 'na' }, getCard).project;
  assert.equal(clipOf(withAudio, 'a').cardId, undefined);
  assert.equal(clipOf(withAudio, 'a').nodeId, 'na');
  assert.equal(withAudio.cardNodes[0].kind, 'audio');
  assert.throws(() => applyCardDefinition(withAudio, { cardId: 'invert', clipId: 'a' }, getCard), /先复制片段/);
  const withVisual = applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', nodeId: 'nv' }, getCard).project;
  assert.throws(() => applyCardDefinition(withVisual, { cardId: 'tone', clipId: 'a' }, getCard), /先复制片段/);
});

test('DOM 卡第一版不接:套在 DOM 卡段上、或拿 DOM 卡段当输入,都报错', () => {
  assert.throws(() => applyCardDefinition(base(), { cardId: 'invert', clipId: 'dom' }, getCard), /DOM 卡/);
  assert.throws(() => applyCardDefinition(base(), { cardId: 'invert', clipId: 'a', inputs: { source: { clipId: 'dom' } } }, getCard), /DOM 卡/);
  assert.throws(() => applyCardDefinition(base(), { cardId: 'title', clipId: 'a' }, getCard), /existing card adapter/);
});

test('删掉输入片段之后:@clip/ 悬空边被丢进 missingInputs,别的悬空输入照旧抛', () => {
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
  // 别的 adapter 一律原样返回
  assert.equal(cloneCardClipInstance({ cardNodes: [{ id: 'x', adapter: 'chrome' }] }, 'a', 'copy', 'x').nodeId, 'x');
});
