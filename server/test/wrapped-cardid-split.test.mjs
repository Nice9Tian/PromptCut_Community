/**
 * When a clip is wrapped in an outer layer (attached emphasis, filter), the queue split step must
 * recognize which card is inside.
 *
 * The card graph (`projectCardGraph` in `src/kernel/cardGraph.mjs`) gives such clips the outer
 * layer (`@clip/<id>/emphasis`, `@clip/<id>/filter`) as the output node, while the card itself
 * sits behind its `inputs.source`. When `planForQueue` in `server/frame-pipeline.mjs` populated
 * `cardId` for controls, it originally only inspected output nodes, producing null;
 * `server/render-node/split.mjs` relied on it to determine "whether to dispatch to browser nodes",
 * "which card's code is required", and "whether it is a user card", so clips wrapped in an outer
 * layer were all misclassified.
 *
 * Here three clips are placed with the same card (none attached, attached emphasis, attached
 * filter; starting and ending at the same time), producing controls according to `planForQueue`
 * assembly and splitting, asserting that tasks for the three clips are identical item-by-item except
 * for the keys: the fingerprint of each, segment, `requires.cardSources`, `requires.userCards`,
 * `input.cardId`, and whether inputs required by the page are included.
 *
 *   WC-01  Lottie media card (unlocked 2026-10-14): given to browser nodes; inspects the inner card
 *          even with attached emphasis or filter
 *   WC-02  Built-in card with modified source code (overlay layer): task requires this card's code
 *          identity, even when wrapped; not given to browser nodes
 *   WC-03  User card: `requires.userCards` is true, requires code for all custom cards, same even
 *          when wrapped
 *   WC-04  Regular built-in card: given to browser nodes, `input.cardId` is this card, same even
 *          when wrapped
 *   WC-05  Both emphasis and filter attached (wrapped in two layers): still recognizes the inner card
 *   WC-06  Clip without an outer layer: populated `cardId` matches main implementation, split tasks
 *          are identical field-by-field
 *   WC-07  Extraction of `innerCardIds` / `withInnerCards`: when there is more than one card inside
 *          or uncertain
 *   WC-08  Controls with more than one card inside or uncertain: not given to browser nodes; require
 *          code for each inner card / code for all custom cards
 *   WC-09  Canvas card (review table `canvasHeavy`): not given to browser nodes, weight is "heavy",
 *          same even with attached emphasis or filter
 *
 * Run: npm test -- server/test/wrapped-cardid-split.test.mjs
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

/** `lottie` and `punch-pill` are standalone cards (shared tier) in the review table; `my-card` is not in the table (user card, treated as unknown, local tier) */
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
const FILTERS = [{ id: 'f-warm', name: 'Warm color', ops: [{ op: 'sepia', amount: 0.4 }] }];
const FRAME = { x: 200, y: 200, w: 400, h: 240 };

/** One clip on each of the three tracks, starting and ending at the same time: none attached, attached emphasis, attached filter */
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

/** The step in `planForQueue` that populates card id for controls (the same function) */
const queueCardPlan = (controls, graph) => withInnerCards(controls.filter(queueHandles), graph);
/** `isUserCard` of `planForQueue` (the same function) */
const isUserCardOf = sourceVersions => control => isUserCardControl(control, sourceVersions);

/** Implementation of `planForQueue` on main (53e7a9ca): inspects only output nodes. For comparison */
function mainCardPlan(controls, graph) {
  const cardIdOf = new Map((graph?.nodes ?? []).map(node => [node?.id, node?.cardId ?? null]));
  return controls.filter(queueHandles).map(control => ({ ...control, cardId: control.cardId ?? cardIdOf.get(control.nodeId) ?? null }));
}
const mainIsUserCardOf = sourceVersions => control => String(sourceVersions[control?.cardId] ?? '').startsWith('user:');

/** Assemble split input following `planForQueue`, then split; `cardSources` is the code identity of custom cards used in this version (`entry.cardSources`) */
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

