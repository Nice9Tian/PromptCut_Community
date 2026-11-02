/**
 * Server consumer side of C4 (reads `wanted` at 4-frame batch boundaries, moves the batch containing
 * it forward) and narrow interface of prerender set. Run: node --test server/test/prerender-schedule.test.mjs
 *
 * `nextBatchStart` is only called between batches: it **does not interrupt the running batch**,
 * only decides where the next batch starts. Run directly with those two methods on
 * `FramePipeline.prototype` and a minimal fake object: this section does not touch Chrome.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePipeline } from '../frame-pipeline.mjs';
import { declaredHeavy, prerenderSetOf, prerenderSetOfPlan } from '../prerender-set.mjs';
import { createReadyHub } from '../ready-index.mjs';

const control = (clipId, count, firstFrame = 0) => ({ clipId, count, sampling: { firstFrame } });
const scheduler = wanted => ({
  playhead: () => ({ t: 0, playing: true, wanted }),
  playheadWanted: FramePipeline.prototype.playheadWanted,
  notePromotion: FramePipeline.prototype.notePromotion,
  nextBatchStart: FramePipeline.prototype.nextBatchStart,
});

test('without wanted, the batches are sequential', () => {
  const pipeline = scheduler(undefined);
  const pending = new Set([0, 4, 8, 12]);
  assert.equal(pipeline.nextBatchStart(pending, control('a', 16)), 0);
  pending.delete(0);
  assert.equal(pipeline.nextBatchStart(pending, control('a', 16)), 4);
});

test('whichever batch wanted falls in moves earlier (local frame = global frame - firstFrame)', () => {
  // Clip starts at global frame 100; playhead wants global frame 1000 → local 900 → batch 900
  const pipeline = scheduler([{ clipId: 'a', frame: 1000 }]);
  const pending = new Set(Array.from({ length: 250 }, (_, i) => i * 4));
  assert.equal(pipeline.nextBatchStart(pending, control('a', 1000, 100)), 900);
  // 901 / 902 / 903 all fall into the same batch
  assert.equal(scheduler([{ clipId: 'a', frame: 1003 }]).nextBatchStart(pending, control('a', 1000, 100)), 900);
  // wanted from other clips does not change this card's order
  assert.equal(scheduler([{ clipId: 'other', frame: 1000 }]).nextBatchStart(pending, control('a', 1000, 100)), 0);
  // The batch already produced is not in pending: no reordering, returns to sequential batch
  const done = new Set([0, 4, 8]);
  assert.equal(pipeline.nextBatchStart(done, control('a', 1000, 100)), 0);
  // Drop frame numbers where clip is not yet mounted / already exited
  assert.equal(scheduler([{ clipId: 'a', frame: 50 }]).nextBatchStart(pending, control('a', 1000, 100)), 0);
  assert.equal(scheduler([{ clipId: 'a', frame: 99999 }]).nextBatchStart(pending, control('a', 1000, 100)), 0);
  // Does not throw when playhead cannot be read (editor has not pushed yet)
  const blind = { playhead: () => { throw new Error('no mirror'); }, playheadWanted: FramePipeline.prototype.playheadWanted,
    notePromotion: FramePipeline.prototype.notePromotion, nextBatchStart: FramePipeline.prototype.nextBatchStart };
  assert.equal(blind.nextBatchStart(pending, control('a', 1000, 100)), 0);
});

test('queue jumps are recorded in diagnostics (the prerender process\'s stdout is consumed by the editor process, so a probe can only see it here)', () => {
  const pipeline = scheduler([{ clipId: 'a', frame: 1000 }]);
  const pending = new Set(Array.from({ length: 250 }, (_, i) => i * 4));
  pipeline.nextBatchStart(pending, control('a', 1000, 100));
  assert.equal(pipeline.promotions.length, 1);
  assert.equal(pipeline.promotions[0].clipId, 'a');
  assert.equal(pipeline.promotions[0].start, 900);
  assert.equal(pipeline.promotions[0].instead, 0);
  // Keep latest 32 entries, do not grow indefinitely
  for (let n = 0; n < 40; n++) pipeline.nextBatchStart(pending, control('a', 1000, 100));
  assert.equal(pipeline.promotions.length, 32);
});

test('no reordering when wanted points exactly at the sequential batch (so the log is not flooded)', () => {
  const pipeline = scheduler([{ clipId: 'a', frame: 2 }]);
  const pending = new Set([0, 4, 8]);
  assert.equal(pipeline.nextBatchStart(pending, control('a', 12)), 0);
});

test('prerenderSetOf fallback rule: direct is not produced, all others are (TODO(R4a) wire up the real one)', () => {
  assert.equal(declaredHeavy({ frameMode: 'direct' }), false);
  assert.equal(declaredHeavy({ frameMode: 'stateful' }), true);
  // unknown is also tested and produced as usual (plan 3.1(2): treated as below-dependent card)
  assert.equal(declaredHeavy({ frameMode: 'stateful', compositing: 'unknown' }), true);
  assert.equal(declaredHeavy({ need_prerendering: true }), true);
  assert.equal(declaredHeavy({ needPrerendering: true }), true);
  assert.equal(declaredHeavy({ need_prerendering: true, frameMode: 'direct' }), false, 'when declarations conflict, frameMode takes precedence');
  assert.equal(declaredHeavy(undefined), false);

  assert.deepEqual([...prerenderSetOfPlan([
    { clipId: 'a', capabilities: { frameMode: 'stateful' } },
    { clipId: 'b', capabilities: { frameMode: 'direct' } },
    { clipId: 'c', capabilities: { frameMode: 'stateful', compositing: 'unknown' } },
    { capabilities: { frameMode: 'stateful' } },
  ])], ['a', 'c']);

  const project = { fps: 30, tracks: [{ clips: [
    { id: 'card-1', cardId: 'particles', mode: 'stateful' },
    { id: 'card-2', cardId: 'caption', mode: 'direct' },
    { id: 'media-1' },
  ] }] };
  assert.deepEqual([...prerenderSetOf(project)], ['card-1'], 'media clips do not enter the prerender set');
});

/* ------------------------------------------------------------------------ *
 * pinned render 9: Prerender set is the **consumer**: cards classified as
 * light at all positions do not produce snapshots and do not enter the ready
 * index. No filtering occurs when the set was never calculated (never went
 * through `adoptCardPlan`).
 * ------------------------------------------------------------------------ */

