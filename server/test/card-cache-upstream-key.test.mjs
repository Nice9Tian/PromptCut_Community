/**
 * 输出节点带上游的片段:预渲染结果的内容键、单卡流的成员键、结果键必须带上上游。
 *
 * 片段挂了强调、滤镜、声音效果时,卡片图(`src/kernel/cardGraph.mjs` 的 `projectCardGraph`)给它的输出节点是外面
 * 那一层(`@clip/<id>/emphasis` 等),卡片自己在它的 `inputs.source` 后面;素材效果卡的输出节点是卡自己,素材在
 * 它的 `inputs` 后面。`CardFrameCache.plan` 原先算内容键时把 `inputs` 剥掉、`inputKeys` 传空对象,于是「外面相同、
 * 里面不同」的两个片段算出同一个键,互相取到对方的预渲染结果。
 *
 * 这里每种情形各构造一对片段:外面的节点相同、时长和采样相位相同(两条序列上同一时刻起止),里面不同。
 * 断言:共享快照的内容键 `contentKey`、单卡流的成员键 `streamMemberKey`、结果键 `snapshotKey` 都不相同;
 * 能进单卡流的,`planStreams` 出的流的内容键和流键也不相同。
 *
 * 反方向:里外都相同的两个片段键仍然相同(共享档「同一张卡两个片段共用一份」的本意)。
 * 对照:输出节点没有上游的片段,键和原来的算法逐字相同。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardFrameCache } from '../card-cache.mjs';
import * as identity from '../card-identity.mjs';
import { planStreams } from '../frame-stream.mjs';
import { snapshotCode } from '../frame-code.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';

const ENV_FP = '0123456789abcdef';
const ENVIRONMENT = { width: 1920, height: 1080, fps: 30, theme: 'dark', fontFingerprint: 'ff00ff00' };

/** 测试用的卡片定义。`punch-pill`、`focus-card` 在审阅表里是独立卡;`fx-*` 不在表里(按未知处理),写了 `card()` 所以是素材效果卡 */
const DEFS = {
  'punch-pill': { id: 'punch-pill', defaults: { text: '' } },
  'focus-card': { id: 'focus-card', defaults: { text: '' } },
  'fx-tint': { id: 'fx-tint', kind: 'filter', defaults: { amount: 1 }, card() { return null; } },
  'fx-blend': { id: 'fx-blend', kind: 'filter', defaults: {}, card() { return null; } },
};
const getCard = id => DEFS[id];
const SOURCE_VERSIONS = { 'punch-pill': 'builtin:pill-v1', 'focus-card': 'builtin:focus-v1', 'fx-tint': 'user:tint-v1', 'fx-blend': 'user:blend-v1' };

const EMPHASIS = { kind: 'outline', color: '#ffffff', size: 6 };
const FILTERS = [{ id: 'f-warm', name: 'Warm color', ops: [{ op: 'sepia', amount: 0.4 }] }];
const AUDIO_FX = [{ id: 'a-echo', name: 'Echo', ops: [{ op: 'delay', time: 0.2 }] }];
const MEDIA = [
  { id: 'm-a', kind: 'video', name: 'a.mp4', path: 'media/a.mp4', duration: 10, width: 1920, height: 1080 },
  { id: 'm-b', kind: 'video', name: 'b.mp4', path: 'media/b.mp4', duration: 10, width: 1920, height: 1080 },
];

/** 两条序列各放一个片段,同一时刻起止:时长、采样的第一帧和相位都相同 */
const projectOf = (left, right, extra = {}) => ({
  id: 'p', width: 1920, height: 1080, fps: 30, duration: 4, themeId: 'dark', style: {},
  media: MEDIA, filters: FILTERS, audioFx: AUDIO_FX, pixelMaps: [], cardNodes: [],
  ...extra,
  tracks: [
    { id: 'tr-l', hidden: false, clips: [{ id: 'clip-l', start: 1, end: 3, ...left }] },
    { id: 'tr-r', hidden: false, clips: [{ id: 'clip-r', start: 1, end: 3, ...right }] },
  ],
});

