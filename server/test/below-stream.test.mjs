/**
 * Below-dependent streams (`kind: 'below'`, sections 5.1 and 5.2 of
 * `docs/plan/prerender-products-contract.md`): plans, keys, input signatures, isolated projects,
 * splitting and claiming, and layer tables. Test case names start with `BL-`.
 * Run: npm test -- server/test/below-stream.test.mjs
 *
 * This kind of stream is enabled by default (`belowStreamsEnabled` in `frame-stream.mjs`; only
 * unit tests and probes have a way to disable it); here `below: true` is explicitly passed to
 * `planStreams`, while several other cases specifically verify that "nothing changes when disabled
 * (behaving like an old node)".
 *
 * Keys are computed using **real** card plans: project → `projectCardGraph` (card definitions use
 * stubs, and whether it is below-dependent is taken from cards that actually exist in the review
 * table) → `CardFrameCache.plan()` → `planStreams`. Therefore, "whether the key changes when one
 * place in lower layers is modified" tests how real keys react to real project data, not
 * handwritten mock keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  planStreams, planListStreams, queueStreamOf, groupStreams, peakConcurrency, isolatedStreamProject, isolatedBelowProject,
  belowStreamEligible, belowStreamsEnabled, belowLayerExtra, belowLayerMark, BELOW_STREAMS_DEFAULT, BELOW_STREAM_RULES, streamEligible, SEGMENT_FRAMES,
} from '../frame-stream.mjs';
import { cardStreamIdentity, BELOW_STREAM_VERSION } from '../card-identity.mjs';
import { CardFrameCache } from '../card-cache.mjs';
import { frameIdentity } from '../frame-identity.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { splitPlan, planTaskOf, clipsPlanTaskOf, SPARSE_STREAM_PRIORITY } from '../render-node/split.mjs';
import { listPlanOverrides } from '../render-node/local-node.mjs';
import { checkClaimable } from '../render-node/filter.mjs';
import { layerMapOf, layerStreamsOf } from '../artifact-transfer.mjs';
import { localMediaGate } from '../queue-local-media.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';
import { streamInputSig, streamInputs, belowLayersOf, streamSigStale } from '../../src/render/streamInputSig.mjs';

/* ------------------------------------------------------------------ Scenario */

const FP = '0123456789abcdef';
const BROWSER = 'fedcba9876543210';
const CV = 'cv-below';
const UNUSED_ROOT = path.join(os.tmpdir(), 'pc-below-unused');   // plan() does not touch the disk

/**
 * Card definition stubs. Whether it is below-dependent is not determined by what is written here,
 * but by the review table (`src/cards/capabilities.json`):
 *   `odometer` is registered as "below-dependent", and `caption-track` is "standalone";
 *   `user-glass` and `direct-unknown` are not registered → "unknown";
 *   `legacy-ctx` is not registered; the source code uses the legacy umbrella term `context`.
 */
const DEFS = {
  odometer: { id: 'odometer', frameMode: 'stateful', defaults: {} },
  'caption-track': { id: 'caption-track', frameMode: 'stateful', defaults: {} },
  'user-glass': { id: 'user-glass', frameMode: 'stateful', defaults: {} },
  'legacy-ctx': { id: 'legacy-ctx', frameMode: 'stateful', compositing: 'context', defaults: {} },
  'direct-unknown': { id: 'direct-unknown', frameMode: 'direct', defaults: {} },
};
const getCard = id => DEFS[id];
const SOURCE_VERSIONS = Object.fromEntries(Object.keys(DEFS).map(id => [id, `builtin:${id}-v1`]));

/**
 * From top to bottom:
 *   t-top    top    standalone card, 0-6 seconds: **above** the target card
 *   t-glass  glass  frosted glass (below-dependent), 1-4 seconds: target card, pinned to the
 *                   top-left of the frame
 *   t-mid    mid    standalone card, 0-5 seconds: lower layer (animated card)
 *   t-late   late   standalone card, 6-7 seconds: below, but does not overlap in time
 *   t-low    vid    video, 0-8 seconds: lower layer (asset)
 *   t-audio  bgm    audio only, 0-8 seconds: not rendered
 */
const project = () => ({
  id: 'below-p', width: 1280, height: 720, fps: 30, duration: 8, themeId: 'dark', style: {},
  media: [
    { id: 'm1', kind: 'video', hash: 'h1', url: '/@media/h1' },
    { id: 'm2', kind: 'image', hash: 'h2', url: '/@media/h2' },
    { id: 'm3', kind: 'audio', hash: 'h3', url: '/@media/h3' },
  ],
  filters: [{ id: 'f1', name: 'warm', ops: [{ op: 'brightness', value: 1.1 }] }],
  pixelMaps: [{ id: 'pm1', name: 'key', where: 'g > 0.5', to: 'transparent', source: { stage: 'origin' } }],
  cardNodes: [],
  tracks: [
    { id: 't-top', clips: [{ id: 'top', cardId: 'caption-track', start: 0, end: 6, params: { text: 'top' } }] },
    { id: 't-glass', clips: [{ id: 'glass', cardId: 'odometer', start: 1, end: 4, params: { value: 42 }, frame: { x: 100, y: 100, w: 600, h: 300 }, opacity: 1 }] },
    { id: 't-mid', clips: [{ id: 'mid', cardId: 'caption-track', start: 0, end: 5, params: { text: 'mid' } }] },
    { id: 't-late', clips: [{ id: 'late', cardId: 'caption-track', start: 6, end: 7, params: { text: 'late' } }] },
    { id: 't-low', clips: [{ id: 'vid', mediaId: 'm1', start: 0, end: 8, mediaOffset: 0, params: {} }] },
    { id: 't-audio', clips: [{ id: 'bgm', mediaId: 'm3', start: 0, end: 8, params: {} }] },
  ],
});
const edit = fn => { const p = structuredClone(project()); fn(p); return p; };
const clipOf = (p, id) => p.tracks.flatMap(t => t.clips).find(c => c.id === id);
const trackOf = (p, id) => p.tracks.find(t => t.id === id);

/**
 * One version of this project: real card graph → real card plan. `unknown` denotes clips whose
 * definitions the prerender room does not recognize (`unknownClipIds` in `__pcCardPlan`).
 */
function entryOf(p, { unknown = [] } = {}) {
  const graph = projectCardGraph(p, getCard);
  const cardPlan = new CardFrameCache({ root: UNUSED_ROOT, project: p, envFingerprint: FP }).plan({
    graph, sourceVersions: SOURCE_VERSIONS, unknownClipIds: unknown,
    environment: { width: p.width, height: p.height, fps: p.fps, theme: p.themeId, fontFingerprint: 'fonts-1' },
  });
  return { key: frameIdentity(p, 'code-1'), project: p, cardPlan };
}
const plan = (p, options = {}) => planStreams(entryOf(p), { envFingerprint: FP, codeVersion: CV, below: true, ...options });
const belowOf = (p, clipId = 'glass', options = {}) => plan(p, options).find(s => s.kind === 'below' && s.topClipId === clipId) ?? null;
const keyOf = (p, clipId = 'glass') => belowOf(p, clipId)?.contentKey ?? null;
const sigOf = (p, clipId = 'glass') => streamInputSig(p, { clipIds: [clipId], kind: 'below' });

/* ================================================================== Switches */

test('BL-off on by default: the constant is true, and the stream is produced when the environment variable is unset; it is turned off only when 0 (or `below: false`) is given explicitly, and when off there is no such stream and other streams stay exactly the same', () => {
  assert.equal(BELOW_STREAMS_DEFAULT, true);
  assert.equal(belowStreamsEnabled({}), true);
  assert.equal(belowStreamsEnabled({ PROMPTCUT_TEST_BELOW_STREAMS: '1' }), true);
  assert.equal(belowStreamsEnabled({ PROMPTCUT_TEST_BELOW_STREAMS: 'false' }), true, 'Only 0 is recognized');
  assert.equal(belowStreamsEnabled({ PROMPTCUT_TEST_BELOW_STREAMS: '0' }), false);
  const saved = process.env.PROMPTCUT_TEST_BELOW_STREAMS;
  delete process.env.PROMPTCUT_TEST_BELOW_STREAMS;
  try {
    const entry = entryOf(project());
    const byDefault = planStreams(entry, { envFingerprint: FP, codeVersion: CV });
    const on = planStreams(entry, { envFingerprint: FP, codeVersion: CV, below: true });
    const off = planStreams(entry, { envFingerprint: FP, codeVersion: CV, below: false });
    assert.deepEqual(byDefault, on, 'Omitting it means on');
    assert.deepEqual(off.map(s => `${s.kind}:${s.clipIds}`).sort(), ['card:late', 'card:mid', 'card:top'], 'Off: only single-card streams of independent cards');
    // When enabled: the original streams remain completely unchanged, except that the below-dependent
    // stream is appended at the end
    assert.deepEqual(on.slice(0, off.length), off, 'The keys, shapes and order of single-card streams are unchanged');
    assert.deepEqual(on.slice(off.length).map(s => `${s.kind}:${s.clipIds}`), ['below:glass']);
    // The manifest plan path (manifest sent by online pages): this stream is included in the plan;
    // whether the splitter's own copy is output is determined by `listPlanOverrides` based on whether
    // this machine can produce streams (`BL-list`), and the browser copy is never output
    assert.deepEqual(planListStreams(entry, ['glass', 'mid'], { envFingerprint: FP, codeVersion: CV }).map(s => s.kind), ['card', 'below']);
    assert.deepEqual(planListStreams(entry, ['glass', 'mid'], { envFingerprint: FP, codeVersion: CV, below: false }).map(s => s.kind), ['card']);
    // The environment variable method for disabling it
    process.env.PROMPTCUT_TEST_BELOW_STREAMS = '0';
    assert.deepEqual(planStreams(entry, { envFingerprint: FP, codeVersion: CV }), off);
  } finally {
    if (saved === undefined) delete process.env.PROMPTCUT_TEST_BELOW_STREAMS; else process.env.PROMPTCUT_TEST_BELOW_STREAMS = saved;
  }
});

