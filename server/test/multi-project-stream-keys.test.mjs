/**
 * 多项目模式的产流：键与要求按「这条流展开出的子集」算（主会话 2026-10-22 定，三级：键认的是会影响这几帧画面的东西，不是整个项目）。
 * 跑：npm test -- server/test/multi-project-stream-keys.test.mjs（纯逻辑，真的卡片图与卡片计划，不起浏览器）
 *
 *   MSK1  展开是确定的：同样的项目、同样的帧，算几次都是同一个子集、同一个键；按子集再展开一次还是同一个（节点手里的是子集也一样）
 *   MSK2  发布方与节点同一个 need：切分方拿到的流（`queueStreamOf` 的形状）与产流节点手里的完整的流算出同一个 `streamNeed`、
 *         同一份 `requires.cardSources`，逐字节相同
 *   MSK3  切分：流任务只要这条流展开出的子集里用到的那几份代码；没给 `streamCardSources` 的旧调用方照旧要全部
 *   MSK4  依赖下层的流退回整场景时，键按子集算：发布方（整个项目）与节点（只有子集）逐字节相同；项目里这一段以外的改动不让它作废，
 *         这一段以内的改动照旧作废
 *   MSK5  旧键对不上只会重算、不会取错：按旧口径（整个项目的 `entry.key`）出的流键与新键不同；执行器拿旧键的任务来对，
 *         这一版的流里没有它，回 `plan-mismatch`（不认领、不当成新键的结果用）
 *   MSK6  单卡流的键本来就只看这张卡（与项目里别的片段无关）：整个项目与子集算出的流键逐字节相同
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { planStreams, queueStreamOf } from '../frame-stream.mjs';
import { CardFrameCache } from '../card-cache.mjs';
import { frameIdentity } from '../frame-identity.mjs';
import { cardEntryCode } from '../card-code.mjs';
import { FramePipeline } from '../frame-pipeline.mjs';
import { splitPlan, planTaskOf } from '../render-node/split.mjs';
import { expandProject, streamNeed, subsetCardSources } from '../render-node/expand.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';

const FP = '0123456789abcdef';
const CV = 'cv-subset';
const ROOT = path.join(os.tmpdir(), 'pc-subset-unused');
const DEFS = {
  odometer: { id: 'odometer', frameMode: 'stateful', defaults: {} },
  'caption-track': { id: 'caption-track', frameMode: 'stateful', defaults: {} },
  'user-a': { id: 'user-a', frameMode: 'stateful', defaults: {} },
  'user-late': { id: 'user-late', frameMode: 'stateful', defaults: {} },
};
const getCard = (id) => DEFS[id];
const VERSIONS = { odometer: 'builtin:odometer-v1', 'caption-track': 'builtin:caption-v1', 'user-a': 'user:a-v3', 'user-late': 'user:late-v7' };

/** 从上到下：top（0～6）、glass 毛玻璃（1～4，目标卡）、mid（0～5，下层）、late（6～7，时间上不重叠）、vid 视频（0～8） */
const project = () => ({
  id: 'subset-p', width: 1280, height: 720, fps: 30, duration: 8, themeId: 'dark', style: {},
  media: [{ id: 'm1', kind: 'video', hash: 'h1', url: '/@media/h1' }, { id: 'm9', kind: 'image', hash: 'h9', url: '/@media/h9' }],
  filters: [], pixelMaps: [], cardNodes: [],
  tracks: [
    { id: 't-top', clips: [{ id: 'top', cardId: 'caption-track', start: 0, end: 6, params: { text: 'top' } }] },
    { id: 't-glass', clips: [{ id: 'glass', cardId: 'odometer', start: 1, end: 4, params: { value: 42 }, frame: { x: 100, y: 100, w: 600, h: 300 } }] },
    { id: 't-mid', clips: [{ id: 'mid', cardId: 'user-a', start: 0, end: 5, params: { text: 'mid' } }] },
    { id: 't-late', clips: [{ id: 'late', cardId: 'user-late', start: 6, end: 7, params: { text: 'late', img: '/@media/h9' } }] },
    { id: 't-low', clips: [{ id: 'vid', mediaId: 'm1', start: 0, end: 8, params: {} }] },
  ],
});
const edit = (fn) => { const p = project(); fn(p); return p; };
const clipOf = (p, id) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);

/** 用真的管线方法算子集的整场景键（`FramePipeline#subsetFrameKey`，代码版本与卡片身份用替身） */
const fakePipeline = { code: () => 'code-1', cardSources: (p) => Object.fromEntries(p.tracks.flatMap((t) => t.clips).map((c) => c.cardId).filter((id) => VERSIONS[id] && id.startsWith('user')).map((id) => [id, VERSIONS[id]])) };
const subsetKeyOf = (p) => (need) => FramePipeline.prototype.subsetFrameKey.call(fakePipeline, p, need);

