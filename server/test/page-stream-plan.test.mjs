/**
 * 本页产流的计划(`src/online/pageStreamPlan.ts`,任务书 `docs/plan/render-refactor-task.md`「甲二」)与切分方的逐字段对拍:
 * 同一条流,页面一侧算出的结果键、流任务、清单、层表里的那一行,与服务端这条链算出的相同 ——
 *
 *   `CardFrameCache.plan`(每张卡的键)→ `planListStreams`(清单计划的流)→ `queueStreamOf` → `splitPlan` 给浏览器出的那一份流任务
 *   → `layerStreamsOf`(层表的 `streams` 表)。
 *
 *   PSP-01  照抄的常量与服务端同值
 *   PSP-02  流的键与形状:内容键、结果键、分段范围、矩形、摆放(整数入点、带小数的入点、带框、超出项目末尾、两张卡)
 *   PSP-03  成员键只有一处:`streamMemberKey` 与切分方用的成员键相同(服务端换算法之后这一条先红)
 *   PSP-04  流任务:id、结果键、范围、input、source、weight、requires、priority 与切分方给浏览器出的那一份相同
 *   PSP-05  清单:同一份分段登记,两边的任务组出的清单相同,过 `manifestMatches`
 *   PSP-06  层表的那一行与 `layerStreamsOf` 写出来的相同
 *   PSP-07  超过解码器预算时合并的结果相同:并进组流的卡两边都不出单卡流
 *   PSP-07b 切分方单独成流的两类卡(三维外框的独立卡、源依赖卡)页面不产,但算进解码器预算:合并的结果仍相同
 *   PSP-08  不产的卡:画布卡、依赖下层、框带三维、隐藏序列两边都不出;页面另外不产的两种(挂了强调的片段、不是内置卡片)
 *   PSP-09  没有指纹、没有代码指纹:一条都不算
 *   PSP-10  并进现有的层表:别的字段与别的卡的行不动、本页的候选提到最前、同一张卡输入签名过期的行去掉(没过期的留在后面)、没有变化时不写;
 *           「先查」认哪些候选:同内容键的,或输入签名没过期的(与播放那一侧同一个判据)
 *
 * 跑:npm test -- server/test/page-stream-plan.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CardFrameCache } from '../card-cache.mjs';
import { captureCode } from '../frame-code.mjs';
import { planListStreams, queueStreamOf, STREAM_CODE_VERSION, STREAM_DECODER_BUDGET, LOCAL_OVERFLOW_PX, SEGMENT_FRAMES } from '../frame-stream.mjs';
import { splitPlan, SPARSE_STREAM_PRIORITY } from '../render-node/split.mjs';
import { clipsPlanTaskOf } from '../render-queue/index.mjs';
import { QUEUE_DEFAULTS } from '../render-queue/constants.mjs';
import { layerStreamsOf, manifestMatches, LAYER_MAP_VERSION } from '../artifact-transfer.mjs';
import { resultKeyOf as serverResultKeyOf } from '../render-node/fingerprint.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';
import { streamManifest, STREAM_SEGMENT_FRAMES } from '../../src/online/browserNode.ts';
import {
  planPageStreams, pageStreamTasks, pageStreamRow, mergeLayerStreams, layerStreamCandidates, candidateSpans, pageControls, streamMemberKey, resultKeyOf,
  PAGE_STREAM_CODE_VERSION, PAGE_STREAM_DECODER_BUDGET, PAGE_LOCAL_OVERFLOW_PX, PAGE_STREAM_SEGMENTS_PER_TASK, PAGE_LAYER_MAP_VERSION,
  PAGE_SNAPSHOT_SPAN, PAGE_SPARSE_STREAM_PRIORITY,
} from '../../src/online/pageStreamPlan.ts';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const OWN = '1111111111111111';      // 切分方的指纹
const BROWSER = '2222222222222222';  // 本页的指纹
const CODES = { capture: captureCode(ROOT) };
const CODE_VERSION = 'code-version-for-test';

/** 注册表的替身:内置卡片只要有 id(能力取审阅表);`user-pill` 当一张用户卡 */
const getCard = id => (id ? { id, defaults: { text: 'x', size: 1 } } : undefined);
const clip = (id, cardId, start, end, extra = {}) => ({ id, cardId, start, end, params: { text: id }, ...extra });
const projectOf = (tracks, extra = {}) => ({
  id: 'proj-page', width: 1920, height: 1080, fps: 30, duration: 8, themeId: 'dark', style: { accent: '#f80' }, media: [], filters: [], pixelMaps: [], cardNodes: [],
  tracks, ...extra,
});

/** 与导出页 `window.__pcCardPlan()` 同形的原料;两边吃同一份 */
function valueOf(project, sourceVersions = null) {
  const graph = projectCardGraph(project, getCard);
  const versions = sourceVersions ?? Object.fromEntries(project.tracks.flatMap(t => t.clips).filter(c => c.cardId).map(c => [c.cardId, `builtin:v-${c.cardId}`]));
  return { graph, sourceVersions: versions, unknownClipIds: [],
    environment: { width: project.width, height: project.height, fps: project.fps, theme: project.themeId, fontFingerprint: '0123456789abcdef' } };
}