test('BL-layer the layer table sent to the page: a below-dependent stream carries `streamKind: below` and the input signature of this version of the project; other streams carry nothing extra', () => {
  const p = project();
  const specs = plan(p);
  const below = specs.find(s => s.kind === 'below');
  assert.equal(below.inputSig, sigOf(p), 'The signature recorded in the plan is the one the page computes from the same project');
  assert.match(below.inputSig, /^s1-/);
  assert.deepEqual(belowLayerMark(below, 'glass'), { streamKind: 'below', inputSig: sigOf(p) });
  // Aliases (another card with the same key) have no signature of their own: they only carry the
  // kind, and the page does not compare them
  assert.deepEqual(belowLayerMark(below, 'someone-else'), { streamKind: 'below' });
  for (const spec of specs.filter(s => s.kind !== 'below')) {
    assert.equal('inputSig' in spec, false);
    assert.deepEqual(belowLayerMark(spec, spec.topClipId), {});
  }
  assert.deepEqual(belowLayerMark(null, 'glass'), {});
});

test('BL-3d a card that is below-dependent (or unreviewed) and also has a 3D frame: produces a normal below-dependent stream (stage coordinates, the 3D drawn into the stream); changing the 3D angle or the project\'s perspective changes both the key and the input signature; the layer table sent still carries the kind and signature', () => {
  const tilt = (frame, more = () => {}) => edit((x) => { clipOf(x, 'glass').frame = { x: 100, y: 100, w: 600, h: 300, ...frame }; x.camera3dFov = 50; more(x); });
  const p = tilt({ rotateY: 20, rotateX: -8, translateZ: -40 });
  const flat = edit((x) => { x.camera3dFov = 50; });
  const spec = belowOf(p);
  assert.ok(spec, 'Produces a below-dependent stream');
  assert.deepEqual([spec.kind, spec.plane, spec.clipIds, spec.offset, spec.bound], ['below', 'stage', ['glass'], { x: 0, y: 0 }, { x: 0, y: 0, w: 1280, h: 720 }], 'The shape is the same as the flat kind: the whole frame, stage coordinates');
  assert.deepEqual(spec.belowClipIds, belowOf(flat).belowClipIds, 'The identification of lower layers is not affected by 3D');
  assert.equal('solo' in spec, false);
  // Consumes decoder budget and does not participate in group stream merging: keys and shapes of
  // other streams are not affected by whether it includes 3D
  assert.deepEqual(plan(p).filter(s => s.kind !== 'below'), plan(flat).filter(s => s.kind !== 'below'));
  assert.equal(plan(p).filter(s => s.topClipId === 'glass').length, 1, 'Only this one; no separate single-card stream is produced');
  // Keys and signatures: every 3D property and project perspective are included
  assert.notEqual(keyOf(p), keyOf(flat)); assert.notEqual(sigOf(p), sigOf(flat));
  for (const [name, other] of [['rotateY', tilt({ rotateY: 21, rotateX: -8, translateZ: -40 })], ['rotateX', tilt({ rotateY: 20, rotateX: -9, translateZ: -40 })],
    ['translateZ', tilt({ rotateY: 20, rotateX: -8, translateZ: -41 })], ['camera3dFov', tilt({ rotateY: 20, rotateX: -8, translateZ: -40 }, (x) => { x.camera3dFov = 60; })]]) {
    assert.notEqual(keyOf(other), keyOf(p), `Changing ${name}: the stream key changes`);
    assert.notEqual(sigOf(other), sigOf(p), `Changing ${name}: the input signature changes`);
    assert.equal(streamSigStale(belowOf(p).inputSig, sigOf(other)), true, `Changing ${name}: the signature carried by the old stream no longer matches, so the page no longer applies it`);
  }
  assert.equal(keyOf(tilt({ rotateY: 20, rotateX: -8, translateZ: -40 })), keyOf(p), 'The same input gives the same key');
  // Remains unchanged no matter how layers above are modified (the same-plane variant)
  assert.equal(keyOf(tilt({ rotateY: 20, rotateX: -8, translateZ: -40 }, (x) => { clipOf(x, 'top').params.text = 'changed'; })), keyOf(p));
  // Emit layer
  assert.equal(spec.inputSig, sigOf(p));
  assert.deepEqual(belowLayerMark(spec, 'glass'), { streamKind: 'below', inputSig: sigOf(p) });
  // Isolated project: the target card's box is kept as-is (all 3D properties are preserved),
  // unlike standalone 3D cards that form their own stream, which keep only position, width, and height
  assert.deepEqual(clipOf(isolatedStreamProject(p, spec), 'glass').frame, clipOf(p, 'glass').frame);
  // The same applies to unreviewed (unknown) user cards with 3D; standalone cards with 3D frames
  // do not take this path (they form their own stream containing the image before transformation)
  const user = edit((x) => { x.camera3dFov = 50; clipOf(x, 'glass').cardId = 'user-glass'; clipOf(x, 'glass').frame = { x: 100, y: 100, w: 600, h: 300, rotateX: 15 }; });
  assert.equal(belowOf(user)?.plane, 'stage');
  const indep = edit((x) => { clipOf(x, 'mid').frame = { x: 0, y: 0, w: 400, h: 200, rotateY: 30 }; });
  assert.deepEqual(plan(indep).filter(s => s.topClipId === 'mid').map(s => [s.kind, s.plane, s.solo]), [['card', 'local', 'spatial']]);
});

/* ================================================================== Which cards enter */

test('BL-eligible cards that are below-dependent, use the old umbrella term context, or are unknown are included (those with a 3D frame are included too); independent cards are not included (flat ones go through the single-card stream, those with 3D become their own stream); source-dependent cards are excluded by default and included once one rule is relaxed', () => {
  const track = { hidden: false };
  const clip = { id: 'a', cardId: 'x' };
  const ctl = (compositing, extra = {}) => ({ clipId: 'a', count: 30, capabilities: compositing === undefined ? {} : { compositing }, ...extra });
  for (const c of ['belowDependent', 'context', 'unknown', undefined, 'no-such-value']) {
    assert.equal(belowStreamEligible(ctl(c), clip, track), true, `${c} included`);
    assert.equal(streamEligible(ctl(c), clip, track), false, `${c} is not in the single-card stream`);
  }
  assert.equal(belowStreamEligible({ clipId: 'a', count: 30, compositing: 'belowDependent' }, clip, track), true, 'Old shape: compositing at the top level');
  assert.equal(belowStreamEligible(ctl('independent'), clip, track), false, 'A flat independent card goes through the single-card stream');
  assert.equal(streamEligible(ctl('independent'), clip, track), true);
  assert.equal(belowStreamEligible(ctl('sourceDependent'), clip, track), false, 'A source-dependent card is excluded by default');
  assert.equal(belowStreamEligible(ctl('belowDependent'), { ...clip, frame: { rotateY: 20 } }, track), true, 'Below-dependent with a 3D frame is included too (the 3D is drawn into the stream)');
  assert.equal(belowStreamEligible(ctl('unknown'), { ...clip, frame: { translateZ: -80 } }, track), true, 'The same for unreviewed with a 3D frame');
  assert.equal(belowStreamEligible(ctl('independent'), { ...clip, frame: { rotateX: 10 } }, track), false, 'An independent card with a 3D frame becomes its own stream and is not included here');
  assert.equal(belowStreamEligible(ctl('belowDependent'), clip, { hidden: true }), false);
  assert.equal(belowStreamEligible(ctl('belowDependent'), clip, { sourceOnly: true }), false);
  assert.equal(belowStreamEligible(ctl('belowDependent'), { id: 'a', mediaId: 'm' }, track), false, 'A media clip is not a card');
  assert.equal(belowStreamEligible(ctl('belowDependent', { count: 0 }), clip, track), false);
  assert.equal(belowStreamEligible(null, clip, track), false);
  // Reserved extension point: to incorporate it later, only one criterion needs to be relaxed
  assert.deepEqual(BELOW_STREAM_RULES, { sourceDependent: false, frame3d: true });
  assert.equal(belowStreamEligible(ctl('sourceDependent'), clip, track, { ...BELOW_STREAM_RULES, sourceDependent: true }), true);
  const spatial = { ...clip, frame: { rotateY: 20 } };
  assert.equal(belowStreamEligible(ctl('belowDependent'), spatial, track, { ...BELOW_STREAM_RULES, frame3d: false }), false, 'Turning this option off excludes it');
  assert.equal(belowStreamEligible(ctl('independent'), spatial, track, { ...BELOW_STREAM_RULES, frame3d: true }), false, 'An independent card with a 3D frame is never included however it is set (it becomes its own stream)');
  assert.equal(belowStreamEligible(ctl('independent'), clip, track, { sourceDependent: true, frame3d: true }), false, 'A flat independent card is never included however much it is relaxed');
});

