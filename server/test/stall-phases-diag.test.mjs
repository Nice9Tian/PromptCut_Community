/**
 * Diagnosis of lost claim, failure, and discard (`docs/archive/agent-reports/AGENT-stall-phases.md`;
 * contract `docs/plan/render-queue-contract.md` A.12 [ruling]).
 * Run: npm test, or node --test server/test/stall-phases-diag.test.mjs
 *
 *   D1  When queue reclaims, `task.lease-lost` sent to original claimer carries real reason
 *       (`lease-expired` / `stalled`), task view broadcast when releasing back to open carries
 *       `lastError`; task views that never failed do not carry this field
 *   D2  task-runner `lost` event carries phase and milliseconds: lost claim during push →
 *       `phase: 'push'`, number of `push` chunks, time since last frame count change, time since claim
 *   D3  task-runner `failed` (sink-incomplete) carries reason `why` stated by artifact store and
 *       push statistics
 *   D4  `createAssetSink().put`: on push error returns
 *       `{ complete: false, reason: 'push-failed:…', stats }`, logs a `sink.incomplete` line,
 *       reports once via `report` after pushing each chunk; returns `stats` when fully received
 *   D5  Editor process forwarder passes through per-task finalization lines and `sink.incomplete`,
 *       other `[queue-node]` lines are not forwarded as usual; session lines forwarded as usual
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createRenderQueue } from '../render-queue/index.mjs';
import { createTaskRunner } from '../render-node/task-runner.mjs';
import { createSessionLineForwarder } from '../render-node/session-diag.mjs';
import { createAssetSink } from '../artifact-transfer.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const T0 = 1_000_000;

function fineTask(label, { from = 0, to = 59 } = {}) {
  const resultKey = sha256(`rk:${label}`);
  return {
    id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier: 'shared', resultKey,
    range: { unit: 'localFrame', from, to }, source: { projectId: 'p1', projectRev: 1 },
    input: { clipId: `clip-${label}`, contentKey: sha256(`ck:${label}`) }, weight: { class: 'medium' }, requires: {}, priority: 'normal',
  };
}

/** One queue, one node connection, one publisher connection, synchronous message delivery, fake clock */
function queueRig(constants = {}) {
  let t = T0;
  const sent = [];
  const q = createRenderQueue({ now: () => t, send: (connId, msg) => sent.push({ connId, msg }), epoch: 'e1', constants });
  q.connect('node', { userId: 'u', tenantId: 't' });
  q.connect('pub', { userId: 'u', tenantId: 't' });
  q.connect('watch', { userId: 'u', tenantId: 't' });
  q.handle('node', { type: 'node.hello', nodeId: 'N', profile: 'pc' });
  q.handle('watch', { type: 'node.hello', nodeId: 'W', profile: 'pc' });
  q.handle('watch', { type: 'queue.watch', projects: 'all' });
  q.handle('pub', { type: 'publisher.hello', publisherId: 'P' });
  return {
    q, sent, at: (v) => { t = v; q.tick(); },
    of: (connId, type) => sent.filter((e) => e.connId === connId && e.msg.type === type).map((e) => e.msg),
  };
}

test('D1 the reclaimed lease-lost carries the real reason (stalled / lease-expired); the view of a task put back to open carries lastError', () => {
  const r = queueRig();
  const task = fineTask('a');
  r.q.handle('pub', { type: 'task.publish', tasks: [task] });
  const opened0 = r.of('watch', 'task.opened').at(-1);
  assert.equal('lastError' in opened0.task, false, 'the view of a task that never failed has no lastError');
  r.q.handle('node', { type: 'task.claim', id: task.id, expectVersion: 1 });
  r.q.handle('node', { type: 'task.progress', id: task.id, token: 2, done: 0 });
  // Renewals sent as usual, frame count unchanged: reclaimed as stalled when strictly exceeding STALL_MS
  for (let s = 10; s <= 120; s += 10) { r.at(T0 + s * 1000); r.q.handle('node', { type: 'task.progress', id: task.id, token: 2, done: 0 }); }
  r.at(T0 + 120_001);
  const lost = r.of('node', 'task.lease-lost');
  assert.deepEqual(lost.map((m) => m.reason), ['stalled']);
  const reopened = r.of('watch', 'task.opened').at(-1);
  assert.equal(reopened.task.lastError, 'stalled', 'the broadcast of putting it back to open carries lastError');

  // Claimed again, no further renewals: reclaimed by lease
  r.q.handle('node', { type: 'task.claim', id: task.id, expectVersion: reopened.task.version });
  const claimed = r.of('node', 'task.claimed').at(-1);
  r.at(T0 + 120_001 + 30_001);
  assert.equal(r.of('node', 'task.lease-lost').at(-1).reason, 'lease-expired');
  assert.equal(claimed.task.lastError, 'stalled', 'the view in the claim reply also carries the previous reason');
  assert.equal(r.of('watch', 'task.opened').at(-1).task.lastError, 'lease-expired');
});