/** 服务端这条链:card plan → 清单计划的流 → 切分给浏览器出的那一份 */
function serverSide(project, value, clips, { budget = STREAM_DECODER_BUDGET, sparseStreams = false } = {}) {
  // 经调试协议取回来的图是 JSON 往返过的
  const wire = JSON.parse(JSON.stringify(value));
  const cache = new CardFrameCache({ root: path.join(os.tmpdir(), 'pc-page-stream-plan'), project, envFingerprint: OWN });
  const cardIdOf = new Map(wire.graph.nodes.map(node => [node.id, node.cardId ?? null]));
  const cardPlan = cache.plan(wire).map(control => ({ ...control, cardId: cardIdOf.get(control.nodeId) ?? null }));
  const entry = { key: 'entry-page', project, cardPlan };
  const specs = planListStreams(entry, clips, { budget, codeVersion: `${STREAM_CODE_VERSION}:${CODES.capture}`, envFingerprint: OWN });
  const planTask = clipsPlanTaskOf({ projectId: project.id, projectRev: 7, clips, codeVersion: CODE_VERSION });
  const tasks = splitPlan({
    planTask, entryKey: entry.key, cardPlan, prerenderSet: new Set(clips),
    // 清单计划:切分方自己不产,流只给浏览器出一份(`local-node.mjs` 的 `listPlanOverrides`)
    streams: specs.map(queueStreamOf).map(s => ({ ...s, browserOnly: true })),
    envFingerprint: OWN, codeVersion: CODE_VERSION, browserFingerprints: [BROWSER], sparseStreams,
    weightOf: control => ({ class: control?.capabilities?.canvasHeavy === true || ['belowDependent', 'unknown'].includes(control?.compositing ?? control?.capabilities?.compositing) ? 'heavy' : 'medium', estMs: null }),
    isUserCard: control => String(wire.sourceVersions[control?.cardId] ?? '').startsWith('user:'),
  }).filter(t => t.kind === 'stream');
  return { entry, cardPlan, specs, planTask, tasks };
}

const pageSide = (project, value, clips, extra = {}) => planPageStreams({ project, value, clips, codes: CODES, envFingerprint: BROWSER, ...extra });

const plain = project => projectOf(project);
const BASIC = () => plain([
  { id: 't-a', clips: [clip('clip-a', 'punch-pill', 0, 2, { frame: { x: 100, y: 80, w: 640, h: 360 } })] },
  { id: 't-b', clips: [clip('clip-b', 'focus-card', 1.25, 5.01)] },
  { id: 't-c', clips: [clip('clip-c', 'punch-pill', 6.5, 9.5, { frame: { x: 0, y: 0, w: 301, h: 99.5 }, opacity: 0.5, fadeIn: 0.2 })] },
]);

test('PSP-01 照抄的常量与服务端同值', () => {
  assert.equal(PAGE_STREAM_CODE_VERSION, STREAM_CODE_VERSION, '流的代码版本(服务端加了,这里跟着改,连同 streamMemberKey)');
  assert.equal(PAGE_STREAM_DECODER_BUDGET, STREAM_DECODER_BUDGET);
  assert.equal(PAGE_LOCAL_OVERFLOW_PX, LOCAL_OVERFLOW_PX);
  assert.equal(PAGE_STREAM_SEGMENTS_PER_TASK, QUEUE_DEFAULTS.STREAM_SEGMENTS);
  assert.equal(PAGE_SNAPSHOT_SPAN, QUEUE_DEFAULTS.SNAPSHOT_SPAN);
  assert.equal(PAGE_LAYER_MAP_VERSION, LAYER_MAP_VERSION);
  assert.equal(STREAM_SEGMENT_FRAMES, SEGMENT_FRAMES);
});

test('PSP-02 流的键与形状逐字段相同', async () => {
  const project = BASIC();
  const value = valueOf(project);
  const clips = ['clip-a', 'clip-b', 'clip-c'];
  const server = serverSide(project, value, clips);
  const page = await pageSide(project, value, clips);
  assert.equal(server.specs.length, 3, '服务端出三条单卡流');
  assert.equal(page.specs.length, 3, `页面也出三条:${JSON.stringify(page.skipped)}`);
  for (const want of server.specs) {
    const got = page.specs.find(s => s.topClipId === want.topClipId);
    assert.ok(got, `页面有 ${want.topClipId} 的流`);
    assert.equal(got.contentKey, want.contentKey, `${want.topClipId} 内容键`);
    assert.equal(got.streamKey, serverResultKeyOf(want.contentKey, BROWSER), `${want.topClipId} 结果键 = 内容键 × 本页指纹`);
    assert.notEqual(got.streamKey, want.streamKey, '与切分方自己指纹的键不同');
    for (const field of ['kind', 'plane', 'fps', 'total', 'firstFrame', 'lastFrame', 'firstSegment', 'lastSegment']) assert.deepEqual(got[field], want[field], `${want.topClipId}.${field}`);
    assert.deepEqual(got.clipIds, want.clipIds);
    assert.deepEqual(got.bound, want.bound, `${want.topClipId} 矩形`);
    assert.deepEqual(got.offset, want.offset, `${want.topClipId} 摆放`);
    assert.deepEqual(got.stage, want.stage);
  }
  // 带小数的入点:第一帧在入点之后,相位不为 0;超出项目末尾的卡被项目时长截断
  const b = page.specs.find(s => s.topClipId === 'clip-b');
  assert.equal(b.firstFrame, 38);
  assert.notEqual(b.bake.sampling.phase.numerator, '0');
  const c = page.specs.find(s => s.topClipId === 'clip-c');
  assert.equal(c.lastFrame, 239, '截到项目末帧');
  assert.equal(await resultKeyOf('ck', 'fp'), serverResultKeyOf('ck', 'fp'));
});