test('BL-plan for cards in the prerender set that are below-dependent, context, or unknown (including remotion-style cards that are not registered), one stream in stage coordinates each; cards not in the set produce none', () => {
  const p = edit((x) => {
    x.tracks.splice(1, 0,
      { id: 't-user', clips: [{ id: 'user', cardId: 'user-glass', start: 2, end: 3, params: {} }] },
      { id: 't-ctx', clips: [{ id: 'ctx', cardId: 'legacy-ctx', start: 2, end: 3, params: {} }] },
      { id: 't-direct', clips: [{ id: 'direct', cardId: 'direct-unknown', start: 2, end: 3, params: {} }] },
      { id: 't-3d', clips: [{ id: 'tilt', cardId: 'odometer', start: 2, end: 3, params: {}, frame: { x: 0, y: 0, w: 200, h: 100, rotateY: 30 } }] });
  });
  const specs = plan(p);
  const below = specs.filter(s => s.kind === 'below');
  assert.deepEqual(below.map(s => s.topClipId).sort(), ['ctx', 'direct', 'glass', 'tilt', 'user'], 'The one with a 3D frame is included too');
  const g = below.find(s => s.topClipId === 'glass');
  assert.equal(g.plane, 'stage');
  assert.deepEqual(g.clipIds, ['glass'], 'The only member is the target card');
  assert.deepEqual(g.offset, { x: 0, y: 0 });
  assert.deepEqual(g.bound, { x: 0, y: 0, w: 1280, h: 720 }, 'The upper bound is the whole frame; tightening is left to the pass that produces the stream');
  assert.equal(g.firstFrame, 30);
  assert.equal(g.lastFrame, 119);
  // Segments are counted from this stream's own first frame (the target card's first frame,
  // frame 30): segment 0 covers frames 30-44, and the last frame 119 is in segment 5
  assert.equal(g.originFrame, 30);
  assert.equal(g.firstSegment, 0);
  assert.equal(g.lastSegment, Math.floor((119 - 30) / SEGMENT_FRAMES));
  assert.equal(g.total, 240);
  assert.deepEqual(g.belowClipIds, ['vid', 'mid'], 'Painter\'s order, lower ones first; the non-overlapping late, the audio-only bgm and the upper top do not count');
  assert.equal(g.belowScene, false);
  assert.equal(g.hasMedia, true);
  assert.equal(g.members.length, 1);
  assert.equal(g.members[0].clipId, 'glass');
  assert.match(g.contentKey, /^[0-9a-f]{64}$/);
  assert.equal(g.streamKey, resultKeyOf(g.contentKey, FP), 'Result key = content key × environment fingerprint');
  assert.equal(g.envFingerprint, FP);
  // Only outputs items in the prerender set
  assert.deepEqual(plan(p, { picked: id => id !== 'glass' }).filter(s => s.kind === 'below').map(s => s.topClipId).sort(), ['ctx', 'direct', 'tilt', 'user']);
  // Still outputs nothing as usual when there is no environment fingerprint
  assert.deepEqual(planStreams(entryOf(p), { codeVersion: CV, below: true }), []);
  // Once the manifest plan path is enabled, outputs are also produced according to the manifest
  assert.deepEqual(planListStreams(entryOf(p), ['glass'], { envFingerprint: FP, codeVersion: CV, below: true }).map(s => `${s.kind}:${s.topClipId}`), ['below:glass']);
});

test('BL-replay replay: needed if any card clip among the target card and the lower layers is motion-style, starting from the earliest mount frame among those cards; not needed if they are all remotion-style plus plain media clips', () => {
  const g = belowOf(project());
  assert.equal(g.replay, true);
  assert.equal(g.mountFrame, 0, 'The lower layer mid is motion-style and was mounted at 0 s, so it has to be advanced from its mount frame');
  // Target card is remotion-style with only assets underneath: no playback
  const direct = edit((x) => { clipOf(x, 'glass').cardId = 'direct-unknown'; x.tracks = x.tracks.filter(t => t.id !== 't-mid'); });
  const d = belowOf(direct);
  assert.equal(d.replay, false);
  assert.equal(d.mountFrame, 29, 'Only the target card\'s own mount frame is left (50 ms before the in point)');
  assert.deepEqual(d.belowClipIds, ['vid']);
  // Target card is remotion-style with a motion-style card underneath: required
  assert.equal(belowOf(edit((x) => { clipOf(x, 'glass').cardId = 'direct-unknown'; })).replay, true);
});

/* ================================================================== Keys and input signatures */

/**
 * Modify one place at a time to check whether the stream's content key (server) and input
 * signature (page) change respectively. `both`: both sides change; `none`: neither changes.
 * "Cross-checking" means both sides react identically on each row, and with the expected outcome.
 */
const EDITS = [
  // ---- Lower layer: parameters, position, appearance, time
  ['A lower-layer card changes parameters', 'both', (p) => { clipOf(p, 'mid').params.text = 'changed'; }],
  ['A lower-layer card is moved (frame added)', 'both', (p) => { clipOf(p, 'mid').frame = { x: 5, y: 6, w: 400, h: 200 }; }],
  ['A lower-layer card changes opacity', 'both', (p) => { clipOf(p, 'mid').opacity = 0.5; }],
  ['A lower-layer card gets an emphasis', 'both', (p) => { clipOf(p, 'mid').emphasis = { shadow: { blur: 4 } }; }],
  ['A lower-layer card\'s in point moves earlier (time)', 'both', (p) => { clipOf(p, 'mid').start = 0.5; }],
  ['A lower-layer card\'s out point changes (duration)', 'both', (p) => { clipOf(p, 'mid').end = 4.5; }],
  ['A lower-layer card is shifted by one second as a whole', 'both', (p) => { const c = clipOf(p, 'mid'); c.start += 1; c.end += 1; }],
  ['Lower-layer media changes its offset', 'both', (p) => { clipOf(p, 'vid').mediaOffset = 1; }],
  ['Lower-layer media is swapped for another', 'both', (p) => { clipOf(p, 'vid').mediaId = 'm2'; }],
  ['Lower-layer media gets a fade-in', 'both', (p) => { clipOf(p, 'vid').fadeIn = 0.3; }],
  ['Lower-layer media is moved', 'both', (p) => { clipOf(p, 'vid').frame = { x: 0, y: 0, w: 640, h: 360 }; }],
  ['Lower-layer media gets a filter attached', 'both', (p) => { clipOf(p, 'vid').filter = { id: 'f1', params: {} }; }],
  ['Lower-layer media gets a pixel map attached', 'both', (p) => { clipOf(p, 'vid').pixelMap = { id: 'pm1' }; }],
  ['The lower-layer media itself changed (hash)', 'both', (p) => { p.media.find(m => m.id === 'm1').hash = 'h1-new'; }],
  // ---- Lower layer: order, adding a layer, removing a layer
  ['Two lower layers swap their stacking order', 'both', (p) => { const i = p.tracks.findIndex(t => t.id === 't-mid'), j = p.tracks.findIndex(t => t.id === 't-low'); [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]]; }],
  ['One more layer below (card)', 'both', (p) => { p.tracks.push({ id: 't-new', clips: [{ id: 'new', cardId: 'caption-track', start: 2, end: 3, params: {} }] }); }],
  ['One more layer below (media)', 'both', (p) => { p.tracks.push({ id: 't-new', clips: [{ id: 'img', mediaId: 'm2', start: 0, end: 8, params: {} }] }); }],
  ['One fewer layer below (deleted)', 'both', (p) => { p.tracks = p.tracks.filter(t => t.id !== 't-low'); }],
  ['One fewer layer below (track hidden)', 'both', (p) => { trackOf(p, 't-mid').hidden = true; }],
  ['A lower layer that did not overlap before is moved into this time range', 'both', (p) => { const c = clipOf(p, 'late'); c.start = 3; c.end = 3.5; }],
  ['An overlapping lower layer is moved out of this time range', 'both', (p) => { const c = clipOf(p, 'mid'); c.start = 5; c.end = 6; }],
  ['An upper layer is moved below', 'both', (p) => { const [top] = p.tracks.splice(0, 1); p.tracks.push(top); }],
  // ---- Target card itself
  ['The target card changes parameters', 'both', (p) => { clipOf(p, 'glass').params.value = 43; }],
  ['The target card is moved', 'both', (p) => { clipOf(p, 'glass').frame.x = 300; }],
  ['The target card is scaled and rotated', 'both', (p) => { Object.assign(clipOf(p, 'glass').frame, { scale: 1.5, rotate: 10 }); }],
  ['The target card changes opacity', 'both', (p) => { clipOf(p, 'glass').opacity = 0.6; }],
  ['The target card gets a fade-out', 'both', (p) => { clipOf(p, 'glass').fadeOut = 0.4; }],
  ['The target card gets a motion path', 'both', (p) => { clipOf(p, 'glass').motion = { mediaId: 'm1', pointIndex: 0, offsets: [[0, 0], [3, 4]], visible: [true, true], frameStep: 1 / 30, whenHidden: 'hold' }; }],
  ['The target card\'s in point moves by one frame', 'both', (p) => { clipOf(p, 'glass').start = 1 + 1 / 30; }],
  // ---- Layers above: remain unchanged regardless of modifications
  ['An upper layer changes parameters', 'none', (p) => { clipOf(p, 'top').params.text = 'changed'; }],
  ['An upper layer is moved and changes opacity', 'none', (p) => { const c = clipOf(p, 'top'); c.frame = { x: 9, y: 9, w: 100, h: 100 }; c.opacity = 0.3; }],
  ['An upper layer changes timing', 'none', (p) => { const c = clipOf(p, 'top'); c.start = 2; c.end = 3; }],
  ['An upper layer is deleted', 'none', (p) => { p.tracks = p.tracks.filter(t => t.id !== 't-top'); }],
  ['One more layer added above', 'none', (p) => { p.tracks.unshift({ id: 't-over', clips: [{ id: 'over', cardId: 'odometer', start: 0, end: 8, params: {} }] }); }],
  ['A media layer added above', 'none', (p) => { p.tracks.unshift({ id: 't-over', clips: [{ id: 'cover', mediaId: 'm2', start: 0, end: 8, params: {} }] }); }],
  ['A clip that comes after the target card in the same track', 'none', (p) => { trackOf(p, 't-glass').clips.push({ id: 'after', cardId: 'caption-track', start: 4, end: 5, params: {} }); }],
  // ---- Unrelated
  ['A lower layer that does not overlap in time changes parameters', 'none', (p) => { clipOf(p, 'late').params.text = 'changed'; }],
  ['An audio-only clip changes its offset', 'none', (p) => { clipOf(p, 'bgm').mediaOffset = 2; }],
  ['Volume, mute', 'none', (p) => { clipOf(p, 'vid').audioMuted = true; clipOf(p, 'vid').audioVolume = 0.2; }],
];

