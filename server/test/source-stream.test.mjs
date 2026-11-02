/**
 * 单独成流的两类卡:源依赖卡(转场、套在视频上的素材效果卡)和外框用了三维变形的独立卡
 * (`frame-stream.mjs` 的 `soloStreamKind`;语义 `docs/semantics/mechanism/rendering.md`「重管线:预渲染」「怎么产,按卡分」)。
 * 用例名以 `SS-` 开头。跑:npm test -- server/test/source-stream.test.mjs
 *
 * 管:哪些卡算这两类、计划(形状、不并进组流、占预算)、键与页面的输入签名对项目数据的反应、隔离工程、回放、切分与认领、层表。
 * 流里的像素对不对、贴回舞台对不对由探针 `scripts/probes/stream-source-probe.mjs` 核对。
 *
 * 键用**真的**卡片计划算:项目 → `projectCardGraph`(卡片定义用替身)→ `CardFrameCache.plan()` → `planStreams`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  planStreams, planListStreams, queueStreamOf, isolatedStreamProject, streamEligible, belowStreamEligible,
  soloStreamKind, graphCardWithInputs, pngAlphaBox, SEGMENT_FRAMES, SPARSE_STRIDE,
} from '../frame-stream.mjs';
import { CardFrameCache } from '../card-cache.mjs';
import { frameIdentity } from '../frame-identity.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { splitPlan, planTaskOf } from '../render-node/split.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import { listPlanOverrides } from '../render-node/local-node.mjs';
import { clipsPlanTaskOf } from '../render-queue/messages.mjs';
import { layerStreamsOf } from '../artifact-transfer.mjs';
import { localMediaGate } from '../queue-local-media.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';
import { streamInputSig } from '../../src/render/streamInputSig.mjs';

/* ------------------------------------------------------------------ 场景 */

const FP = '0123456789abcdef';
const BROWSER = 'fedcba9876543210';
const CV = 'cv-source';
const UNUSED_ROOT = path.join(os.tmpdir(), 'pc-source-unused');   // plan() 不碰盘

/**
 * 卡片定义的替身。依不依赖下层这一样不看这里写的,看审阅表(`src/cards/capabilities.json`):
 *   `caption-track` 登记的是「独立」,`odometer` 是「依赖下层」;三张素材效果卡(写了 `card`)没登记 → 「未知」。
 */
const gpu = () => ({ type: 'glsl' });
const DEFS = {
  'caption-track': { id: 'caption-track', frameMode: 'stateful', defaults: {} },
  odometer: { id: 'odometer', frameMode: 'stateful', defaults: {} },
  'fx-invert': { id: 'fx-invert', kind: 'filter', frameMode: 'stateful', inputs: { source: {} }, defaults: { amount: 1 }, card: gpu },
  'fx-direct': { id: 'fx-direct', kind: 'filter', frameMode: 'direct', inputs: { source: {} }, defaults: {}, card: gpu },
  'tr-fade': { id: 'tr-fade', kind: 'transition', frameMode: 'direct', inputs: { A: {}, B: {} }, defaults: { curve: 1 }, card: gpu },
  'gen-noise': { id: 'gen-noise', kind: 'animation', frameMode: 'stateful', inputs: {}, defaults: {}, card: gpu },
};
const getCard = id => DEFS[id];
const SOURCE_VERSIONS = Object.fromEntries(Object.keys(DEFS).map(id => [id, `builtin:${id}-v1`]));

/**
 * 从上到下(第一条序列在最上面):
 *   t-tilt   tilt    独立卡,外框带三维(rotateY),0.5～3 秒
 *   t-flat   flat    独立卡,平面,0～4 秒
 *   t-trans  trans   转场(素材效果卡,接 va、vb 两段视频),3.1～4.1 秒;入点不在 15 的倍数帧上(第 93 帧)
 *   t-fx     fx      套在视频上的素材效果卡(素材段 + 卡,接自己那段素材),1.3～3 秒(第 39 帧)
 *   t-gen    gen     没有输入的素材效果卡(自己生成画面),0～2 秒
 *   t-glass  glass3  依赖下层的卡,外框带三维,4～5 秒
 *   t-va     va      视频 m1,0～3.6 秒
 *   t-vb     vb      视频 m2,3.6～8 秒
 */
