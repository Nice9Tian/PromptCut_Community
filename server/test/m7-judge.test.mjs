/**
 * Criteria for M7 acceptance check probe D1-D2-D12 (`scripts/probes/m7-judge.mjs`). Fixtures taken
 * from laptop run on claude/rq-m7 4047133 (page copy on h1, h3 was taken over midway by D2,
 * old criterion reported badRanges ["0-59:2"]).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createQueueHarness } from './fake-render-queue-env.mjs';
import { snapTask, importRepo } from './m7-kit.mjs';
import { judgeDualClip, observedSuperseded, observeLayerEnvironments, createTaskObservationHistory } from '../../scripts/probes/m7-judge.mjs';

const RANGES = ['0-59', '60-119', '120-179', '180-239', '240-299'];
const all = (live) => RANGES.map((range) => ({ range, live }));

/** Old criterion (probe before change): all output keys combined have exactly one valid copy per segment */
function oldJudge({ groups, candidates }) {
  const counts = new Map();
  for (const list of Object.values(groups)) for (const t of list) counts.set(t.range, (counts.get(t.range) ?? 0) + (t.live ? 1 : 0));
  const badRanges = [...counts].filter(([, n]) => n !== 1).map(([r, n]) => `${r}:${n}`);
  return { ok: badRanges.length === 0 && candidates.includes('pc') && candidates.includes('page'), badRanges };
}

test('h1 / h3 of the laptop round: after page finished 0-59, pc took over per D2; the old criterion fails and the new criterion passes (the takeover is for information only)', () => {
  const clip = {
    groups: { page: RANGES.map((range) => ({ range, live: range === '0-59' })), pc: all(true) },
    candidates: ['page', 'pc'], layerFp: 'pc',
  };
  const old = oldJudge(clip);
  assert.equal(old.ok, false);
  assert.deepEqual(old.badRanges, ['0-59:2']);
  const r = judgeDualClip(clip);
  assert.equal(r.ok, true, r.reasons.join(';'));
  assert.equal(r.winner, 'pc');
  assert.deepEqual(r.takenOverMidway, ['page']);
});

test('The first claimer gets the card (normal case): the other group is invalidated as a whole and both criteria pass; pc getting the card first also fits the contract', () => {
  for (const [winner, loser] of [['page', 'pc'], ['pc', 'page']]) {
    const clip = { groups: { [winner]: all(true), [loser]: all(false) }, candidates: ['pc', 'page'], layerFp: winner };
    assert.equal(oldJudge(clip).ok, true);
    const r = judgeDualClip(clip);
    assert.equal(r.ok, true, r.reasons.join(';'));
    assert.deepEqual(r.fullySuperseded, [loser]);
    assert.deepEqual(r.takenOverMidway, []);
  }
});

test('Cases that should fail still fail: both groups fully valid (not invalidated), the taking-over side is missing segments, the layer table lacks candidates, the layer does not point to either group', () => {
  assert.equal(judgeDualClip({ groups: { page: all(true), pc: all(true) }, candidates: ['pc', 'page'], layerFp: 'pc' }).ok, false);
  assert.equal(judgeDualClip({ groups: { page: RANGES.map((range) => ({ range, live: range === '0-59' })), pc: RANGES.map((range) => ({ range, live: range !== '240-299' })) }, candidates: ['pc', 'page'], layerFp: 'pc' }).ok, false);
  assert.equal(judgeDualClip({ groups: { page: all(true), pc: all(false) }, candidates: ['page'], layerFp: 'page' }).ok, false);
  assert.equal(judgeDualClip({ groups: { page: all(true), pc: all(false) }, candidates: ['pc', 'page'], layerFp: null }).ok, false);
});

const PC = '1111111111111111', PAGE = '2222222222222222';