test('BL-key if any lower layer changes its parameters, position, timing or order, or a layer is added or removed, both the stream key and the input signature change; no change to an upper layer affects them; changing the target card\'s appearance changes the key; both sides react the same way', () => {
  const base = project();
  const key0 = keyOf(base), sig0 = sigOf(base);
  assert.match(key0, /^[0-9a-f]{64}$/);
  assert.match(sig0, /^s1-[0-9a-f]{16}$/);
  assert.equal(keyOf(structuredClone(base)), key0, 'Computing the same project twice gives the same result');
  assert.equal(sigOf(JSON.parse(JSON.stringify(base))), sig0);
  for (const [what, expect, mutate] of EDITS) {
    const p = edit(mutate);
    const key = keyOf(p), sig = sigOf(p);
    assert.ok(key && sig, `${what}: the stream is still there`);
    const keyChanged = key !== key0, sigChanged = sig !== sig0;
    assert.equal(keyChanged, sigChanged, `${what}: server key ${keyChanged ? 'changed' : 'unchanged'}, page input signature ${sigChanged ? 'changed' : 'unchanged'}`);
    assert.equal(keyChanged, expect === 'both', `${what}: should ${expect === 'both' ? 'changed' : 'stay the same'}`);
  }
  // Reverting the change restores the original key (keys only recognize content, not edit history)
  assert.equal(keyOf(edit((p) => { clipOf(p, 'mid').params.text = 'changed'; clipOf(p, 'mid').params.text = 'mid'; })), key0);
});

test('BL-key-pixelmap the pixel map of lower-layer media: the cache content key does not cover it, so an extra item is added to the key; changing its definition, or the media referenced in its definition, changes the key too', () => {
  const withMap = edit((p) => { clipOf(p, 'vid').pixelMap = { id: 'pm1' }; });
  const vidKey = p => entryOf(p).cardPlan.find(c => c.clipId === 'vid').cacheContentKey;
  assert.equal(vidKey(withMap), vidKey(project()), 'The card graph has no pixel map: this layer\'s own cache content key does not change (hence the extra item)');
  const key0 = keyOf(withMap), sig0 = sigOf(withMap);
  assert.notEqual(key0, keyOf(project()));
  const redef = edit((p) => { clipOf(p, 'vid').pixelMap = { id: 'pm1' }; p.pixelMaps[0].where = 'g > 0.8'; });
  assert.notEqual(keyOf(redef), key0, 'Changing the definition: the key changes');
  assert.notEqual(sigOf(redef), sig0, 'Changing the definition: the input signature changes');
  // Another asset was referenced in the definition, and that asset changed: the server-side key
  // recognizes it
  const toMedia = (hash) => edit((p) => { clipOf(p, 'vid').pixelMap = { id: 'pm1' }; p.pixelMaps[0].to = { kind: 'media', mediaId: 'm2', stage: 'origin' }; p.media.find(m => m.id === 'm2').hash = hash; });
  assert.notEqual(keyOf(toMedia('h2')), keyOf(toMedia('h2-new')));
  assert.equal(belowLayerExtra(project(), clipOf(project(), 'vid')), undefined, 'No pixel map attached: this item is not carried');
  const extra = belowLayerExtra(toMedia('h2'), clipOf(toMedia('h2'), 'vid'));
  assert.deepEqual(extra.pixelMap, { id: 'pm1' });
  assert.deepEqual(extra.media, [['m2', 'h2']]);
  assert.deepEqual(belowLayerExtra({ pixelMaps: [], media: [] }, { pixelMap: { id: 'gone' } }), { pixelMap: { id: 'gone' }, def: null, media: [] });
});

test('BL-key-other the key also carries: aspect ratio, frame rate, code version, environment (result key only), and the card source version of every layer; the version number of what the stream holds is in the digest', () => {
  const base = project();
  const g = belowOf(base);
  assert.notEqual(belowOf(base, 'glass', { codeVersion: 'cv-2' }).contentKey, g.contentKey, 'The production code changed, so the old stream is voided');
  assert.notEqual(keyOf(edit((p) => { p.width = 1920; p.height = 1080; })), g.contentKey, 'Aspect ratio');
  assert.notEqual(keyOf(edit((p) => { p.camera3dFov = 40; })), g.contentKey, '3D perspective');
  const other = planStreams(entryOf(base), { envFingerprint: BROWSER, codeVersion: CV, below: true }).find(s => s.kind === 'below');
  assert.equal(other.contentKey, g.contentKey, 'The content key is independent of the environment');
  assert.notEqual(other.streamKey, g.streamKey, 'The result key is separate per environment');
  // The source code of the lower-layer card changed (the page's input signature cannot track this;
  // relies on the render node changing keys to rewrite the layer table)
  const entry = entryOf(base);
  const graph = projectCardGraph(base, getCard);
  const replan = new CardFrameCache({ root: UNUSED_ROOT, project: base, envFingerprint: FP }).plan({ graph, sourceVersions: { ...SOURCE_VERSIONS, 'caption-track': 'builtin:caption-track-v2' },
    environment: { width: base.width, height: base.height, fps: base.fps, theme: base.themeId, fontFingerprint: 'fonts-1' } });
  const resourced = planStreams({ ...entry, cardPlan: replan }, { envFingerprint: FP, codeVersion: CV, below: true }).find(s => s.kind === 'below');
  assert.notEqual(resourced.contentKey, g.contentKey, 'A lower-layer card\'s source code changed: the key changes');
  // Digest composition: version number, kind, one item for the target card, a list for lower layers
  const sampling = { firstFrame: 30, phase: { numerator: '0', denominator: '1' } };
  const id = (over = {}) => cardStreamIdentity({ kind: 'below', fps: 30, stage: { width: 1280, height: 720 }, codeVersion: 'c',
    members: [{ key: 'T', sampling, count: 90 }], below: { layers: [{ key: 'L1', sampling, count: 10 }, { key: 'L2', sampling, count: 20 }] }, ...over });
  assert.equal(typeof BELOW_STREAM_VERSION, 'number');
  assert.match(id(), /^[0-9a-f]{64}$/);
  assert.notEqual(id(), id({ below: { layers: [{ key: 'L2', sampling, count: 20 }, { key: 'L1', sampling, count: 10 }] } }), 'The order of lower layers goes into the key');
  assert.notEqual(id(), id({ below: { layers: [{ key: 'L1', sampling, count: 10 }] } }), 'One layer fewer');
  assert.notEqual(id(), id({ below: { layers: [{ key: 'L1', sampling, count: 11 }, { key: 'L2', sampling, count: 20 }] } }), 'The frame count of a lower layer');
  assert.notEqual(id(), id({ below: { layers: [{ key: 'L1', sampling: { ...sampling, firstFrame: 31 }, count: 10 }, { key: 'L2', sampling, count: 20 }] } }), 'The first frame of a lower layer');
  assert.notEqual(id(), id({ below: { layers: [{ key: 'L1', sampling, count: 10, extra: { pixelMap: { id: 'x' } } }, { key: 'L2', sampling, count: 20 }] } }), 'The extra item added for a lower layer');
  assert.notEqual(id({ below: { layers: [] } }), id({ below: { scene: 'E' } }), 'Having no lower layers is not the same as falling back to the whole-project key');
  assert.notEqual(id(), cardStreamIdentity({ kind: 'group', fps: 30, stage: { width: 1280, height: 720 }, codeVersion: 'c', members: [{ key: 'T', sampling, count: 90 }] }), 'Never equal to the key of a group stream');
  assert.throws(() => id({ members: [] }), /only the target card/);
  assert.throws(() => id({ members: [{ key: 'T' }, { key: 'U' }] }), /only the target card/);
  assert.throws(() => id({ below: null }), /keys of the lower layers/);
  assert.throws(() => id({ below: { layers: [{ key: '' }] } }), /one layer has no key/);
  assert.throws(() => id({ below: { layers: [{}] } }), /one layer has no key/);
  assert.throws(() => id({ below: { scene: '' } }), /the key for the whole project is invalid/);
  assert.throws(() => id({ members: [{ key: undefined }] }), /one layer has no key/);
  // The digests of the other two kinds of streams are unaffected by the new parameter
  const card = over => cardStreamIdentity({ kind: 'card', fps: 30, stage: { width: 1280, height: 720 }, codeVersion: 'c', members: [{ key: 'T', sampling, count: 90 }], ...over });
  assert.equal(card(), card({ below: { layers: [{ key: 'L1' }] } }), 'A single-card stream ignores below');
  assert.throws(() => cardStreamIdentity({ kind: 'nope', members: [{ key: 'T' }] }), /Unknown stream kind/);
});