function planOf(project) {
  const cache = new CardFrameCache({ root: 'unused', project, envFingerprint: ENV_FP });
  const value = { graph: projectCardGraph(project, getCard), sourceVersions: SOURCE_VERSIONS, environment: ENVIRONMENT };
  const controls = cache.plan(value);
  const byClip = Object.fromEntries(controls.map(control => [control.clipId, control]));
  const streams = planStreams({ project, cardPlan: controls }, { envFingerprint: ENV_FP, codeVersion: 'test-code', budget: 8, below: false });
  const streamOf = clipId => streams.find(spec => spec.kind === 'card' && spec.clipIds.length === 1 && spec.clipIds[0] === clipId) ?? null;
  return { value, controls, left: byClip['clip-l'], right: byClip['clip-r'], streamLeft: streamOf('clip-l'), streamRight: streamOf('clip-r') };
}

const KEYS = ['contentKey', 'streamMemberKey', 'snapshotKey'];

/** 里面不同、外面相同的一对:三个键都不能相同;`streams` 为真时两个片段都要有单卡流,流的内容键和流键也不能相同 */
function assertDistinct(left, right, { extra, streams = false, outer } = {}) {
  const planned = planOf(projectOf(left, right, extra));
  assert.ok(planned.left && planned.right, 'both clips must have controls');
  // 前提:两个片段的输出节点是同一种外层节点,采样与时长相同
  if (outer) for (const control of [planned.left, planned.right]) assert.match(control.nodeId, outer);
  assert.deepEqual(planned.left.sampling, planned.right.sampling);
  assert.equal(planned.left.count, planned.right.count);
  // 带外观的缓存键本来就带上游(`cardNodeIdentities`),它一直是不同的
  assert.notEqual(planned.left.cacheContentKey, planned.right.cacheContentKey, 'cacheContentKey');
  for (const name of KEYS) assert.notEqual(planned.left[name], planned.right[name], `${name} must differ between the two clips`);
  if (streams) {
    assert.ok(planned.streamLeft && planned.streamRight, 'both clips must have a single-card stream');
    assert.notEqual(planned.streamLeft.contentKey, planned.streamRight.contentKey, 'the content keys of the streams must differ');
    assert.notEqual(planned.streamLeft.streamKey, planned.streamRight.streamKey, 'the stream keys must differ');
  }
  return planned;
}

/** 里外都相同的一对:三个键相同(共用一份),流的内容键和流键也相同 */
function assertShared(left, right, { extra, streams = false } = {}) {
  const planned = planOf(projectOf(left, right, extra));
  assert.ok(planned.left && planned.right, 'both clips must have controls');
  for (const name of KEYS) assert.equal(planned.left[name], planned.right[name], `${name} should be the same for the two clips`);
  if (streams) {
    assert.ok(planned.streamLeft && planned.streamRight, 'both clips must have a single-card stream');
    assert.equal(planned.streamLeft.contentKey, planned.streamRight.contentKey);
    assert.equal(planned.streamLeft.streamKey, planned.streamRight.streamKey);
  }
  return planned;
}

const pill = (text, more = {}) => ({ kind: 'card', cardId: 'punch-pill', params: { text }, ...more });
const focus = (text, more = {}) => ({ kind: 'card', cardId: 'focus-card', params: { text }, ...more });

// ---------------------------------------------------------------- 强调

test('emphasis: it contains two different cards, keys must differ', () => {
  const planned = assertDistinct(pill('aaa', { emphasis: EMPHASIS }), focus('zzz', { emphasis: EMPHASIS }), { streams: true, outer: /\/emphasis$/ });
  // 己二：撤掉每张卡的快照后 tier 恒为 none
  assert.equal(planned.left.tier, 'none');
  assert.equal(planned.left.cacheable, true);
});

test('emphasis: same card with different parameters, keys must differ', () => {
  assertDistinct(pill('aaa', { emphasis: EMPHASIS }), pill('zzz', { emphasis: EMPHASIS }), { streams: true, outer: /\/emphasis$/ });
});