const project = () => ({
  id: 'source-p', width: 1280, height: 720, fps: 30, duration: 8, themeId: 'dark', style: {}, camera3dFov: 50,
  media: [
    { id: 'm1', kind: 'video', hash: 'h1', url: '/@media/h1' },
    { id: 'm2', kind: 'video', hash: 'h2', url: '/@media/h2' },
    { id: 'm3', kind: 'video', hash: 'h3', url: '/@media/h3' },
  ],
  filters: [], pixelMaps: [],
  cardNodes: [
    { id: 'n-fx', adapter: 'card', cardId: 'fx-invert', kind: 'filter', params: { amount: 1 }, inputs: { source: { nodeId: '@clip/fx/source', offset: 0, rate: 1 } } },
    { id: 'n-trans', adapter: 'card', cardId: 'tr-fade', kind: 'transition', params: { curve: 1 },
      inputs: { A: { nodeId: '@clip/va/source', offset: 3.1, rate: 1 }, B: { nodeId: '@clip/vb/source', offset: 0, rate: 1 } } },
    { id: 'n-gen', adapter: 'card', cardId: 'gen-noise', kind: 'animation', params: {}, inputs: {} },
  ],
  tracks: [
    { id: 't-tilt', clips: [{ id: 'tilt', cardId: 'caption-track', start: 0.5, end: 3, params: { text: 'tilt' }, frame: { x: 640, y: 360, w: 600, h: 300, anchor: [0.5, 0.5], rotateY: 35, rotateX: 10 } }] },
    { id: 't-flat', clips: [{ id: 'flat', cardId: 'caption-track', start: 0, end: 4, params: { text: 'flat' } }] },
    { id: 't-trans', clips: [{ id: 'trans', cardId: 'tr-fade', nodeId: 'n-trans', start: 3.1, end: 4.1, params: { curve: 1 } }] },
    { id: 't-fx', clips: [{ id: 'fx', cardId: 'fx-invert', nodeId: 'n-fx', mediaId: 'm3', mediaOffset: 0.5, start: 1.3, end: 3, params: { amount: 1 } }] },
    { id: 't-gen', clips: [{ id: 'gen', cardId: 'gen-noise', nodeId: 'n-gen', start: 0, end: 2, params: {} }] },
    { id: 't-glass', clips: [{ id: 'glass3', cardId: 'odometer', start: 4, end: 5, params: { value: 1 }, frame: { x: 0, y: 0, w: 400, h: 200, rotateY: 20 } }] },
    { id: 't-va', clips: [{ id: 'va', cardId: '', mediaId: 'm1', mediaOffset: 0, start: 0, end: 3.6, params: {} }] },
    { id: 't-vb', clips: [{ id: 'vb', cardId: '', mediaId: 'm2', mediaOffset: 2, start: 3.6, end: 8, params: {} }] },
  ],
});
const edit = fn => { const p = structuredClone(project()); fn(p); return p; };
const clipOf = (p, id) => p.tracks.flatMap(t => t.clips).find(c => c.id === id);
const trackOf = (p, clipId) => p.tracks.find(t => t.clips.some(c => c.id === clipId));
const nodeOf = (p, id) => p.cardNodes.find(n => n.id === id);

function entryOf(p) {
  const graph = projectCardGraph(p, getCard);
  const cardPlan = new CardFrameCache({ root: UNUSED_ROOT, project: p, envFingerprint: FP }).plan({
    graph, sourceVersions: SOURCE_VERSIONS,
    environment: { width: p.width, height: p.height, fps: p.fps, theme: p.themeId, fontFingerprint: 'fonts-1' },
  });
  return { key: frameIdentity(p, 'code-1'), project: p, cardPlan };
}
const plan = (p, options = {}) => planStreams(entryOf(p), { envFingerprint: FP, codeVersion: CV, below: false, ...options });
const specOf = (p, clipId, options = {}) => plan(p, options).find(s => s.topClipId === clipId) ?? null;
const keyOf = (p, clipId) => specOf(p, clipId)?.contentKey ?? null;
const sigOf = (p, clipId) => streamInputSig(p, { clipIds: [clipId], kind: 'card' });
const controlOf = (entry, clipId) => entry.cardPlan.find(c => c.clipId === clipId);

/* ================================================================== 哪些卡算 */

test('SS-eligible source-dependent cards: media effect cards with an input connected (transitions, ones applied over media), or ones the review table marks sourceDependent; independent cards with a 3D frame; nothing else counts', () => {
  const p = project();
  const entry = entryOf(p);
  const kind = id => soloStreamKind(controlOf(entry, id), clipOf(p, id), trackOf(p, id), p);
  assert.equal(controlOf(entry, 'fx').compositing, 'unknown', 'media effect card has not been reviewed');
  assert.equal(kind('fx'), 'source', 'media effect card applied over a video');
  assert.equal(kind('trans'), 'source', 'transition');
  assert.equal(kind('tilt'), 'spatial', 'independent card with a 3D frame');
  assert.equal(kind('flat'), null, 'A flat independent card goes through the single-card stream');
  assert.equal(kind('gen'), null, 'a media effect card with no input does not count as source-dependent');
  assert.equal(kind('glass3'), null, 'below-dependent cards that also have 3D do not belong here');
  assert.equal(graphCardWithInputs(p, clipOf(p, 'fx')), true);
  assert.equal(graphCardWithInputs(p, clipOf(p, 'gen')), false);
  assert.equal(graphCardWithInputs(p, clipOf(p, 'flat')), false);
  // 平面独立卡的判据(可以并进组流的那一种)照旧不收这两类
  assert.equal(streamEligible(controlOf(entry, 'tilt'), clipOf(p, 'tilt'), trackOf(p, 'tilt')), false);
  assert.equal(streamEligible(controlOf(entry, 'fx'), clipOf(p, 'fx'), trackOf(p, 'fx')), false);
  assert.equal(streamEligible(controlOf(entry, 'flat'), clipOf(p, 'flat'), trackOf(p, 'flat')), true);
  // 手写的能力:审阅表的三个值
  const clip = { id: 'a', cardId: 'x', start: 0, end: 1 }, track = { id: 't' };
  const ctl = (compositing, extra = {}) => ({ clipId: 'a', count: 30, capabilities: { compositing }, ...extra });
  assert.equal(soloStreamKind(ctl('sourceDependent'), clip, track, {}), 'source', 'the review table says sourceDependent');
  assert.equal(soloStreamKind(ctl('sourceDependent'), { ...clip, frame: { rotateY: 20 } }, track, {}), 'source', 'both kinds holding at once counts as source-dependent');
  assert.equal(soloStreamKind(ctl('independent'), { ...clip, frame: { translateZ: -100 } }, track, {}), 'spatial');
  assert.equal(soloStreamKind(ctl('independent'), { ...clip, frame: { rotate: 30, scale: 2 } }, track, {}), null, 'in-plane rotation and scaling do not count as 3D');
  assert.equal(soloStreamKind(ctl('belowDependent'), { ...clip, nodeId: 'n' }, track, { cardNodes: [{ id: 'n', adapter: 'card', inputs: { source: 'x' } }] }), null, 'when the review table says below-dependent, follow the review table');
  assert.equal(soloStreamKind(ctl('context'), { ...clip, nodeId: 'n' }, track, { cardNodes: [{ id: 'n', adapter: 'card', inputs: { source: 'x' } }] }), 'source', 'the old catch-all value, with an input connected');
  assert.equal(soloStreamKind(ctl('unknown'), { ...clip, nodeId: 'n' }, track, { cardNodes: [{ id: 'n', adapter: 'card', kind: 'audio', inputs: { source: 'x' } }] }), null, 'a media effect card that outputs only sound does not count');
  assert.equal(soloStreamKind(ctl('unknown'), { ...clip, nodeId: 'n' }, track, { cardNodes: { n: { id: 'n', adapter: 'card', inputs: { source: 'x' } } } }), 'source', 'old data with nodes stored as an object keyed by id is recognized too');
  // 不出画、没有帧的不算
  assert.equal(soloStreamKind(ctl('sourceDependent'), clip, { id: 't', hidden: true }, {}), null);
  assert.equal(soloStreamKind(ctl('sourceDependent'), clip, { id: 't', sourceOnly: true }, {}), null);
  assert.equal(soloStreamKind(ctl('sourceDependent', { count: 0 }), clip, track, {}), null);
  assert.equal(soloStreamKind(ctl('sourceDependent'), { ...clip, cardId: '' }, track, {}), null, 'a plain media clip is not a card');
  // 「依赖下层的流」的判据对这几张卡怎么说:接了输入的素材效果卡它也认(未知),所以计划里要先把单独成流的挑走
  assert.equal(belowStreamEligible(controlOf(entry, 'fx'), clipOf(p, 'fx'), trackOf(p, 'fx')), true);
});