test('PSP-03 成员键只有一处:与切分方用的成员键相同', async () => {
  const project = BASIC();
  const value = valueOf(project);
  const server = serverSide(project, value, ['clip-a', 'clip-b', 'clip-c']);
  const wire = JSON.parse(JSON.stringify(value));
  for (const control of pageControls(project, wire)) {
    const theirs = server.cardPlan.find(c => c.clipId === control.clipId);
    const key = await streamMemberKey({
      node: control.node, definition: control.definition, style: project.style, environment: wire.environment, sourceVersions: wire.sourceVersions,
      fps: 30, sampling: control.sampling, duration: control.end - control.start,
      stage: { width: project.width, height: project.height, camera3dFov: project.camera3dFov }, frame: control.frame, themeId: project.themeId,
    });
    // `planStreams` 取成员键的那个式子:`streamMemberKey ?? contentKey`(「己一」起有 `streamMemberKey`,不带生成快照的代码指纹)
    assert.ok(theirs.streamMemberKey, '服务端的 card plan 带 streamMemberKey');
    assert.equal(key, theirs.streamMemberKey ?? theirs.contentKey, `${control.clipId} 的成员键`);
    assert.notEqual(key, theirs.contentKey, '不是带生成快照代码指纹的那一份');
    assert.deepEqual(control.sampling, theirs.sampling);
    assert.equal(control.count, theirs.count);
    assert.equal(control.tier, theirs.tier);
    assert.equal(control.compositing, theirs.compositing);
  }
});

test('PSP-04 流任务与切分方给浏览器出的那一份相同;PSP-05 清单相同', async () => {
  const project = BASIC();
  // clip-b 拉长到第 38～185 帧(148 帧):从它自己的第一帧起分段是 0～9,超过 8 段,分两个任务;末段只有 13 帧
  project.tracks.find(t => t.id === 't-b').clips[0].end = 6.2;
  project.tracks.find(t => t.id === 't-b').clips[0].cardId = 'caption-track';
  const value = valueOf(project);
  const clips = ['clip-a', 'clip-b', 'clip-c'];
  const server = serverSide(project, value, clips);
  const page = await pageSide(project, value, clips);
  const mine = page.specs.flatMap(spec => pageStreamTasks(spec, { projectId: project.id, projectRev: 7, codeVersion: CODE_VERSION, derivedFrom: server.planTask.id }));
  assert.ok(server.tasks.length >= 4, '服务端切出了流任务(clip-b 跨 8 段以上,分两个任务)');
  assert.equal(mine.length, server.tasks.length);
  const bTasks = server.tasks.filter(t => t.input.clipId === 'clip-b');
  assert.deepEqual(bTasks.map(t => [t.range.from, t.range.to, t.weight.frames]), [[0, 7, 120], [8, 9, 28]], '分段从 clip-b 自己的第一帧起数;帧数按实际算(末段不满)');
  assert.deepEqual([bTasks[0].input.stream.originFrame, bTasks[0].input.stream.lastFrame], [38, 185]);
  assert.ok(server.tasks.every(t => t.requires.envFingerprint === BROWSER), '清单计划只给浏览器出');
  const norm = v => JSON.parse(JSON.stringify(v));
  for (const want of server.tasks) {
    const got = mine.find(t => t.id === want.id);
    assert.ok(got, `页面有任务 ${want.id}`);
    assert.deepEqual(norm(got), norm(want), want.id);
  }
  // 清单:同一份分段登记,两边的任务组出的清单逐字段相同
  for (const want of server.tasks) {
    const got = mine.find(t => t.id === want.id);
    const inits = { aaaaaaaaaaaaaaaa: { hash: 'a'.repeat(64), bytes: 700, codec: 'avc1.640028', width: 704, height: 848, timescale: 30, rect: got.input.stream.bound, encoder: 'webcodecs-avc' } };
    const segments = {};
    for (let n = want.range.from; n <= want.range.to; n++) segments[n] = { hash: (n % 10).toString().repeat(64), bytes: 1000 + n, init: 'aaaaaaaaaaaaaaaa', stride: 1, samples: 15, sig: null, encoder: 'webcodecs-avc' };
    const a = streamManifest(got, { inits, segments }), b = streamManifest(want, { inits, segments });
    assert.deepEqual(a, b);
    assert.equal(a.header.originFrame, want.input.stream.originFrame, '清单的头带着这条流的第一帧');
    assert.equal(manifestMatches(a, { kind: 'stream', resultKey: want.resultKey, range: want.range }), true);
  }
});

