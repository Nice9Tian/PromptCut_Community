/**
 * 片段外面套了一层(挂强调、滤镜)时,经队列切分的那一步要认得出里面是哪张卡。
 *
 * 卡片图(`src/kernel/cardGraph.mjs` 的 `projectCardGraph`)给这种片段的输出节点是外面那一层(`@clip/<id>/emphasis`、
 * `@clip/<id>/filter`),卡片自己在它的 `inputs.source` 后面。`server/frame-pipeline.mjs` 的 `planForQueue` 给控件补
 * `cardId` 时原先只看输出节点,补出来是 null;`server/render-node/split.mjs` 靠它判「给不给浏览器节点」「要哪张卡的代码」
 * 「是不是用户卡」,于是套了一层的片段都判错。
 *
 * 这里同一张卡放三个片段(不挂、挂强调、挂滤镜;同一时刻起止),照 `planForQueue` 的拼法出控件、切分,断言三个片段的
 * 任务除了键以外逐项相同:每一份的指纹、段、`requires.cardSources`、`requires.userCards`、`input.cardId`、带不带页面要的输入。
 *
 *   WC-01  Lottie 素材卡(2026-10-14 放开):给浏览器节点,挂了强调、滤镜也看里面那张卡
 *   WC-02  改过源码的内置卡(改动层):任务要这张卡的代码身份,挂了也要;不给浏览器节点
 *   WC-03  用户卡:`requires.userCards` 为真、要全部定制卡的代码,挂了也一样
 *   WC-04  普通内置卡:给浏览器节点,`input.cardId` 是这张卡,挂了也一样
 *   WC-05  强调和滤镜都挂(套两层):照样认得出里面那张
 *   WC-06  不套一层的片段:补出来的 `cardId` 与 main 的写法相同,切出的任务逐字段相同
 *   WC-07  `innerCardIds` / `withInnerCards` 的取法:里面不止一张卡、拿不准时
 *   WC-08  里面不止一张卡、拿不准的控件:不给浏览器节点;要里面每张卡的代码 / 全部定制卡的代码
 *   WC-09  画布卡(审阅表 `canvasHeavy`):不给浏览器节点、重度为「重」,挂了强调、滤镜也一样
 *
 * 跑:npm test -- server/test/wrapped-cardid-split.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardFrameCache } from '../card-cache.mjs';
import { planStreams, queueStreamOf } from '../frame-stream.mjs';
import { splitPlan, withInnerCards, innerCardIds, isUserCardControl, cardIdsOf } from '../render-node/split.mjs';
import { snapshotTier } from '../snapshot-store.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';
import { clipsPlan } from './m7-kit.mjs';

const OWN = '1111111111111111';
const BR = '2222222222222222';
const ENVIRONMENT = { width: 1920, height: 1080, fps: 30, theme: 'dark', fontFingerprint: 'ff00ff00' };

/** `lottie`、`punch-pill` 在审阅表里是独立卡(共享档);`my-card` 不在表里(用户卡,按未知处理,本地档) */
const DEFS = {
  lottie: { id: 'lottie', defaults: { src: '' } },
  'punch-pill': { id: 'punch-pill', defaults: { text: '' } },
  'focus-card': { id: 'focus-card', defaults: { text: '' } },
  'my-card': { id: 'my-card', defaults: { text: '' } },
  particles: { id: 'particles', defaults: {} },
};
const getCard = id => DEFS[id];
const SOURCE_VERSIONS = { lottie: 'builtin:lottie-v1', 'punch-pill': 'builtin:pill-v1', 'focus-card': 'builtin:focus-v1', 'my-card': 'user:mine-v1', particles: 'builtin:particles-v1' };

const EMPHASIS = { kind: 'outline', color: '#ffffff', size: 6 };
const FILTERS = [{ id: 'f-warm', name: '暖色', ops: [{ op: 'sepia', amount: 0.4 }] }];
const FRAME = { x: 200, y: 200, w: 400, h: 240 };

/** 三条序列各一个片段,同一时刻起止:不挂、挂强调、挂滤镜 */
const projectOf = (card, extra = {}) => ({
  id: 'p', width: 1920, height: 1080, fps: 30, duration: 4, themeId: 'dark', style: {},
  media: [], filters: FILTERS, audioFx: [], pixelMaps: [], cardNodes: [],
  ...extra,
  tracks: [
    { id: 'tr-bare', hidden: false, clips: [{ id: 'clip-bare', start: 1, end: 3, frame: FRAME, ...card }] },
    { id: 'tr-emph', hidden: false, clips: [{ id: 'clip-emph', start: 1, end: 3, frame: FRAME, ...card, emphasis: EMPHASIS }] },
    { id: 'tr-filt', hidden: false, clips: [{ id: 'clip-filt', start: 1, end: 3, frame: FRAME, ...card, filter: { id: 'f-warm', params: {} } }] },
  ],
});