test('emphasis: two projects with the same card and parameters but different source versions, keys must differ', () => {
  const project = projectOf(pill('aaa', { emphasis: EMPHASIS }), pill('aaa', { emphasis: EMPHASIS }));
  const run = sourceVersions => new CardFrameCache({ root: 'unused', project, envFingerprint: ENV_FP })
    .plan({ graph: projectCardGraph(project, getCard), sourceVersions, environment: ENVIRONMENT })[0];
  const before = run(SOURCE_VERSIONS), after = run({ ...SOURCE_VERSIONS, 'punch-pill': 'builtin:pill-v2' });
  for (const name of KEYS) assert.notEqual(before[name], after[name], `${name}: the card source changed, so the key must change`);
});

// ---------------------------------------------------------------- 滤镜

test('filter: it contains two different cards, keys must differ', () => {
  assertDistinct(pill('aaa', { filter: { id: 'f-warm', params: {} } }), focus('zzz', { filter: { id: 'f-warm', params: {} } }), { streams: true, outer: /\/filter$/ });
});

test('filter: same card with different parameters, keys must differ', () => {
  assertDistinct(pill('aaa', { filter: { id: 'f-warm', params: {} } }), pill('zzz', { filter: { id: 'f-warm', params: {} } }), { streams: true, outer: /\/filter$/ });
});

// ---------------------------------------------------------------- 声音效果(输出节点是 `@clip/<id>/audioFx`)

test('sound effect: it contains two different cards, keys must differ', () => {
  assertDistinct(pill('aaa', { audioFx: { id: 'a-echo', params: {} } }), focus('zzz', { audioFx: { id: 'a-echo', params: {} } }), { streams: true, outer: /\/audioFx$/ });
});

// ---------------------------------------------------------------- 两层:滤镜外面再挂强调

test('filter plus emphasis (two upstream layers): the innermost card differs, keys must differ', () => {
  const wrap = { filter: { id: 'f-warm', params: {} }, emphasis: EMPHASIS };
  assertDistinct(pill('aaa', wrap), focus('zzz', wrap), { streams: true, outer: /\/emphasis$/ });
  assertDistinct(pill('aaa', wrap), pill('zzz', wrap), { streams: true, outer: /\/emphasis$/ });
});

test('filter plus emphasis: the middle filter layer has different parameters, keys must differ', () => {
  assertDistinct(pill('aaa', { filter: { id: 'f-warm', params: { amount: 0.2 } }, emphasis: EMPHASIS }),
    pill('aaa', { filter: { id: 'f-warm', params: { amount: 0.9 } }, emphasis: EMPHASIS }), { streams: true, outer: /\/emphasis$/ });
});

// ---------------------------------------------------------------- 素材段挂强调(输出节点是强调,上游是素材)

test('media clip with emphasis attached: different media, keys must differ', () => {
  assertDistinct({ kind: 'media', mediaId: 'm-a', emphasis: EMPHASIS }, { kind: 'media', mediaId: 'm-b', emphasis: EMPHASIS }, { outer: /\/emphasis$/ });
});

test('media clip with emphasis attached: same media with different in-points, keys must differ', () => {
  assertDistinct({ kind: 'media', mediaId: 'm-a', mediaOffset: 0, emphasis: EMPHASIS }, { kind: 'media', mediaId: 'm-a', mediaOffset: 2, emphasis: EMPHASIS }, { outer: /\/emphasis$/ });
});

// ---------------------------------------------------------------- 素材效果卡(输出节点是卡自己,素材在它的 inputs 后面)

const fxNodes = (inputL = '@clip/clip-l/source', inputR = '@clip/clip-r/source') => [
  { id: 'n-l', adapter: 'card', cardId: 'fx-tint', kind: 'filter', params: { amount: 1 }, inputs: { source: inputL } },
  { id: 'n-r', adapter: 'card', cardId: 'fx-tint', kind: 'filter', params: { amount: 1 }, inputs: { source: inputR } },
];