/* ================================================================== 计划 */

test('SS-plan: each of these two kinds yields one single-card stream (kind card, plane local) with solo; segments count from their own first frame; media effect cards with no input and below-dependent cards that also have 3D are not in these two kinds (not yielded while the below-dependent stream is off)', () => {
  const p = project();
  const specs = plan(p);
  assert.deepEqual(specs.map(s => `${s.kind}:${s.clipIds}:${s.solo ?? '-'}`), ['card:flat:-', 'card:fx:source', 'card:trans:source', 'card:tilt:spatial'],
    'flat independent cards come first; the ones that get their own stream follow in painter\'s order');
  for (const s of specs) { assert.equal(s.plane, 'local'); assert.equal(s.firstSegment, 0); assert.equal(s.clipIds.length, 1); assert.equal(s.streamKey, resultKeyOf(s.contentKey, FP)); }
  const fx = specs.find(s => s.topClipId === 'fx');
  // 1.3 秒 = 第 39 帧,3 秒之前的最后一帧是第 89 帧:51 帧,4 个分段(15、15、15、6)
  assert.deepEqual([fx.originFrame, fx.firstFrame, fx.lastFrame, fx.lastSegment], [39, 39, 89, 3]);
  assert.notEqual(fx.originFrame % SEGMENT_FRAMES, 0, 'does not start on a frame that is a multiple of 15');
  assert.deepEqual(fx.offset, { x: 0, y: 0 });
  assert.deepEqual(fx.bound, { x: 0, y: 0, w: 1280, h: 720 }, 'no frame: the whole picture');
  const trans = specs.find(s => s.topClipId === 'trans');
  assert.deepEqual([trans.originFrame, trans.lastFrame, trans.lastSegment], [93, 122, 1]);
  const tilt = specs.find(s => s.topClipId === 'tilt');
  assert.deepEqual([tilt.originFrame, tilt.lastFrame], [15, 89]);
  // 三维外框:框在隔离工程里居中摆着,流的矩形是框外扩一圈(和平面的卡一个算法),不是它在屏幕上投影出来的样子
  assert.deepEqual(tilt.offset, { x: 340, y: 210 });
  assert.deepEqual(tilt.bound, { x: -32, y: -32, w: 664, h: 364 });
  // 交给切分的形状带着 solo;平面的独立卡不带这一项(形状与原来相同)
  assert.equal(queueStreamOf(fx).solo, 'source');
  assert.equal(queueStreamOf(tilt).solo, 'spatial');
  assert.ok(!('solo' in queueStreamOf(specs.find(s => s.topClipId === 'flat'))));
  assert.equal(queueStreamOf(fx).kind, 'card');
  // 不在预渲染集合里的不出
  assert.deepEqual(plan(p, { picked: id => id !== 'fx' && id !== 'tilt' }).map(s => s.topClipId), ['flat', 'trans']);
  // 没有环境指纹:一条都不出
  assert.deepEqual(planStreams(entryOf(p), { codeVersion: CV }), []);
});

test('SS-plan-same: when the project has none of these two kinds of cards, the plan is identical to before item by item; when it does, the keys and shapes of the flat independent card entries are unaffected', () => {
  const p = project();
  const without = edit((x) => { x.tracks = x.tracks.filter(t => !['t-tilt', 't-trans', 't-fx'].includes(t.id)); x.cardNodes = x.cardNodes.filter(n => n.id === 'n-gen'); });
  const a = plan(without);
  assert.deepEqual(a.map(s => `${s.kind}:${s.clipIds}`), ['card:flat']);
  assert.ok(a.every(s => !('solo' in s)), 'no cards of these two kinds: the spec has no solo entry');
  assert.deepEqual(plan(p).find(s => s.topClipId === 'flat'), a[0], 'with a card that gets its own stream added beside it, the flat independent card\'s entry is unchanged to the last character');
});