test('PSP-06 层表的那一行与 layerStreamsOf 写出来的相同', async () => {
  const project = BASIC();
  const value = valueOf(project);
  const clips = ['clip-a', 'clip-b', 'clip-c'];
  const server = serverSide(project, value, clips);
  const page = await pageSide(project, value, clips);
  // 清单计划给浏览器出的流进层表的写法(`issuedStreamSpecs`):不补切分方自己的指纹,候选只有实际出键的浏览器指纹
  const rows = layerStreamsOf(server.entry, { streams: server.specs.map(s => ({ ...s, ownCandidate: false })), fingerprint: OWN, candidatesOf: () => [BROWSER] });
  assert.equal(rows.length, 3);
  for (const want of rows) {
    const spec = page.specs.find(s => s.topClipId === want.topClipId);
    assert.deepEqual(pageStreamRow(project, spec), want, want.topClipId);
    assert.ok(want.inputSig, '带输入签名');
  }
});

test('PSP-07 超过解码器预算时合并的结果相同', async () => {
  // 四张卡同时在画,预算给 2:相邻的并成组流
  const project = plain([
    { id: 't-1', clips: [clip('g-1', 'punch-pill', 0, 4)] },
    { id: 't-2', clips: [clip('g-2', 'focus-card', 0, 4)] },
    { id: 't-3', clips: [clip('g-3', 'punch-pill', 1, 3)] },
    { id: 't-4', clips: [clip('g-4', 'focus-card', 5, 7)] },
  ]);
  const value = valueOf(project);
  const clips = ['g-1', 'g-2', 'g-3', 'g-4'];
  for (const budget of [1, 2, 3, 6]) {
    const server = serverSide(project, value, clips, { budget });
    const page = await pageSide(project, value, clips, { budget });
    const singles = server.specs.filter(s => s.kind === 'card').map(s => s.topClipId).sort();
    assert.deepEqual(page.specs.map(s => s.topClipId).sort(), singles, `预算 ${budget}`);
    assert.deepEqual(page.specs.map(s => s.contentKey).sort(), server.specs.filter(s => s.kind === 'card').map(s => s.contentKey).sort());
    for (const id of clips.filter(id => !singles.includes(id))) assert.equal(page.skipped[id], 'grouped', `${id} 并进了组流`);
    assert.deepEqual(server.tasks.map(t => t.input.clipId).filter((id, i, a) => a.indexOf(id) === i).sort(), singles, '切分只给单卡流出浏览器那一份');
  }
});

test('PSP-07b 切分方单独成流的两类卡(三维外框的独立卡、源依赖卡)页面不产,但算进解码器预算:并进组流的卡两边仍然相同', async () => {
  // 三张平面的独立卡同时在画,上面再压一张三维外框的独立卡、一张套在视频上的素材效果卡(接了输入,没审阅过)
  const project = projectOf([
    { id: 't-3d', clips: [clip('threed', 'punch-pill', 0, 4, { frame: { x: 0, y: 0, w: 200, h: 200, rotateY: 30 } })] },
    { id: 't-fx', clips: [clip('fx', 'user-fx', 0, 4, { nodeId: 'n-fx', mediaId: 'm1' })] },
    { id: 't-1', clips: [clip('g-1', 'punch-pill', 0, 4)] },
    { id: 't-2', clips: [clip('g-2', 'focus-card', 0, 4)] },
    { id: 't-3', clips: [clip('g-3', 'punch-pill', 0, 4)] },
  ], {
    media: [{ id: 'm1', kind: 'video', hash: 'h1', url: '/@media/h1' }],
    cardNodes: [{ id: 'n-fx', adapter: 'card', cardId: 'user-fx', kind: 'filter', params: {}, inputs: { source: { nodeId: '@clip/fx/source', offset: 0, rate: 1 } } }],
  });
  const value = valueOf(project, { 'punch-pill': 'builtin:a', 'focus-card': 'builtin:e', 'user-fx': 'user:x' });
  const clips = ['threed', 'fx', 'g-1', 'g-2', 'g-3'];
  let merged = 0;
  for (const budget of [1, 2, 3, 4, 5, 6]) {
    const server = serverSide(project, value, clips, { budget });
    const page = await pageSide(project, value, clips, { budget });
    assert.deepEqual(server.specs.filter(s => s.solo).map(s => `${s.topClipId}:${s.solo}`).sort(), ['fx:source', 'threed:spatial'], `预算 ${budget}:切分方给这两张各出一条单独的流`);
    const singles = server.specs.filter(s => s.kind === 'card' && !s.solo).map(s => s.topClipId).sort();
    if (singles.length < 3) merged++;
    assert.deepEqual(page.specs.map(s => s.topClipId).sort(), singles, `预算 ${budget}:页面产的单卡流与切分方给浏览器的相同`);
    for (const id of ['g-1', 'g-2', 'g-3'].filter(id => !singles.includes(id))) assert.equal(page.skipped[id], 'grouped', `预算 ${budget}:${id} 并进了组流`);
    assert.equal(page.skipped.threed, 'frame-3d');
    assert.equal(page.skipped.fx, 'not-independent');
    assert.deepEqual(server.tasks.map(t => t.input.clipId).filter((id, i, a) => a.indexOf(id) === i).sort(), singles, `预算 ${budget}:浏览器那一份只有平面独立卡的单卡流`);
  }
  // 预算 4:五条流超了一条 —— 只按平面的三张算是不超的;算上那两条才知道要合并(这一条在页面不算它们的时候会红)
  assert.ok(merged >= 3, '有几档预算是靠算上这两条才合并的');
});