test('media effect card: same card and parameters but different connected media, keys must differ', () => {
  const planned = assertDistinct({ kind: 'media', mediaId: 'm-a', nodeId: 'n-l', params: { amount: 1 } }, { kind: 'media', mediaId: 'm-b', nodeId: 'n-r', params: { amount: 1 } },
    { extra: { cardNodes: fxNodes() } });
  assert.equal(planned.left.nodeId, 'n-l');
  // 己二：撤掉每张卡的快照后 tier 恒为 none
  assert.equal(planned.left.tier, 'none');
});

test('media effect card: same connected media but different input time mappings, keys must differ', () => {
  const nodes = [
    { id: 'n-l', adapter: 'card', cardId: 'fx-tint', kind: 'filter', params: { amount: 1 }, inputs: { source: { nodeId: '@clip/clip-l/source', offset: 0, rate: 1 } } },
    { id: 'n-r', adapter: 'card', cardId: 'fx-tint', kind: 'filter', params: { amount: 1 }, inputs: { source: { nodeId: '@clip/clip-r/source', offset: 0, rate: 0.5 } } },
  ];
  assertDistinct({ kind: 'media', mediaId: 'm-a', nodeId: 'n-l', params: { amount: 1 } }, { kind: 'media', mediaId: 'm-a', nodeId: 'n-r', params: { amount: 1 } }, { extra: { cardNodes: nodes } });
});

test('media effect card chained two layers deep: same outermost layer but different parameters on the middle card, keys must differ', () => {
  const nodes = [
    { id: 'in-l', adapter: 'card', cardId: 'fx-tint', kind: 'filter', params: { amount: 0.2 }, inputs: { source: '@clip/clip-l/source' } },
    { id: 'in-r', adapter: 'card', cardId: 'fx-tint', kind: 'filter', params: { amount: 0.9 }, inputs: { source: '@clip/clip-r/source' } },
    { id: 'n-l', adapter: 'card', cardId: 'fx-blend', kind: 'filter', params: {}, inputs: { source: 'in-l' } },
    { id: 'n-r', adapter: 'card', cardId: 'fx-blend', kind: 'filter', params: {}, inputs: { source: 'in-r' } },
  ];
  assertDistinct({ kind: 'media', mediaId: 'm-a', nodeId: 'n-l', params: {} }, { kind: 'media', mediaId: 'm-a', nodeId: 'n-r', params: {} }, { extra: { cardNodes: nodes } });
});

test('media effect card: with one input pointing to a deleted clip, it must not share a key with one whose inputs are all present', () => {
  const nodes = [
    { id: 'n-l', adapter: 'card', cardId: 'fx-blend', kind: 'filter', params: {}, inputs: { source: '@clip/clip-l/source', other: '@clip/gone/source' } },
    { id: 'n-r', adapter: 'card', cardId: 'fx-blend', kind: 'filter', params: {}, inputs: { source: '@clip/clip-r/source', other: '@clip/clip-l/source' } },
  ];
  assertDistinct({ kind: 'media', mediaId: 'm-a', nodeId: 'n-l', params: {} }, { kind: 'media', mediaId: 'm-a', nodeId: 'n-r', params: {} }, { extra: { cardNodes: nodes } });
});

// ---------------------------------------------------------------- 反方向:里外都相同,仍然共用

test('sharing: same card and parameters with the same emphasis attached, the two clips have the same key', () => {
  assertShared(pill('aaa', { emphasis: EMPHASIS }), pill('aaa', { emphasis: EMPHASIS }), { streams: true });
});

test('sharing: same card and parameters with the same filter plus emphasis attached, the two clips have the same key', () => {
  const wrap = { filter: { id: 'f-warm', params: { amount: 0.2 } }, emphasis: EMPHASIS };
  assertShared(pill('aaa', wrap), pill('aaa', wrap), { streams: true });
});