test('SS-below: when the "below-dependent stream" is on, media effect cards with an input no longer produce that kind of stream (they already have their own stream); those with no input still belong to it; below-dependent cards that also have 3D belong to it too (stage coordinates, 3D drawn into the stream)', () => {
  const p = project();
  const on = plan(p, { below: true });
  assert.deepEqual(on.map(s => `${s.kind}:${s.clipIds}:${s.solo ?? '-'}`), ['card:flat:-', 'card:fx:source', 'card:trans:source', 'card:tilt:spatial', 'below:glass3:-', 'below:gen:-']);
  assert.deepEqual(on.slice(0, 4), plan(p), 'the switch does not affect the first few entries');
  const glass3 = on.find(s => s.topClipId === 'glass3');
  assert.deepEqual([glass3.kind, glass3.plane, 'solo' in glass3], ['below', 'stage', false], 'below-dependent with 3D: a below-dependent stream, not the kind that gets its own stream');
});

test('SS-nomerge: they do not take part in group stream merging, but each takes one decoder: they push the budget over, and what gets merged are the flat independent cards beside them', () => {
  // 三张平面独立卡叠在一起,上面再压一张三维外框的、一张转场
  const p = edit((x) => {
    x.tracks = [
      { id: 't-tilt', clips: [{ id: 'tilt', cardId: 'caption-track', start: 0, end: 4, params: {}, frame: { x: 0, y: 0, w: 300, h: 200, rotateY: 30 } }] },
      { id: 't-trans', clips: [{ id: 'trans', cardId: 'tr-fade', nodeId: 'n-trans', start: 0, end: 4, params: {} }] },
      { id: 't-a', clips: [{ id: 'a', cardId: 'caption-track', start: 0, end: 4, params: { text: 'a' } }] },
      { id: 't-b', clips: [{ id: 'b', cardId: 'caption-track', start: 0, end: 4, params: { text: 'b' } }] },
      { id: 't-c', clips: [{ id: 'c', cardId: 'caption-track', start: 0, end: 4, params: { text: 'c' } }] },
      { id: 't-va', clips: [{ id: 'va', cardId: '', mediaId: 'm1', start: 0, end: 4, params: {} }] },
      { id: 't-vb', clips: [{ id: 'vb', cardId: '', mediaId: 'm2', start: 0, end: 4, params: {} }] },
    ];
  });
  const shape = specs => specs.map(s => `${s.kind}:${s.clipIds.join('+')}`);
  assert.deepEqual(shape(plan(p, { budget: 6 })), ['card:c', 'card:b', 'card:a', 'card:trans', 'card:tilt'], 'budget is enough: one each');
  // 预算 4:五条流超了一条,合并的是两张相邻的平面独立卡
  assert.deepEqual(shape(plan(p, { budget: 4 })), ['group:c+b', 'card:a', 'card:trans', 'card:tilt']);
  // 预算 3:三张平面的并成一组;两条单独成流的不动
  assert.deepEqual(shape(plan(p, { budget: 3 })), ['group:c+b+a', 'card:trans', 'card:tilt']);
  // 预算 1:能并的都并了,这两条仍然各自一条(超出预算的层由舞台照兜底顺序处理)
  const tight = plan(p, { budget: 1 });
  assert.deepEqual(shape(tight), ['group:c+b+a', 'card:trans', 'card:tilt']);
  assert.deepEqual(tight.filter(s => s.solo).map(s => s.solo), ['source', 'spatial']);
  // 单独成流的卡夹在两张平面独立卡中间时,照旧挡住那两张合并(它在画家顺序里有自己那一层)
  const between = edit((x) => {
    x.tracks = [
      { id: 't-a', clips: [{ id: 'a', cardId: 'caption-track', start: 0, end: 4, params: { text: 'a' } }] },
      { id: 't-tilt', clips: [{ id: 'tilt', cardId: 'caption-track', start: 0, end: 4, params: {}, frame: { x: 0, y: 0, w: 300, h: 200, rotateY: 30 } }] },
      { id: 't-b', clips: [{ id: 'b', cardId: 'caption-track', start: 0, end: 4, params: { text: 'b' } }] },
    ];
  });
  assert.deepEqual(shape(plan(between, { budget: 1 })), ['card:b', 'card:a', 'card:tilt']);
});

/* ================================================================== 键与输入签名 */

