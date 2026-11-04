/**
 * Field-by-field verification between this page's stream plan (`src/online/pageStreamPlan.ts`, task
 * brief `docs/plan/render-refactor-task.md` "Jia-2") and the splitter:
 * For the same stream, the result key, stream task, manifest, and row in the layer table computed on
 * the page side match those computed by the server chain:
 *
 *   `CardFrameCache.plan` (keys for each card) → `planListStreams` (manifest plan streams) →
 *   `queueStreamOf` → stream tasks output by `splitPlan` for the browser → `layerStreamsOf` (`streams`
 *   table of the layer table).
 *
 *   PSP-01  Copied constants have the same values as the server
 *   PSP-02  Stream keys and shapes: content key, result key, segment range, rectangle, placement
 *           (integer in point, fractional in point, with frame, exceeding project end, two cards)
 *   PSP-03  Member key appears in only one place: `streamMemberKey` matches the member key used by
 *           the splitter (this item goes red first after server changes its algorithm)
 *   PSP-04  Stream tasks: id, result key, range, input, source, weight, requires, priority match
 *           those output by the splitter for the browser
 *   PSP-05  Manifest: for the same segment registrations, manifests output by task groups on both
 *           sides match, passing `manifestMatches`
 *   PSP-06  That row in the layer table matches what `layerStreamsOf` writes
 *   PSP-07  Merge results match when exceeding decoder budget: cards merged into group streams do
 *           not produce single-card streams on either side
 *   PSP-07b Two types of cards that the splitter streams separately (standalone cards with 3D
 *           frames, source-dependent cards) are not produced on the page, but count toward decoder
 *           budget: merge results still match
 *   PSP-08  Cards not produced: canvas cards, below-dependent, 3D frames, hidden tracks are not
 *           produced on either side; two additional kinds not produced on the page (clips with
 *           emphasis attached, not built-in cards)
 *   PSP-09  No fingerprint, no code fingerprint: not a single stream is counted
 *   PSP-10  Merge into existing layer table: other fields and rows for other cards remain
 *           untouched, candidates from this page are moved to the front, rows with expired input
 *           signatures for the same card are removed (unexpired ones remain behind), and nothing is
 *           written when there are no changes;
 *           Which candidates "check first" accepts: same content key, or unexpired input signature
 *           (same criterion as the playback side)
 *
 * Run: npm test -- server/test/page-stream-plan.test.mjs
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
const OWN = '1111111111111111';      // Splitter fingerprint
const BROWSER = '2222222222222222';  // This page's fingerprint
const CODES = { capture: captureCode(ROOT) };
const CODE_VERSION = 'code-version-for-test';

/** Registry test double: built-in cards only need id (capabilities from review table); `user-pill` as user card */
const getCard = id => (id ? { id, defaults: { text: 'x', size: 1 } } : undefined);
const clip = (id, cardId, start, end, extra = {}) => ({ id, cardId, start, end, params: { text: id }, ...extra });
const projectOf = (tracks, extra = {}) => ({
  id: 'proj-page', width: 1920, height: 1080, fps: 30, duration: 8, themeId: 'dark', style: { accent: '#f80' }, media: [], filters: [], pixelMaps: [], cardNodes: [],
  tracks, ...extra,
});

/** Raw input shaped identically to export page `window.__pcCardPlan()`; consumed by both sides */
function valueOf(project, sourceVersions = null) {
  const graph = projectCardGraph(project, getCard);
  const versions = sourceVersions ?? Object.fromEntries(project.tracks.flatMap(t => t.clips).filter(c => c.cardId).map(c => [c.cardId, `builtin:v-${c.cardId}`]));
  return { graph, sourceVersions: versions, unknownClipIds: [],
    environment: { width: project.width, height: project.height, fps: project.fps, theme: project.themeId, fontFingerprint: '0123456789abcdef' } };
}