/** 两边的单卡流集合(切分方给浏览器出的那一种:平面独立卡的单卡流)逐条比:片段与内容键都相同 */
async function assertParity(project, value, clips, opts = {}, label = '') {
  const server = serverSide(project, value, clips, opts);
  const page = await pageSide(project, value, clips, opts.budget === undefined ? {} : { budget: opts.budget });
  const want = server.specs.filter(s => s.kind === 'card' && !s.solo).map(s => `${s.topClipId}:${s.contentKey}`).sort();
  const got = page.specs.map(s => `${s.topClipId}:${s.contentKey}`).sort();
  assert.deepEqual(got, want, `${label}:页面的单卡流与切分方的相同`);
  for (const s of server.specs.filter(s => s.kind === 'group')) for (const id of s.clipIds) assert.equal(page.skipped[id], 'grouped', `${label}:${id} 两边都并进了组流`);
  return { server, page };
}

/** 4K、60 帧;六张满屏的平面独立卡同时在画,最上面再压 `extra` 几条序列 */
const crowded = (extra = [], more = {}) => projectOf([
  ...extra,
  ...[1, 2, 3, 4, 5, 6].map(n => ({ id: `t-${n}`, clips: [clip(`f-${n}`, n % 2 ? 'punch-pill' : 'focus-card', 0, 3)] })),
], { width: 3840, height: 2160, fps: 60, duration: 4, ...more });

test('PSP-11 复现:依赖下层的流占预算,页面要算上(4K 60 帧,六张满屏独立卡 + 一张依赖下层的卡)', async () => {
  // 七条流同屏:超过不看像素的 6 条,4K 满屏的像素远超预算 → 切分方要并;页面若不算依赖下层的那一条,只看到 6 条,一张都不并
  const project = crowded([{ id: 't-below', clips: [clip('below', 'terminal-3d', 0, 3)] }]);
  const value = valueOf(project);
  const clips = ['below', 'f-1', 'f-2', 'f-3', 'f-4', 'f-5', 'f-6'];
  const { server, page } = await assertParity(project, value, clips, {}, '4K 七条');
  assert.ok(server.specs.some(s => s.kind === 'below' && s.topClipId === 'below'), '切分方给依赖下层的卡出了一条流');
  assert.ok(server.specs.some(s => s.kind === 'group'), '切分方并出了组流');
  assert.ok(page.specs.length < 6, '页面也少出了并进组流的那几张');
  assert.equal(page.skipped.below, 'not-independent');
});

