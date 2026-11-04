/**
 * Stream production in multi-project mode: keys and requirements computed by "subset expanded from
 * this stream" (lead session decision, 2026-10-22, tier 3: keys identify things affecting these
 * frame visuals, not the whole project).
 * Run: npm test -- server/test/multi-project-stream-keys.test.mjs (pure logic, real card graph and
 * card plan, no browser spawned)
 *
 *   MSK1  Expansion is deterministic: same project and same frames compute the same subset and same
 *         key across multiple runs; expanding again from subset yields same result (even when node
 *         holds only subset)
 *   MSK2  Publisher and node share same need: stream received by splitter (shape of `queueStreamOf`)
 *         and complete stream held by stream-producing node compute same `streamNeed`, same
 *         `requires.cardSources`, byte-for-byte identical
 *   MSK3  Splitting: stream tasks only require code used in subset expanded from this stream;
 *         legacy callers not passing `streamCardSources` still require all as before
 *   MSK4  When below-dependent streams fall back to whole scene, keys computed by subset: publisher
 *         (whole project) and node (subset only) are byte-for-byte identical; changes outside this
 *         segment do not invalidate it, changes within this segment still invalidate as usual
 *   MSK5  Old key mismatches only trigger recalculation and do not fetch wrong one: stream keys
 *         produced under old criteria (whole-project `entry.key`) differ from new keys; when runner
 *         reconciles tasks with old keys, this stream version lacks it and returns `plan-mismatch`
 *         (not claimed, not used as results for new keys)
 *   MSK6  Single-card stream keys inherently inspect only this card (independent of other clips in
 *         project): stream keys computed from whole project versus subset are byte-for-byte identical
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

/**
 * From top to bottom: top (0-6), glass frosted glass (1-4, target card), mid (0-5, lower layer),
 * late (6-7, no time overlap), vid video (0-8)
 */
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

/**
 * Real pipeline method computes subset whole-scene key (`FramePipeline#subsetFrameKey`, stubs for
 * code version and card identity)
 */
const fakePipeline = { code: () => 'code-1', cardSources: (p) => Object.fromEntries(p.tracks.flatMap((t) => t.clips).map((c) => c.cardId).filter((id) => VERSIONS[id] && id.startsWith('user')).map((id) => [id, VERSIONS[id]])) };
const subsetKeyOf = (p) => (need) => FramePipeline.prototype.subsetFrameKey.call(fakePipeline, p, need);

/**
 * One version of this project: real card graph → real card plan. `unknown`: prerender does not
 * recognize defined clip (below-dependent streams fall back to whole-scene keys)
 */
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

test('MSK1 expansion is deterministic: the same project and the same frames always give the same subset and the same key; expanding again from the subset gives the same one', () => {
  const p = project();
  const spec = belowOf(p);
  const need = streamNeed(spec);
  const a = JSON.stringify(expandProject(p, need).project);
  for (let i = 0; i < 5; i += 1) assert.equal(JSON.stringify(expandProject(structuredClone(p), need).project), a, `attempt ${i + 2}`);
  const key = subsetKeyOf(p)(need);
  assert.equal(subsetKeyOf(structuredClone(p))(need), key);
  // The node holds only a larger subset (e.g. union of several cards in this manifest version):
  // expanding again by this stream is byte-for-byte identical to expanding from the whole project
  const wider = expandProject(p, { spans: [[0, 5]], clipIds: [] }).project;
  assert.equal(JSON.stringify(expandProject(wider, need).project), a);
  assert.equal(subsetKeyOf(wider)(need), key, 'a subset of a subset, the key is unchanged');
  console.log('[MSK1] need', JSON.stringify(need), 'subset clips', expandProject(p, need).clipIds.join(','), 'key', key.slice(0, 16));
  assert.deepEqual(expandProject(p, need).clipIds.sort(), ['glass', 'mid', 'top', 'vid'], 'late is not in this segment');
});

test('MSK2 the publisher and the node get the same need and the same requires.cardSources (byte for byte identical)', () => {
  const p = project();
  for (const spec of specsOf(p)) {
    const q = queueStreamOf(spec); // Shape received by splitter
    assert.deepEqual(streamNeed(q), streamNeed(spec), `${spec.kind}:${spec.topClipId}`);
    assert.equal(JSON.stringify(subsetCardSources(p, streamNeed(q), VERSIONS)), JSON.stringify(subsetCardSources(p, streamNeed(spec), VERSIONS)));
  }
});

test('MSK3 splitting: a stream task needs only the code used in this stream\'s subset; without streamCardSources it still needs all of it', () => {
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
  for (const t of glass) assert.deepEqual(t.requires.cardSources, { odometer: VERSIONS.odometer, 'caption-track': VERSIONS['caption-track'], 'user-a': VERSIONS['user-a'] }, 'the four cards in this segment (late is not included)');
  console.log('[MSK3] code needed by the frosted-glass stream', Object.keys(glass[0].requires.cardSources).join(','), '; the whole project has', Object.keys(VERSIONS).join(','));
  const old = splitPlan(base).filter((t) => t.kind === 'stream' && t.input.clipId === 'glass' && t.requires.belowDependent);
  for (const t of old) assert.deepEqual(t.requires.cardSources, VERSIONS, 'old caller: all');
  // Both splitting methods have identical task id and result key (key unchanged, requirements simply
  // reduced)
  assert.deepEqual(glass.map((t) => t.id), old.map((t) => t.id));
});