test('BL-key-scene when the key of some lower layer cannot be computed: fall back to the whole-project key (coarser, never wrong); if even that is missing, this stream is not produced', () => {
  const base = project();
  // The prerender room does not recognize mid's definition: it is not in the card plan
  const entry = entryOf(base, { unknown: ['mid'] });
  assert.equal(entry.cardPlan.some(c => c.clipId === 'mid'), false);
  const spec = planStreams(entry, { envFingerprint: FP, codeVersion: CV, below: true }).find(s => s.kind === 'below');
  assert.equal(spec.belowScene, true);
  assert.deepEqual(spec.belowClipIds, ['vid', 'mid'], 'Lower layers are still listed in full');
  assert.equal(spec.replay, true, 'A layer not found in the plan is treated as stateful');
  assert.notEqual(spec.contentKey, keyOf(base), 'Not the same as the key produced per layer');
  // If the whole project's key changes (even if modifying layers above), this stream is invalidated
  const upper = edit((p) => { clipOf(p, 'top').params.text = 'changed'; });
  const again = planStreams(entryOf(upper, { unknown: ['mid'] }), { envFingerprint: FP, codeVersion: CV, below: true }).find(s => s.kind === 'below');
  assert.notEqual(again.contentKey, spec.contentKey);
  // Same project, same whole-project key: identical
  assert.equal(planStreams(entryOf(base, { unknown: ['mid'] }), { envFingerprint: FP, codeVersion: CV, below: true }).find(s => s.kind === 'below').contentKey, spec.contentKey);
  // No whole-project key to fall back to: this stream is not output (this card follows the old way
  // without streams)
  assert.deepEqual(planStreams({ ...entry, key: undefined }, { envFingerprint: FP, codeVersion: CV, below: true }).filter(s => s.kind === 'below'), []);
  // Target card itself is classified as unrecognized: it is not in the card plan, so naturally not
  // output
  assert.deepEqual(planStreams(entryOf(base, { unknown: ['glass'] }), { envFingerprint: FP, codeVersion: CV, below: true }).filter(s => s.kind === 'below'), []);
});

test('BL-layers `belowLayersOf`: the single identification shared by the server computing the key, the page computing the signature, and the isolated project', () => {
  const p = project();
  const found = belowLayersOf(p, 'glass');
  assert.deepEqual(found.below.map(l => l.id), ['vid', 'mid']);
  assert.ok(found.below[0].order < found.below[1].order && found.below[1].order < found.order);
  assert.equal(belowLayersOf(p, 'nope'), null);
  assert.equal(belowLayersOf(edit((x) => { trackOf(x, 't-glass').hidden = true; }), 'glass'), null, 'The target card itself is not drawn');
  assert.deepEqual(belowLayersOf(p, 'vid').below, [], 'The bottom layer has no lower layer');
  // Besides clips that meet end-to-end in time not counting as overlapping: relaxed by a mount lead
  // time, erring on the side of inclusion
  const touching = edit((x) => { const c = clipOf(x, 'late'); c.start = 4.02; c.end = 5; });
  assert.deepEqual(belowLayersOf(touching, 'glass').below.map(l => l.id), ['vid', 'late', 'mid']);
  const apart = edit((x) => { const c = clipOf(x, 'late'); c.start = 4.2; c.end = 5; });
  assert.deepEqual(belowLayersOf(apart, 'glass').below.map(l => l.id), ['vid', 'mid']);
  // Clips with non-positive duration are not rendered
  assert.deepEqual(belowLayersOf(edit((x) => { clipOf(x, 'mid').end = 0; }), 'glass').below.map(l => l.id), ['vid']);
  // Within the same track: items ordered earlier are below, items ordered later are on top
  const sameTrack = edit((x) => { trackOf(x, 't-glass').clips = [{ id: 'pre', cardId: 'caption-track', start: 0, end: 1.02, params: {} }, ...trackOf(x, 't-glass').clips, { id: 'post', cardId: 'caption-track', start: 3.98, end: 5, params: {} }]; });
  assert.deepEqual(belowLayersOf(sameTrack, 'glass').below.map(l => l.id), ['vid', 'mid', 'pre']);
  // The page's signature input is exactly this list
  const inputs = streamInputs(p, { clipIds: ['glass'], kind: 'below' });
  assert.equal(inputs.kind, 'below');
  assert.deepEqual(inputs.members.map(m => m.id), ['glass']);
  assert.deepEqual(inputs.below.map(m => m.id), ['vid', 'mid']);
  assert.deepEqual(inputs.members[0].frame, { x: 100, y: 100, w: 600, h: 300 }, 'The target card\'s appearance is included');
  assert.deepEqual(inputs.below[1].window, { firstFrame: 0, count: 150, last: 149 });
});

/* ================================================================== Group streams and decoder budget */

const CAPS = { compositing: 'independent', frameMode: 'stateful' };
const GLASS = { compositing: 'belowDependent', frameMode: 'stateful' };
const control = (clipId, start, end, caps = CAPS) => ({
  clipId, key: `K-${clipId}`, snapshotKey: `S-${clipId}`, capabilities: caps, compositing: caps.compositing, frameMode: caps.frameMode,
  start, end, count: Math.ceil((end - start) * 30), sampling: { firstFrame: Math.ceil(start * 30), fps: { numerator: '30', denominator: '1' }, phase: { numerator: '0', denominator: '1' } },
});
const small = (tracks) => ({ width: 1920, height: 1080, fps: 30, duration: 8, media: [], tracks });
const shape = specs => specs.map(s => `${s.kind}:${s.clipIds.join('+')}`).sort();

test('BL-budget a below-dependent stream does not take part in group stream merging, but it uses the decoder budget: when it pushes the budget over, the independent cards next to it are merged', () => {
  const p = small([
    { id: 't1', clips: [{ id: 'a', cardId: 'x', start: 0, end: 4 }] },
    { id: 't2', clips: [{ id: 'b', cardId: 'y', start: 0, end: 4 }] },
    { id: 't3', clips: [{ id: 'g', cardId: 'glass', start: 0, end: 4 }] },
  ]);
  const entry = { key: 'E', project: p, cardPlan: [control('a', 0, 4), control('b', 0, 4), control('g', 0, 4, GLASS)] };
  const run = (options) => planStreams(entry, { envFingerprint: FP, ...options });
  assert.deepEqual(shape(run({ budget: 2, below: false })), ['card:a', 'card:b'], 'Off: two single-card streams fit exactly within the budget');
  assert.deepEqual(shape(run({ budget: 2, below: true })), ['below:g', 'group:b+a'], 'On: there is one more stream using budget, and the two independent cards are merged into a group stream');
  assert.deepEqual(shape(run({ budget: 3, below: true })), ['below:g', 'card:a', 'card:b'], 'No merging when the budget is enough');
  assert.deepEqual(shape(run({ budget: 1, below: true })), ['below:g', 'group:b+a'], 'However the budget is squeezed, a below-dependent stream never joins a group');
  for (const spec of run({ budget: 1, below: true })) if (spec.kind === 'group') assert.ok(!spec.clipIds.includes('g'));
  // Sandwiched between two standalone cards: it is already a layer, blocking those two cards from
  // merging as usual
  const mid = small([
    { id: 't1', clips: [{ id: 'a', cardId: 'x', start: 0, end: 4 }] },
    { id: 't2', clips: [{ id: 'g', cardId: 'glass', start: 0, end: 4 }] },
    { id: 't3', clips: [{ id: 'b', cardId: 'y', start: 0, end: 4 }] },
  ]);
  const midEntry = { key: 'E', project: mid, cardPlan: entry.cardPlan };
  assert.deepEqual(shape(planStreams(midEntry, { envFingerprint: FP, budget: 1, below: true })), ['below:g', 'card:a', 'card:b']);
  assert.deepEqual(shape(planStreams(midEntry, { envFingerprint: FP, budget: 1, below: false })), ['card:a', 'card:b'], 'Even when off, they cannot be merged (a layer lies in between)');
});