/** `FramePipeline.queueWeightClass` */
const weightOf = control => {
  const caps = control?.capabilities ?? {};
  const compositing = control?.compositing ?? caps.compositing;
  if (control?.tier === 'local' || caps.canvasHeavy === true || control?.innerCanvasHeavy === true || compositing === 'belowDependent' || compositing === 'context' || compositing === 'unknown') return { class: 'heavy', estMs: null };
  return { class: 'medium', estMs: null };
};

/** `FramePipeline.queueHandles` */
const queueHandles = control => {
  if (!control?.snapshotKey || !control.clipId) return false;
  const caps = control?.capabilities ?? {};
  const tier = control.tier || snapshotTier(caps);
  if (tier === 'local' || (tier === 'shared' && control.cacheable === true)) return true;
  if (tier === 'none') {
    const stateful = control.frameMode === 'stateful' || caps.frameMode === 'stateful' || control.needPrerendering === true || caps.need_prerendering === true || caps.needPrerendering === true;
    const compositing = control.compositing ?? caps.compositing ?? 'unknown';
    return stateful && (compositing !== 'sourceDependent' || control.cacheable === true);
  }
  return false;
};

/** `planForQueue` 给控件补卡片 id 的那一步(同一个函数) */
const queueCardPlan = (controls, graph) => withInnerCards(controls.filter(queueHandles), graph);
/** `planForQueue` 的 `isUserCard`(同一个函数) */
const isUserCardOf = sourceVersions => control => isUserCardControl(control, sourceVersions);

/** main(53e7a9ca)上 `planForQueue` 的写法:只看输出节点。对照用 */
function mainCardPlan(controls, graph) {
  const cardIdOf = new Map((graph?.nodes ?? []).map(node => [node?.id, node?.cardId ?? null]));
  return controls.filter(queueHandles).map(control => ({ ...control, cardId: control.cardId ?? cardIdOf.get(control.nodeId) ?? null }));
}
const mainIsUserCardOf = sourceVersions => control => String(sourceVersions[control?.cardId] ?? '').startsWith('user:');

/** 照 `planForQueue` 拼出切分的输入,切分;`cardSources` 是这一版用到的定制卡的代码身份(`entry.cardSources`) */
function splitOf(card, { cardSources = {}, sourceVersions = SOURCE_VERSIONS, extra } = {}) {
  const project = projectOf(card, extra);
  const graph = projectCardGraph(project, getCard);
  const controls = new CardFrameCache({ root: 'unused', project, envFingerprint: OWN }).plan({ graph, sourceVersions, environment: ENVIRONMENT });
  const cardPlan = queueCardPlan(controls, graph);
  const streams = planStreams({ project, cardPlan: controls }, { envFingerprint: OWN, codeVersion: 'test-code', budget: 8, below: true }).map(queueStreamOf);
  const tasks = splitPlan({
    planTask: clipsPlan({ clips: cardPlan.map(control => control.clipId) }), entryKey: 'entry-1', cardPlan, prerenderSet: null, streams,
    envFingerprint: OWN, codeVersion: 'cv-1', cardSourceVersions: cardSources, weightOf, isUserCard: isUserCardOf(sourceVersions),
    browser: { nodeId: 'n-br', envFingerprint: BR },
  });
  return { controls, cardPlan, streams, tasks };
}