/** Server chain: card plan → manifest plan streams → slice output by splitter for browser */
function serverSide(project, value, clips, { budget = STREAM_DECODER_BUDGET, sparseStreams = false } = {}) {
  // Maps retrieved via debug protocol underwent a JSON round trip
  const wire = JSON.parse(JSON.stringify(value));
  const cache = new CardFrameCache({ root: path.join(os.tmpdir(), 'pc-page-stream-plan'), project, envFingerprint: OWN });
  const cardIdOf = new Map(wire.graph.nodes.map(node => [node.id, node.cardId ?? null]));
  const cardPlan = cache.plan(wire).map(control => ({ ...control, cardId: cardIdOf.get(control.nodeId) ?? null }));
  const entry = { key: 'entry-page', project, cardPlan };
  const specs = planListStreams(entry, clips, { budget, codeVersion: `${STREAM_CODE_VERSION}:${CODES.capture}`, envFingerprint: OWN });
  const planTask = clipsPlanTaskOf({ projectId: project.id, projectRev: 7, clips, codeVersion: CODE_VERSION });
  const tasks = splitPlan({
    planTask, entryKey: entry.key, cardPlan, prerenderSet: new Set(clips),
    // Manifest plan: splitter does not produce them itself; streams are only output once for the
    // browser (`listPlanOverrides` in `local-node.mjs`)
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

test('PSP-01 copied constants have the same values as the server\'s', () => {
  assert.equal(PAGE_STREAM_CODE_VERSION, STREAM_CODE_VERSION, 'stream code version (when the server bumps it, change it here too, along with streamMemberKey)');
  assert.equal(PAGE_STREAM_DECODER_BUDGET, STREAM_DECODER_BUDGET);
  assert.equal(PAGE_LOCAL_OVERFLOW_PX, LOCAL_OVERFLOW_PX);
  assert.equal(PAGE_STREAM_SEGMENTS_PER_TASK, QUEUE_DEFAULTS.STREAM_SEGMENTS);
  assert.equal(PAGE_SNAPSHOT_SPAN, QUEUE_DEFAULTS.SNAPSHOT_SPAN);
  assert.equal(PAGE_LAYER_MAP_VERSION, LAYER_MAP_VERSION);
  assert.equal(STREAM_SEGMENT_FRAMES, SEGMENT_FRAMES);
});

test('PSP-02 stream keys and shapes are identical field by field', async () => {
  const project = BASIC();
  const value = valueOf(project);
  const clips = ['clip-a', 'clip-b', 'clip-c'];
  const server = serverSide(project, value, clips);
  const page = await pageSide(project, value, clips);
  assert.equal(server.specs.length, 3, 'the server produces three single-card streams');
  assert.equal(page.specs.length, 3, `the page also produces three:${JSON.stringify(page.skipped)}`);
  for (const want of server.specs) {
    const got = page.specs.find(s => s.topClipId === want.topClipId);
    assert.ok(got, `the page has a stream for ${want.topClipId}`);
    assert.equal(got.contentKey, want.contentKey, `content key of ${want.topClipId}`);
    assert.equal(got.streamKey, serverResultKeyOf(want.contentKey, BROWSER), `result key of ${want.topClipId} = content key × this page's fingerprint`);
    assert.notEqual(got.streamKey, want.streamKey, 'differs from the key under the splitter\'s own fingerprint');
    for (const field of ['kind', 'plane', 'fps', 'total', 'firstFrame', 'lastFrame', 'firstSegment', 'lastSegment']) assert.deepEqual(got[field], want[field], `${want.topClipId}.${field}`);
    assert.deepEqual(got.clipIds, want.clipIds);
    assert.deepEqual(got.bound, want.bound, `rectangle of ${want.topClipId}`);
    assert.deepEqual(got.offset, want.offset, `placement of ${want.topClipId}`);
    assert.deepEqual(got.stage, want.stage);
  }
  // Fractional in point: first frame is after the in point, phase is non-zero; cards extending beyond
  // project end are truncated by project duration
  const b = page.specs.find(s => s.topClipId === 'clip-b');
  assert.equal(b.firstFrame, 38);
  assert.notEqual(b.bake.sampling.phase.numerator, '0');
  const c = page.specs.find(s => s.topClipId === 'clip-c');
  assert.equal(c.lastFrame, 239, 'cut off at the project\'s last frame');
  assert.equal(await resultKeyOf('ck', 'fp'), serverResultKeyOf('ck', 'fp'));
});

test('PSP-03 there is only one member key: the same as the one the splitter uses', async () => {
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
    // Expression in `planStreams` for member key: `streamMemberKey ?? contentKey` (`streamMemberKey`
    // present since "Ji-1", without snapshot-generating code fingerprint)
    assert.ok(theirs.streamMemberKey, 'the server\'s card plan carries streamMemberKey');
    assert.equal(key, theirs.streamMemberKey ?? theirs.contentKey, `member key of ${control.clipId}`);
    assert.notEqual(key, theirs.contentKey, 'not the copy that carries the code fingerprint for generating snapshots');
    assert.deepEqual(control.sampling, theirs.sampling);
    assert.equal(control.count, theirs.count);
    assert.equal(control.tier, theirs.tier);
    assert.equal(control.compositing, theirs.compositing);
  }
});

test('PSP-04 stream tasks are identical to the copy the splitter produces for the browser; PSP-05 manifests are identical', async () => {
  const project = BASIC();
  // clip-b stretched to frames 38-185 (148 frames): segments are 0-9 from its own first frame,
  // exceeding 8 segments, split into two tasks; the last segment has only 13 frames
  project.tracks.find(t => t.id === 't-b').clips[0].end = 6.2;
  project.tracks.find(t => t.id === 't-b').clips[0].cardId = 'caption-track';
  const value = valueOf(project);
  const clips = ['clip-a', 'clip-b', 'clip-c'];
  const server = serverSide(project, value, clips);
  const page = await pageSide(project, value, clips);
  const mine = page.specs.flatMap(spec => pageStreamTasks(spec, { projectId: project.id, projectRev: 7, codeVersion: CODE_VERSION, derivedFrom: server.planTask.id }));
  assert.ok(server.tasks.length >= 4, 'the server split out stream tasks (clip-b spans more than 8 segments, split into two tasks)');
  assert.equal(mine.length, server.tasks.length);
  const bTasks = server.tasks.filter(t => t.input.clipId === 'clip-b');
  assert.deepEqual(bTasks.map(t => [t.range.from, t.range.to, t.weight.frames]), [[0, 7, 120], [8, 9, 28]], 'segments are counted from clip-b\'s own first frame; the frame count is the actual one (the last segment is not full)');
  assert.deepEqual([bTasks[0].input.stream.originFrame, bTasks[0].input.stream.lastFrame], [38, 185]);
  assert.ok(server.tasks.every(t => t.requires.envFingerprint === BROWSER), 'manifest plans are produced for the browser only');
  const norm = v => JSON.parse(JSON.stringify(v));
  for (const want of server.tasks) {
    const got = mine.find(t => t.id === want.id);
    assert.ok(got, `the page has task ${want.id}`);
    assert.deepEqual(norm(got), norm(want), want.id);
  }
  // Manifest: for the same segment registration, manifests output by task groups on both sides match
  // field by field
  for (const want of server.tasks) {
    const got = mine.find(t => t.id === want.id);
    const inits = { aaaaaaaaaaaaaaaa: { hash: 'a'.repeat(64), bytes: 700, codec: 'avc1.640028', width: 704, height: 848, timescale: 30, rect: got.input.stream.bound, encoder: 'webcodecs-avc' } };
    const segments = {};
    for (let n = want.range.from; n <= want.range.to; n++) segments[n] = { hash: (n % 10).toString().repeat(64), bytes: 1000 + n, init: 'aaaaaaaaaaaaaaaa', stride: 1, samples: 15, sig: null, encoder: 'webcodecs-avc' };
    const a = streamManifest(got, { inits, segments }), b = streamManifest(want, { inits, segments });
    assert.deepEqual(a, b);
    assert.equal(a.header.originFrame, want.input.stream.originFrame, 'the manifest header carries the first frame of this stream');
    assert.equal(manifestMatches(a, { kind: 'stream', resultKey: want.resultKey, range: want.range }), true);
  }
});

test('PSP-06 the layer table row matches what layerStreamsOf writes', async () => {
  const project = BASIC();
  const value = valueOf(project);
  const clips = ['clip-a', 'clip-b', 'clip-c'];
  const server = serverSide(project, value, clips);
  const page = await pageSide(project, value, clips);
  // How manifest plan writes browser streams into layer table (`issuedStreamSpecs`): splitter's own
  // fingerprint is not added, candidates only include browser fingerprints that actually emitted keys
  const rows = layerStreamsOf(server.entry, { streams: server.specs.map(s => ({ ...s, ownCandidate: false })), fingerprint: OWN, candidatesOf: () => [BROWSER] });
  assert.equal(rows.length, 3);
  for (const want of rows) {
    const spec = page.specs.find(s => s.topClipId === want.topClipId);
    assert.deepEqual(pageStreamRow(project, spec), want, want.topClipId);
    assert.ok(want.inputSig, 'carries an input signature');
  }
});

test('PSP-07 merged results are identical when the decoder budget is exceeded', async () => {
  // Four cards rendering simultaneously, budget set to 2: adjacent cards merge into a group stream
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
    assert.deepEqual(page.specs.map(s => s.topClipId).sort(), singles, `budget ${budget}`);
    assert.deepEqual(page.specs.map(s => s.contentKey).sort(), server.specs.filter(s => s.kind === 'card').map(s => s.contentKey).sort());
    for (const id of clips.filter(id => !singles.includes(id))) assert.equal(page.skipped[id], 'grouped', `${id} was merged into a group stream`);
    assert.deepEqual(server.tasks.map(t => t.input.clipId).filter((id, i, a) => a.indexOf(id) === i).sort(), singles, 'splitter issues the browser share only for single-card streams');
  }
});

test('PSP-07b the page does not produce the two kinds of cards the splitter gives their own stream (standalone cards with a 3D frame, source-dependent cards), but counts them in the decoder budget: cards merged into group streams still match on both sides', async () => {
  // Three planar standalone cards rendering simultaneously, topped by a standalone card with 3D frame
  // and a media effect card wrapped over video (inputs connected, not reviewed)
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
    assert.deepEqual(server.specs.filter(s => s.solo).map(s => `${s.topClipId}:${s.solo}`).sort(), ['fx:source', 'threed:spatial'], `budget ${budget}: splitter issues a separate stream for each of these two cards`);
    const singles = server.specs.filter(s => s.kind === 'card' && !s.solo).map(s => s.topClipId).sort();
    if (singles.length < 3) merged++;
    assert.deepEqual(page.specs.map(s => s.topClipId).sort(), singles, `budget ${budget}: single-card streams produced by the page match those the splitter gives the browser`);
    for (const id of ['g-1', 'g-2', 'g-3'].filter(id => !singles.includes(id))) assert.equal(page.skipped[id], 'grouped', `budget ${budget}: ${id} was merged into a group stream`);
    assert.equal(page.skipped.threed, 'frame-3d');
    assert.equal(page.skipped.fx, 'not-independent');
    assert.deepEqual(server.tasks.map(t => t.input.clipId).filter((id, i, a) => a.indexOf(id) === i).sort(), singles, `budget ${budget}: the browser share has only the single-card streams of planar standalone cards`);
  }
  // Budget 4: five streams exceed by one: not exceeded if only counting the three planar cards; only
  // realizes merge is needed when counting those two (this goes red when page does not count them)
  assert.ok(merged >= 3, 'several budget tiers merge only because these two streams are counted');
});

