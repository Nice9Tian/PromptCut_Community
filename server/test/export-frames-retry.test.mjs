/**
 * Export bitmap "redo" areas (supplemented after review; `exportSaltOf` in `server/export-frames.mjs`,
 * index in `render-node/export-plan.mjs`, `produceExportRange` in `frame-stream.mjs`).
 * Run: node --test server/test/export-frames-retry.test.mjs
 *
 *   EFR-01 Redo tag changes export key: key changes if tag present (task is a new task), identical
 *     to original without it; malformed tag treated as missing
 *   EFR-02 Tag carried throughout: manifest plan's `input.exportSalt` → executor computes plan →
 *     sliced task's `input.exportSalt`, result key
 *   EFR-03 Index on plan completion carries an exact copy of tasks for each stream (used by page to
 *     check task status and rebuild deleted tasks), queue inbound validation accepts it
 *   EFR-04 Failed records determined by differential layer extraction not kept across tasks: new task
 *     retries (E)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportFramesKey, exportSaltOf, exportSpecOf, exportStreamOf } from '../export-frames.mjs';
import { exportIndexOf } from '../render-node/export-plan.mjs';
import { splitPlan } from '../render-node/split.mjs';
import { listPlanOverrides } from '../render-node/local-node.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';
import { parseInbound } from '../render-queue/messages.mjs';
import { StreamProducer } from '../frame-stream.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const FP = 'a'.repeat(16);
const STREAM_KEY = sha256('stream-content');
const specOf = (over = {}) => ({
  streamKey: resultKeyOf(STREAM_KEY, FP), contentKey: STREAM_KEY, envFingerprint: FP, kind: 'card', plane: 'local', clipIds: ['c1'], topClipId: 'c1',
  offset: { x: 0, y: 0 }, bound: { x: 0, y: 0, w: 64, h: 32 }, fps: 30, originFrame: 12, lastFrame: 20, firstSegment: 0, lastSegment: 0, mountFrame: 12, ...over,
});
const planTask = { id: 'plan:p1@7#clips:abc', kind: 'plan', resultKey: 'p1@7#clips:abc', source: { projectId: 'p1', projectRev: 7 }, input: { clips: ['c1'], exportOnly: true, exportSalt: 'r1abc' } };
const base = { planTask, entryKey: 'e1', cardPlan: [], prerenderSet: new Set(), streams: [], envFingerprint: FP, codeVersion: 'cv1' };

test('EFR-01 a retry identifier changes the export key', () => {
  const plain = exportFramesKey(STREAM_KEY);
  assert.equal(exportFramesKey(STREAM_KEY, ''), plain);
  assert.equal(exportFramesKey(STREAM_KEY, 'Bad Salt!'), plain, 'a malformed identifier is treated as not provided');
  assert.notEqual(exportFramesKey(STREAM_KEY, 'r1abc'), plain);
  assert.notEqual(exportFramesKey(STREAM_KEY, 'r1abc'), exportFramesKey(STREAM_KEY, 'r2abc'));
  assert.equal(exportSaltOf('r1abc'), 'r1abc');
  assert.equal(exportSaltOf('x'.repeat(33)), '');
  assert.equal(exportSaltOf(undefined), '');
  const a = exportSpecOf(specOf(), FP), b = exportSpecOf(specOf(), FP, 'r1abc');
  assert.notEqual(a.exportResultKey, b.exportResultKey);
  assert.equal(a.exportSalt, undefined);
  assert.equal(exportStreamOf(a).salt, undefined);
  assert.equal(exportStreamOf(b).salt, 'r1abc');
});

test('EFR-02 the identifier is carried from the plan all the way to the task', () => {
  let got = null;
  const over = listPlanOverrides(planTask, { exportStreamsFor: (clips, salt) => { got = salt; return { streams: [exportStreamOf(exportSpecOf(specOf(), FP, salt))], unsupported: [] }; } });
  assert.equal(got, 'r1abc');
  const [task] = splitPlan({ ...base, exportStreams: over.exportStreams });
  assert.equal(task.input.exportSalt, 'r1abc');
  assert.equal(task.resultKey, resultKeyOf(exportFramesKey(STREAM_KEY, 'r1abc'), FP));
  // Plan without tag: task lacks this item, key identical to original
  const plainOver = listPlanOverrides({ ...planTask, input: { clips: ['c1'], exportOnly: true } }, { exportStreamsFor: (clips, salt) => ({ streams: [exportStreamOf(exportSpecOf(specOf(), FP, salt))], unsupported: [] }) });
  const [plain] = splitPlan({ ...base, exportStreams: plainOver.exportStreams });
  assert.equal(plain.input.exportSalt, undefined);
  assert.equal(plain.resultKey, resultKeyOf(exportFramesKey(STREAM_KEY), FP));
  assert.notEqual(plain.id, task.id);
});

test('EFR-03 the index carries one unchanged copy of each stream\'s tasks', () => {
  const stream = exportStreamOf(exportSpecOf(specOf({ lastFrame: 143, lastSegment: 8 }), FP));
  const tasks = splitPlan({ ...base, exportStreams: [stream] });
  const index = exportIndexOf({ exportStreams: [stream], published: tasks, projectRev: 7, segmentsPerTask: 8 });
  assert.equal(index.streams[0].tasks.length, 2);
  assert.deepEqual(index.streams[0].tasks.map(t => t.id), tasks.map(t => t.id));
  assert.deepEqual(index.streams[0].tasks[0].input, tasks[0].input);
  assert.deepEqual(index.streams[0].tasks[0].requires, tasks[0].requires);
  // Page republishes as-is: queue accepts it, id unchanged (existing tasks only return status, missing ones rebuilt)
  const parsed = parseInbound({ type: 'task.publish', tasks: index.streams[0].tasks });
  assert.equal(parsed.ok, true, parsed.detail);
  assert.deepEqual(parsed.body.tasks.map(t => t.id), tasks.map(t => t.id));
  assert.equal(parsed.body.tasks[0].input.exportFrames, true);
});

test('EFR-04 the record of a failed differential layer capture does not persist across tasks', async () => {
  const spec = exportSpecOf(specOf({ kind: 'below', plane: 'stage', belowClipIds: ['v0'] }), FP);
  const calls = [];
  const state = { spec: { ...spec, streamKey: spec.exportResultKey }, manifest: {}, isolated: {}, reserved: new Set(), failures: new Map(), exportOnly: true, below: { failed: 'upper-changed' } };
  const fake = {
    closed: false, stats: { failures: 0 }, note() {},
    exportStates: new Map([[spec.exportResultKey, state]]),
    pipeline: { leaseStreamBakery: async () => ({}), returnStreamBakery() {} },
    freshManifest: () => ({}),
    async runSegment(bakery, task) { calls.push(task.segment); return true; },
  };
  const frames = [];
  const out = await StreamProducer.prototype.produceExportRange.call(fake, { project: {} }, spec, { from: 0, to: 0 }, { onFrame: f => frames.push(f) });
  assert.deepEqual(calls, [0], 'the previous task judged it failed, and this one retries anyway');
  assert.equal(state.below, null);
  assert.equal(out.frames, 9);
  // Determined failed again in this task: abort this task as early as possible, non-retryable
  fake.runSegment = async () => { state.below = { failed: 'upper-changed' }; throw Object.assign(new Error('differential layer capture failed'), { code: 'below-capture-failed', retryable: false }); };
  await assert.rejects(StreamProducer.prototype.produceExportRange.call(fake, { project: {} }, spec, { from: 0, to: 0 }, { onFrame() {} }), e => e.code === 'below-capture-failed' && e.retryable === false);
});

/* ---------------------------------------------------------------- Against real queue */