test('M7 observation: real queue supersedes then removes on locked republish between two samples', t => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('page', 'pub-page', { userId: 'member@device' });
  h.node('pc', 'pc-node', { profile: 'pc', userId: 'observer@device', watch: ['p1'] });
  h.node('br', 'br-node', { profile: 'browser', userId: 'member@device', watch: ['p1'], hello: { envFingerprint: PAGE } });
  const pc = snapTask({ contentKey: 'observation-gap', fp: PC, seg: 0, input: { dual: true } });
  const page = snapTask({ contentKey: 'observation-gap', fp: PAGE, seg: 0, input: { dual: true } });
  h.publish('page', [pc, page]);
  const sampled = new Map(h.describe().tasks.map(task => [task.id, task]));
  assert.equal(sampled.get(pc.id).state, 'open');
  const claim = h.claim('br', page.id, h.task(page.id).version).one('br', 'task.claimed');
  assert.equal(h.task(pc.id).lastError, 'superseded');
  assert.ok(h.bus.of('page', 'task.failed').some(e => e.id === pc.id && e.error === 'superseded'));
  const terminal = h.bus.of('pc', 'task.closed').find(e => e.id === pc.id && e.state === 'failed');
  assert.ok(terminal);
  const republish = h.publish('page', [pc]).one('page', 'task.published');
  assert.equal(republish.results[0].error, 'card-locked');
  assert.equal(h.task(pc.id), null);
  // Exactly the old god-view update: absent entries are never removed.
  for (const task of h.describe().tasks) sampled.set(task.id, task);
  const clip = pcLive => ({ groups: { pc: [{ range: '0-59', live: pcLive }], page: [{ range: '0-59', live: true }] }, candidates: ['pc', 'page'], layerFp: 'page' });
  assert.equal(judgeDualClip(clip(sampled.get(pc.id).state !== 'failed')).ok, false);
  const history = createTaskObservationHistory();
  for (const message of h.bus.of('pc')) history.note(message);
  const publisher = h.bus.of('page', 'task.failed').find(e => e.id === pc.id);
  const proven = observedSuperseded({ current: h.task(pc.id), closed: terminal, publisher, history: history.proof(pc.id) });
  assert.equal(proven, true);
  assert.equal(judgeDualClip(clip(!proven)).ok, true);
  h.complete('br', page.id, claim.token, { v: 1 });
  t.diagnostic(JSON.stringify({ sampled: sampled.get(pc.id).state, current: h.task(pc.id), published: republish.results[0].error, publisher: 'superseded', watcher: terminal.state }));
});

test('M7 observation: absent, generic failure, or old superseded after reopen cannot prove cancellation', () => {
  const publisher = { type: 'task.failed', error: 'superseded', epoch: 'test' };
  assert.equal(observedSuperseded({}), false);
  assert.equal(observedSuperseded({ closed: { state: 'failed' } }), false);
  assert.equal(observedSuperseded({ publisher }), false);
  assert.equal(observedSuperseded({ closed: { state: 'done' }, publisher }), false);
  for (const state of ['open', 'claimed', 'done']) assert.equal(observedSuperseded({ current: { state }, closed: { state: 'failed' }, publisher }), false);
  assert.equal(observedSuperseded({ current: { state: 'failed', lastError: 'decode-error' }, closed: { state: 'failed' }, publisher }), false);
  assert.equal(observedSuperseded({ current: { state: 'failed', lastError: 'superseded' } }), true);
});

test('M7 observation: real OnlineSnapshotSource complete can precede the layer-map reply', async t => {
  const { OnlineSnapshotSource } = await importRepo('src/render/snapshotSource.ts');
  const candidate = fp => ({ envFingerprint: fp, resultKey: `result-${fp}`, key: `wire-${fp}` });
  const layer = { clipId: 'h1', kind: 'html', ...candidate(PC), firstFrame: 0, count: 60, contentKey: 'clip-content', candidates: [candidate(PC)] };
  let map = { v: 3, kind: 'layer-map', projectId: 'p1', fps: 30, span: 60, layers: [layer] };
  let pendingMap = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const source = new OnlineSnapshotSource({
    request: async request => request.key === 'layers:p1'
      ? { type: 'content.item', body: structuredClone(pendingMap ? await gate : map) }
      : { type: 'content.item', missing: true },
    assetBase: () => 'http://unused.invalid', authHeaders: async () => ({}),
    setTimer: () => 0, clearTimer() {},
  }, { tier: 'original' });
  t.after(() => { release(map); source.stop(); });
  source.setProject('p1');
  await source.tickNow();
  assert.equal(source.debug().layers[0].envFingerprint, PC);
  pendingMap = true;
  source.refresh();
  source.markAlive(candidate(PAGE).resultKey);
  assert.equal(source.debug().aliveKeys, 1);
  assert.equal(source.debug().layers[0].envFingerprint, PC, 'complete does not supply the missing candidate map');
  let clock = 0;
  const observation = await observeLayerEnvironments(() => source.debug(), {
    clips: ['h1'], fingerprint: PAGE, timeoutMs: 100, now: () => clock,
    sleep: async () => {
      clock++;
      map = { ...map, layers: [{ ...layer, candidates: [candidate(PC), candidate(PAGE)] }] };
      release(map);
      await source.tickNow();
    },
  });
  assert.equal(observation.first[0].fp, PC);
  assert.equal(observation.layers[0].fp, PAGE);
  assert.equal(observation.ok, true);
  assert.equal(observation.samples, 2);
  t.diagnostic(JSON.stringify(observation));
});