test('BL-budget-frames `groupStreams` fixed: counted into the peak only, never merged; when every stream on the peak frame cannot be merged, move to another over-budget frame to merge', () => {
  assert.deepEqual(peakConcurrency([{ from: 0, to: 9 }, { from: 5, to: 20 }]), { peak: 2, at: 5 });
  assert.deepEqual(peakConcurrency([{ from: 0, to: 9 }, { from: 5, to: 20 }], new Set([5])), { peak: 1, at: 0 }, 'Peak after skipping frame 5');
  assert.deepEqual(peakConcurrency([{ from: 0, to: 9 }], new Set()), { peak: 1, at: 0 });
  const layers = [
    { clipId: 'a', order: 1, from: 60, to: 99 },
    { clipId: 'b', order: 2, from: 60, to: 99 },
  ];
  const streams = layers.map(l => ({ clipIds: [l.clipId], order: l.order, from: l.from, to: l.to }));
  // Frames 0-29 are crowded with three non-mergeable streams (peak 3), and frames 60-99 have two
  // cards plus one non-mergeable stream (also 3)
  const fixed = [{ from: 0, to: 29 }, { from: 0, to: 29 }, { from: 0, to: 29 }, { from: 60, to: 99 }];
  assert.deepEqual(groupStreams(streams, layers, 2, fixed).map(s => s.clipIds), [['a', 'b']], 'Frame 0 cannot be merged, so merge at frame 60 instead');
  assert.deepEqual(groupStreams(streams, layers, 2).map(s => s.clipIds), [['a'], ['b']], 'Without fixed: same as before');
  assert.deepEqual(groupStreams(streams, layers, 2, []).map(s => s.clipIds), [['a'], ['b']]);
  assert.deepEqual(groupStreams(streams, layers, 3, fixed).map(s => s.clipIds), [['a'], ['b']], 'No merging when not over budget');
  // All non-mergeable streams: stops when unable to merge without infinite looping; they are not in
  // the result
  assert.deepEqual(groupStreams([], [], 1, fixed), []);
  assert.deepEqual(groupStreams([streams[0]], layers, 1, fixed).map(s => s.clipIds), [['a']]);
});

/* ================================================================== Isolated project */

test('BL-isolated isolated project: the target card and all layers and media below it are present, the layers above are hidden; clips after it in the same track are hidden too; appearance and timing are unchanged', () => {
  const p = edit((x) => {
    trackOf(x, 't-glass').clips = [
      { id: 'pre', cardId: 'caption-track', start: 0, end: 1, params: {} },
      ...trackOf(x, 't-glass').clips,
      { id: 'post', cardId: 'caption-track', start: 4, end: 5, params: {} },
    ];
    Object.assign(clipOf(x, 'glass'), { opacity: 0.7, fadeIn: 0.2, emphasis: { shadow: { blur: 2 } } });
    Object.assign(clipOf(x, 'glass').frame, { scale: 1.2, rotate: 5 });
    x.tracks.push({ id: 't-off', hidden: true, clips: [{ id: 'off', cardId: 'caption-track', start: 0, end: 8, params: {} }] });
  });
  const spec = belowOf(p);
  const iso = isolatedStreamProject(p, spec);
  assert.deepEqual(iso, isolatedBelowProject(p, spec), '`isolatedStreamProject` takes the new variant for this kind of stream');
  const visible = iso.tracks.filter(t => !t.hidden);
  assert.deepEqual(visible.map(t => `${t.id}:${t.clips.map(c => c.id)}`), ['t-glass:pre,glass', 't-mid:mid', 't-late:late', 't-low:vid', 't-audio:bgm'], 'The target card, the clips before it in the same track, and the tracks below');
  const hidden = iso.tracks.filter(t => t.hidden);
  assert.deepEqual(hidden.map(t => `${t.id}:${t.clips.map(c => c.id)}:${!!t.sourceOnly}`), ['t-top:top:true', '__pc_source_t-glass:post:true', 't-off:off:false'],
    'Tracks above and clips after the target card in the same track are hidden as sources; tracks that were already hidden stay unchanged');
  // Target card appearance is kept as-is (produced in stage coordinates, appearance rendered into
  // the stream), without time shifting
  assert.deepEqual(iso.tracks.find(t => t.id === 't-glass').clips[1], clipOf(p, 'glass'));
  assert.deepEqual(iso.tracks.find(t => t.id === 't-mid'), trackOf(p, 't-mid'));
  assert.deepEqual(iso.tracks.find(t => t.id === 't-low'), trackOf(p, 't-low'));
  assert.deepEqual(iso.media, p.media, 'All media is present');
  assert.deepEqual(iso._cardRender, { mode: 'final', frames: {}, missing: {} });
  assert.equal(iso.duration, p.duration);
  // Track order is untouched: layer stacking order matches the original project
  assert.deepEqual(iso.tracks.map(t => t.id), ['t-top', 't-glass', '__pc_source_t-glass', 't-mid', 't-late', 't-low', 't-audio', 't-off']);
  // Rendered layers = target card + lower layers identified by `belowLayersOf` (plus those that do
  // not overlap in time); none of the layers above are included
  const painted = new Set(visible.flatMap(t => t.clips.map(c => c.id)));
  for (const id of spec.belowClipIds) assert.ok(painted.has(id), `Lower layer ${id} is present`);
  assert.ok(painted.has('glass'));
  assert.ok(!painted.has('top') && !painted.has('post'));
  // Does not modify the original project
  assert.equal(trackOf(p, 't-top').hidden, undefined);
  // The one without the target card (required by differential layer extraction)
  const lower = isolatedBelowProject(p, spec, { withTarget: false });
  assert.deepEqual(lower.tracks.filter(t => !t.hidden).map(t => `${t.id}:${t.clips.map(c => c.id)}`), ['t-glass:pre', 't-mid:mid', 't-late:late', 't-low:vid', 't-audio:bgm']);
  assert.deepEqual(lower.tracks.find(t => t.id === '__pc_source_t-glass').clips.map(c => c.id), ['glass', 'post']);
  // Renaming hidden tracks avoids collisions with existing ones
  const clash = edit((x) => { x.tracks.push({ id: '__pc_source_t-glass', clips: [] }); trackOf(x, 't-glass').clips.push({ id: 'post', cardId: 'caption-track', start: 4, end: 5, params: {} }); });
  assert.ok(isolatedBelowProject(clash, belowOf(clash)).tracks.some(t => t.id === '__pc_source_t-glass_1'));
  assert.throws(() => isolatedBelowProject(p, { kind: 'below', topClipId: 'nope', clipIds: ['nope'] }), /no clip nope/);
});

test('BL-isolated-old the isolated project for single-card and group streams is unchanged: all non-members are hidden', () => {
  const p = project();
  const card = plan(p).find(s => s.kind === 'card' && s.topClipId === 'mid');
  const iso = isolatedStreamProject(p, card);
  assert.deepEqual(iso.tracks.filter(t => !t.hidden).map(t => t.clips.map(c => c.id)), [['mid']]);
  assert.ok(iso.tracks.filter(t => t.id !== 't-mid').every(t => t.hidden && t.sourceOnly));
});

/* ================================================================== Splitting and claiming */

const OWN = FP;
const planTask = planTaskOf({ projectId: 'below-p', projectRev: 3 });
function splitOf(p, extra = {}, mapStream = s => s) {
  const entry = entryOf(p);
  const specs = planStreams(entry, { envFingerprint: OWN, codeVersion: CV, below: true });
  const tasks = splitPlan({
    planTask, entryKey: entry.key, cardPlan: entry.cardPlan.map(c => ({ ...c, cardId: clipOf(p, c.clipId)?.cardId ?? null })),
    streams: specs.map(queueStreamOf).map(mapStream), envFingerprint: OWN, codeVersion: CV,
    weightOf: () => ({ class: 'medium', estMs: null }), ...extra,
  });
  return { entry, specs, tasks, streams: tasks.filter(t => t.kind === 'stream') };
}