/** Controllable clock, fake session, manually advanceable executor and artifact store */
function runnerRig({ putBlocks = 3 } = {}) {
  let t = T0;
  const events = [];
  const holds = new Map();
  const session = {
    held: () => [...holds.values()],
    progress: (id) => holds.has(id),
    complete: (id) => holds.delete(id),
    fail: (id) => holds.delete(id),
  };
  const gates = {};
  const executor = {
    render: (task, { progress }) => new Promise((resolve) => { gates.render = { resolve, progress }; }),
  };
  const sink = {
    has: async () => false,
    put: (entry, hooks) => new Promise((resolve) => {
      hooks?.report?.({ stage: 'push' });
      hooks?.report?.({ blocks: putBlocks, pushed: 0, bytes: 0 });
      gates.put = { resolve, report: hooks?.report };
    }),
  };
  const runner = createTaskRunner({ nodeId: 'N', session: () => session, executor, sink, emit: (e) => events.push(e), now: () => t });
  return {
    runner, events, gates,
    claim(task, token = 2) { holds.set(task.id, { id: task.id, token }); runner.onTask(task, { token }); },
    advance(ms) { t += ms; },
    drop(id) { holds.delete(id); },
  };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('D2 claim lost during push: the lost event carries phase=push, the number of chunks pushed, the time since the last frame-count change, and the milliseconds since the claim', async () => {
  const r = runnerRig({ putBlocks: 120 });
  const task = fineTask('b');
  r.claim(task);
  await turn();
  r.advance(5_000);
  r.gates.render.progress(30);
  r.advance(5_000);
  r.gates.render.progress(60);
  r.gates.render.resolve(null);
  await turn(); await turn();
  assert.ok(r.gates.put, 'rendering finished, entering push');
  r.advance(1_000);
  r.gates.put.report({ blocks: 120, pushed: 40, bytes: 4_000 });
  r.advance(129_000);
  r.drop(task.id);
  r.runner.onLost(task.id, 'stalled');
  const lost = r.events.find((e) => e.type === 'lost');
  assert.equal(lost.reason, 'stalled');
  assert.equal(lost.phase, 'push');
  assert.equal(lost.done, 60);
  assert.equal(lost.sinceDoneMs, 130_000, 'time since the last frame-count change');
  assert.equal(lost.sinceClaimMs, 140_000, 'time since the claim');
  assert.equal(lost.phaseMs, 130_000, 'how long in the push phase');
  assert.deepEqual(lost.push, { blocks: 120, pushed: 40, bytes: 4_000, ms: 130_000 });
  await r.runner.settled();
  const discarded = r.events.find((e) => e.type === 'discarded');
  assert.equal(discarded.phase, 'push');
  assert.equal(discarded.reason, 'stalled');
});

test('D3 the failed event for sink-incomplete carries the reason given by the output store and the push statistics', async () => {
  const r = runnerRig({ putBlocks: 10 });
  const task = fineTask('c');
  r.claim(task);
  await turn();
  r.gates.render.progress(60);
  r.gates.render.resolve(null);
  await turn(); await turn();
  r.advance(2_000);
  r.gates.put.report({ blocks: 10, pushed: 7, bytes: 700 });
  r.gates.put.resolve({ complete: false, reason: 'push-failed:timeout' });
  await r.runner.settled();
  const failed = r.events.find((e) => e.type === 'failed');
  assert.equal(failed.error, 'sink-incomplete');
  assert.equal(failed.why, 'push-failed:timeout');
  assert.equal(failed.phase, 'push');
  assert.deepEqual(failed.push, { blocks: 10, pushed: 7, bytes: 700, ms: 2_000 });
});

/** Minimal pipeline (shared tier) with frames 0..3 in the frame store */
function tinyPipeline(frames = 4) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-stall-diag-'));
  const dir = path.join(root, 'snap');
  fs.mkdirSync(dir, { recursive: true });
  for (let f = 0; f < frames; f++) fs.writeFileSync(path.join(dir, `${f}.html`), `<div>${f}</div>`);
  return {
    root,
    pipeline: {
      snapshots: () => ({ snapshotIndex: async () => ({ frames: [[0, frames - 1]], oversize: [] }), dir: () => dir }),
      whenSmallSettled: async () => {},
    },
  };
}