test('SS-key-source: if any of the video\'s or card\'s parameters, trim or time mapping changes, both the stream key and the page\'s input signature change; where the card sits and how the other layers above or below are edited never change them', () => {
  const base = project();
  const k = { fx: keyOf(base, 'fx'), trans: keyOf(base, 'trans') };
  const s = { fx: sigOf(base, 'fx'), trans: sigOf(base, 'trans') };
  assert.ok(k.fx && k.trans && s.fx && s.trans);
  /** [说明, 改法, 哪张卡的流该变] */
  const changes = [
    ['the video it is applied over was swapped for another clip', (x) => { clipOf(x, 'fx').mediaId = 'm1'; }, ['fx']],
    ['the media itself changed content (hash changes)', (x) => { x.media.find(m => m.id === 'm3').hash = 'h3b'; x.media.find(m => m.id === 'm3').url = '/@media/h3b'; }, ['fx']],
    ['the video\'s trim start', (x) => { clipOf(x, 'fx').mediaOffset = 0.8; }, ['fx']],
    ['card parameters', (x) => { clipOf(x, 'fx').params.amount = 0.5; }, ['fx']],
    ['input time offset', (x) => { nodeOf(x, 'n-fx').inputs.source.offset = 0.25; }, ['fx']],
    ['input playback rate', (x) => { nodeOf(x, 'n-fx').inputs.source.rate = 0.5; }, ['fx']],
    ['clip moved by one frame on the timeline', (x) => { clipOf(x, 'fx').start += 1 / 30; clipOf(x, 'fx').end += 1 / 30; }, ['fx']],
    ['clip got longer', (x) => { clipOf(x, 'fx').end = 3.5; }, ['fx']],
    ['transition: the previous video\'s media was swapped', (x) => { clipOf(x, 'va').mediaId = 'm3'; }, ['trans']],
    ['transition: the next video\'s trim start', (x) => { clipOf(x, 'vb').mediaOffset = 2.5; }, ['trans']],
    ['transition: time offset of one input', (x) => { nodeOf(x, 'n-trans').inputs.A.offset = 3; }, ['trans']],
    ['transition: one input rewired to another clip', (x) => { nodeOf(x, 'n-trans').inputs.B.nodeId = '@clip/va/source'; }, ['trans']],
    ['transition: card parameters', (x) => { clipOf(x, 'trans').params.curve = 2; }, ['trans']],
    ['transition: the clip behind one input was deleted', (x) => { x.tracks = x.tracks.filter(t => t.id !== 't-vb'); }, ['trans']],
    ['Aspect ratio', (x) => { x.width = 1920; x.height = 1080; }, ['fx', 'trans']],
  ];
  for (const [what, change, affected] of changes) {
    const p = edit(change);
    for (const id of ['fx', 'trans']) {
      const moved = affected.includes(id);
      assert.equal(keyOf(p, id) !== k[id], moved, `${what}: ${id} key ${moved ? 'should change' : 'should not change'}`);
      assert.equal(sigOf(p, id) !== s[id], moved, `${what}: ${id} input signature ${moved ? 'should change' : 'should not change'}`);
    }
  }
  // 不在流里的:这张卡摆在哪、多透明;上面下面别的层
  const same = [
    ['card position, opacity, fade-in', (x) => { Object.assign(clipOf(x, 'trans'), { opacity: 0.5, fadeIn: 0.2, frame: undefined }); clipOf(x, 'fx').opacity = 0.7; }],
    ['the independent card above was edited', (x) => { clipOf(x, 'flat').params.text = 'changed'; }],
    ['a layer was added below', (x) => { x.tracks.push({ id: 't-more', clips: [{ id: 'more', cardId: 'caption-track', start: 0, end: 8, params: {} }] }); }],
  ];
  for (const [what, change] of same) {
    const p = edit(change);
    for (const id of ['fx', 'trans']) { assert.equal(keyOf(p, id), k[id], `${what}: ${id} key unchanged`); assert.equal(sigOf(p, id), s[id], `${what}: ${id} signature unchanged`); }
  }
  // 转场接的那段视频自己在时间轴上挪了:画面不变(素材效果卡按自己的时间加输入的偏移取帧,不看那个片段摆在哪),键不变;
  // 页面的签名记着两个片段的起点差,会变 —— 页面先不贴,渲染节点认下新一版后照同一个键重写层表里的签名,页面再贴上
  const movedSource = edit((x) => { clipOf(x, 'va').end = 3.4; clipOf(x, 'va').start = 0.2; });
  assert.equal(keyOf(movedSource, 'trans'), k.trans);
  assert.notEqual(sigOf(movedSource, 'trans'), s.trans);
});

test('SS-key-spatial 3D frame: the 3D properties, position, and in-plane scaling and rotation are not in the stream, so changing them leaves the key and signature unchanged; the key changes only when the frame\'s width and height, the card\'s parameters or the perspective field of view change', () => {
  const base = project();
  const k = keyOf(base, 'tilt'), s = sigOf(base, 'tilt');
  for (const [what, change] of [
    ['rotateY', (x) => { clipOf(x, 'tilt').frame.rotateY = -50; }],
    ['rotateX and translateZ', (x) => { clipOf(x, 'tilt').frame.rotateX = 0; clipOf(x, 'tilt').frame.translateZ = -300; }],
    ['position, anchor, scale, rotation', (x) => { Object.assign(clipOf(x, 'tilt').frame, { x: 100, y: 80, anchor: [0, 0], scale: 1.5, rotate: 12 }); }],
  ]) {
    const p = edit(change);
    assert.equal(keyOf(p, 'tilt'), k, `${what}: key unchanged`);
    assert.equal(sigOf(p, 'tilt'), s, `${what}: signature unchanged`);
    assert.equal(specOf(p, 'tilt').solo, 'spatial');
  }
  // 三维全拿掉:变回平面的独立卡,同一个键(流里的画面本来就一样),只是不再单独成流
  const flatten = edit((x) => { const f = clipOf(x, 'tilt').frame; delete f.rotateY; delete f.rotateX; });
  assert.equal(keyOf(flatten, 'tilt'), k);
  assert.ok(!('solo' in specOf(flatten, 'tilt')));
  for (const [what, change] of [
    ['frame width and height', (x) => { clipOf(x, 'tilt').frame.w = 500; }],
    ['card parameters', (x) => { clipOf(x, 'tilt').params.text = 'changed'; }],
    ['perspective field of view', (x) => { x.camera3dFov = 35; }],
  ]) {
    const p = edit(change);
    assert.notEqual(keyOf(p, 'tilt'), k, `${what}: key changed`);
    assert.notEqual(sigOf(p, 'tilt'), s, `${what}: signature changed`);
  }
});