const { createRenderQueue } = await import('../render-queue/index.mjs');
const { createQueueHarness } = await import('./fake-render-queue-env.mjs');
const { QUEUE_DEFAULTS } = await import('../render-queue/constants.mjs');

test('EFR-05 real queue: republishing a failed export bitmap task unchanged only returns failed and does not reopen it; a task with a new identifier is a new task', () => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('page', 'page-1');
  h.node('node', 'n1', { profile: 'host', hello: { envFingerprint: FP, codeVersions: ['cv1'], capabilities: {} } });
  const page = { ...planTask, source: { projectId: 'p1', projectRev: 7 } };
  void page;
  const [task] = splitPlan({ ...base, planTask: { ...planTask, id: null }, exportStreams: [exportStreamOf(exportSpecOf(specOf(), FP))] });
  const first = h.publish('page', [task]).one('page', 'task.published').results[0];
  assert.equal(first.created, true);
  const claimed = h.claim('node', task.id, first.version).one('node', 'task.claimed');
  const failedStep = h.fail('node', task.id, claimed.token, { error: 'below-capture-failed', retryable: false });
  assert.equal(failedStep.one('page', 'task.failed').error, 'below-capture-failed');
  // Page (already a subscriber) republishes as-is: response says failed, does not reopen,
  // no notification re-sent: page only knows through response
  const again = h.publish('page', [task]);
  assert.deepEqual(again.one('page', 'task.published').results.map(r => [r.state, r.created]), [['failed', false]]);
  assert.equal(again.of('page', 'task.failed').length, 0);
  assert.equal(h.task(task.id).state, 'failed');
  // With new tag: key changed, it is a new task, nodes can reclaim
  const [retry] = splitPlan({ ...base, planTask: { ...planTask, id: null }, exportStreams: [exportStreamOf(exportSpecOf(specOf(), FP, 'r1abc'))] });
  assert.notEqual(retry.id, task.id);
  const fresh = h.publish('page', [retry]).one('page', 'task.published').results[0];
  assert.deepEqual([fresh.state, fresh.created], ['open', true]);
});

test('EFR-06 real queue: when the page stays disconnected beyond the grace period, unclaimed tasks are deleted; republishing unchanged after reconnecting rebuilds them', () => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('page', 'page-1');
  const [task] = splitPlan({ ...base, planTask: { ...planTask, id: null }, exportStreams: [exportStreamOf(exportSpecOf(specOf(), FP))] });
  h.publish('page', [task]);
  h.disconnect('page');
  h.advance(QUEUE_DEFAULTS.RECONNECT_GRACE_MS + 1);
  assert.equal(h.task(task.id), null, 'tasks that were still open after their subscription was cleared were deleted');
  h.publisher('page2', 'page-1');
  const back = h.publish('page2', [task]).one('page2', 'task.published').results[0];
  assert.deepEqual([back.state, back.created], ['open', true]);
});