test('PSP-12 对拍:一组有代表性的项目,页面的单卡流与切分方的逐条相同', async () => {
  const fxNode = { id: 'n-fx', adapter: 'card', cardId: 'user-fx', kind: 'filter', params: {}, inputs: { source: { nodeId: '@clip/fx/source', offset: 0, rate: 1 } } };
  const versions = { 'punch-pill': 'builtin:a', 'focus-card': 'builtin:e', 'terminal-3d': 'builtin:d', 'user-fx': 'user:x' };
  const cases = [
    // 少于 6 条
    ['1080p 三条', BASIC(), ['clip-a', 'clip-b', 'clip-c'], null],
    // 多于 6 条、1080p:七张满屏独立卡,第 7 条起看像素
    ['1080p 七条', projectOf([1, 2, 3, 4, 5, 6, 7].map(n => ({ id: `t-${n}`, clips: [clip(`f-${n}`, 'punch-pill', 0, 3)] })), { fps: 60 }), null, null],
    // 高画幅、少于 6 条(不看像素,一张都不并)
    ['4K 六条', crowded(), null, null],
    // 带依赖下层的卡(两张,一张外框带三维:同样出依赖下层的流)
    ['4K 依赖下层两张', crowded([
      { id: 't-b1', clips: [clip('below', 'terminal-3d', 0, 3)] },
      { id: 't-b2', clips: [clip('below3d', 'terminal-3d', 1, 2, { frame: { x: 0, y: 0, w: 400, h: 300, rotateX: 20 } })] },
    ]), null, null],
    // 带三维外框的独立卡(单独成流)
    ['4K 三维外框', crowded([{ id: 't-3d', clips: [clip('threed', 'punch-pill', 0, 3, { frame: { x: 0, y: 0, w: 800, h: 600, rotateY: 30 } })] }]), null, null],
    // 带源依赖卡(接了输入的素材效果卡,没审阅过)
    ['4K 源依赖卡', crowded([{ id: 't-fx', clips: [clip('fx', 'user-fx', 0, 3, { nodeId: 'n-fx', mediaId: 'm1' })] }],
      { media: [{ id: 'm1', kind: 'video', hash: 'h1', url: '/@media/h1' }], cardNodes: [fxNode] }), null, versions],
    // 三样都有,1080p 小卡多条
    ['1080p 混合', projectOf([
      { id: 't-below', clips: [clip('below', 'terminal-3d', 0, 3)] },
      { id: 't-3d', clips: [clip('threed', 'punch-pill', 0, 3, { frame: { x: 0, y: 0, w: 200, h: 200, rotateY: 30 } })] },
      { id: 't-fx', clips: [clip('fx', 'user-fx', 0, 3, { nodeId: 'n-fx', mediaId: 'm1' })] },
      ...[1, 2, 3, 4, 5, 6].map(n => ({ id: `t-${n}`, clips: [clip(`f-${n}`, 'focus-card', 0, 3)] })),
    ], { fps: 60, media: [{ id: 'm1', kind: 'video', hash: 'h1', url: '/@media/h1' }], cardNodes: [fxNode] }), null, versions],
  ];
  let grouped = 0;
  for (const [label, project, listed, sourceVersions] of cases) {
    const value = valueOf(project, sourceVersions);
    const clips = listed ?? project.tracks.flatMap(t => t.clips.map(c => c.id));
    for (const budget of [undefined, 3]) {
      const { server } = await assertParity(project, value, clips, budget === undefined ? {} : { budget }, `${label} 预算 ${budget ?? '缺省'}`);
      if (server.specs.some(s => s.kind === 'group')) grouped++;
    }
  }
  assert.ok(grouped >= 4, `有几种项目两边都并了组流(${grouped})`);
});

test('PSP-08 不产的卡', async () => {
  const project = plain([
    { id: 't-ok', clips: [clip('ok', 'punch-pill', 0, 1)] },
    { id: 't-canvas', clips: [clip('canvas', 'particles', 0, 1)] },
    { id: 't-lottie', clips: [clip('lottie', 'lottie', 1, 2)] },
    { id: 't-below', clips: [clip('below', 'terminal-3d', 2, 3)] },
    { id: 't-3d', clips: [clip('threed', 'punch-pill', 3, 4, { frame: { x: 0, y: 0, w: 200, h: 200, rotateY: 30 } })] },
    { id: 't-hidden', hidden: true, clips: [clip('hidden', 'punch-pill', 4, 5)] },
    { id: 't-emph', clips: [clip('emph', 'focus-card', 5, 6, { emphasis: { kind: 'pulse' } })] },
    { id: 't-user', clips: [clip('user', 'user-pill', 6, 7)] },
  ]);
  const versions = { 'punch-pill': 'builtin:a', particles: 'builtin:b', lottie: 'builtin:c', 'terminal-3d': 'builtin:d', 'focus-card': 'builtin:e', 'user-pill': 'user:f' };
  const value = valueOf(project, versions);
  const clips = ['ok', 'canvas', 'lottie', 'below', 'threed', 'hidden', 'emph', 'user'];
  const server = serverSide(project, value, clips);
  const page = await pageSide(project, value, clips);
  const issued = [...new Set(server.tasks.map(t => t.input.clipId))].sort();
  // Lottie 素材卡 2026-10-14 起放开:两边都出,和普通独立卡一样
  assert.deepEqual(page.specs.map(s => s.topClipId).sort(), ['lottie', 'ok']);
  // 两边都不出的
  for (const id of ['canvas', 'below', 'threed', 'hidden']) assert.equal(issued.includes(id), false, `切分方不给浏览器出 ${id}`);
  assert.equal(page.skipped.canvas, 'canvas');
  assert.equal(page.skipped.lottie, undefined);
  assert.equal(issued.includes('lottie'), true, '切分方给浏览器出 lottie');
  assert.equal(page.skipped.below, 'not-independent');
  assert.equal(page.skipped.threed, 'frame-3d');
  // 页面比切分方更紧的:不是内置卡片(用户卡在切分方那边要本页声明能运行才出,这里没声明,所以也没出)
  assert.equal(page.skipped.user, 'not-independent');
  assert.equal(issued.includes('ok'), true);
  // 用户卡(审阅表里没有,按 unknown 处理)换成一张审阅过的卡当「不是内置」:源码版本不是 builtin: 开头就不产
  const asUser = valueOf(project, { ...versions, 'punch-pill': 'user:z' });
  const again = await pageSide(project, asUser, ['ok']);
  assert.deepEqual(again.specs, []);
  assert.equal(again.skipped.ok, 'not-builtin');
  // 挂了强调的片段:输出节点是外面那一层
  assert.equal(page.skipped.emph, 'wrapped-node');
  // 记下切分方对这种片段的做法(它的成员键只由外面那一层决定,见报告「发现的问题」):切分方出了,页面不出
  assert.equal(issued.includes('emph'), true, '切分方给挂了强调的片段出了浏览器那一份');
});