test('sharing: same media and in-point with the same emphasis attached; the same media effect card connected to the same media, keys are the same', () => {
  assertShared({ kind: 'media', mediaId: 'm-a', mediaOffset: 1, emphasis: EMPHASIS }, { kind: 'media', mediaId: 'm-a', mediaOffset: 1, emphasis: EMPHASIS });
  assertShared({ kind: 'media', mediaId: 'm-a', nodeId: 'n-l', params: { amount: 1 } }, { kind: 'media', mediaId: 'm-a', nodeId: 'n-r', params: { amount: 1 } }, { extra: { cardNodes: fxNodes() } });
});

test('sharing: two clips with different in-points and the same phase (with the same emphasis attached) have the same snapshot key; position on screen and opacity do not go into the key', () => {
  const project = projectOf(pill('aaa', { emphasis: EMPHASIS, frame: { x: 0, y: 0, w: 800, h: 400 }, opacity: 1 }),
    pill('aaa', { emphasis: EMPHASIS, start: 0.5, end: 2.5, frame: { x: 300, y: 200, w: 800, h: 400 }, opacity: 0.4 }));
  const { left, right } = planOf(project);
  assert.notEqual(left.sampling.firstFrame, right.sampling.firstFrame);
  for (const name of KEYS) assert.equal(left[name], right[name], name);
});

test('the same card with and without emphasis attached has different keys (different output nodes; it has always been this way)', () => {
  const { left, right } = planOf(projectOf(pill('aaa', { emphasis: EMPHASIS }), pill('aaa')));
  for (const name of KEYS) assert.notEqual(left[name], right[name], name);
});

// ---------------------------------------------------------------- 对照:没有上游的片段,键一个字不变

/** 原来的算法(改之前 `CardFrameCache.plan` 里的两处调用),逐字照抄:`inputKeys` 是空对象 */
function legacyKeys(project, value, control) {
  const node = value.graph.nodes.find(item => item.id === control.nodeId);
  const output = value.graph.outputs.find(item => item.clipId === control.clipId);
  const common = {
    definition: undefined, style: project.style || {}, environment: value.environment || {},
    sourceVersions: value.sourceVersions || {}, inputKeys: {},
    fps: Number(project.fps) || 30, sampling: control.sampling, duration: control.end - control.start,
    stage: { width: project.width, height: project.height, camera3dFov: project.camera3dFov },
    frame: output.frame, themeId: project.themeId,
    fontFingerprint: value.environment?.fontFingerprint || '',
  };
  const contentKey = identity.cardSnapshotIdentity(node, { ...common, snapshotCode: snapshotCode() });
  return { contentKey, snapshotKey: resultKeyOf(contentKey, ENV_FP), streamMemberKey: identity.cardSnapshotIdentity(node, { ...common, snapshotCode: '' }) };
}

test('clip with no upstream: the three keys are identical verbatim to those of the original algorithm', () => {
  const cases = [
    projectOf(pill('aaa'), focus('zzz')),
    projectOf(pill('aaa', { frame: { x: 10, y: 20, w: 640, h: 360 }, opacity: 0.5, fadeIn: 0.2, motion: { kind: 'slide' } }), { kind: 'media', mediaId: 'm-a', mediaOffset: 1.5 }),
    // 素材效果卡片段(只有 cardId,就地合成 `@clip/<id>/card` 节点);没有输入的素材效果卡节点
    projectOf({ kind: 'card', cardId: 'fx-tint', params: { amount: 0.3 } }, { kind: 'card', cardId: 'fx-blend', nodeId: 'n-free', params: {} },
      { cardNodes: [{ id: 'n-free', adapter: 'card', cardId: 'fx-blend', kind: 'filter', params: {}, inputs: {} }] }),
    // 相位不为零
    projectOf(pill('aaa', { start: 1.005, end: 3.005 }), focus('zzz', { start: 0.99, end: 2 })),
  ];
  let checked = 0;
  for (const project of cases) {
    const { value, controls } = planOf(project);
    assert.equal(controls.length, 2);
    for (const control of controls) {
      const node = value.graph.nodes.find(item => item.id === control.nodeId);
      assert.deepEqual(node.inputs, {}, 'this group is all output nodes with no upstream');
      const legacy = legacyKeys(project, value, control);
      for (const name of KEYS) assert.equal(control[name], legacy[name], `${control.clipId} ${name}`);
      checked++;
    }
  }
  assert.equal(checked, 8);
});