/** The task of a clip after stripping keys (keys are inherently distinct: outer layer is in key) */
function shapeOf(tasks, clipId) {
  return tasks.filter(task => task.input.clipId === clipId).map(task => ({
    kind: task.kind, tier: task.tier ?? null, fingerprint: task.requires.envFingerprint, range: task.range,
    cardId: task.input.cardId, cardSources: task.requires.cardSources, userCards: task.requires.userCards, graphCards: task.requires.graphCards,
    transcode: task.requires.transcode, dual: task.input.dual === true, forBrowser: 'bake' in task.input, weight: task.weight.class,
  })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
}
const browserTasks = (tasks, clipId) => tasks.filter(task => task.input.clipId === clipId && task.requires.envFingerprint === BR);
const WRAPPED = ['clip-emph', 'clip-filt'];

/** Tasks for the three clips are identical item-by-item; returns the state of the clip with none attached */
function assertSame(tasks) {
  const bare = shapeOf(tasks, 'clip-bare');
  assert.ok(bare.length > 0, 'A clip with nothing attached must have tasks');
  for (const clipId of WRAPPED) assert.deepEqual(shapeOf(tasks, clipId), bare, `The tasks of ${clipId} must match those of the clip with nothing attached, item by item`);
  return bare;
}

test('WC-01 Lottie media card (opened up, 2026-10-14): gets a browser node like an ordinary standalone card, and with emphasis or a filter attached it still looks at the card inside', () => {
  const { cardPlan, tasks } = splitOf({ cardId: 'lottie', params: { src: 'a.json' } });
  for (const control of cardPlan) assert.equal(control.tier, 'none', `${control.clipId} is in the none tier`);
  assert.ok(browserTasks(tasks, 'clip-bare').length > 0, 'The one with nothing attached goes to the browser');
  for (const clipId of WRAPPED) assert.ok(browserTasks(tasks, clipId).length > 0, `${clipId} also goes to the browser`);
  const bare = assertSame(tasks);
  for (const item of bare.filter(item => item.kind === 'stream' && item.forBrowser)) assert.equal(item.cardId, 'lottie');
});

test('WC-02 Built-in card with modified source: even when attached it needs this card\'s code identity and gets no browser node', () => {
  const cardSources = { 'punch-pill': 'override:abc', 'focus-card': 'override:def' };
  const { cardPlan, tasks } = splitOf({ cardId: 'punch-pill', params: { text: 'A' } }, { cardSources });
  for (const control of cardPlan) assert.equal(control.tier, 'none', `${control.clipId} is in the none tier`);
  const bare = assertSame(tasks);
  // Splitter single-card stream carries all code identities; nodes without this code will not claim it
  for (const item of bare.filter(item => item.kind === 'stream')) assert.deepEqual(item.cardSources, cardSources);
  for (const clipId of ['clip-bare', ...WRAPPED]) assert.equal(browserTasks(tasks, clipId).length, 0, `${clipId} does not go to the browser`);
});

test('WC-03 User card: even when attached it still counts as a user card and needs the custom card\'s code', () => {
  const cardSources = { 'my-card': 'user:mine-v1' };
  const { tasks } = splitOf({ cardId: 'my-card', params: { text: 'A' } }, { cardSources });
  const bare = assertSame(tasks);
  const streams = bare.filter(item => item.kind === 'stream');
  assert.ok(streams.length > 0);
  for (const item of streams) {
    assert.deepEqual(item.cardSources, cardSources);
  }
  for (const clipId of ['clip-bare', ...WRAPPED]) assert.equal(browserTasks(tasks, clipId).length, 0, `${clipId} does not go to the browser`);
});

test('WC-04 Ordinary built-in card: even when attached it gets a browser node, and input.cardId is this card', () => {
  const { tasks } = splitOf({ cardId: 'punch-pill', params: { text: 'A' } });
  const bare = assertSame(tasks);
  for (const item of bare.filter(item => item.kind === 'stream' && item.forBrowser)) {
    assert.equal(item.cardId, 'punch-pill');
    assert.deepEqual(item.cardSources, {});
    assert.equal(item.userCards, false);
  }
  for (const clipId of ['clip-bare', ...WRAPPED]) assert.ok(browserTasks(tasks, clipId).some(task => task.kind === 'stream'), `The stream of ${clipId} goes to the browser`);
});

test('WC-05 Emphasis and filter both attached (two layers of wrapping): the inner card is still recognized', () => {
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
    assert.deepEqual(shapeOf(tasks, 'clip-filt'), shapeOf(tasks, 'clip-bare'), `${cardId}: the tasks with two layers of wrapping match those with nothing attached, item by item`);
  }
});