/* ================================================================== 隔离工程 */

test('SS-isolated: the isolated project of a source-dependent card: only this card is shown, the video clips it uses all stay in a hidden track (media and nodes untouched); its appearance properties are removed', () => {
  const p = edit((x) => { Object.assign(clipOf(x, 'trans'), { opacity: 0.5, fadeIn: 0.3, emphasis: { kind: 'shadow' } }); });
  const trans = specOf(p, 'trans');
  const iso = isolatedStreamProject(p, trans);
  const visible = iso.tracks.filter(t => !t.hidden);
  assert.deepEqual(visible.map(t => t.clips.map(c => c.id)), [['trans']]);
  const shown = visible[0].clips[0];
  assert.equal(shown.nodeId, 'n-trans');
  assert.equal(shown.cardId, 'tr-fade');
  for (const gone of ['opacity', 'fadeIn', 'emphasis', 'motion']) assert.ok(!(gone in shown), `${gone} is not in the stream`);
  assert.deepEqual([shown.start, shown.end], [3.1, 4.1], 'Time is not shifted');
  // 两段视频还在,只是不出画
  for (const id of ['va', 'vb']) {
    const track = iso.tracks.find(t => t.clips.some(c => c.id === id));
    assert.equal(track.hidden, true); assert.equal(track.sourceOnly, true);
    assert.deepEqual(track.clips.find(c => c.id === id), clipOf(p, id));
  }
  assert.deepEqual(iso.cardNodes, p.cardNodes);
  assert.deepEqual(iso.media, p.media);
  // 隔离工程的卡片图里,转场的两路输入解得到(没有被当成「片段已删除」丢掉)
  const graph = projectCardGraph(iso, getCard);
  const node = graph.nodes.find(n => n.id === 'n-trans');
  assert.deepEqual(Object.keys(node.inputs).sort(), ['A', 'B']);
  assert.equal(node.missingInputs, undefined);
  assert.deepEqual(graph.outputs.map(o => o.clipId), ['trans'], 'only this card is shown');
  // 套在视频上的那一种:这个片段自己带着素材和节点
  const fx = isolatedStreamProject(p, specOf(p, 'fx')).tracks.find(t => !t.hidden).clips[0];
  assert.deepEqual([fx.id, fx.mediaId, fx.mediaOffset, fx.nodeId], ['fx', 'm3', 0.5, 'n-fx']);
});

test('SS-isolated-spatial: the isolated project of a 3D frame: the frame keeps only position and width/height (the stream holds the flat picture before it is transformed), the perspective field of view is unchanged', () => {
  const p = project();
  const tilt = specOf(p, 'tilt');
  const iso = isolatedStreamProject(p, tilt);
  const shown = iso.tracks.filter(t => !t.hidden).flatMap(t => t.clips);
  assert.deepEqual(shown.map(c => c.id), ['tilt']);
  assert.deepEqual(shown[0].frame, { x: 340, y: 210, w: 600, h: 300, anchor: [0, 0] }, 'no rotateX / rotateY / translateZ, and no scale or rotation');
  assert.equal(iso.camera3dFov, 50);
});

/* ================================================================== 回放 */

test('SS-replay replay: needed when the card itself is motion-style; not needed for remotion-style cards that only take media; needed when the input chain has other media effect cards', () => {
  const p = project();
  assert.equal(specOf(p, 'fx').replay, true, 'fx-invert is motion-style');
  assert.equal(specOf(p, 'fx').mountFrame, 38, 'starts from its own mount frame (0.05 s before the in point)');
  assert.equal(specOf(p, 'trans').replay, false, 'tr-fade is remotion-style, both inputs take media');
  // remotion 式的素材效果卡套在视频上:不回放
  const direct = edit((x) => { clipOf(x, 'fx').cardId = 'fx-direct'; nodeOf(x, 'n-fx').cardId = 'fx-direct'; });
  assert.equal(specOf(direct, 'fx').replay, false);
  // 转场的一路改接另一张素材效果卡的输出:那张卡的写法这里拿不到,保守地回放
  const chained = edit((x) => { nodeOf(x, 'n-trans').inputs.A = { nodeId: 'n-fx', offset: 0, rate: 1 }; });
  assert.equal(specOf(chained, 'trans').replay, true);
  // 显式写在项目里的素材节点:和 `@clip/<id>/source` 一样没有历史
  const mediaNode = edit((x) => { x.cardNodes.push({ id: 'n-m', adapter: 'media', media: x.media[0], inputs: {} }); nodeOf(x, 'n-trans').inputs.A = { nodeId: 'n-m', offset: 0, rate: 1 }; });
  assert.equal(specOf(mediaNode, 'trans').replay, false);
  // 三维外框的独立卡:照它自己的写法
  assert.equal(specOf(p, 'tilt').replay, true);
});

/* ================================================================== 切分与认领 */

const planTask = planTaskOf({ projectId: 'source-p', projectRev: 3 });
function splitOf(p, extra = {}, mapStream = s => s) {
  const entry = entryOf(p);
  const specs = planStreams(entry, { envFingerprint: FP, codeVersion: CV, below: false });
  const tasks = splitPlan({
    planTask, entryKey: entry.key, cardPlan: entry.cardPlan.map(c => ({ ...c, cardId: clipOf(p, c.clipId)?.cardId ?? null })),
    streams: specs.map(queueStreamOf).map(mapStream), envFingerprint: FP, codeVersion: CV,
    weightOf: () => ({ class: 'medium', estMs: null }), ...extra,
  });
  return { entry, specs, tasks, streams: tasks.filter(t => t.kind === 'stream') };
}