test('M7 observation: deadline preserves failure when the real layer never changes', async () => {
  let clock = 0;
  const observed = await observeLayerEnvironments(async () => ({ layers: [{ clipId: 'h1', envFingerprint: PC, ready: 0 }] }), {
    clips: ['h1'], fingerprint: PAGE, timeoutMs: 2, pollMs: 1, now: () => clock, sleep: async ms => { clock += ms; },
  });
  assert.equal(observed.ok, false);
  assert.equal(observed.samples, 3);
  assert.equal(observed.waitedMs, 2);
  assert.deepEqual(observed.layers, observed.first);
});

test('M7 review: real superseded -> reopen -> ordinary failure -> TTL removal cannot reuse old proof', t => {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('p', 'pub');
  h.node('watch', 'watch', { profile: 'pc', watch: ['p1'] });
  h.node('pc', 'pc', { profile: 'pc', watch: ['p1'], hello: { envFingerprint: PC } });
  h.node('page', 'page', { profile: 'browser', watch: ['p1'], hello: { envFingerprint: PAGE } });
  const a = snapTask({ contentKey: 'review-reopen', fp: PC, seg: 0, input: { dual: true } });
  const b = snapTask({ contentKey: 'review-reopen', fp: PAGE, seg: 0, input: { dual: true } });
  h.publish('p', [a, b]);
  h.claim('page', b.id, h.task(b.id).version);
  const oldPublisher = h.bus.of('p', 'task.failed').find(m => m.id === a.id);
  assert.equal(oldPublisher.error, 'superseded');
  h.publish('p', [{ ...a, takeover: true }]);
  const claim = h.claim('pc', a.id, h.task(a.id).version).one('pc', 'task.claimed');
  h.fail('pc', a.id, claim.token, { error: 'controlled-decode-error', retryable: false });
  assert.equal(h.task(a.id).lastError, 'controlled-decode-error');
  h.advance(600_001);
  assert.equal(h.task(a.id), null);
  const closed = h.bus.of('watch', 'task.closed').filter(m => m.id === a.id).at(-1);
  assert.equal(closed.state, 'failed');
  // The pre-review fallback would accept this combination.
  assert.equal(oldPublisher.error === 'superseded' && closed.state === 'failed', true);
  const history = createTaskObservationHistory();
  for (const message of h.bus.of('watch')) history.note(message);
  const proof = history.proof(a.id);
  assert.equal(proof.generation, 2);
  assert.equal(proof.completeFirstGeneration, false);
  assert.equal(observedSuperseded({ current: null, closed, publisher: oldPublisher, history: proof }), false);
  const latestPublisher = h.bus.of('p', 'task.failed').filter(m => m.id === a.id).at(-1);
  assert.equal(latestPublisher.error, 'controlled-decode-error');
  assert.equal(observedSuperseded({ current: null, closed, publisher: latestPublisher, history: proof }), false);
  t.diagnostic(JSON.stringify({ current: null, historicalError: oldPublisher.error, latestError: latestPublisher.error, proof }));
});

test('M7 review: snapshots, disconnects, epoch changes and missed reopens never restore complete-first-generation proof', () => {
  const opened = { type: 'task.opened', epoch: 'q1', task: { id: 'x', version: 1 } };
  const failed = { type: 'task.closed', epoch: 'q1', id: 'x', state: 'failed' };
  const publisher = { type: 'task.failed', epoch: 'q1', id: 'x', error: 'superseded' };
  const accepts = history => observedSuperseded({ current: null, closed: failed, publisher, history: history.proof('x') });
  const first = createTaskObservationHistory();
  first.note(opened); first.note(failed);
  assert.equal(accepts(first), true);
  assert.equal(observedSuperseded({ closed: failed, publisher: { ...publisher, epoch: 'q2' }, history: first.proof('x') }), false);
  assert.equal(observedSuperseded({ closed: failed, publisher: { ...publisher, type: 'task.done' }, history: first.proof('x') }), false);
  for (const state of ['open', 'failed']) {
    const history = createTaskObservationHistory();
    history.note({ type: 'queue.snapshot', epoch: 'q1', tasks: [{ id: 'x', state, version: 1 }] });
    history.note(opened); history.note(failed);
    assert.equal(accepts(history), false, `initial ${state} snapshot is not a first opened event`);
  }
  const disconnected = createTaskObservationHistory();
  disconnected.note(opened); disconnected.invalidate();
  disconnected.note({ type: 'queue.snapshot', epoch: 'q1', tasks: [{ id: 'x', state: 'open', version: 1 }] });
  disconnected.note(failed);
  assert.equal(accepts(disconnected), false);
  const epochs = createTaskObservationHistory();
  epochs.note(opened); epochs.note({ ...failed, epoch: 'q2' });
  assert.equal(accepts(epochs), false);
  const missed = createTaskObservationHistory();
  missed.note(opened); missed.note(failed); missed.note({ type: 'task.taken', epoch: 'q1', id: 'x' }); missed.note(failed);
  assert.equal(accepts(missed), false);
});