test('BL-split splitting: tasks of this kind of stream carry requires.transcode and requires.belowDependent, only the splitter\'s own copy is produced and the browser\'s copy is not; the weight is recorded as heavy', () => {
  const p = project();
  const { specs, streams } = splitOf(p, { browserFingerprints: [BROWSER] });
  const spec = specs.find(s => s.kind === 'below');
  const q = queueStreamOf(spec);
  assert.equal(q.kind, 'below');
  assert.equal(q.plane, 'stage');
  assert.deepEqual(q.clipIds, ['glass']);
  assert.deepEqual(q.belowClipIds, ['vid', 'mid']);
  assert.ok(!('belowClipIds' in queueStreamOf(specs.find(s => s.kind === 'card'))), 'The shape handed to the splitter for other streams is unchanged');
  const mine = streams.filter(t => t.input.contentKey === spec.contentKey);
  assert.equal(q.originFrame, 30, 'The copy handed to the splitter carries the first frame of this stream');
  assert.deepEqual(mine.map(t => [t.range.from, t.range.to]), [[0, 5]], 'Segments 0 to 5 (counted from the target card\'s first frame), one task');
  for (const t of mine) {
    assert.equal(t.resultKey, resultKeyOf(spec.contentKey, OWN));
    assert.equal(t.resultKey, spec.streamKey, 'The same directory as the one the local producer writes to');
    assert.equal(t.requires.envFingerprint, OWN);
    assert.equal(t.requires.transcode, true);
    assert.equal(t.requires.belowDependent, true);
    assert.deepEqual(t.requires.capabilities, { streams: true });
    assert.equal(t.requires.userCards, false);
    assert.equal(t.requires.codeVersion, CV);
    assert.ok(!('localMedia' in t.requires), 'No local media capability gate was given: not carried');
    assert.equal(t.weight.class, 'heavy');
    assert.equal(t.weight.frames, 6 * SEGMENT_FRAMES);
    assert.deepEqual(t.input, { clipId: 'glass', cardId: null, entryKey: null, contentKey: spec.contentKey }, 'Does not carry the inputs of the browser\'s copy (stream / bake / dual)');
    assert.equal(t.takeover, undefined);
  }
  // No matter how many online browser nodes there are, this stream only has the splitter's own
  // copy; single-card streams in the same split still produce two copies as usual
  assert.ok(streams.filter(t => t.input.contentKey !== spec.contentKey).some(t => t.requires.envFingerprint === BROWSER), 'A single-card stream has the browser\'s copy');
  assert.ok(streams.filter(t => t.requires.envFingerprint === BROWSER).every(t => t.requires.belowDependent === false && t.input.stream?.kind === 'card'));
  // `belowDependent` of other stream tasks remains false as usual
  assert.ok(streams.filter(t => t.input.contentKey !== spec.contentKey).every(t => t.requires.belowDependent === false));
  // Marked as output only for browsers (manifest plan from online pages when the splitter itself
  // cannot produce streams, `BL-list`): not a single copy of this stream is output
  const only = splitOf(p, { browserFingerprints: [BROWSER] }, s => ({ ...s, browserOnly: true })).streams;
  assert.deepEqual(only.filter(t => t.input.contentKey === spec.contentKey), []);
  // Locked to another fingerprint: outputs only one copy per lock, still as this task type
  const locked = splitOf(p, { cardLocks: { [`stream:${spec.contentKey}`]: BROWSER } }).streams.filter(t => t.input.contentKey === spec.contentKey);
  assert.deepEqual(locked.map(t => [t.requires.envFingerprint, t.requires.belowDependent, t.requires.transcode]), [[BROWSER, true, true]]);
});

/**
 * The online page manifest plan path (task brief "Wu-2", "Lower layer 4"): for below-dependent
 * cards in the manifest, the splitter emits tasks for this stream using its own fingerprint and
 * produces them itself. Assembled following how `local-node.mjs` splits manifest plans:
 * `listPlanOverrides` marks which copies each stream outputs, which is then passed to `splitPlan`.
 */
function splitListOf(p, clips, plan = {}, extra = {}) {
  const entry = entryOf(p);
  const listTask = clipsPlanTaskOf({ projectId: 'below-p', projectRev: 3, clips });
  const browserStreamsFor = set => planListStreams(entry, set, { envFingerprint: OWN, codeVersion: CV }).map(queueStreamOf);
  const overrides = listPlanOverrides(listTask, { browserStreamsFor, ...plan });
  const tasks = splitPlan({
    planTask: listTask, entryKey: entry.key, cardPlan: entry.cardPlan.map(c => ({ ...c, cardId: clipOf(p, c.clipId)?.cardId ?? null })),
    envFingerprint: OWN, codeVersion: CV, weightOf: () => ({ class: 'medium', estMs: null }), browserFingerprints: [BROWSER], sparseStreams: true,
    ...overrides, ...extra,
  });
  return { entry, overrides, streams: tasks.filter(t => t.kind === 'stream') };
}

test('BL-list manifest plan: the splitter produces this kind of stream for below-dependent cards under its own fingerprint (sparse first, then full density), the browser\'s copy is not produced and a browser node cannot claim it; when the splitter cannot produce streams, no copy is produced at all', () => {
  const p = project();
  // The manifest contains clips classified as heavy by the page: the frosted-glass card and the
  // animated card underneath it
  const { entry, overrides, streams } = splitListOf(p, ['glass', 'mid'], { ownListStreams: true });
  assert.deepEqual(overrides.streams.map(s => [s.kind, s.topClipId, 'browserOnly' in s]), [['card', 'mid', false], ['below', 'glass', false]]);
  // The key computed is identical to that of "this machine's own version": independent of what
  // other clips are in the manifest (listing only the target card, listing other cards together, or
  // computing the entire version all yield the same result)
  const whole = planStreams(entry, { envFingerprint: OWN, codeVersion: CV }).find(s => s.kind === 'below');
  const alone = planListStreams(entry, ['glass'], { envFingerprint: OWN, codeVersion: CV });
  assert.deepEqual(alone.map(s => s.kind), ['below']);
  assert.equal(alone[0].contentKey, whole.contentKey);
  assert.equal(overrides.streams.find(s => s.kind === 'below').contentKey, whole.contentKey);
  assert.equal(alone[0].inputSig, sigOf(p), 'The freshly computed one carries the same input signature the page computes');
  const mine = streams.filter(t => t.input.contentKey === whole.contentKey);
  // Only has the splitter's own fingerprint; the sparse version is ordered first with higher rank;
  // both task types have the same scope
  assert.deepEqual(mine.map(t => [t.requires.envFingerprint, t.input.density ?? 'dense', `${t.range.from}-${t.range.to}`]), [[OWN, 'sparse', '0-5'], [OWN, 'dense', '0-5']]);
  assert.equal(mine[0].priority, SPARSE_STREAM_PRIORITY);
  assert.notEqual(mine[1].priority, SPARSE_STREAM_PRIORITY);
  const browser = (capabilities, more = {}) => ({ profile: 'browser', envFingerprint: OWN, codeVersions: [CV], capabilities, ownProjectIds: ['below-p'], userId: 'u1', ...more });
  const desk = profile => ({ profile, envFingerprint: OWN, codeVersions: [CV], capabilities: { userCards: true, transcode: true, streams: true }, ownProjectIds: ['below-p'] });
  for (const t of mine) {
    assert.equal(t.resultKey, resultKeyOf(whole.contentKey, OWN));
    assert.equal(t.requires.transcode, true);
    assert.equal(t.requires.belowDependent, true);
    assert.equal(t.weight.class, 'heavy');
    assert.equal(t.input.clipId, 'glass');
    assert.ok(!('dual' in t.input) && !('stream' in t.input), 'There is no browser copy paired with it');
    // Browser nodes cannot claim them (blocked by standard shape rule 2; even if transcoding and
    // heavy status are both relaxed, rule 7 still explicitly rejects them)
    const task = { ...t, source: { projectId: 'below-p', projectRev: 3, userId: 'u1' } };
    assert.equal(checkClaimable(task, browser({ transcode: false, streams: true })).ok, false);
    assert.deepEqual(checkClaimable(task, browser({ transcode: true, streams: true }, { weightPolicy: { browser: 'all' } })), { ok: false, rule: 7, reason: 'below-dependent' });
    assert.deepEqual(checkClaimable(task, desk('pc')), { ok: true });
    assert.deepEqual(checkClaimable(task, desk('host')), { ok: true });
  }
  assert.ok(streams.every(t => t.requires.envFingerprint !== BROWSER || t.requires.belowDependent === false), 'There is no stream of this kind under the browser\'s fingerprint');
  // Other cards remain as usual: single-card streams produce one copy for itself and one for the
  // browser, in pairs
  const cardTasks = streams.filter(t => t.input.contentKey !== whole.contentKey);
  assert.deepEqual([...new Set(cardTasks.map(t => t.requires.envFingerprint))].sort(), [OWN, BROWSER].sort());
  assert.ok(cardTasks.every(t => t.input.dual === true && t.requires.belowDependent === false));

  // Splitter cannot produce streams (no encoder detected, switch is off): not a single copy of this
  // stream is output; single-card streams are still given only to the browser as usual
  const off = splitListOf(p, ['glass', 'mid'], {});
  assert.deepEqual(off.overrides.streams.map(s => [s.kind, s.browserOnly === true]), [['card', true], ['below', true]]);
  assert.deepEqual(off.streams.filter(t => t.input.contentKey === whole.contentKey), []);
  assert.ok(off.streams.length > 0 && off.streams.every(t => t.requires.envFingerprint === BROWSER));

  // Host render node, with "generate track streams" disabled for this project: its own copy only
  // outputs sparse stream tasks (same rule as single-card streams)
  const sparseOnly = splitListOf(p, ['glass', 'mid'], { ownListSparseStreams: true });
  assert.deepEqual(sparseOnly.overrides.streams.map(s => [s.kind, s.ownSparseOnly === true, 'browserOnly' in s]), [['card', true, false], ['below', true, false]]);
  assert.deepEqual(sparseOnly.streams.filter(t => t.input.contentKey === whole.contentKey).map(t => [t.requires.envFingerprint, t.input.density ?? 'dense']), [[OWN, 'sparse']]);
  // The queue does not recognize sparse stream tasks (legacy queue): only the full density one is
  // present
  const old = splitListOf(p, ['glass'], { ownListStreams: true }, { sparseStreams: false });
  assert.deepEqual(old.streams.map(t => [t.requires.envFingerprint, t.input.density ?? 'dense']), [[OWN, 'dense']]);

  // No frosted-glass card in the manifest (page did not classify it as heavy): does not output this
  // kind of stream
  assert.deepEqual(splitListOf(p, ['mid'], { ownListStreams: true }).overrides.streams.map(s => s.kind), ['card']);
  // Cards that are below-dependent and have a 3D outer frame also produce this stream
  // (`BELOW_STREAM_RULES.frame3d`): the manifest plan path still produces it, the splitter has its
  // own copy, and the browser copy is not produced
  const tilted = edit((x) => { clipOf(x, 'glass').frame = { x: 100, y: 100, w: 600, h: 300, rotateY: 20 }; });
  const tiltedList = splitListOf(tilted, ['glass'], { ownListStreams: true });
  assert.deepEqual(tiltedList.overrides.streams.map(s => [s.kind, s.plane, s.clipIds.join(), 'browserOnly' in s]), [['below', 'stage', 'glass', false]]);
  assert.ok(tiltedList.streams.length > 0 && tiltedList.streams.every(t => t.requires.belowDependent === true && t.requires.envFingerprint === OWN));
  // Prerender retry plan (backfill tier sent by older pages) does not split streams
  const entry2 = entryOf(p);
  const listed = clipsPlanTaskOf({ projectId: 'below-p', projectRev: 3, clips: ['glass'] });
  const backfill = { ...listed, id: listed.id.replace('#clips:', '#backfill:'), resultKey: listed.resultKey.replace('#clips:', '#backfill:'), priority: 'backfill' };
  assert.deepEqual(listPlanOverrides(backfill, { browserStreamsFor: set => planListStreams(entry2, set, { envFingerprint: OWN, codeVersion: CV }).map(queueStreamOf), ownListStreams: true }).streams, []);
});

