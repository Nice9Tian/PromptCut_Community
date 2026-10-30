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

test('SS-eligible 源依赖卡:接了输入的素材效果卡(转场、套在素材上的),或审阅表写了 sourceDependent;三维外框的独立卡;别的不算', () => {
  const p = project();
  const entry = entryOf(p);
  const kind = id => soloStreamKind(controlOf(entry, id), clipOf(p, id), trackOf(p, id), p);
  assert.equal(controlOf(entry, 'fx').compositing, 'unknown', '素材效果卡没审阅过');
  assert.equal(kind('fx'), 'source', '套在视频上的素材效果卡');
  assert.equal(kind('trans'), 'source', '转场');
  assert.equal(kind('tilt'), 'spatial', '外框带三维的独立卡');
  assert.equal(kind('flat'), null, '平面的独立卡走单卡流');
  assert.equal(kind('gen'), null, '没有输入的素材效果卡不算源依赖');
  assert.equal(kind('glass3'), null, '依赖下层又带三维的不在这里');
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
  assert.equal(soloStreamKind(ctl('sourceDependent'), clip, track, {}), 'source', '审阅表写了 sourceDependent');
  assert.equal(soloStreamKind(ctl('sourceDependent'), { ...clip, frame: { rotateY: 20 } }, track, {}), 'source', '两类同时成立算源依赖');
  assert.equal(soloStreamKind(ctl('independent'), { ...clip, frame: { translateZ: -100 } }, track, {}), 'spatial');
  assert.equal(soloStreamKind(ctl('independent'), { ...clip, frame: { rotate: 30, scale: 2 } }, track, {}), null, '平面里的旋转、缩放不算三维');
  assert.equal(soloStreamKind(ctl('belowDependent'), { ...clip, nodeId: 'n' }, track, { cardNodes: [{ id: 'n', adapter: 'card', inputs: { source: 'x' } }] }), null, '审阅表说依赖下层的照审阅表');
  assert.equal(soloStreamKind(ctl('context'), { ...clip, nodeId: 'n' }, track, { cardNodes: [{ id: 'n', adapter: 'card', inputs: { source: 'x' } }] }), 'source', '旧的统称,接了输入');
  assert.equal(soloStreamKind(ctl('unknown'), { ...clip, nodeId: 'n' }, track, { cardNodes: [{ id: 'n', adapter: 'card', kind: 'audio', inputs: { source: 'x' } }] }), null, '只出声音的素材效果卡不算');
  assert.equal(soloStreamKind(ctl('unknown'), { ...clip, nodeId: 'n' }, track, { cardNodes: { n: { id: 'n', adapter: 'card', inputs: { source: 'x' } } } }), 'source', '节点按 id 存成对象的旧数据也认');
  // 不出画、没有帧的不算
  assert.equal(soloStreamKind(ctl('sourceDependent'), clip, { id: 't', hidden: true }, {}), null);
  assert.equal(soloStreamKind(ctl('sourceDependent'), clip, { id: 't', sourceOnly: true }, {}), null);
  assert.equal(soloStreamKind(ctl('sourceDependent', { count: 0 }), clip, track, {}), null);
  assert.equal(soloStreamKind(ctl('sourceDependent'), { ...clip, cardId: '' }, track, {}), null, '纯素材段不是卡');
  // 「依赖下层的流」的判据对这几张卡怎么说:接了输入的素材效果卡它也认(未知),所以计划里要先把单独成流的挑走
  assert.equal(belowStreamEligible(controlOf(entry, 'fx'), clipOf(p, 'fx'), trackOf(p, 'fx')), true);
});

/* ================================================================== 计划 */