const statefulControl = (clipId, count = 8) => ({
  clipId, count, snapshotKey: `key-${clipId}`, sampling: { firstFrame: 0 }, end: 100, tier: 'shared',
  capabilities: { frameMode: 'stateful', compositing: 'independent' },
});
const picker = (entry, index = { count: 0, frames: [], oversize: [] }) => ({
  entries: new Map([[entry.key, entry]]),
  prerenderPicked: FramePipeline.prototype.prerenderPicked,
  snapshotTargets: FramePipeline.prototype.snapshotTargets,
  planDiagnostics: FramePipeline.prototype.planDiagnostics,
  missingSnapshotFrames: FramePipeline.prototype.missingSnapshotFrames,
  publishLayer() {},
  snapshots: () => ({ snapshotIndex: async () => index }),
});

test('Render 9: cards outside the prerender set get no snapshot target', () => {
  const entry = { key: 'E', project: { fps: 30 }, cardPlan: [statefulControl('heavy'), statefulControl('light')],
    prerenderSet: new Set(['heavy']) };
  const targets = picker(entry).snapshotTargets(entry);
  assert.deepEqual([...targets.keys()], ['heavy'], 'cards classified as light produce no snapshots');
  assert.equal(targets.get('heavy').tier, 'shared');
});

test('Render 9: when the set has not been computed (undefined), nothing is filtered, same behavior as before it was wired in', () => {
  const entry = { key: 'E', project: { fps: 30 }, cardPlan: [statefulControl('a'), statefulControl('b')] };
  assert.deepEqual([...picker(entry).snapshotTargets(entry).keys()], ['a', 'b']);
});

test('Render 9: an empty set (all classified as light) produces not a single snapshot', () => {
  const entry = { key: 'E', project: { fps: 30 }, cardPlan: [statefulControl('a')], prerenderSet: new Set() };
  assert.equal(picker(entry).snapshotTargets(entry).size, 0);
});

test('Render 9: after the set changes, the snapshotTargets cache is replaced along with it', () => {
  const plan = [statefulControl('a'), statefulControl('b')];
  const entry = { key: 'E', project: { fps: 30 }, cardPlan: plan, prerenderSet: new Set(['a', 'b']) };
  const pipeline = picker(entry);
  assert.equal(pipeline.snapshotTargets(entry).size, 2);
  entry.prerenderSet = new Set(['a']);            // After K6 downgrade / recalculation, set changed but cardPlan remained unchanged
  assert.deepEqual([...pipeline.snapshotTargets(entry).keys()], ['a']);
});