/** Compare single-card stream sets on both sides (planar standalone cards for browser): clips and content keys match */
async function assertParity(project, value, clips, opts = {}, label = '') {
  const server = serverSide(project, value, clips, opts);
  const page = await pageSide(project, value, clips, opts.budget === undefined ? {} : { budget: opts.budget });
  const want = server.specs.filter(s => s.kind === 'card' && !s.solo).map(s => `${s.topClipId}:${s.contentKey}`).sort();
  const got = page.specs.map(s => `${s.topClipId}:${s.contentKey}`).sort();
  assert.deepEqual(got, want, `${label}: the page's single-card streams match the splitter's`);
  for (const s of server.specs.filter(s => s.kind === 'group')) for (const id of s.clipIds) assert.equal(page.skipped[id], 'grouped', `${label}: ${id} was merged into a group stream on both sides`);
  return { server, page };
}

/** 4K, 60 fps; six full-screen planar standalone cards rendering, topped by `extra` tracks */
const crowded = (extra = [], more = {}) => projectOf([
  ...extra,
  ...[1, 2, 3, 4, 5, 6].map(n => ({ id: `t-${n}`, clips: [clip(`f-${n}`, n % 2 ? 'punch-pill' : 'focus-card', 0, 3)] })),
], { width: 3840, height: 2160, fps: 60, duration: 4, ...more });