test('SS-plan 这两类各出一条单卡流(kind card、plane local),带 solo;分段从自己的第一帧起数;没有输入的素材效果卡、依赖下层又带三维的不在这两类里(关着依赖下层的流时不出)', () => {
  const p = project();
  const specs = plan(p);
  assert.deepEqual(specs.map(s => `${s.kind}:${s.clipIds}:${s.solo ?? '-'}`), ['card:flat:-', 'card:fx:source', 'card:trans:source', 'card:tilt:spatial'],
    '平面的独立卡在前;单独成流的按画家顺序排在后面');
  for (const s of specs) { assert.equal(s.plane, 'local'); assert.equal(s.firstSegment, 0); assert.equal(s.clipIds.length, 1); assert.equal(s.streamKey, resultKeyOf(s.contentKey, FP)); }
  const fx = specs.find(s => s.topClipId === 'fx');
  // 1.3 秒 = 第 39 帧,3 秒之前的最后一帧是第 89 帧:51 帧,4 个分段(15、15、15、6)
  assert.deepEqual([fx.originFrame, fx.firstFrame, fx.lastFrame, fx.lastSegment], [39, 39, 89, 3]);
  assert.notEqual(fx.originFrame % SEGMENT_FRAMES, 0, '不从 15 的倍数帧开始');
  assert.deepEqual(fx.offset, { x: 0, y: 0 });
  assert.deepEqual(fx.bound, { x: 0, y: 0, w: 1280, h: 720 }, '没有框:整个画面');
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

test('SS-plan-same 项目里没有这两类卡时,计划与原来逐项相同;有的时候,平面独立卡那几条的键和形状不受影响', () => {
  const p = project();
  const without = edit((x) => { x.tracks = x.tracks.filter(t => !['t-tilt', 't-trans', 't-fx'].includes(t.id)); x.cardNodes = x.cardNodes.filter(n => n.id === 'n-gen'); });
  const a = plan(without);
  assert.deepEqual(a.map(s => `${s.kind}:${s.clipIds}`), ['card:flat']);
  assert.ok(a.every(s => !('solo' in s)), '没有这两类卡:规格里没有 solo 这一项');
  assert.deepEqual(plan(p).find(s => s.topClipId === 'flat'), a[0], '旁边多了单独成流的卡,平面独立卡的那一条一个字不变');
});

test('SS-below 「依赖下层的流」打开时:接了输入的素材效果卡不再出那种流(已经单独成流);没有输入的照旧归它;依赖下层又带三维的也归它(舞台坐标,三维画进流里)', () => {
  const p = project();
  const on = plan(p, { below: true });
  assert.deepEqual(on.map(s => `${s.kind}:${s.clipIds}:${s.solo ?? '-'}`), ['card:flat:-', 'card:fx:source', 'card:trans:source', 'card:tilt:spatial', 'below:glass3:-', 'below:gen:-']);
  assert.deepEqual(on.slice(0, 4), plan(p), '开关不影响前面几条');
  const glass3 = on.find(s => s.topClipId === 'glass3');
  assert.deepEqual([glass3.kind, glass3.plane, 'solo' in glass3], ['below', 'stage', false], '依赖下层又带三维的:一条依赖下层的流,不是单独成流的那一种');
});

test('SS-nomerge 不参加组流合并,但各占一个解码器:它们把预算顶超了,合并的是旁边平面的独立卡', () => {
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
  assert.deepEqual(shape(plan(p, { budget: 6 })), ['card:c', 'card:b', 'card:a', 'card:trans', 'card:tilt'], '预算够:各一条');
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

test('SS-key-source 视频或卡的参数、裁剪、时间映射任一变了,流的键和页面的输入签名都变;卡摆在哪、上下别的层怎么改都不变', () => {
  const base = project();
  const k = { fx: keyOf(base, 'fx'), trans: keyOf(base, 'trans') };
  const s = { fx: sigOf(base, 'fx'), trans: sigOf(base, 'trans') };
  assert.ok(k.fx && k.trans && s.fx && s.trans);
  /** [说明, 改法, 哪张卡的流该变] */
  const changes = [
    ['套着的那段视频换了一段', (x) => { clipOf(x, 'fx').mediaId = 'm1'; }, ['fx']],
    ['素材本身换了内容(哈希变)', (x) => { x.media.find(m => m.id === 'm3').hash = 'h3b'; x.media.find(m => m.id === 'm3').url = '/@media/h3b'; }, ['fx']],
    ['视频的裁剪起点', (x) => { clipOf(x, 'fx').mediaOffset = 0.8; }, ['fx']],
    ['卡的参数', (x) => { clipOf(x, 'fx').params.amount = 0.5; }, ['fx']],
    ['输入的时间偏移', (x) => { nodeOf(x, 'n-fx').inputs.source.offset = 0.25; }, ['fx']],
    ['输入的倍速', (x) => { nodeOf(x, 'n-fx').inputs.source.rate = 0.5; }, ['fx']],
    ['片段在时间轴上挪了一帧', (x) => { clipOf(x, 'fx').start += 1 / 30; clipOf(x, 'fx').end += 1 / 30; }, ['fx']],
    ['片段变长', (x) => { clipOf(x, 'fx').end = 3.5; }, ['fx']],
    ['转场:前一段视频换了素材', (x) => { clipOf(x, 'va').mediaId = 'm3'; }, ['trans']],
    ['转场:后一段视频的裁剪起点', (x) => { clipOf(x, 'vb').mediaOffset = 2.5; }, ['trans']],
    ['转场:一路输入的时间偏移', (x) => { nodeOf(x, 'n-trans').inputs.A.offset = 3; }, ['trans']],
    ['转场:一路输入改接另一个片段', (x) => { nodeOf(x, 'n-trans').inputs.B.nodeId = '@clip/va/source'; }, ['trans']],
    ['转场:卡的参数', (x) => { clipOf(x, 'trans').params.curve = 2; }, ['trans']],
    ['转场:一路输入的片段删了', (x) => { x.tracks = x.tracks.filter(t => t.id !== 't-vb'); }, ['trans']],
    ['画幅', (x) => { x.width = 1920; x.height = 1080; }, ['fx', 'trans']],
  ];
  for (const [what, change, affected] of changes) {
    const p = edit(change);
    for (const id of ['fx', 'trans']) {
      const moved = affected.includes(id);
      assert.equal(keyOf(p, id) !== k[id], moved, `${what}:${id} 的键${moved ? '该变' : '不该变'}`);
      assert.equal(sigOf(p, id) !== s[id], moved, `${what}:${id} 的输入签名${moved ? '该变' : '不该变'}`);
    }
  }
  // 不在流里的:这张卡摆在哪、多透明;上面下面别的层
  const same = [
    ['卡的位置、不透明度、淡入', (x) => { Object.assign(clipOf(x, 'trans'), { opacity: 0.5, fadeIn: 0.2, frame: undefined }); clipOf(x, 'fx').opacity = 0.7; }],
    ['上面的独立卡改了', (x) => { clipOf(x, 'flat').params.text = 'changed'; }],
    ['下面多了一层', (x) => { x.tracks.push({ id: 't-more', clips: [{ id: 'more', cardId: 'caption-track', start: 0, end: 8, params: {} }] }); }],
  ];
  for (const [what, change] of same) {
    const p = edit(change);
    for (const id of ['fx', 'trans']) { assert.equal(keyOf(p, id), k[id], `${what}:${id} 的键不变`); assert.equal(sigOf(p, id), s[id], `${what}:${id} 的签名不变`); }
  }
  // 转场接的那段视频自己在时间轴上挪了:画面不变(素材效果卡按自己的时间加输入的偏移取帧,不看那个片段摆在哪),键不变;
  // 页面的签名记着两个片段的起点差,会变 —— 页面先不贴,渲染节点认下新一版后照同一个键重写层表里的签名,页面再贴上
  const movedSource = edit((x) => { clipOf(x, 'va').end = 3.4; clipOf(x, 'va').start = 0.2; });
  assert.equal(keyOf(movedSource, 'trans'), k.trans);
  assert.notEqual(sigOf(movedSource, 'trans'), s.trans);
});

test('SS-key-spatial 三维外框:三维那几项、位置、平面里的缩放旋转都不在流里,改了键和签名不变;框的宽高、卡的参数、透视的视角改了才变', () => {
  const base = project();
  const k = keyOf(base, 'tilt'), s = sigOf(base, 'tilt');
  for (const [what, change] of [
    ['rotateY', (x) => { clipOf(x, 'tilt').frame.rotateY = -50; }],
    ['rotateX 与 translateZ', (x) => { clipOf(x, 'tilt').frame.rotateX = 0; clipOf(x, 'tilt').frame.translateZ = -300; }],
    ['位置、锚点、缩放、旋转', (x) => { Object.assign(clipOf(x, 'tilt').frame, { x: 100, y: 80, anchor: [0, 0], scale: 1.5, rotate: 12 }); }],
  ]) {
    const p = edit(change);
    assert.equal(keyOf(p, 'tilt'), k, `${what}:键不变`);
    assert.equal(sigOf(p, 'tilt'), s, `${what}:签名不变`);
    assert.equal(specOf(p, 'tilt').solo, 'spatial');
  }
  // 三维全拿掉:变回平面的独立卡,同一个键(流里的画面本来就一样),只是不再单独成流
  const flatten = edit((x) => { const f = clipOf(x, 'tilt').frame; delete f.rotateY; delete f.rotateX; });
  assert.equal(keyOf(flatten, 'tilt'), k);
  assert.ok(!('solo' in specOf(flatten, 'tilt')));
  for (const [what, change] of [
    ['框的宽高', (x) => { clipOf(x, 'tilt').frame.w = 500; }],
    ['卡的参数', (x) => { clipOf(x, 'tilt').params.text = 'changed'; }],
    ['透视的视角', (x) => { x.camera3dFov = 35; }],
  ]) {
    const p = edit(change);
    assert.notEqual(keyOf(p, 'tilt'), k, `${what}:键变`);
    assert.notEqual(sigOf(p, 'tilt'), s, `${what}:签名变`);
  }
});

/* ================================================================== 隔离工程 */

test('SS-isolated 源依赖卡的隔离工程:只有这张卡出画,它用到的视频片段都留在藏起来的序列里(素材、节点原样);外观拿掉', () => {
  const p = edit((x) => { Object.assign(clipOf(x, 'trans'), { opacity: 0.5, fadeIn: 0.3, emphasis: { kind: 'shadow' } }); });
  const trans = specOf(p, 'trans');
  const iso = isolatedStreamProject(p, trans);
  const visible = iso.tracks.filter(t => !t.hidden);
  assert.deepEqual(visible.map(t => t.clips.map(c => c.id)), [['trans']]);
  const shown = visible[0].clips[0];
  assert.equal(shown.nodeId, 'n-trans');
  assert.equal(shown.cardId, 'tr-fade');
  for (const gone of ['opacity', 'fadeIn', 'emphasis', 'motion']) assert.ok(!(gone in shown), `${gone} 不在流里`);
  assert.deepEqual([shown.start, shown.end], [3.1, 4.1], '时间不平移');
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
  assert.deepEqual(graph.outputs.map(o => o.clipId), ['trans'], '出画的只有这一张');
  // 套在视频上的那一种:这个片段自己带着素材和节点
  const fx = isolatedStreamProject(p, specOf(p, 'fx')).tracks.find(t => !t.hidden).clips[0];
  assert.deepEqual([fx.id, fx.mediaId, fx.mediaOffset, fx.nodeId], ['fx', 'm3', 0.5, 'n-fx']);
});

test('SS-isolated-spatial 三维外框的隔离工程:框只留位置和宽高(流里是变形之前的平面画面),透视的视角原样', () => {
  const p = project();
  const tilt = specOf(p, 'tilt');
  const iso = isolatedStreamProject(p, tilt);
  const shown = iso.tracks.filter(t => !t.hidden).flatMap(t => t.clips);
  assert.deepEqual(shown.map(c => c.id), ['tilt']);
  assert.deepEqual(shown[0].frame, { x: 340, y: 210, w: 600, h: 300, anchor: [0, 0] }, '没有 rotateX / rotateY / translateZ,也没有缩放旋转');
  assert.equal(iso.camera3dFov, 50);
});

/* ================================================================== 回放 */

test('SS-replay 回放:这张卡自己是 motion 式的要;remotion 式、只接素材的不要;输入链上还有别的素材效果卡的要', () => {
  const p = project();
  assert.equal(specOf(p, 'fx').replay, true, 'fx-invert 是 motion 式');
  assert.equal(specOf(p, 'fx').mountFrame, 38, '从它自己的挂载帧起(入点前 0.05 秒)');
  assert.equal(specOf(p, 'trans').replay, false, 'tr-fade 是 remotion 式,两路都接素材');
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

test('SS-split 切分:这两类的流只出切分方自己的一份(要本机转码),浏览器那一份不出;稀疏流任务照出,排在满密度前面', () => {
  const p = project();
  const { specs, streams } = splitOf(p, { browserFingerprints: [BROWSER], sparseStreams: true });
  for (const id of ['fx', 'trans', 'tilt']) {
    const spec = specs.find(s => s.topClipId === id);
    const mine = streams.filter(t => t.input.contentKey === spec.contentKey);
    assert.ok(mine.length >= 2, `${id}:有任务`);
    for (const t of mine) {
      assert.equal(t.requires.envFingerprint, FP, `${id}:只有切分方自己的指纹`);
      assert.equal(t.resultKey, spec.streamKey);
      assert.equal(t.requires.transcode, true);
      assert.deepEqual(t.requires.capabilities, { streams: true });
      assert.equal(t.requires.belowDependent, false);
      assert.deepEqual(Object.keys(t.input).filter(key => key !== 'density').sort(), ['cardId', 'clipId', 'contentKey', 'entryKey'], `${id}:不带浏览器那一份的输入(stream / bake / dual)`);
    }
    // 先稀疏后满密度,同一个结果键
    assert.deepEqual(mine.map(t => t.input.density ?? 'dense'), [...mine.filter(t => t.input.density).map(() => 'sparse'), ...mine.filter(t => !t.input.density).map(() => 'dense')]);
    assert.ok(mine.some(t => t.input.density === 'sparse') && mine.some(t => !t.input.density));
    assert.ok(mine.filter(t => t.input.density === 'sparse').every(t => t.priority > mine.find(x => !x.input.density).priority), `${id}:稀疏流任务的名次在满密度之前`);
  }
  // 三维外框的那张是内置的独立卡:要不是单独成流,浏览器本来做得了(同一次切分里平面的那张就有浏览器那一份)
  const flat = specs.find(s => s.topClipId === 'flat');
  assert.ok(streams.some(t => t.input.contentKey === flat.contentKey && t.requires.envFingerprint === BROWSER), '平面的独立卡有浏览器那一份');
  assert.ok(streams.filter(t => t.requires.envFingerprint === BROWSER).every(t => t.input.contentKey === flat.contentKey), '浏览器那一份只有平面独立卡的');
  // 分段范围:fx 是 0～3(51 帧),一个任务;帧数按实际算
  const fx = specs.find(s => s.topClipId === 'fx');
  const dense = streams.filter(t => t.input.contentKey === fx.contentKey && !t.input.density);
  assert.deepEqual(dense.map(t => [t.range.from, t.range.to, t.weight.frames]), [[0, 3, 51]]);
});

test('SS-claim 认领:桌面应用和渲染主机能认领;纯浏览器节点认领不了(要转码)', () => {
  const { specs, streams } = splitOf(project());
  const node = (profile, capabilities, extra = {}) => ({ profile, envFingerprint: FP, codeVersions: [CV], capabilities, ownProjectIds: ['source-p'], ...extra });
  for (const id of ['fx', 'trans', 'tilt']) {
    const spec = specs.find(s => s.topClipId === id);
    const task = { ...streams.find(t => t.input.contentKey === spec.contentKey), source: { projectId: 'source-p', projectRev: 3, userId: 'u1' } };
    assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, transcode: true, streams: true })), { ok: true }, `${id}:桌面应用`);
    assert.deepEqual(checkClaimable(task, node('host', { userCards: true, transcode: true, streams: true })), { ok: true }, `${id}:渲染主机`);
    assert.deepEqual(checkClaimable(task, node('browser', { transcode: false, streams: true }, { userId: 'u1' })), { ok: false, rule: 2, reason: 'transcode' }, `${id}:纯浏览器`);
  }
});

test('SS-split-media 用到只在发布方本机的素材时带 requires.localMedia(流任务一律算用到)', () => {
  const p = edit((x) => { const m = x.media.find(v => v.id === 'm3'); delete m.hash; m.url = '/@media/clip.mp4'; x.media.filter(v => v.id !== 'm3').forEach((v, i) => { v.hash = String(i + 1).repeat(64); v.url = `/@media/${v.hash}`; }); });
  const gate = localMediaGate(p);
  assert.equal(typeof gate, 'function');
  const { specs, streams } = splitOf(p, { localMedia: 'node-pub', usesLocalMedia: gate });
  const fx = specs.find(s => s.topClipId === 'fx');
  const mine = streams.filter(t => t.input.contentKey === fx.contentKey);
  assert.ok(mine.length > 0);
  for (const t of mine) assert.equal(t.requires.localMedia, 'node-pub');
});

test('SS-list 在线页面的清单计划:切分方能产流时这两类照单卡流出自己的那一份;切分方产不了时一份都不出(浏览器做不了)', () => {
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
      assert.deepEqual([...new Set(tasks.filter(t => t.input.contentKey === key).map(t => t.requires.envFingerprint))], [FP], `${id}:只有切分方自己的那一份`);
    }
    const none = tasksOf(listPlanOverrides(listTask, { browserStreamsFor }));
    for (const id of ['fx', 'trans', 'tilt']) {
      const key = listed.find(s => s.topClipId === id).contentKey;
      assert.deepEqual(none.filter(t => t.input.contentKey === key), [], `${id}:切分方产不了流时一份都不出`);
    }
    assert.ok(none.some(t => t.requires.envFingerprint === BROWSER), '平面的独立卡照旧给浏览器');
  } else assert.fail('这份任务没被认成清单计划');
});

/* ================================================================== 层表 */

test('SS-layer-map 层表的 streams 表:这两类是普通的单卡流那种行(kind card、plane local),输入签名是页面算的那一个', () => {
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

test('SS-sparse 稀疏版的间隔就是一个分段的帧数(这两类和别的流同一个常数,不另设)', () => {
  assert.equal(SPARSE_STRIDE, SEGMENT_FRAMES);
});

/* ================================================================== 位置矩形 */

test('SS-opaque-box 没有 alpha 通道的截图(画面铺满又不透明,带着视频的流多半如此):位置矩形是整张图,不当成读不懂', () => {
  const png = new PNG({ width: 64, height: 40 });
  png.data.fill(255);
  const rgb = PNG.sync.write(png, { colorType: 2 });
  assert.equal(rgb[25], 2, '写出来的是真彩色、没有 alpha 通道的 PNG');
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