test('PSP-09 没有指纹、没有代码指纹:一条都不算', async () => {
  const project = BASIC();
  const value = valueOf(project);
  assert.deepEqual((await planPageStreams({ project, value, clips: ['clip-a'], codes: CODES, envFingerprint: null })).specs, []);
  assert.deepEqual((await planPageStreams({ project, value, clips: ['clip-a'], codes: null, envFingerprint: BROWSER })).specs, []);
  assert.deepEqual((await planPageStreams({ project, value, clips: [], codes: CODES, envFingerprint: BROWSER })).specs, []);
  // 换了指纹:内容键不变,结果键换
  const a = (await pageSide(project, value, ['clip-a'])).specs[0];
  const b = (await planPageStreams({ project, value, clips: ['clip-a'], codes: CODES, envFingerprint: '3333333333333333' })).specs[0];
  assert.equal(a.contentKey, b.contentKey);
  assert.notEqual(a.streamKey, b.streamKey);
  // 改了参数:内容键换
  const edited = BASIC();
  edited.tracks[0].clips[0].params = { text: 'changed' };
  const c = (await pageSide(edited, valueOf(edited), ['clip-a'])).specs[0];
  assert.notEqual(c.contentKey, a.contentKey);
});

test('PSP-10 并进现有的层表', async () => {
  const project = BASIC();
  const value = valueOf(project);
  const page = await pageSide(project, value, ['clip-a', 'clip-b']);
  const rows = page.specs.map(spec => pageStreamRow(project, spec));
  const rowA = rows.find(r => r.topClipId === 'clip-a');
  // 没有层表:新写一张,layers 为空
  const fresh = mergeLayerStreams(null, { project, rows, now: 5 });
  assert.equal(fresh.v, LAYER_MAP_VERSION);
  assert.equal(fresh.kind, 'layer-map');
  assert.equal(fresh.projectId, project.id);
  assert.deepEqual(fresh.layers, []);
  assert.equal(fresh.streams.length, 2);
  // 再并一次:没有变化,不写
  assert.equal(mergeLayerStreams(fresh, { project, rows, now: 6 }), null);
  // 现有的表:别的字段、layers、别的卡的行不动(先后也不动);同一张卡同内容键的行,本页的候选提到最前、别人的留着
  const rowB = rows.find(r => r.topClipId === 'clip-b');
  const other = { topClipId: 'clip-z', clipIds: ['clip-z'], kind: 'card', plane: 'local', contentKey: 'z', candidates: [{ envFingerprint: OWN, resultKey: 'rz' }], firstSegment: 0, lastSegment: 1, segmentsPerTask: 8 };
  const theirs = { ...rowA, candidates: [{ envFingerprint: OWN, resultKey: serverResultKeyOf(rowA.contentKey, OWN) }] };
  // clip-b 另有两行别的内容键的:一行输入签名过期(旧参数的流),一行没过期(别的环境按它自己的键产的同一条流)
  const stale = { ...rowB, contentKey: 'old-content', inputSig: 's1-0000000000000000', candidates: [{ envFingerprint: OWN, resultKey: 'old' }] };
  const foreign = { ...rowB, contentKey: 'their-content', candidates: [{ envFingerprint: OWN, resultKey: 'their-key' }] };
  const existing = { v: 3, kind: 'layer-map', projectId: project.id, entryKey: 'e', fps: 30, width: 1920, height: 1080, span: 60, at: 1, layers: [{ clipId: 'clip-a', kind: 'html' }], streams: [other, theirs, stale, foreign] };
  const merged = mergeLayerStreams(existing, { project, rows, now: 9 });
  assert.deepEqual(merged.layers, existing.layers);
  assert.equal(merged.entryKey, 'e');
  assert.deepEqual(merged.streams.map(r => [r.topClipId, r.contentKey === 'z' ? 'z' : r.contentKey === rowA.contentKey ? 'A' : r.contentKey === rowB.contentKey ? 'B' : r.contentKey]),
    [['clip-z', 'z'], ['clip-a', 'A'], ['clip-b', 'B'], ['clip-b', 'their-content']], '别的卡的行原位;本页的行在这张卡的第一行的位置;过期的去掉,没过期的留在后面');
  assert.deepEqual(merged.streams[0], other);
  assert.deepEqual(merged.streams[1].candidates.map(c => c.envFingerprint), [BROWSER, OWN]);
  assert.deepEqual(merged.streams[3], foreign);
  assert.equal(mergeLayerStreams(merged, { project, rows, now: 10 }), null, '并过的再并:没有变化');
  // 「先查」认的候选:同内容键的;别的内容键、输入签名没过期的(连同那一行的分段范围);过期的不认
  assert.deepEqual(layerStreamCandidates(existing, rowA).map(c => c.envFingerprint), [OWN]);
  assert.deepEqual(layerStreamCandidates(existing, rowB).map(c => c.resultKey), ['their-key']);
  assert.deepEqual(layerStreamCandidates({ ...existing, streams: [{ ...foreign, inputSig: undefined }] }, rowB).map(c => c.resultKey), ['their-key'], '那一行没带输入签名:照播,也认');
  assert.deepEqual(layerStreamCandidates(existing, { ...rowB, topClipId: 'clip-q' }), []);
  assert.deepEqual(layerStreamCandidates({ ...existing, streams: [{ ...foreign, kind: 'group' }] }, rowB), [], '组流不算');
  // 没带这条流第一帧的行(改分段规则之前的节点写的,分段按项目帧号数):在线来源不播它,这里也不当现成的
  const { originFrame: _origin, ...oldForeign } = foreign;
  assert.equal(Number.isInteger(foreign.originFrame), true);
  assert.deepEqual(layerStreamCandidates({ ...existing, streams: [{ ...oldForeign, firstSegment: 2 }] }, rowB), [], '旧形状的行不算');
  assert.deepEqual(layerStreamCandidates({ ...existing, streams: [foreign] }, rowB).map(c => [c.firstSegment, c.lastSegment]), [[0, foreign.lastSegment]], '分段号从 0 起');
  // 候选的清单按它那一行的范围分份:盖住本页这一段的是哪几份
  const cand = { envFingerprint: OWN, resultKey: 'k', firstSegment: 2, lastSegment: 20, segmentsPerTask: 8 };
  assert.deepEqual(candidateSpans(cand, 2, 9), [[2, 9]]);
  assert.deepEqual(candidateSpans(cand, 9, 11), [[2, 9], [10, 17]]);
  assert.deepEqual(candidateSpans(cand, 18, 20), [[18, 20]]);
  assert.equal(candidateSpans(cand, 0, 9), null, '候选的范围没把这一段盖全');
  assert.equal(candidateSpans(cand, 18, 21), null);
  // 别的项目的表、不认识的版本:当没有,重写
  assert.deepEqual(mergeLayerStreams({ ...existing, projectId: 'someone-else' }, { project, rows, now: 9 }).layers, []);
  assert.deepEqual(mergeLayerStreams({ ...existing, v: 9 }, { project, rows, now: 9 }).layers, []);
});