test('D4 output store put: a push error returns reason and stats and logs sink.incomplete; progress is reported once per chunk pushed; stats are included when everything has arrived', async () => {
  const { root, pipeline } = tinyPipeline(4);
  try {
    const ref = { kind: 'snapshot', tier: 'shared', resultKey: sha256('rk:d4'), range: { unit: 'localFrame', from: 0, to: 3 } };
    const logs = [];
    let n = 0;
    const flaky = {
      put: async (ns, bytes) => {
        n += 1;
        if (n === 3) throw Object.assign(new Error('Asset service PUT snap/x/0 timed out (not completed within 30000 ms)'), { code: 'timeout' });
        return { hash: sha256(bytes), uploaded: true };
      },
    };
    const reports = [];
    const bad = await createAssetSink({ pipeline, client: flaky, log: (event, fields) => logs.push({ event, fields }) })
      .put({ ...ref, artifacts: null, meta: { taskId: 't', nodeId: 'N', token: 1 } }, { report: (r) => reports.push(r) });
    assert.equal(bad.complete, false);
    assert.equal(bad.reason, 'push-failed:timeout');
    assert.equal(bad.stats.blocks, 4);
    assert.ok(bad.stats.pushed >= 2 && bad.stats.pushed <= 3, `pushed ${bad.stats.pushed} chunks`);
    const line = logs.find((l) => l.event === 'sink.incomplete');
    assert.ok(line, 'logs one sink.incomplete line');
    assert.equal(line.fields.reason, 'push-failed:timeout');
    assert.ok(reports.some((r) => r.stage === 'collect') && reports.some((r) => r.stage === 'push'), 'both the list-manifest and push-chunks stages were reported');
    assert.ok(reports.some((r) => r.blocks === 4 && r.pushed === 0), 'the total chunk count is reported when the push starts');

    const ok = { put: async (ns, bytes) => ({ hash: sha256(bytes), uploaded: true }) };
    const counted = [];
    const good = await createAssetSink({ pipeline, client: ok })
      .put({ ...ref, artifacts: null, meta: { taskId: 't', nodeId: 'N', token: 1 } }, { report: (r) => { if (Number.isFinite(r.pushed)) counted.push(r.pushed); } });
    assert.equal(good.complete, true);
    assert.equal(good.stats.blocks, 4);
    assert.equal(good.stats.pushed, 4);
    assert.deepEqual(counted, [0, 1, 2, 3, 4], 'once when the push starts + once per chunk');

    // Missing frames: reason is range-missing
    const short = await createAssetSink({ pipeline, client: ok }).put({ ...ref, range: { unit: 'localFrame', from: 0, to: 9 }, artifacts: null, meta: { taskId: 't', nodeId: 'N', token: 1 } });
    assert.equal(short.complete, false);
    assert.equal(short.reason, 'range-missing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('D5 the forwarder lets through the per-task wrap-up lines, sink.incomplete and the dedup diagnostics (sink.has-miss, manifest.*-failed); other queue-node lines are not forwarded; session lines are forwarded as before', () => {
  const out = [];
  const forward = createSessionLineForwarder((line) => out.push(line));
  forward([
    '[queue-node] node.task-lost {"id":"snapshot:ab:0-59","reason":"stalled","phase":"push","sinceDoneMs":121000}',
    '[queue-node] node.task-discarded {"id":"snapshot:ab:0-59","phase":"push"}',
    '[queue-node] node.task-failed {"id":"snapshot:cd:0-59","error":"sink-incomplete","why":"push-failed:timeout"}',
    '[queue-node] node.task-completed {"id":"snapshot:ef:0-59","push":{"blocks":120,"pushed":120,"ms":40000}}',
    '[queue-node] sink.incomplete {"resultKey":"ab","reason":"push-failed:timeout"}',
    '[queue-node] sink.has-miss {"resultKey":"ab","reason":"manifest-missing","covered":false}',
    '[queue-node] manifest.get-failed {"kind":"snapshot-manifest","code":"timeout"}',
    '[queue-node] queue.started {"nodeId":"x"}',
    '[queue-node] executor.plan {"version":"p@1"}',
    '[queue-node] docservice.session.resume {"gapMs":600}',
    '',
  ].join('\n'));
  assert.deepEqual(out.map((l) => l.split(' ')[1]), [
    'node.task-lost', 'node.task-discarded', 'node.task-failed', 'node.task-completed', 'sink.incomplete', 'sink.has-miss', 'manifest.get-failed',
    'docservice.session.resume',
  ]);
  // Dozens of tasks in a round: per-task lines are not suppressed by the session-line quota
  // (10 lines per minute for each type)
  const many = [];
  const f2 = createSessionLineForwarder((line) => many.push(line));
  f2(`${Array.from({ length: 40 }, (_, i) => `[queue-node] node.task-completed {"id":"t${i}"}`).join('\n')}\n`);
  assert.equal(many.length, 40);
});