/** 这份项目的一版：真的卡片图 → 真的卡片计划。`unknown`：预渲染间不认识定义的片段（这时依赖下层的流退回整场景的键） */
function entryOf(p, { unknown = [], subset = true } = {}) {
  const graph = projectCardGraph(p, getCard);
  const cardPlan = new CardFrameCache({ root: ROOT, project: p, envFingerprint: FP }).plan({
    graph, sourceVersions: VERSIONS, unknownClipIds: unknown,
    environment: { width: p.width, height: p.height, fps: p.fps, theme: p.themeId, fontFingerprint: 'fonts-1' },
  });
  const entry = { key: frameIdentity(p, cardEntryCode('code-1', {})), project: p, cardPlan };
  if (subset) entry.subsetKey = subsetKeyOf(p);
  return entry;
}
const specsOf = (p, o = {}) => planStreams(entryOf(p, o), { envFingerprint: FP, codeVersion: CV, below: true });
const belowOf = (p, o) => specsOf(p, o).find((s) => s.kind === 'below' && s.topClipId === 'glass');

test('MSK1 展开是确定的：同样的项目、同样的帧算几次都同一个子集同一个键；按子集再展开一次还是同一个', () => {
  const p = project();
  const spec = belowOf(p);
  const need = streamNeed(spec);
  const a = JSON.stringify(expandProject(p, need).project);
  for (let i = 0; i < 5; i += 1) assert.equal(JSON.stringify(expandProject(structuredClone(p), need).project), a, `第 ${i + 2} 次`);
  const key = subsetKeyOf(p)(need);
  assert.equal(subsetKeyOf(structuredClone(p))(need), key);
  // 节点手里只有一个更大的子集（例如这一版清单里几张卡的并集）：再按这条流展开，结果与从整个项目展开逐字节相同
  const wider = expandProject(p, { spans: [[0, 5]], clipIds: [] }).project;
  assert.equal(JSON.stringify(expandProject(wider, need).project), a);
  assert.equal(subsetKeyOf(wider)(need), key, '子集上的子集，键不变');
  console.log('[MSK1] need', JSON.stringify(need), '子集片段', expandProject(p, need).clipIds.join(','), '键', key.slice(0, 16));
  assert.deepEqual(expandProject(p, need).clipIds.sort(), ['glass', 'mid', 'top', 'vid'], 'late 不在这一段');
});

test('MSK2 发布方与节点同一个 need、同一份 requires.cardSources（逐字节相同）', () => {
  const p = project();
  for (const spec of specsOf(p)) {
    const q = queueStreamOf(spec); // 切分方拿到的形状
    assert.deepEqual(streamNeed(q), streamNeed(spec), `${spec.kind}:${spec.topClipId}`);
    assert.equal(JSON.stringify(subsetCardSources(p, streamNeed(q), VERSIONS)), JSON.stringify(subsetCardSources(p, streamNeed(spec), VERSIONS)));
  }
});

test('MSK3 切分：流任务只要这条流子集里用到的代码；不给 streamCardSources 照旧要全部', () => {
  const p = project();
  const entry = entryOf(p);
  const specs = planStreams(entry, { envFingerprint: FP, codeVersion: CV, below: true });
  const base = {
    planTask: planTaskOf({ projectId: 'subset-p', projectRev: 3 }), entryKey: entry.key, cardPlan: entry.cardPlan,
    streams: specs.map(queueStreamOf), envFingerprint: FP, codeVersion: CV, cardSourceVersions: VERSIONS, weightOf: () => ({ class: 'medium', estMs: null }),
  };
  const subset = splitPlan({ ...base, streamCardSources: (stream) => subsetCardSources(p, streamNeed(stream), VERSIONS) }).filter((t) => t.kind === 'stream');
  const glass = subset.filter((t) => t.input.clipId === 'glass' && t.requires.belowDependent);
  assert.ok(glass.length > 0);
  for (const t of glass) assert.deepEqual(t.requires.cardSources, { odometer: VERSIONS.odometer, 'caption-track': VERSIONS['caption-track'], 'user-a': VERSIONS['user-a'] }, '这一段里的四张卡（late 不在）');
  console.log('[MSK3] 毛玻璃那条流要的代码', Object.keys(glass[0].requires.cardSources).join(','), '；整个项目有', Object.keys(VERSIONS).join(','));
  const old = splitPlan(base).filter((t) => t.kind === 'stream' && t.input.clipId === 'glass' && t.requires.belowDependent);
  for (const t of old) assert.deepEqual(t.requires.cardSources, VERSIONS, '旧调用方：全部');
  // 两种切法任务 id 与结果键都相同（键没变，只是要求变少）
  assert.deepEqual(glass.map((t) => t.id), old.map((t) => t.id));
});