test('BL-split-media carries requires.localMedia when using media that exists only on the publisher\'s machine (media of lower layers counts)', () => {
  // Assets are all addressed by content hash: other nodes can fetch them, so no gate is set
  const hashed = () => edit((x) => { x.media.forEach((m, i) => { m.hash = String(i + 1).repeat(64); m.url = `/@media/${m.hash}`; }); });
  assert.equal(localMediaGate(hashed()), null);
  // That lower-layer video has no content hash and is fetched by local address: only on the
  // publisher's local machine
  const p = hashed();
  { const m = p.media.find(v => v.id === 'm1'); delete m.hash; m.url = '/@media/clip.mp4'; }
  const gate = localMediaGate(p);
  assert.equal(typeof gate, 'function');
  const seen = [];
  const usesLocalMedia = (control) => { if (control?.kind === 'stream') seen.push(control); return gate(control); };
  const { specs, streams } = splitOf(p, { localMedia: 'node-pub', usesLocalMedia });
  const spec = specs.find(s => s.kind === 'below');
  const mine = streams.filter(t => t.input.contentKey === spec.contentKey);
  assert.ok(mine.length > 0);
  for (const t of mine) assert.equal(t.requires.localMedia, 'node-pub');
  // The item received by the predicate recognizes this stream, carrying the lower layer computed
  // into the key
  assert.deepEqual(seen.find(c => c.streamKind === 'below'), { clipId: 'glass', kind: 'stream', streamKind: 'below', belowClipIds: ['vid', 'mid'] });
  assert.ok(seen.filter(c => c.streamKind !== 'below').every(c => Object.keys(c).sort().join() === 'clipId,kind'), 'The item received by other streams is unchanged');
  // If evaluated as false, it is not included
  const none = splitOf(p, { localMedia: 'node-pub', usesLocalMedia: () => false }).streams;
  assert.ok(none.every(t => !('localMedia' in t.requires)));
});

test('BL-claim claiming: a browser-only node cannot claim this kind of task; the desktop app and the render host can', () => {
  const { specs, streams } = splitOf(project());
  const spec = specs.find(s => s.kind === 'below');
  const task = { ...streams.find(t => t.input.contentKey === spec.contentKey), source: { projectId: 'below-p', projectRev: 3, userId: 'u1' } };
  const node = (profile, capabilities, extra = {}) => ({ profile, envFingerprint: OWN, codeVersions: [CV], capabilities, ownProjectIds: ['below-p'], ...extra });
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, transcode: true, streams: true })), { ok: true });
  assert.deepEqual(checkClaimable(task, node('host', { userCards: true, transcode: true, streams: true })), { ok: true });
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, transcode: false, streams: true })), { ok: false, rule: 2, reason: 'transcode' }, 'Not accepted if it cannot transcode');
  assert.deepEqual(checkClaimable(task, node('pc', { userCards: true, transcode: true, streams: false })), { ok: false, rule: 2, reason: 'streams' });
  // Pure browser: standard shapes (cannot transcode) are blocked at rule 2
  const browser = (capabilities, extra = {}) => node('browser', capabilities, { userId: 'u1', ...extra });
  assert.deepEqual(checkClaimable(task, browser({ transcode: false, streams: true })), { ok: false, rule: 2, reason: 'transcode' });
  // Even if it reports that it can transcode, heavy is not accepted
  assert.deepEqual(checkClaimable(task, browser({ transcode: true, streams: true })), { ok: false, rule: 4, reason: 'weight' });
  // Even if transcoding and heavy are both allowed, rule 7 explicitly states this stream is not
  // accepted
  const open = browser({ transcode: true, streams: true }, { weightPolicy: { browser: 'all' } });
  assert.deepEqual(checkClaimable(task, open), { ok: false, rule: 7, reason: 'below-dependent' });
  // Wrapping it in a browser-shaped input does not help: it checks requires.belowDependent
  const dressed = { ...task, input: { ...task.input, compositing: 'independent', bake: { start: 1, end: 4, count: 90 }, stream: { kind: 'card', plane: 'local' } } };
  assert.deepEqual(checkClaimable(dressed, open), { ok: false, rule: 7, reason: 'below-dependent' });
  // Browser-shaped single-card streams are still accepted (this rule causes no false positives)
  const cardTask = { ...dressed, requires: { ...task.requires, belowDependent: false, transcode: false }, weight: { class: 'medium' } };
  assert.deepEqual(checkClaimable(cardTask, browser({ transcode: false, streams: true })), { ok: true });
});

/* ================================================================== Layer table */

test('BL-layer-map the streams table of the layer table recognizes this kind of stream: kind below, stage coordinates, the only member is the target card, and the input signature is the one the page computes; when off, the layer table has no such row', () => {
  const p = project();
  const entry = entryOf(p);
  const on = planStreams(entry, { envFingerprint: OWN, codeVersion: CV, below: true });
  const rows = layerStreamsOf(entry, { streams: on, fingerprint: OWN });
  const row = rows.find(r => r.kind === 'below');
  const spec = on.find(s => s.kind === 'below');
  assert.deepEqual(row, {
    topClipId: 'glass', clipIds: ['glass'], kind: 'below', plane: 'stage', contentKey: spec.contentKey,
    candidates: [{ envFingerprint: OWN, resultKey: spec.streamKey }],
    originFrame: 30, lastSegment: spec.lastSegment, segmentsPerTask: row.segmentsPerTask,
    inputSig: streamInputSig(p, { clipIds: ['glass'], kind: 'below' }),
  });
  assert.match(row.inputSig, /^s1-/);
  assert.notEqual(row.inputSig, streamInputSig(p, { clipIds: ['glass'], kind: 'card' }), 'Not the kind of signature a single-card stream has');
  // The page computes against the modified project: if the lower layer changes, it does not match;
  // if upper layers change, it still matches as usual
  assert.notEqual(streamInputSig(edit((x) => { clipOf(x, 'mid').params.text = 'changed'; }), row), row.inputSig);
  assert.equal(streamInputSig(edit((x) => { clipOf(x, 'top').params.text = 'changed'; }), row), row.inputSig);
  // Items with incorrect shapes are not listed
  assert.deepEqual(layerStreamsOf(entry, { streams: [{ ...spec, plane: 'local' }], fingerprint: OWN }), []);
  assert.deepEqual(layerStreamsOf(entry, { streams: [{ ...spec, clipIds: ['glass', 'mid'] }], fingerprint: OWN }), []);
  // When disabled: the layer table is verbatim identical to when this stream is absent
  const off = planStreams(entry, { envFingerprint: OWN, codeVersion: CV, below: false });
  const mapOff = layerMapOf(entry, { fingerprint: OWN, streams: off, now: 1 });
  assert.ok((mapOff.streams ?? []).every(r => r.kind !== 'below'));
  const mapOn = layerMapOf(entry, { fingerprint: OWN, streams: on, now: 1 });
  assert.deepEqual(mapOn.layers, mapOff.layers, 'The snapshot layer table is unaffected');
  assert.deepEqual(mapOn.streams.filter(r => r.kind !== 'below'), mapOff.streams, 'Rows of other streams are unchanged');
});