/** 一个片段的任务,去掉键以后的样子(键本来就各不相同:外面那一层在键里) */
function shapeOf(tasks, clipId) {
  return tasks.filter(task => task.input.clipId === clipId).map(task => ({
    kind: task.kind, tier: task.tier ?? null, fingerprint: task.requires.envFingerprint, range: task.range,
    cardId: task.input.cardId, cardSources: task.requires.cardSources, userCards: task.requires.userCards, graphCards: task.requires.graphCards,
    transcode: task.requires.transcode, dual: task.input.dual === true, forBrowser: 'bake' in task.input, weight: task.weight.class,
  })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
}
const browserTasks = (tasks, clipId) => tasks.filter(task => task.input.clipId === clipId && task.requires.envFingerprint === BR);
const WRAPPED = ['clip-emph', 'clip-filt'];

/** 三个片段的任务逐项相同;回不挂的那个片段的样子 */
function assertSame(tasks) {
  const bare = shapeOf(tasks, 'clip-bare');
  assert.ok(bare.length > 0, '不挂的片段要有任务');
  for (const clipId of WRAPPED) assert.deepEqual(shapeOf(tasks, clipId), bare, `${clipId} 的任务要和不挂的片段逐项相同`);
  return bare;
}

test('WC-01 Lottie 素材卡(2026-10-14 放开):和普通独立卡一样给浏览器节点,挂了强调、滤镜也看里面那张卡', () => {
  const { cardPlan, tasks } = splitOf({ cardId: 'lottie', params: { src: 'a.json' } });
  for (const control of cardPlan) assert.equal(control.tier, 'none', `${control.clipId} 是 none 档`);
  assert.ok(browserTasks(tasks, 'clip-bare').length > 0, '不挂的给浏览器');
  for (const clipId of WRAPPED) assert.ok(browserTasks(tasks, clipId).length > 0, `${clipId} 也给浏览器`);
  const bare = assertSame(tasks);
  for (const item of bare.filter(item => item.kind === 'stream' && item.forBrowser)) assert.equal(item.cardId, 'lottie');
});

test('WC-02 改过源码的内置卡:挂了也要这张卡的代码身份,不给浏览器节点', () => {
  const cardSources = { 'punch-pill': 'override:abc', 'focus-card': 'override:def' };
  const { cardPlan, tasks } = splitOf({ cardId: 'punch-pill', params: { text: '甲' } }, { cardSources });
  for (const control of cardPlan) assert.equal(control.tier, 'none', `${control.clipId} 是 none 档`);
  const bare = assertSame(tasks);
  // 切分方单卡流带全部代码身份;没有这份代码的节点不认领
  for (const item of bare.filter(item => item.kind === 'stream')) assert.deepEqual(item.cardSources, cardSources);
  for (const clipId of ['clip-bare', ...WRAPPED]) assert.equal(browserTasks(tasks, clipId).length, 0, `${clipId} 不给浏览器`);
});

test('WC-03 用户卡:挂了也算用户卡、要定制卡的代码', () => {
  const cardSources = { 'my-card': 'user:mine-v1' };
  const { tasks } = splitOf({ cardId: 'my-card', params: { text: '甲' } }, { cardSources });
  const bare = assertSame(tasks);
  const streams = bare.filter(item => item.kind === 'stream');
  assert.ok(streams.length > 0);
  for (const item of streams) {
    assert.deepEqual(item.cardSources, cardSources);
  }
  for (const clipId of ['clip-bare', ...WRAPPED]) assert.equal(browserTasks(tasks, clipId).length, 0, `${clipId} 不给浏览器`);
});

test('WC-04 普通内置卡:挂了也给浏览器节点,input.cardId 是这张卡', () => {
  const { tasks } = splitOf({ cardId: 'punch-pill', params: { text: '甲' } });
  const bare = assertSame(tasks);
  for (const item of bare.filter(item => item.kind === 'stream' && item.forBrowser)) {
    assert.equal(item.cardId, 'punch-pill');
    assert.deepEqual(item.cardSources, {});
    assert.equal(item.userCards, false);
  }
  for (const clipId of ['clip-bare', ...WRAPPED]) assert.ok(browserTasks(tasks, clipId).some(task => task.kind === 'stream'), `${clipId} 的流给浏览器`);
});

test('WC-05 强调和滤镜都挂(套两层):照样认得出里面那张', () => {
  const both = { filter: { id: 'f-warm', params: {} }, emphasis: EMPHASIS };
  for (const [cardId, cardSources] of [['lottie', {}], ['punch-pill', { 'punch-pill': 'override:abc' }], ['my-card', { 'my-card': 'user:mine-v1' }], ['punch-pill', {}]]) {
    const project = projectOf({ cardId, params: {} });
    project.tracks[2].clips[0] = { ...project.tracks[2].clips[0], ...both };
    const graph = projectCardGraph(project, getCard);
    const controls = new CardFrameCache({ root: 'unused', project, envFingerprint: OWN }).plan({ graph, sourceVersions: SOURCE_VERSIONS, environment: ENVIRONMENT });
    const cardPlan = queueCardPlan(controls, graph);
    const two = cardPlan.find(control => control.clipId === 'clip-filt');
    assert.equal(two.nodeId, '@clip/clip-filt/emphasis');
    assert.equal(two.cardId, cardId);
    assert.deepEqual(two.cardIds, [cardId]);
    const streams = planStreams({ project, cardPlan: controls }, { envFingerprint: OWN, codeVersion: 'test-code', budget: 8, below: true }).map(queueStreamOf);
    const tasks = splitPlan({
      planTask: clipsPlan({ clips: cardPlan.map(control => control.clipId) }), entryKey: 'entry-1', cardPlan, prerenderSet: null, streams,
      envFingerprint: OWN, codeVersion: 'cv-1', cardSourceVersions: cardSources, weightOf, isUserCard: isUserCardOf(SOURCE_VERSIONS),
      browser: { nodeId: 'n-br', envFingerprint: BR },
    });
    assert.deepEqual(shapeOf(tasks, 'clip-filt'), shapeOf(tasks, 'clip-bare'), `${cardId}:套两层的任务和不挂的逐项相同`);
  }
});

test('WC-06 不套一层的片段:cardId 与 main 的写法相同,切出的任务逐字段相同', () => {
  const cards = ['lottie', 'punch-pill', 'focus-card', 'my-card', 'particles'];
  const project = {
    id: 'p', width: 1920, height: 1080, fps: 30, duration: 8, themeId: 'dark', style: {}, media: [], filters: FILTERS, audioFx: [], pixelMaps: [], cardNodes: [],
    tracks: cards.map((cardId, n) => ({ id: `tr-${n}`, hidden: false, clips: [{ id: `clip-${cardId}`, start: 0.5 + n, end: 2.5 + n, frame: FRAME, cardId, params: {} }] })),
  };
  const graph = projectCardGraph(project, getCard);
  const controls = new CardFrameCache({ root: 'unused', project, envFingerprint: OWN }).plan({ graph, sourceVersions: SOURCE_VERSIONS, environment: ENVIRONMENT });
  const before = mainCardPlan(controls, graph), after = queueCardPlan(controls, graph);
  assert.equal(after.length, cards.length);
  // 控件只多了 cardIds 一栏(就是它自己那一张),别的逐字段相同
  assert.deepEqual(after.map(({ cardIds, ...rest }) => rest), before);
  for (const control of after) assert.deepEqual(control.cardIds, [control.cardId]);
  const streams = planStreams({ project, cardPlan: controls }, { envFingerprint: OWN, codeVersion: 'test-code', budget: 8, below: true }).map(queueStreamOf);
  for (const cardSources of [{}, { 'punch-pill': 'override:abc', 'my-card': 'user:mine-v1' }]) {
    const args = { planTask: clipsPlan({ clips: after.map(control => control.clipId) }), entryKey: 'entry-1', prerenderSet: null, streams,
      envFingerprint: OWN, codeVersion: 'cv-1', cardSourceVersions: cardSources, weightOf, browser: { nodeId: 'n-br', envFingerprint: BR } };
    const tasksBefore = splitPlan({ ...args, cardPlan: before, isUserCard: mainIsUserCardOf(SOURCE_VERSIONS) });
    const tasksAfter = splitPlan({ ...args, cardPlan: after, isUserCard: isUserCardOf(SOURCE_VERSIONS) });
    assert.ok(tasksBefore.length > 0);
    assert.deepEqual(tasksAfter, tasksBefore);
  }
});

/** 手写的图:外面一层接着两张卡(转场的样子)、一层接着找不到的节点 */
const HAND_GRAPH = { nodes: [
  { id: 'a', cardId: 'punch-pill', inputs: {} },
  { id: 'b', cardId: 'my-card', inputs: {} },
  { id: 'media', adapter: 'media', inputs: {} },
  { id: 'wrap-a', adapter: 'emphasis', inputs: { source: { nodeId: 'a' } } },
  { id: 'wrap-wrap-a', adapter: 'filter', inputs: { source: { nodeId: 'wrap-a' } } },
  { id: 'wrap-media', adapter: 'emphasis', inputs: { source: { nodeId: 'media' } } },
  { id: 'mix', adapter: 'transition', inputs: { to: { nodeId: 'b' }, from: { nodeId: 'a' } } },
  { id: 'wrap-mix', adapter: 'emphasis', inputs: { source: { nodeId: 'mix' } } },
  { id: 'fx', cardId: 'fx-tint', inputs: { source: { nodeId: 'a' } } },
  { id: 'same', adapter: 'transition', inputs: { from: { nodeId: 'a' }, to: 'a' } },
  { id: 'lost', adapter: 'emphasis', inputs: { source: { nodeId: 'gone' } } },
] };

test('WC-07 innerCardIds / withInnerCards 的取法', () => {
  const inner = innerCardIds(HAND_GRAPH);
  assert.deepEqual(inner('a'), { cardIds: ['punch-pill'], unsure: false, canvasHeavy: false });
  assert.deepEqual(inner('wrap-wrap-a'), { cardIds: ['punch-pill'], unsure: false, canvasHeavy: false });
  assert.deepEqual(inner('wrap-media'), { cardIds: [], unsure: false, canvasHeavy: false });
  // 输入按名字排序(from 在 to 前面),与写的先后无关
  assert.deepEqual(inner('wrap-mix'), { cardIds: ['punch-pill', 'my-card'], unsure: false, canvasHeavy: false });
  assert.deepEqual(inner('fx'), { cardIds: ['fx-tint', 'punch-pill'], unsure: false, canvasHeavy: false });
  assert.deepEqual(inner('same'), { cardIds: ['punch-pill'], unsure: false, canvasHeavy: false });
  assert.deepEqual(inner('lost'), { cardIds: [], unsure: true, canvasHeavy: false });
  assert.deepEqual(inner('nowhere'), { cardIds: [], unsure: true, canvasHeavy: false });

  const pick = nodeId => { const [out] = withInnerCards([{ clipId: 'c', nodeId }], HAND_GRAPH); return [out.cardId, out.cardIds, out.cardIdsUnsure === true]; };
  assert.deepEqual(pick('a'), ['punch-pill', ['punch-pill'], false]);
  assert.deepEqual(pick('wrap-wrap-a'), ['punch-pill', ['punch-pill'], false]);
  assert.deepEqual(pick('wrap-media'), [null, [], false]);
  // 里面两张:input.cardId 不取(null),两张都记着
  assert.deepEqual(pick('wrap-mix'), [null, ['punch-pill', 'my-card'], false]);
  // 输出节点自己是卡片:cardId 还是它自己(与原来相同),上游的卡也记着
  assert.deepEqual(pick('fx'), ['fx-tint', ['fx-tint', 'punch-pill'], false]);
  assert.deepEqual(pick('lost'), [null, [], true]);
  // 控件上已经写了 cardId 的照旧以它为准
  assert.deepEqual(withInnerCards([{ clipId: 'c', nodeId: 'wrap-a', cardId: 'given' }], HAND_GRAPH)[0].cardIds, ['given', 'punch-pill']);
  // 没有 cardIds 的控件(旧调用方):就是 cardId 那一张
  assert.deepEqual(cardIdsOf({ cardId: 'x' }), ['x']);
  assert.deepEqual(cardIdsOf({ cardId: null }), []);
  assert.deepEqual(cardIdsOf({ cardId: 'x', cardIds: ['y', 'y', ''] }), ['y']);
  const versions = { 'punch-pill': 'builtin:1', 'my-card': 'user:1' };
  assert.equal(isUserCardControl({ cardId: null, cardIds: ['punch-pill', 'my-card'] }, versions), true);
  assert.equal(isUserCardControl({ cardId: 'punch-pill', cardIds: ['punch-pill'] }, versions), false);
  assert.equal(isUserCardControl({ cardId: null, cardIds: [], cardIdsUnsure: true }, versions), true);
  assert.equal(isUserCardControl({ cardId: null, cardIds: [], cardIdsUnsure: true }, { 'punch-pill': 'builtin:1' }), false);
});

test('WC-08 里面不止一张卡、拿不准的控件:不给浏览器节点,代码身份往多里要', () => {
  const base = { snapshotKey: 'sk', contentKey: 'ck', tier: 'shared', start: 1, end: 3, count: 60,
    sampling: { firstFrame: 30, phase: { numerator: 0, denominator: 1 } }, compositing: 'independent', capabilities: { compositing: 'independent' } };
  const cardSources = { 'punch-pill': 'override:abc', 'focus-card': 'override:def', 'my-card': 'user:mine-v1' };
  const run = (control, sources = cardSources) => splitPlan({
    planTask: clipsPlan({ clips: [control.clipId] }), entryKey: 'entry-1', cardPlan: [control], prerenderSet: null, streams: [],
    envFingerprint: OWN, codeVersion: 'cv-1', cardSourceVersions: sources, weightOf, isUserCard: isUserCardOf(SOURCE_VERSIONS),
    browser: { nodeId: 'n-br', envFingerprint: BR },
  });
  // 对照:一张没改过的内置卡,给浏览器
  const one = run({ ...base, clipId: 'c1', cardId: 'focus-card', cardIds: ['focus-card'] }, {});
  assert.ok(one.some(task => task.requires.envFingerprint === BR));
  // 两张都没改过的内置卡:也不给浏览器(页面的隔离单卡工程只认一张)
  const two = run({ ...base, clipId: 'c2', cardId: null, cardIds: ['focus-card', 'punch-pill'] }, {});
  assert.ok(two.length > 0 && two.every(task => task.requires.envFingerprint === OWN));
  // 两张里有改过的、有用户卡:两张的代码身份都要,算用户卡
  const mixed = run({ ...base, clipId: 'c3', cardId: null, cardIds: ['punch-pill', 'my-card'] });
  assert.ok(mixed.length > 0);
  for (const task of mixed) {
    assert.equal(task.requires.envFingerprint, OWN);
    assert.deepEqual(task.requires.cardSources, { 'punch-pill': 'override:abc', 'my-card': 'user:mine-v1' });
    assert.equal(task.requires.userCards, true);
    assert.equal(task.input.cardId, null);
  }
  // 拿不准:全部定制卡的代码都要,不给浏览器
  const unsure = run({ ...base, clipId: 'c4', cardId: null, cardIds: [], cardIdsUnsure: true });
  assert.ok(unsure.length > 0);
  for (const task of unsure) {
    assert.equal(task.requires.envFingerprint, OWN);
    assert.deepEqual(task.requires.cardSources, cardSources);
    assert.equal(task.requires.userCards, true);
  }
  const unsureClean = run({ ...base, clipId: 'c5', cardId: null, cardIds: [], cardIdsUnsure: true }, {});
  assert.ok(unsureClean.length > 0 && unsureClean.every(task => task.requires.envFingerprint === OWN), '拿不准的即使没有定制卡也不给浏览器');
});

test('WC-09 画布卡:挂了强调、滤镜也不给浏览器节点、重度为「重」', () => {
  const { cardPlan, tasks } = splitOf({ cardId: 'particles', params: {} });
  for (const control of cardPlan) assert.equal(control.tier, 'none', `${control.clipId} 是 none 档`);
  assert.equal(cardPlan.find(control => control.clipId === 'clip-bare').capabilities.canvasHeavy, true);
  const bare = assertSame(tasks);
  for (const item of bare.filter(item => item.kind === 'stream')) assert.equal(item.weight, 'heavy');
  for (const clipId of ['clip-bare', ...WRAPPED]) assert.equal(browserTasks(tasks, clipId).length, 0, `${clipId} 不给浏览器`);
});

test('WC-10 innerCardIds 的 canvasHeavy:里面有画布卡才为真;控件自己标了的不另加 innerCanvasHeavy', () => {
  const graph = { nodes: [
    { id: 'p', cardId: 'particles', inputs: {}, capabilities: { compositing: 'independent', canvasHeavy: true } },
    { id: 'wrap-p', adapter: 'emphasis', inputs: { source: { nodeId: 'p' } }, capabilities: { compositing: 'independent' } },
    { id: 'a', cardId: 'punch-pill', inputs: {}, capabilities: { compositing: 'independent', canvasHeavy: false } },
    { id: 'wrap-a', adapter: 'emphasis', inputs: { source: { nodeId: 'a' } }, capabilities: { compositing: 'independent' } },
  ] };
  const inner = innerCardIds(graph);
  assert.equal(inner('p').canvasHeavy, true);
  assert.equal(inner('wrap-p').canvasHeavy, true);
  assert.equal(inner('wrap-a').canvasHeavy, false);
  const [bare, wrapped, plain] = withInnerCards([
    { clipId: 'c1', nodeId: 'p', capabilities: { canvasHeavy: true } },
    { clipId: 'c2', nodeId: 'wrap-p', capabilities: { compositing: 'independent' } },
    { clipId: 'c3', nodeId: 'wrap-a', capabilities: { compositing: 'independent' } },
  ], graph);
  assert.equal('innerCanvasHeavy' in bare, false);
  assert.equal(wrapped.innerCanvasHeavy, true);
  assert.equal('innerCanvasHeavy' in plain, false);
});