test('PSP-11 reproduction: streams that depend on the layer below take up budget, so the page has to count them (4K 60 fps, six full-screen standalone cards + one card that depends on the layer below)', async () => {
  // Seven streams on screen: exceeds the pixel-blind limit of 6, 4K full-screen pixels far exceed
  // budget → splitter merges; if page ignores the below-dependent stream, it sees 6 and merges none
  const project = crowded([{ id: 't-below', clips: [clip('below', 'terminal-3d', 0, 3)] }]);
  const value = valueOf(project);
  const clips = ['below', 'f-1', 'f-2', 'f-3', 'f-4', 'f-5', 'f-6'];
  const { server, page } = await assertParity(project, value, clips, {}, '4K seven streams');
  assert.ok(server.specs.some(s => s.kind === 'below' && s.topClipId === 'below'), 'splitter issued a stream for the card that depends on the layer below');
  assert.ok(server.specs.some(s => s.kind === 'group'), 'splitter produced a group stream by merging');
  assert.ok(page.specs.length < 6, 'the page also produced fewer streams by leaving out the cards merged into group streams');
  assert.equal(page.skipped.below, 'not-independent');
});

test('PSP-12 parity check: for a set of representative projects, the page\'s single-card streams match the splitter\'s one by one', async () => {
  const fxNode = { id: 'n-fx', adapter: 'card', cardId: 'user-fx', kind: 'filter', params: {}, inputs: { source: { nodeId: '@clip/fx/source', offset: 0, rate: 1 } } };
  const versions = { 'punch-pill': 'builtin:a', 'focus-card': 'builtin:e', 'terminal-3d': 'builtin:d', 'user-fx': 'user:x' };
  const cases = [
    // Fewer than 6 streams
    ['1080p three streams', BASIC(), ['clip-a', 'clip-b', 'clip-c'], null],
    // More than 6 streams, 1080p: seven full-screen standalone cards, pixels inspected from 7th stream
    // onward
    ['1080p seven streams', projectOf([1, 2, 3, 4, 5, 6, 7].map(n => ({ id: `t-${n}`, clips: [clip(`f-${n}`, 'punch-pill', 0, 3)] })), { fps: 60 }), null, null],
    // Tall aspect ratio, fewer than 6 streams (pixels not checked, merges none)
    ['4K six streams', crowded(), null, null],
    // Cards with below-dependent (two cards, one with 3D frame: also emits below-dependent stream)
    ['4K two cards depending on the layer below', crowded([
      { id: 't-b1', clips: [clip('below', 'terminal-3d', 0, 3)] },
      { id: 't-b2', clips: [clip('below3d', 'terminal-3d', 1, 2, { frame: { x: 0, y: 0, w: 400, h: 300, rotateX: 20 } })] },
    ]), null, null],
    // Standalone card with 3D outer frame (streams separately)
    ['4K 3D frame', crowded([{ id: 't-3d', clips: [clip('threed', 'punch-pill', 0, 3, { frame: { x: 0, y: 0, w: 800, h: 600, rotateY: 30 } })] }]), null, null],
    // With source-dependent card (media effect card with inputs connected, not reviewed)
    ['4K source-dependent card', crowded([{ id: 't-fx', clips: [clip('fx', 'user-fx', 0, 3, { nodeId: 'n-fx', mediaId: 'm1' })] }],
      { media: [{ id: 'm1', kind: 'video', hash: 'h1', url: '/@media/h1' }], cardNodes: [fxNode] }), null, versions],
    // All three present, multiple 1080p small cards
    ['1080p mixed', projectOf([
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
      const { server } = await assertParity(project, value, clips, budget === undefined ? {} : { budget }, `${label} budget ${budget ?? 'default'}`);
      if (server.specs.some(s => s.kind === 'group')) grouped++;
    }
  }
  assert.ok(grouped >= 4, `several kinds of project merge into group streams on both sides (${grouped})`);
});

test('PSP-08 cards that are not produced', async () => {
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
  // Lottie media cards enabled since 2026-10-14: output on both sides, same as normal standalone cards
  assert.deepEqual(page.specs.map(s => s.topClipId).sort(), ['lottie', 'ok']);
  // Produced on neither side
  for (const id of ['canvas', 'below', 'threed', 'hidden']) assert.equal(issued.includes(id), false, `splitter does not issue ${id} to the browser`);
  assert.equal(page.skipped.canvas, 'canvas');
  assert.equal(page.skipped.lottie, undefined);
  assert.equal(issued.includes('lottie'), true, 'splitter issues lottie to the browser');
  assert.equal(page.skipped.below, 'not-independent');
  assert.equal(page.skipped.threed, 'frame-3d');
  // Page is stricter than splitter: not a built-in card (user cards require this page to declare
  // runnable on the splitter side; not declared here, so not produced either)
  assert.equal(page.skipped.user, 'not-independent');
  assert.equal(issued.includes('ok'), true);
  // User card (missing in review table, treated as unknown) replaced by reviewed card as "not built-in":
  // not produced if source version does not start with builtin:
  const asUser = valueOf(project, { ...versions, 'punch-pill': 'user:z' });
  const again = await pageSide(project, asUser, ['ok']);
  assert.deepEqual(again.specs, []);
  assert.equal(again.skipped.ok, 'not-builtin');
  // Clip with emphasis attached: output node is the outer layer
  assert.equal(page.skipped.emph, 'wrapped-node');
  // Note splitter's handling of such clips (its member key is determined solely by outer layer,
  // see report "Issues Found"): splitter outputs it, page does not
  assert.equal(issued.includes('emph'), true, 'splitter issued the browser share for the clip with emphasis attached');
});

test('PSP-09 no fingerprint and no code fingerprint: none counts', async () => {
  const project = BASIC();
  const value = valueOf(project);
  assert.deepEqual((await planPageStreams({ project, value, clips: ['clip-a'], codes: CODES, envFingerprint: null })).specs, []);
  assert.deepEqual((await planPageStreams({ project, value, clips: ['clip-a'], codes: null, envFingerprint: BROWSER })).specs, []);
  assert.deepEqual((await planPageStreams({ project, value, clips: [], codes: CODES, envFingerprint: BROWSER })).specs, []);
  // Fingerprint changed: content key unchanged, result key changes
  const a = (await pageSide(project, value, ['clip-a'])).specs[0];
  const b = (await planPageStreams({ project, value, clips: ['clip-a'], codes: CODES, envFingerprint: '3333333333333333' })).specs[0];
  assert.equal(a.contentKey, b.contentKey);
  assert.notEqual(a.streamKey, b.streamKey);
  // Parameters modified: content key changes
  const edited = BASIC();
  edited.tracks[0].clips[0].params = { text: 'changed' };
  const c = (await pageSide(edited, valueOf(edited), ['clip-a'])).specs[0];
  assert.notEqual(c.contentKey, a.contentKey);
});

test('PSP-10 merge into the existing layer table', async () => {
  const project = BASIC();
  const value = valueOf(project);
  const page = await pageSide(project, value, ['clip-a', 'clip-b']);
  const rows = page.specs.map(spec => pageStreamRow(project, spec));
  const rowA = rows.find(r => r.topClipId === 'clip-a');
  // No layer table: write a new one with empty layers
  const fresh = mergeLayerStreams(null, { project, rows, now: 5 });
  assert.equal(fresh.v, LAYER_MAP_VERSION);
  assert.equal(fresh.kind, 'layer-map');
  assert.equal(fresh.projectId, project.id);
  assert.deepEqual(fresh.layers, []);
  assert.equal(fresh.streams.length, 2);
  // Merge once more: no changes, nothing written
  assert.equal(mergeLayerStreams(fresh, { project, rows, now: 6 }), null);
  // Existing table: other fields, layers, and rows for other cards remain untouched (order untouched);
  // for rows of same card and content key, this page's candidates move to front, others kept
  const rowB = rows.find(r => r.topClipId === 'clip-b');
  const other = { topClipId: 'clip-z', clipIds: ['clip-z'], kind: 'card', plane: 'local', contentKey: 'z', candidates: [{ envFingerprint: OWN, resultKey: 'rz' }], firstSegment: 0, lastSegment: 1, segmentsPerTask: 8 };
  const theirs = { ...rowA, candidates: [{ envFingerprint: OWN, resultKey: serverResultKeyOf(rowA.contentKey, OWN) }] };
  // clip-b has two other rows with different content keys: one with expired input signature (stream
  // with old parameters), one not expired (same stream produced by another environment with its own key)
  const stale = { ...rowB, contentKey: 'old-content', inputSig: 's1-0000000000000000', candidates: [{ envFingerprint: OWN, resultKey: 'old' }] };
  const foreign = { ...rowB, contentKey: 'their-content', candidates: [{ envFingerprint: OWN, resultKey: 'their-key' }] };
  const existing = { v: 3, kind: 'layer-map', projectId: project.id, entryKey: 'e', fps: 30, width: 1920, height: 1080, span: 60, at: 1, layers: [{ clipId: 'clip-a', kind: 'html' }], streams: [other, theirs, stale, foreign] };
  const merged = mergeLayerStreams(existing, { project, rows, now: 9 });
  assert.deepEqual(merged.layers, existing.layers);
  assert.equal(merged.entryKey, 'e');
  assert.deepEqual(merged.streams.map(r => [r.topClipId, r.contentKey === 'z' ? 'z' : r.contentKey === rowA.contentKey ? 'A' : r.contentKey === rowB.contentKey ? 'B' : r.contentKey]),
    [['clip-z', 'z'], ['clip-a', 'A'], ['clip-b', 'B'], ['clip-b', 'their-content']], 'rows of other cards stay in place; this page\'s rows take the position of this card\'s first row; expired rows are dropped, unexpired rows stay after them');
  assert.deepEqual(merged.streams[0], other);
  assert.deepEqual(merged.streams[1].candidates.map(c => c.envFingerprint), [BROWSER, OWN]);
  assert.deepEqual(merged.streams[3], foreign);
  assert.equal(mergeLayerStreams(merged, { project, rows, now: 10 }), null, 'merging again what was already merged: no change');
  // Candidates recognized by "check first": same content key; different content key with unexpired
  // input signature (along with that row's segment range); expired ones rejected
  assert.deepEqual(layerStreamCandidates(existing, rowA).map(c => c.envFingerprint), [OWN]);
  assert.deepEqual(layerStreamCandidates(existing, rowB).map(c => c.resultKey), ['their-key']);
  assert.deepEqual(layerStreamCandidates({ ...existing, streams: [{ ...foreign, inputSig: undefined }] }, rowB).map(c => c.resultKey), ['their-key'], 'a row without an input signature: still plays and is still accepted');
  assert.deepEqual(layerStreamCandidates(existing, { ...rowB, topClipId: 'clip-q' }), []);
  assert.deepEqual(layerStreamCandidates({ ...existing, streams: [{ ...foreign, kind: 'group' }] }, rowB), [], 'group streams do not count');
  // Row missing first frame of this stream (written by node before segment rule changed, segmented
  // by project frame number): online source does not play it, not treated as ready-made here either
  const { originFrame: _origin, ...oldForeign } = foreign;
  assert.equal(Number.isInteger(foreign.originFrame), true);
  assert.deepEqual(layerStreamCandidates({ ...existing, streams: [{ ...oldForeign, firstSegment: 2 }] }, rowB), [], 'rows in the old shape do not count');
  assert.deepEqual(layerStreamCandidates({ ...existing, streams: [foreign] }, rowB).map(c => [c.firstSegment, c.lastSegment]), [[0, foreign.lastSegment]], 'segment numbers start at 0');
  // Candidate manifests partitioned by that row's range: which parts cover this section of this page
  const cand = { envFingerprint: OWN, resultKey: 'k', firstSegment: 2, lastSegment: 20, segmentsPerTask: 8 };
  assert.deepEqual(candidateSpans(cand, 2, 9), [[2, 9]]);
  assert.deepEqual(candidateSpans(cand, 9, 11), [[2, 9], [10, 17]]);
  assert.deepEqual(candidateSpans(cand, 18, 20), [[18, 20]]);
  assert.equal(candidateSpans(cand, 0, 9), null, 'the candidate\'s range does not fully cover this segment');
  assert.equal(candidateSpans(cand, 18, 21), null);
  // Tables from other projects, unrecognized versions: treated as nonexistent, rewritten
  assert.deepEqual(mergeLayerStreams({ ...existing, projectId: 'someone-else' }, { project, rows, now: 9 }).layers, []);
  assert.deepEqual(mergeLayerStreams({ ...existing, v: 9 }, { project, rows, now: 9 }).layers, []);
});

test('PSP-sparse sparse stream tasks: the tasks the page builds by density are field-for-field identical to the sparse stream tasks the splitter hands the browser; the full-density group is unchanged', async () => {
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
  assert.equal(PAGE_SPARSE_STREAM_PRIORITY, SPARSE_STREAM_PRIORITY, 'The sparse stream task priority is the same number as the splitter\'s');
  assert.ok(wantSparse.length >= 3 && wantSparse.length === wantDense.length, 'Every full-density task has a sparse stream task with the same range');
  assert.equal(sparse.length, wantSparse.length);
  const norm = v => JSON.parse(JSON.stringify(v));
  for (const want of wantSparse) {
    const got = sparse.find(t => t.id === want.id);
    assert.ok(got, `the page has task ${want.id}`);
    assert.ok(want.id.endsWith(':sparse'));
    assert.deepEqual(norm(got), norm(want), want.id);
    // Full-density tasks of same range: result key and range match (manifest key in content store
    // matches), id differs only at the end
    const twin = wantDense.find(t => `${t.id}:sparse` === want.id);
    assert.ok(twin, 'Has a full-density task with the same range');
    assert.equal(twin.resultKey, want.resultKey);
    assert.deepEqual(twin.range, want.range);
    assert.ok(want.priority > twin.priority);
  }
  // The full-density group is verbatim identical to when sparse stream tasks are not sliced
  assert.deepEqual(norm(wantDense), norm(plainServer.tasks));
  for (const want of wantDense) assert.deepEqual(norm(dense.find(t => t.id === want.id)), norm(want), want.id);
});