test('SS-split splitting: streams of these two kinds produce only the splitter\'s own copy (needs local transcoding), the browser copy is not produced; sparse stream tasks are still produced, ranked ahead of full density', () => {
  const p = project();
  const { specs, streams } = splitOf(p, { browserFingerprints: [BROWSER], sparseStreams: true });
  for (const id of ['fx', 'trans', 'tilt']) {
    const spec = specs.find(s => s.topClipId === id);
    const mine = streams.filter(t => t.input.contentKey === spec.contentKey);
    assert.ok(mine.length >= 2, `${id}: has tasks`);
    for (const t of mine) {
      assert.equal(t.requires.envFingerprint, FP, `${id}: only the splitter's own fingerprint`);
      assert.equal(t.resultKey, spec.streamKey);
      assert.equal(t.requires.transcode, true);
      assert.deepEqual(t.requires.capabilities, { streams: true });
      assert.equal(t.requires.belowDependent, false);
      assert.deepEqual(Object.keys(t.input).filter(key => key !== 'density').sort(), ['cardId', 'clipId', 'contentKey', 'entryKey'], `${id}: no input for the browser copy (stream / bake / dual)`);
    }
    // 先稀疏后满密度,同一个结果键
    assert.deepEqual(mine.map(t => t.input.density ?? 'dense'), [...mine.filter(t => t.input.density).map(() => 'sparse'), ...mine.filter(t => !t.input.density).map(() => 'dense')]);
    assert.ok(mine.some(t => t.input.density === 'sparse') && mine.some(t => !t.input.density));
    assert.ok(mine.filter(t => t.input.density === 'sparse').every(t => t.priority > mine.find(x => !x.input.density).priority), `${id}: sparse stream tasks rank ahead of full density`);
  }
  // 三维外框的那张是内置的独立卡:要不是单独成流,浏览器本来做得了(同一次切分里平面的那张就有浏览器那一份)
  const flat = specs.find(s => s.topClipId === 'flat');
  assert.ok(streams.some(t => t.input.contentKey === flat.contentKey && t.requires.envFingerprint === BROWSER), 'the flat independent card has the browser copy');
  assert.ok(streams.filter(t => t.requires.envFingerprint === BROWSER).every(t => t.input.contentKey === flat.contentKey), 'the browser copy exists only for flat independent cards');
  // 分段范围:fx 是 0～3(51 帧),一个任务;帧数按实际算
  const fx = specs.find(s => s.topClipId === 'fx');
  const dense = streams.filter(t => t.input.contentKey === fx.contentKey && !t.input.density);
  assert.deepEqual(dense.map(t => [t.range.from, t.range.to, t.weight.frames]), [[0, 3, 51]]);
});

test('SS-claim claiming: the desktop app and the render host can claim; a pure browser node cannot (needs transcoding)', () => {
  const { specs, streams } = splitOf(project());
  const node = (profile, capabilities, extra = {}) => ({ profile, envFingerprint: FP, codeVersions: [CV], capabilities, ownProjectIds: ['source-p'], ...extra });
  for (const id of ['fx', 'trans', 'tilt']) {
    const spec = specs.find(s => s.topClipId === id);
    const task = { ...streams.find(t => t.input.contentKey === spec.contentKey), source: { projectId: 'source-p', projectRev: 3, userId: 'u1' } };
    assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, transcode: true, streams: true })), { ok: true }, `${id}: desktop app`);
    assert.deepEqual(checkClaimable(task, node('host', { userCards: true, transcode: true, streams: true })), { ok: true }, `${id}: render host`);
    assert.deepEqual(checkClaimable(task, node('browser', { transcode: false, streams: true }, { userId: 'u1' })), { ok: false, rule: 2, reason: 'transcode' }, `${id}: browser only`);
  }
});

test('SS-split-media: carries requires.localMedia when it uses media that exists only on the publisher\'s machine (stream tasks always count as using it)', () => {
  const p = edit((x) => { const m = x.media.find(v => v.id === 'm3'); delete m.hash; m.url = '/@media/clip.mp4'; x.media.filter(v => v.id !== 'm3').forEach((v, i) => { v.hash = String(i + 1).repeat(64); v.url = `/@media/${v.hash}`; }); });
  const gate = localMediaGate(p);
  assert.equal(typeof gate, 'function');
  const { specs, streams } = splitOf(p, { localMedia: 'node-pub', usesLocalMedia: gate });
  const fx = specs.find(s => s.topClipId === 'fx');
  const mine = streams.filter(t => t.input.contentKey === fx.contentKey);
  assert.ok(mine.length > 0);
  for (const t of mine) assert.equal(t.requires.localMedia, 'node-pub');
});