test('cardSnapshotInputKeys: a node with no upstream is an empty object; a node with upstream carries the upstream identity, and the identity contains no clip id', () => {
  const project = projectOf(pill('aaa', { emphasis: EMPHASIS }), pill('aaa', { emphasis: EMPHASIS }));
  const graph = projectCardGraph(project, getCard);
  const opts = { style: {}, environment: ENVIRONMENT, sourceVersions: SOURCE_VERSIONS };
  const keys = identity.cardSnapshotInputKeys(graph, opts);
  assert.equal(keys.size, graph.nodes.length, 'one entry per node');
  assert.deepEqual(keys.get('@clip/clip-l/source'), {});
  const left = keys.get('@clip/clip-l/emphasis'), right = keys.get('@clip/clip-r/emphasis');
  assert.deepEqual(Object.keys(left), ['source']);
  assert.match(left.source.key, /^[0-9a-f]{64}$/);
  assert.equal(left.source.offset, 0);
  assert.equal(left.source.rate, 1);
  assert.deepEqual(left, right, 'two clips containing the same card and parameters: the upstream identities are the same');
  // 对照:`cardNodeIdentities` 的节点身份带片段的 id(给带外观的缓存键用),两个片段不同;它没有被改动
  const nodeKeys = identity.cardNodeIdentities(graph, opts);
  assert.notEqual(nodeKeys.get('@clip/clip-l/source'), nodeKeys.get('@clip/clip-r/source'));
  assert.notEqual(left.source.key, nodeKeys.get('@clip/clip-l/source'));
  // 环境、项目样式、源码版本进上游的身份
  assert.notEqual(identity.cardSnapshotInputKeys(graph, { ...opts, sourceVersions: { ...SOURCE_VERSIONS, 'punch-pill': 'builtin:pill-v2' } }).get('@clip/clip-l/emphasis').source.key, left.source.key);
  assert.notEqual(identity.cardSnapshotInputKeys(graph, { ...opts, environment: { ...ENVIRONMENT, fontFingerprint: 'deadbeef' } }).get('@clip/clip-l/emphasis').source.key, left.source.key);
  assert.notEqual(identity.cardSnapshotInputKeys(graph, { ...opts, style: { accent: '#f00' } }).get('@clip/clip-l/emphasis').source.key, left.source.key);
});

test('clip with no upstream: pinned values of the member keys (computed and recorded on main before the change)', () => {
  // 整份图手写,不经 `projectCardGraph`、不读审阅表;成员键不带生成快照的代码指纹,所以只随键的算法变
  const graph = { definitions: [], nodes: [{ id: 'card', adapter: 'chrome', cardId: 'demo', clipId: 'clip', params: { text: 'aaa' }, parts: [],
    capabilities: { frameMode: 'stateful', need_prerendering: true, compositing: 'independent', canvasHeavy: false, independentCache: true }, inputs: {} }],
    outputs: [{ nodeId: 'card', clipId: 'clip', start: 1, end: 3, opacity: 1, frame: { x: 0, y: 0, w: 800, h: 400 } }] };
  const cache = new CardFrameCache({ root: 'unused', project: { fps: 30, width: 1920, height: 1080, style: {}, themeId: 'dark' }, envFingerprint: ENV_FP });
  const [control] = cache.plan({ graph, sourceVersions: { demo: 'builtin:demo-v1' }, environment: ENVIRONMENT });
  assert.equal(control.streamMemberKey, GOLDEN_STREAM_MEMBER_KEY);
  assert.equal(control.cacheContentKey, GOLDEN_CACHE_CONTENT_KEY);
});
const GOLDEN_STREAM_MEMBER_KEY = 'cbab76e2bfbc378c01764ba43bda4f234e309c793fce383d609f9c5a533e1481';
const GOLDEN_CACHE_CONTENT_KEY = '774629ff1ce115bd73dfff8703d8ef5fc06cf3167ceb19bf531580c8e8e7606e';
