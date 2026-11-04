/**
 * Supplementary unit tests for queue priority (the rest of C10 section 3 only checks: c10a
 * already added priority tiers in `19c2d19`, unit tests C10A-L17-Q1~Q6).
 * Here we cover items not covered by Q1~Q6 (numbered CQ-01~CQ-03):
 *
 *   CQ-01 A claimed backfill task encountering a normal publish: priority upgraded to normal
 *         (does not resend task.opened, does not interrupt claimant); when lease expires and
 *         returns to open, reopens as normal, ranked ahead of other backfills
 *   CQ-02 A completed backfill task encountering a normal publish: does not spawn another task,
 *         publisher receives task.done
 *   CQ-03 Within the normal tier, higher integer ranks are claimed first; string 'normal' and
 *         default both count as rank 0; backfill is always after all normal tasks
 *
 * Run: node --test server/test/c10-cost-queue.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue, priorityBand } from '../render-queue/index.mjs';
import { rankCandidates } from '../render-node/pick.mjs';

const FP = '0123456789abcdef';
const CV = 'c0de5a';

function fineTask(resultKey, priority) {
  const t = {
    id: `snapshot:${resultKey}:0-59`, kind: 'snapshot', tier: 'shared', resultKey, range: { unit: 'localFrame', from: 0, to: 59 },
    source: { projectId: 'p1', projectRev: 1 }, input: { clipId: `clip-${resultKey}`, contentKey: `ck-${resultKey}` },
    weight: { class: 'heavy', estMs: null, frames: 60 }, requires: {},
  };
  if (priority !== undefined) t.priority = priority;
  return t;
}

function rig() {
  let now = 1_000;
  const inbox = new Map();
  const q = createRenderQueue({ now: () => now, send: (connId, msg) => { if (!inbox.has(connId)) inbox.set(connId, []); inbox.get(connId).push(msg); }, epoch: 'e1' });
  q.connect('pub', { userId: 'member' });
  q.handle('pub', { type: 'publisher.hello', publisherId: 'P' });
  q.connect('node', { userId: 'creator' });
  q.handle('node', { type: 'node.hello', nodeId: 'N', profile: 'pc', envFingerprint: FP, codeVersions: [CV] });
  q.handle('node', { type: 'queue.watch', projects: 'all' });
  const take = (connId) => { const list = inbox.get(connId) ?? []; inbox.set(connId, []); return list; };
  return {
    q, take,
    tick(ms) { now += ms; q.tick(); },
    publish(tasks) { q.handle('pub', { type: 'task.publish', tasks, reqId: `r${now}` }); return take('pub').find((m) => m.type === 'task.published'); },
  };
}

test('CQ-01 a claimed backfill that meets a normal publish is promoted to normal; when the lease expires and it returns to open, it is queued as normal ahead of other backfills', () => {
  const r = rig();
  r.publish([fineTask('b-old', 'backfill')]);
  r.tick(10);
  r.publish([fineTask('b1', 'backfill')]);
  const opened = r.take('node').filter((m) => m.type === 'task.opened').map((m) => m.task);
  const b1 = opened.find((t) => t.resultKey === 'b1');
  r.q.handle('node', { type: 'task.claim', id: b1.id, expectVersion: b1.version });
  assert.ok(r.take('node').some((m) => m.type === 'task.claimed' && m.id === b1.id));
  // Claimed backfill published as normal: no new task, tier upgraded, no task.opened sent to node (still claimed)
  const up = r.publish([fineTask('b1', 'normal')]);
  assert.equal(up.results[0].created, false);
  assert.equal(r.take('node').filter((m) => m.type === 'task.opened').length, 0);
  // Lease expires (no renewal): returns to open, reopens with normal, ranks ahead of b-old
  r.tick(31_000);
  const reopened = r.take('node').filter((m) => m.type === 'task.opened').map((m) => m.task);
  const again = reopened.find((t) => t.id === b1.id);
  assert.ok(again, `Lease expired, returned to open:${JSON.stringify(r.q.describe().tasks.map((t) => [t.id, t.state]))}`);
  assert.equal(priorityBand(again.priority), 'normal');
  const view = [opened.find((t) => t.resultKey === 'b-old'), again];
  assert.deepEqual(rankCandidates(view).map((t) => t.resultKey), ['b1', 'b-old']);
});

test('CQ-02 a completed backfill that meets a normal publish: no new task is started, and the publisher receives task.done', () => {
  const r = rig();
  r.publish([fineTask('d1', 'backfill')]);
  const t = r.take('node').find((m) => m.type === 'task.opened').task;
  r.q.handle('node', { type: 'task.claim', id: t.id, expectVersion: t.version });
  const claimed = r.take('node').find((m) => m.type === 'task.claimed');
  r.q.handle('node', { type: 'task.complete', id: t.id, token: claimed.token, result: { frames: 60 } });
  const doneState = r.q.describe().tasks.find((x) => x.id === t.id)?.state;
  if (doneState !== 'done') {
    // Field names of complete follow queue contract; print response if incomplete
    assert.fail(`Not completed:${JSON.stringify(r.take('node'))}`);
  }
  r.take('pub');
  r.q.handle('pub', { type: 'task.publish', tasks: [fineTask('d1', 'normal')], reqId: 'again' });
  const msgs = r.take('pub');
  assert.equal(msgs.find((m) => m.type === 'task.published').results[0].created, false);
  assert.ok(msgs.some((m) => m.type === 'task.done' && m.id === t.id), 'The publisher receives task.done');
  assert.equal(r.take('node').filter((m) => m.type === 'task.opened').length, 0, 'Not reopened');
  assert.equal(r.q.describe().tasks.filter((x) => x.id === t.id).length, 1);
});

test('CQ-03 within the normal tier, the higher integer rank is claimed first; the normal string and the default count as rank 0; backfill comes after all normal', () => {
  const r = rig();
  r.publish([fineTask('bf', 'backfill')]); r.tick(1);
  r.publish([fineTask('n0')]); r.tick(1);
  r.publish([fineTask('nstr', 'normal')]); r.tick(1);
  r.publish([fineTask('n50', 50)]); r.tick(1);
  r.publish([fineTask('n5', 5)]);
  const opened = r.take('node').filter((m) => m.type === 'task.opened').map((m) => m.task);
  assert.deepEqual(rankCandidates(opened).map((t) => t.resultKey), ['n50', 'n5', 'n0', 'nstr', 'bf']);
});