test('SS-list: manifest plan of the online page: when the splitter can produce streams, these two kinds still output their own copy as single-card streams; when the splitter cannot, no copy is output at all (the browser cannot do it)', () => {
  const p = project();
  const entry = entryOf(p);
  const listed = planListStreams(entry, ['fx', 'trans', 'tilt', 'flat'], { envFingerprint: FP, codeVersion: CV });
  assert.deepEqual(listed.map(s => `${s.topClipId}:${s.solo ?? '-'}`), ['flat:-', 'fx:source', 'trans:source', 'tilt:spatial']);
  // 单卡流的内容键与清单里还有哪些片段无关:只给一个片段也算得出同一条流(执行器按任务的片段把它对回这一版)
  for (const id of ['fx', 'trans', 'tilt']) {
    assert.equal(planListStreams(entry, [id], { envFingerprint: FP, codeVersion: CV })[0].contentKey, listed.find(s => s.topClipId === id).contentKey);
  }
  const listTask = clipsPlanTaskOf({ projectId: 'source-p', projectRev: 3, clips: ['fx', 'trans', 'tilt', 'flat'], codeVersion: CV, streams: true });
  const browserStreamsFor = clips => planListStreams(entry, clips, { envFingerprint: FP, codeVersion: CV }).map(queueStreamOf);
  const tasksOf = (overrides) => splitPlan({
    planTask: listTask, entryKey: entry.key, cardPlan: entry.cardPlan.map(c => ({ ...c, cardId: clipOf(p, c.clipId)?.cardId ?? null })),
    envFingerprint: FP, codeVersion: CV, weightOf: () => ({ class: 'medium', estMs: null }), browserFingerprints: [BROWSER], ...overrides,
  }).filter(t => t.kind === 'stream');
  const own = listPlanOverrides(listTask, { browserStreamsFor, ownListStreams: true });
  if (Object.keys(own).length) {
    const tasks = tasksOf(own);
    for (const id of ['fx', 'trans', 'tilt']) {
      const key = listed.find(s => s.topClipId === id).contentKey;
      assert.deepEqual([...new Set(tasks.filter(t => t.input.contentKey === key).map(t => t.requires.envFingerprint))], [FP], `${id}: only the splitter's own copy`);
    }
    const none = tasksOf(listPlanOverrides(listTask, { browserStreamsFor }));
    for (const id of ['fx', 'trans', 'tilt']) {
      const key = listed.find(s => s.topClipId === id).contentKey;
      assert.deepEqual(none.filter(t => t.input.contentKey === key), [], `${id}: no copy at all when the splitter cannot produce streams`);
    }
    assert.ok(none.some(t => t.requires.envFingerprint === BROWSER), 'flat independent cards still go to the browser');
  } else assert.fail('this task was not recognized as a manifest plan');
});

/* ================================================================== 层表 */

test('SS-layer-map: the streams table of the layer table: these two kinds are rows like ordinary single-card streams (kind card, plane local), and the input signature is the one the page computes', () => {
  const p = project();
  const entry = entryOf(p);
  const specs = planStreams(entry, { envFingerprint: FP, codeVersion: CV, below: false });
  const rows = layerStreamsOf(entry, { streams: specs, fingerprint: FP });
  for (const id of ['fx', 'trans', 'tilt']) {
    const spec = specs.find(s => s.topClipId === id);
    const row = rows.find(r => r.topClipId === id);
    assert.deepEqual(row, {
      topClipId: id, clipIds: [id], kind: 'card', plane: 'local', contentKey: spec.contentKey,
      candidates: [{ envFingerprint: FP, resultKey: spec.streamKey }],
      originFrame: spec.originFrame, lastSegment: spec.lastSegment, segmentsPerTask: row.segmentsPerTask,
      inputSig: sigOf(p, id),
    });
  }
  // 页面按改过的项目算:视频的裁剪改了对不上,三维的角度改了照旧对得上
  assert.notEqual(streamInputSig(edit((x) => { clipOf(x, 'fx').mediaOffset = 1; }), rows.find(r => r.topClipId === 'fx')), rows.find(r => r.topClipId === 'fx').inputSig);
  assert.equal(streamInputSig(edit((x) => { clipOf(x, 'tilt').frame.rotateY = 5; }), rows.find(r => r.topClipId === 'tilt')), rows.find(r => r.topClipId === 'tilt').inputSig);
});

test('SS-sparse: the sparse version\'s interval is the frame count of one segment (these two kinds use the same constant as the other streams, no separate one)', () => {
  assert.equal(SPARSE_STRIDE, SEGMENT_FRAMES);
});

/* ================================================================== 位置矩形 */

test('SS-opaque-box: a screenshot with no alpha channel (the picture fills the frame and is opaque, as most streams carrying video are): the placement rectangle is the whole image, not treated as unreadable', () => {
  const png = new PNG({ width: 64, height: 40 });
  png.data.fill(255);
  const rgb = PNG.sync.write(png, { colorType: 2 });
  assert.equal(rgb[25], 2, 'the output is a true-color PNG with no alpha channel');
  assert.deepEqual(pngAlphaBox(rgb), { x: 0, y: 0, w: 64, h: 40 });
  const gray = PNG.sync.write(png, { colorType: 0 });
  assert.deepEqual(pngAlphaBox(gray), { x: 0, y: 0, w: 64, h: 40 });
  // 带 alpha 通道的照旧逐像素量;全透明照旧是 null
  assert.deepEqual(pngAlphaBox(PNG.sync.write(png)), { x: 0, y: 0, w: 64, h: 40 });
  png.data.fill(0);
  assert.equal(pngAlphaBox(PNG.sync.write(png)), null);
  // 真彩色但带透明色(tRNS):有的像素可能是透明的,这里不解,照旧回「读不懂」
  const keyed = Buffer.concat([rgb.subarray(0, 33), Buffer.from([0, 0, 0, 6]), Buffer.from('tRNS'), Buffer.alloc(6), Buffer.alloc(4), rgb.subarray(33)]);
  assert.deepEqual(pngAlphaBox(keyed), { full: true });
});