test('WC-06 Clip without a wrapping layer: cardId is written the same way as in main, and the split-out tasks are identical field by field', () => {
  const cards = ['lottie', 'punch-pill', 'focus-card', 'my-card', 'particles'];
  const project = {
    id: 'p', width: 1920, height: 1080, fps: 30, duration: 8, themeId: 'dark', style: {}, media: [], filters: FILTERS, audioFx: [], pixelMaps: [], cardNodes: [],
    tracks: cards.map((cardId, n) => ({ id: `tr-${n}`, hidden: false, clips: [{ id: `clip-${cardId}`, start: 0.5 + n, end: 2.5 + n, frame: FRAME, cardId, params: {} }] })),
  };
  const graph = projectCardGraph(project, getCard);
  const controls = new CardFrameCache({ root: 'unused', project, envFingerprint: OWN }).plan({ graph, sourceVersions: SOURCE_VERSIONS, environment: ENVIRONMENT });
  const before = mainCardPlan(controls, graph), after = queueCardPlan(controls, graph);
  assert.equal(after.length, cards.length);
  // Control only adds a cardIds field (its own card only), other fields are identical field-by-field
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

/** Hand-crafted graph: outer layer connects two cards (like a transition), one connects missing node */
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

test('WC-07 How innerCardIds / withInnerCards are derived', () => {
  const inner = innerCardIds(HAND_GRAPH);
  assert.deepEqual(inner('a'), { cardIds: ['punch-pill'], unsure: false, canvasHeavy: false });
  assert.deepEqual(inner('wrap-wrap-a'), { cardIds: ['punch-pill'], unsure: false, canvasHeavy: false });
  assert.deepEqual(inner('wrap-media'), { cardIds: [], unsure: false, canvasHeavy: false });
  // Inputs are sorted by name (from before to), independent of insertion order
  assert.deepEqual(inner('wrap-mix'), { cardIds: ['punch-pill', 'my-card'], unsure: false, canvasHeavy: false });
  assert.deepEqual(inner('fx'), { cardIds: ['fx-tint', 'punch-pill'], unsure: false, canvasHeavy: false });
  assert.deepEqual(inner('same'), { cardIds: ['punch-pill'], unsure: false, canvasHeavy: false });
  assert.deepEqual(inner('lost'), { cardIds: [], unsure: true, canvasHeavy: false });
  assert.deepEqual(inner('nowhere'), { cardIds: [], unsure: true, canvasHeavy: false });

  const pick = nodeId => { const [out] = withInnerCards([{ clipId: 'c', nodeId }], HAND_GRAPH); return [out.cardId, out.cardIds, out.cardIdsUnsure === true]; };
  assert.deepEqual(pick('a'), ['punch-pill', ['punch-pill'], false]);
  assert.deepEqual(pick('wrap-wrap-a'), ['punch-pill', ['punch-pill'], false]);
  assert.deepEqual(pick('wrap-media'), [null, [], false]);
  // Two cards inside: input.cardId is not set (null), both cards are tracked
  assert.deepEqual(pick('wrap-mix'), [null, ['punch-pill', 'my-card'], false]);
  // Output node itself is a card: cardId remains itself (same as before), upstream cards are also tracked
  assert.deepEqual(pick('fx'), ['fx-tint', ['fx-tint', 'punch-pill'], false]);
  assert.deepEqual(pick('lost'), [null, [], true]);
  // Controls that already have cardId keep taking it as the source of truth
  assert.deepEqual(withInnerCards([{ clipId: 'c', nodeId: 'wrap-a', cardId: 'given' }], HAND_GRAPH)[0].cardIds, ['given', 'punch-pill']);
  // Controls without cardIds (legacy callers): resolved to the single card in cardId
  assert.deepEqual(cardIdsOf({ cardId: 'x' }), ['x']);
  assert.deepEqual(cardIdsOf({ cardId: null }), []);
  assert.deepEqual(cardIdsOf({ cardId: 'x', cardIds: ['y', 'y', ''] }), ['y']);
  const versions = { 'punch-pill': 'builtin:1', 'my-card': 'user:1' };
  assert.equal(isUserCardControl({ cardId: null, cardIds: ['punch-pill', 'my-card'] }, versions), true);
  assert.equal(isUserCardControl({ cardId: 'punch-pill', cardIds: ['punch-pill'] }, versions), false);
  assert.equal(isUserCardControl({ cardId: null, cardIds: [], cardIdsUnsure: true }, versions), true);
  assert.equal(isUserCardControl({ cardId: null, cardIds: [], cardIdsUnsure: true }, { 'punch-pill': 'builtin:1' }), false);
});

test('WC-08 Controls with more than one card inside, or uncertain ones: no browser node, and the code identity errs on the side of asking for more', () => {
  const base = { snapshotKey: 'sk', contentKey: 'ck', tier: 'shared', start: 1, end: 3, count: 60,
    sampling: { firstFrame: 30, phase: { numerator: 0, denominator: 1 } }, compositing: 'independent', capabilities: { compositing: 'independent' } };
  const cardSources = { 'punch-pill': 'override:abc', 'focus-card': 'override:def', 'my-card': 'user:mine-v1' };
  const run = (control, sources = cardSources) => splitPlan({
    planTask: clipsPlan({ clips: [control.clipId] }), entryKey: 'entry-1', cardPlan: [control], prerenderSet: null, streams: [],
    envFingerprint: OWN, codeVersion: 'cv-1', cardSourceVersions: sources, weightOf, isUserCard: isUserCardOf(SOURCE_VERSIONS),
    browser: { nodeId: 'n-br', envFingerprint: BR },
  });
  // Comparison: an unmodified built-in card, given to browser
  const one = run({ ...base, clipId: 'c1', cardId: 'focus-card', cardIds: ['focus-card'] }, {});
  assert.ok(one.some(task => task.requires.envFingerprint === BR));
  // Two unmodified built-in cards: also not given to browser (page's isolated single-card project recognizes only one)
  const two = run({ ...base, clipId: 'c2', cardId: null, cardIds: ['focus-card', 'punch-pill'] }, {});
  assert.ok(two.length > 0 && two.every(task => task.requires.envFingerprint === OWN));
  // Between the two cards, some are modified or user cards: code identities of both cards are required, treated as user cards
  const mixed = run({ ...base, clipId: 'c3', cardId: null, cardIds: ['punch-pill', 'my-card'] });
  assert.ok(mixed.length > 0);
  for (const task of mixed) {
    assert.equal(task.requires.envFingerprint, OWN);
    assert.deepEqual(task.requires.cardSources, { 'punch-pill': 'override:abc', 'my-card': 'user:mine-v1' });
    assert.equal(task.requires.userCards, true);
    assert.equal(task.input.cardId, null);
  }
  // Uncertain: code for all custom cards is required, not given to browser
  const unsure = run({ ...base, clipId: 'c4', cardId: null, cardIds: [], cardIdsUnsure: true });
  assert.ok(unsure.length > 0);
  for (const task of unsure) {
    assert.equal(task.requires.envFingerprint, OWN);
    assert.deepEqual(task.requires.cardSources, cardSources);
    assert.equal(task.requires.userCards, true);
  }
  const unsureClean = run({ ...base, clipId: 'c5', cardId: null, cardIds: [], cardIdsUnsure: true }, {});
  assert.ok(unsureClean.length > 0 && unsureClean.every(task => task.requires.envFingerprint === OWN), 'Uncertain ones do not go to the browser even if there is no custom card');
});

test('WC-09 Canvas card: even with emphasis or a filter attached it gets no browser node, and its heaviness is "heavy"', () => {
  const { cardPlan, tasks } = splitOf({ cardId: 'particles', params: {} });
  for (const control of cardPlan) assert.equal(control.tier, 'none', `${control.clipId} is in the none tier`);
  assert.equal(cardPlan.find(control => control.clipId === 'clip-bare').capabilities.canvasHeavy, true);
  const bare = assertSame(tasks);
  for (const item of bare.filter(item => item.kind === 'stream')) assert.equal(item.weight, 'heavy');
  for (const clipId of ['clip-bare', ...WRAPPED]) assert.equal(browserTasks(tasks, clipId).length, 0, `${clipId} does not go to the browser`);
});

test('WC-10 canvasHeavy of innerCardIds: true only when there is a canvas card inside; innerCanvasHeavy is not added when the control marked it itself', () => {
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