test('MSK4 依赖下层的流退回整场景时键按子集算：发布方（整个项目）与节点（子集）逐字节相同；这一段以外的改动不作废，以内的照旧作废', () => {
  const p = project();
  const pub = belowOf(p, { unknown: ['mid'] });
  assert.equal(pub.belowScene, true, '前提：mid 不在卡片计划里，退回整场景');
  // 节点手里只有这条流展开出的子集（多项目模式）：照子集算出来的流的键与发布方逐字节相同
  const sub = expandProject(p, streamNeed(pub)).project;
  const node = belowOf(sub, { unknown: ['mid'] });
  assert.equal(node.contentKey, pub.contentKey);
  assert.equal(node.streamKey, pub.streamKey);
  // 这一段以外（late 在 6～7 秒）的改动：键不变（原来按整个项目的键会作废）
  const outside = belowOf(edit((q) => { clipOf(q, 'late').params.text = 'changed'; }), { unknown: ['mid'] });
  assert.equal(outside.contentKey, pub.contentKey, 'late 改了不影响这一段');
  const outsideOld = belowOf(edit((q) => { clipOf(q, 'late').params.text = 'changed'; }), { unknown: ['mid'], subset: false });
  assert.notEqual(outsideOld.contentKey, belowOf(p, { unknown: ['mid'], subset: false }).contentKey, '对照：旧口径下 late 一改就作废');
  // 这一段以内（top 在 0～6 秒，挡在上面）的改动：照旧作废
  assert.notEqual(belowOf(edit((q) => { clipOf(q, 'top').params.text = 'changed'; }), { unknown: ['mid'] }).contentKey, pub.contentKey);
});

test('MSK5 旧键对不上只会重算、不会取错：旧口径的流键与新键不同；执行器拿旧键的任务来对，回 plan-mismatch', async () => {
  const p = project();
  const fresh = belowOf(p, { unknown: ['mid'] });
  const stale = belowOf(p, { unknown: ['mid'], subset: false });
  assert.notEqual(stale.contentKey, fresh.contentKey);
  assert.notEqual(stale.streamKey, fresh.streamKey, '结果键（流库里的目录）也不同：新键下面找不到旧产物');
  // 执行器：这一版的流里只有新键；旧键的任务来了不认，回 plan-mismatch（任务按失败处理，队列照新键重新切分、重算）
  const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
  const entry = entryOf(p, { unknown: ['mid'] });
  const pipeline = {
    envFingerprint: FP,
    async planForQueue() { return { entry, context: { entryKey: entry.key, cardPlan: entry.cardPlan, streams: [] }, streamSpecs: planStreams(entry, { envFingerprint: FP, codeVersion: CV, below: true }) }; },
    async streamCapable() { return true; },
    renderStreamRange: async () => { throw new Error('不该产：旧键的任务不该被当成新键的去产'); },
  };
  const executor = createPrerenderExecutor({ pipeline, projects: { get: async () => p } });
  const task = {
    id: `stream:${stale.streamKey}:0-0`, kind: 'stream', resultKey: stale.streamKey, range: { unit: 'segment', from: stale.firstSegment, to: stale.firstSegment },
    source: { projectId: 'subset-p', projectRev: 3 }, input: { clipId: 'glass', cardId: null, entryKey: null, contentKey: stale.contentKey },
    requires: { envFingerprint: FP, codeVersion: CV, belowDependent: true, transcode: true, capabilities: { streams: true } },
  };
  await assert.rejects(executor.render(task, {}), (err) => err?.code === 'plan-mismatch', '旧键：plan-mismatch');
  // 同一个任务换成新键：对得上（产流那一步由替身报错，说明确实走到了产）
  await assert.rejects(executor.render({ ...task, resultKey: fresh.streamKey, input: { ...task.input, contentKey: fresh.contentKey } }, {}), /不该产/);
});

test('MSK6 单卡流的键本来就只看这张卡：整个项目与这条流的子集算出的键逐字节相同', () => {
  const p = project();
  for (const spec of specsOf(p).filter((s) => s.kind === 'card')) {
    const sub = expandProject(p, streamNeed(spec)).project;
    const again = specsOf(sub).find((s) => s.kind === 'card' && s.topClipId === spec.topClipId);
    assert.ok(again, spec.topClipId);
    assert.equal(again.contentKey, spec.contentKey, `${spec.topClipId} 的内容键`);
    assert.equal(again.streamKey, spec.streamKey);
  }
});