test('MSK4 when a stream that depends on lower layers falls back to the whole scene, the key is computed from the subset: the publisher (whole project) and the node (subset) are byte for byte identical; changes outside this segment do not invalidate it, changes inside still do', () => {
  const p = project();
  const pub = belowOf(p, { unknown: ['mid'] });
  assert.equal(pub.belowScene, true, 'precondition: mid is not in the card plan, falling back to the whole scene');
  // The node holds only the subset expanded from this stream (multi-project mode): stream key
  // computed from subset is byte-for-byte identical to publisher
  const sub = expandProject(p, streamNeed(pub)).project;
  const node = belowOf(sub, { unknown: ['mid'] });
  assert.equal(node.contentKey, pub.contentKey);
  assert.equal(node.streamKey, pub.streamKey);
  // Changes outside this segment (late at 6-7s): key remains unchanged (previously invalidated under
  // whole-project key)
  const outside = belowOf(edit((q) => { clipOf(q, 'late').params.text = 'changed'; }), { unknown: ['mid'] });
  assert.equal(outside.contentKey, pub.contentKey, 'changing late does not affect this segment');
  const outsideOld = belowOf(edit((q) => { clipOf(q, 'late').params.text = 'changed'; }), { unknown: ['mid'], subset: false });
  assert.notEqual(outsideOld.contentKey, belowOf(p, { unknown: ['mid'], subset: false }).contentKey, 'control: under the old definition, any change to late invalidates it');
  // Changes within this segment (top at 0-6s, occluding above): invalidated as usual
  assert.notEqual(belowOf(edit((q) => { clipOf(q, 'top').params.text = 'changed'; }), { unknown: ['mid'] }).contentKey, pub.contentKey);
});

test('MSK5 an old key that does not match only causes a recompute, never a wrong fetch: the stream key under the old definition differs from the new key; when the executor is given a task with the old key to check, it answers plan-mismatch', async () => {
  const p = project();
  const fresh = belowOf(p, { unknown: ['mid'] });
  const stale = belowOf(p, { unknown: ['mid'], subset: false });
  assert.notEqual(stale.contentKey, fresh.contentKey);
  assert.notEqual(stale.streamKey, fresh.streamKey, 'the result key (the directory in the stream store) also differs: old output cannot be found under the new key');
  // Runner: only new keys exist in this stream version; tasks with old keys are rejected, returning
  // plan-mismatch (task treated as failed, queue re-splits and re-computes according to new key)
  const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
  const entry = entryOf(p, { unknown: ['mid'] });
  const pipeline = {
    envFingerprint: FP,
    async planForQueue() { return { entry, context: { entryKey: entry.key, cardPlan: entry.cardPlan, streams: [] }, streamSpecs: planStreams(entry, { envFingerprint: FP, codeVersion: CV, below: true }) }; },
    async streamCapable() { return true; },
    renderStreamRange: async () => { throw new Error('should not produce: a task with the old key must not be produced as a new-key task'); },
  };
  const executor = createPrerenderExecutor({ pipeline, projects: { get: async () => p } });
  const task = {
    id: `stream:${stale.streamKey}:0-0`, kind: 'stream', resultKey: stale.streamKey, range: { unit: 'segment', from: stale.firstSegment, to: stale.firstSegment },
    source: { projectId: 'subset-p', projectRev: 3 }, input: { clipId: 'glass', cardId: null, entryKey: null, contentKey: stale.contentKey },
    requires: { envFingerprint: FP, codeVersion: CV, belowDependent: true, transcode: true, capabilities: { streams: true } },
  };
  await assert.rejects(executor.render(task, {}), (err) => err?.code === 'plan-mismatch', 'old key: plan-mismatch');
  // The same task switched to a new key: matches (the stream production step throws an error from
  // the test double, showing that it indeed reached production)
  await assert.rejects(executor.render({ ...task, resultKey: fresh.streamKey, input: { ...task.input, contentKey: fresh.contentKey } }, {}), /should not produce/);
});

test('MSK6 the key of a single-card stream only ever looks at that card: the keys computed from the whole project and from this stream\'s subset are byte for byte identical', () => {
  const p = project();
  for (const spec of specsOf(p).filter((s) => s.kind === 'card')) {
    const sub = expandProject(p, streamNeed(spec)).project;
    const again = specsOf(sub).find((s) => s.kind === 'card' && s.topClipId === spec.topClipId);
    assert.ok(again, spec.topClipId);
    assert.equal(again.contentKey, spec.contentKey, `content key of ${spec.topClipId}`);
    assert.equal(again.streamKey, spec.streamKey);
  }
});