test('Render 9: a card classified as light does not count as "missing frames", so the whole-scene pass does not render extra for it', async () => {
  const entry = { key: 'E', project: { fps: 30, duration: 1 },
    cardPlan: [statefulControl('heavy', 3), statefulControl('light', 3)], prerenderSet: new Set(['heavy']) };
  const frames = await picker(entry).missingSnapshotFrames(entry, { tiers: ['shared'] });
  assert.deepEqual(frames, [0, 1, 2], 'only the frames missing from the heavy card');
  entry.prerenderSet = new Set();
  assert.deepEqual(await picker(entry).missingSnapshotFrames(entry, { tiers: ['shared'] }), []);
});

test('R6-7: when a session switches to a new project version, the page is first told to clear its table (reset) so no old layers remain; the same version is not reset again', () => {
  const pipeline = Object.create(FramePipeline.prototype);
  pipeline.ready = createReadyHub();
  const messages = [];
  pipeline.ready.subscribe('s', m => messages.push(m));
  messages.length = 0;
  const plan = [{ clipId: 'a', snapshotKey: 'KA', tier: 'shared', capabilities: { frameMode: 'stateful', compositing: 'independent' } }];
  const entryA = { key: 'E1', project: { fps: 30 } };
  pipeline.adoptSession('s', entryA, 3);
  pipeline.adoptCardPlan(entryA, plan);
  pipeline.publishLayer(entryA, plan[0], 'shared', [[0, 1]]);
  assert.deepEqual(messages.map(m => m.type), ['reset', 'layer'], 'reset first when the version changes');
  assert.equal(messages[0].localRev, 3, 'reset carries the preload\'s localRev');

  // Same project version again (e.g. re-preload): do not reset repeatedly
  messages.length = 0;
  pipeline.adoptSession('s', entryA, 4);
  pipeline.adoptCardPlan(entryA, plan);
  assert.deepEqual(messages.map(m => m.type), []);

  // Switch to a new project version (entry.key is content-addressed): reset once again
  messages.length = 0;
  const entryB = { key: 'E2', project: { fps: 30 } };
  pipeline.adoptSession('s', entryB, 5);
  assert.deepEqual(messages.map(m => m.type), [], 'plan not computed yet: do not clear the page\'s table for now (keep the old results)');
  pipeline.adoptCardPlan(entryB, []);
  assert.deepEqual(messages.map(m => m.type), ['reset']);
  assert.equal(messages[0].localRev, 5);
  assert.deepEqual(pipeline.ready.peek('s').index.list(), [], 'no old layers remain');
});

test('R6-14: frames dropped for exceeding the limit no longer count as "missing", so the next pass does not re-render them', async () => {
  const entry = { key: 'E', project: { fps: 30, duration: 1 },
    cardPlan: [statefulControl('heavy', 3)], prerenderSet: new Set(['heavy']) };
  // Frame 1 exceeded budget in previous pass: only remaining frames 0 and 2 count as missing
  const index = { count: 0, frames: [], oversize: [[1, 1]] };
  assert.deepEqual(await picker(entry, index).missingSnapshotFrames(entry, { tiers: ['shared'] }), [0, 2]);
  // All three frames evaluated (one ready, two exceeded budget) = card is done, no frames to re-render
  const done = { count: 1, frames: [[0, 0]], oversize: [[1, 2]] };
  assert.deepEqual(await picker(entry, done).missingSnapshotFrames(entry, { tiers: ['shared'] }), []);
});

test('Render 9: diagnostics expose the set and costKey (where probes read from)', () => {
  const entry = { key: 'E', project: { fps: 30 },
    cardPlan: [{ ...statefulControl('heavy'), costKey: 'ck-heavy' }, { ...statefulControl('light'), costKey: 'ck-light' }],
    prerenderSet: new Set(['heavy']) };
  const [plan] = picker(entry).planDiagnostics();
  assert.deepEqual(plan.prerenderSet, ['heavy']);
  assert.deepEqual(plan.controls.map(c => [c.clipId, c.costKey, c.picked]),
    [['heavy', 'ck-heavy', true], ['light', 'ck-light', false]]);
});