test('PSP-sparse 稀疏流任务:页面按 density 组出来的任务与切分方给浏览器出的稀疏流任务逐字段相同;满密度的那一组不变', async () => {
  const project = BASIC();
  const value = valueOf(project);
  const clips = ['clip-a', 'clip-b', 'clip-c'];
  const server = serverSide(project, value, clips, { sparseStreams: true });
  const plainServer = serverSide(project, value, clips);
  const page = await pageSide(project, value, clips);
  const opts = { projectId: project.id, projectRev: 7, codeVersion: CODE_VERSION, derivedFrom: server.planTask.id };
  const sparse = page.specs.flatMap(spec => pageStreamTasks(spec, { ...opts, density: 'sparse' }));
  const dense = page.specs.flatMap(spec => pageStreamTasks(spec, opts));
  const wantSparse = server.tasks.filter(t => t.input.density === 'sparse');
  const wantDense = server.tasks.filter(t => t.input.density === undefined);
  assert.equal(PAGE_SPARSE_STREAM_PRIORITY, SPARSE_STREAM_PRIORITY, '稀疏流任务的名次与切分方同一个数');
  assert.ok(wantSparse.length >= 3 && wantSparse.length === wantDense.length, '每个满密度任务都有一个同范围的稀疏流任务');
  assert.equal(sparse.length, wantSparse.length);
  const norm = v => JSON.parse(JSON.stringify(v));
  for (const want of wantSparse) {
    const got = sparse.find(t => t.id === want.id);
    assert.ok(got, `页面有任务 ${want.id}`);
    assert.ok(want.id.endsWith(':sparse'));
    assert.deepEqual(norm(got), norm(want), want.id);
    // 同范围的满密度任务:结果键、范围相同(内容库里的清单键相同),id 只差结尾
    const twin = wantDense.find(t => `${t.id}:sparse` === want.id);
    assert.ok(twin, '有同范围的满密度任务');
    assert.equal(twin.resultKey, want.resultKey);
    assert.deepEqual(twin.range, want.range);
    assert.ok(want.priority > twin.priority);
  }
  // 满密度的那一组与不切稀疏流任务时逐字相同
  assert.deepEqual(norm(wantDense), norm(plainServer.tasks));
  for (const want of wantDense) assert.deepEqual(norm(dense.find(t => t.id === want.id)), norm(want), want.id);
});
