/**
 * Task D (`claude/queue-maint`): Page is only busy, not taken over by D2 (queue lock idle takeover,
 * M7 contract Section 3.4).
 * Origin: `docs/reports/REPORT-M7.md` Section 11 line 1: "Lock idle only looks at output, not
 * whether page is busy or gone".
 *
 * Fix (M7 D2 addendum [ruling]): `node.welcome` includes `activeIntervalMs`; when a node is busy
 * (generating other cards, background stage measuring or catching up), it sends
 * `node.active { busy }`; lock records last node that produced output for it; when that node is
 * currently connected, its fingerprint hasn't changed, and it reported busy, `lockIdleMs` in
 * response is calculated based on "the last output or reported busy". When page disconnects, stops
 * reporting, or never reported (legacy page), only output is checked, same as before change.
 *
 *   QM-D-01 welcome includes interval, and interval is far smaller than takeover gate
 *   QM-D-02 Page busy (reporting node.active, no output for this card): idle does not increase,
 *           splitter determines not to take over (both publish response and claim response paths)
 *   QM-D-03 Page disconnects: reported busy immediately invalidated, idle calculated from last
 *           output, takeover proceeds as usual
 *   QM-D-04 Page connected but stops reporting busy: calculated from last reported busy, takeover
 *           proceeds as usual after 30 s
 *   QM-D-05 Page resumes output: lock renewed (still on its fingerprint, idle resets to zero,
 *           recorded node remains this node)
 *   QM-D-06 Legacy page (does not report node.active): two queue instances, same message sequence,
 *           response matches algorithm before change
 *   QM-D-07 Reporting busy from other nodes does not count: another node with same fingerprint, or
 *           original node checking in again with new fingerprint
 *   QM-D-08 Message format: if busy is not a string / too long, return bad-message; connections not
 *           from a node return not-registered; no response on success
 *   QM-D-09 describe: only nodes that reported busy get extra activeAt / activeBusy
 *   QM-D-10 In-process (real queue + real splitter): browser locks card, busy for 60 s without
 *           output, new plan revision not taken over; subsequently disconnects, next plan revision
 *           taken over by pc
 *
 * Run: node --test server/test/queue-maint-d2-busy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRenderQueue, clipsPlanTaskOf } from '../render-queue/index.mjs';
import { NODE_ACTIVE_INTERVAL_MS, LOCK_IDLE_TAKEOVER_MS } from '../render-queue/constants.mjs';
import { NODE_TYPES } from '../render-queue/messages.mjs';
import { createLocalNode, idleLockTakeover } from '../render-node/local-node.mjs';
import { createQueueHarness, makeTaskInput, T0 } from './fake-render-queue-env.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const rk = (contentKey, fp) => sha256(`${contentKey}\n${fp}`);
const P = 'pppppppppppppppp';
const B = 'bbbbbbbbbbbbbbbb';
const X = 'xxxxxxxxxxxxxxxx';
const CV = 'c0de5a';

function snap(ck, fp, from = 0) {
  return makeTaskInput({ projectId: 'p1', kind: 'snapshot', resultKey: rk(ck, fp), range: [from, from + 59], input: { clipId: `clip-${ck}`, contentKey: ck }, requires: { envFingerprint: fp } });
}

/** Publisher p, splitter node pc (P), browser node bw for same user (B, watch p1) */
function setup() {
  const h = createQueueHarness(createRenderQueue);
  h.publisher('p', 'pub-p');
  h.node('pc', 'node-pc', { hello: { envFingerprint: P } });
  h.node('bw', 'node-bw', { profile: 'browser', watch: ['p1'], hello: { envFingerprint: B } });
  h.bus.clear();
  return h;
}
const active = (h, conn, busy = 'bake') => h.handle(conn, { type: 'node.active', ...(busy === undefined ? {} : { busy }) });
/** pc sends card locked on B with its own fingerprint: response (card-locked, with lockIdleMs / lockUndone) */
const probe = (h, ck = 'ck1') => {
  const out = h.publish('p', [snap(ck, P, 0)]);
  return out.one('p', 'task.published').results[0];
};
const takes = (r) => idleLockTakeover(`snapshot:${'ck1'}`, r.lockedBy, r);

/** Browser locks ck1 (claims first segment, reports progress once); second segment remains open */
function lockOnBrowser(h, before = []) {
  const br0 = snap('ck1', B, 0), br1 = snap('ck1', B, 60);
  h.publish('p', [...before, br0, br1]);
  const c = h.claim('bw', br0.id, 1).one('bw', 'task.claimed');
  h.progress('bw', br0.id, c.token, 1);
  h.complete('bw', br0.id, c.token, {});
  return { br0, br1 };
}

test('QM-D-01 node.welcome carries activeIntervalMs (the new queue recognizes node.active); the interval is far smaller than the takeover gate of 30 s', () => {
  const h = createQueueHarness(createRenderQueue);
  const out = h.node('bw', 'node-bw', { profile: 'browser', watch: null, hello: { envFingerprint: B } });
  const w = out.one('bw', 'node.welcome');
  assert.equal(w.activeIntervalMs, NODE_ACTIVE_INTERVAL_MS);
  assert.ok(NODE_ACTIVE_INTERVAL_MS * 2 < LOCK_IDLE_TAKEOVER_MS, 'the idle time of the lock between two busy reports is nowhere near the takeover gate');
  assert.ok(NODE_TYPES.has('node.active'), 'node.active is a node connection message (the document service routes messages to the queue by this table)');
});

test('QM-D-02 page busy: holds the lock on ck1 while working on something else (reports node.active every 10 s), and produces nothing for ck1 for 60 s: the idle time does not grow, and the splitter does not take over', () => {
  const h = setup();
  const own1 = snap('ck1', P, 60);   // Splitter's copy was sent before locking (without dual; kept after locking, blocked by lock)
  lockOnBrowser(h, [own1]);
  for (let i = 0; i < 6; i++) { h.advance(NODE_ACTIVE_INTERVAL_MS); active(h, 'bw', 'bake'); }
  h.advance(4_000);
  const r = probe(h);
  assert.equal(r.error, 'card-locked');
  assert.equal(r.lockedBy, B);
  assert.equal(r.lockIdleMs, 4_000, 'counted from the last busy report');
  assert.equal(r.lockUndone, 1, 'the second segment is not done yet');
  assert.equal(takes(r), false, 'the splitter decides not to take over');
  // Claim response path (splitter claims locked card with old view) also calculates by reported busy
  const rej = h.claim('pc', own1.id, 1).one('pc', 'task.claim-rejected');
  assert.deepEqual([rej.reason, rej.lockIdleMs], ['card-locked', 4_000]);
  assert.equal(h.describe().locks.find((l) => l.lockKey === 'snapshot:ck1').envFingerprint, B, 'The lock is still on the browser');
});

test('QM-D-03 page disconnects: busy reports already made stop counting immediately, idle time is counted from the last output, and takeover still happens after 30 s', () => {
  const h = setup();
  lockOnBrowser(h);
  for (let i = 0; i < 4; i++) { h.advance(NODE_ACTIVE_INTERVAL_MS); active(h, 'bw'); }
  h.disconnect('bw');
  const r = probe(h);
  assert.equal(r.lockIdleMs, 4 * NODE_ACTIVE_INTERVAL_MS, 'after the disconnect only output counts (the segment completed 40 s ago)');
  assert.equal(takes(r), true, 'takes over as before');
  // Reconnecting within grace period and reporting busy again: valid again (page hasn't left)
  h.node('bw2', 'node-bw', { profile: 'browser', watch: ['p1'], hello: { envFingerprint: B } });
  active(h, 'bw2');
  h.advance(1_000);
  assert.equal(probe(h).lockIdleMs, 1_000);
});

test('QM-D-04 page connected but no longer reports busy (idle, hidden, or just playing): counted from the last busy report, and takeover still happens after 30 s', () => {
  const h = setup();
  lockOnBrowser(h);
  h.advance(NODE_ACTIVE_INTERVAL_MS);
  active(h, 'bw');
  h.advance(30_000);
  const at30 = probe(h);
  assert.equal(at30.lockIdleMs, 30_000);
  assert.equal(takes(at30), false, 'takes over only when strictly over 30 s');
  h.advance(1);
  const r = probe(h);
  assert.equal(r.lockIdleMs, 30_001);
  assert.equal(takes(r), true);
});

test('QM-D-05 the page finishes being busy and comes back to continue ck1: the lock continues (still on B, idle reset to zero, the recorded node is still it), and being busy again afterwards still does not get it taken over', () => {
  const h = setup();
  const { br1 } = lockOnBrowser(h);
  for (let i = 0; i < 5; i++) { h.advance(NODE_ACTIVE_INTERVAL_MS); active(h, 'bw'); }
  h.advance(2_000);
  const c = h.claim('bw', br1.id, 1).one('bw', 'task.claimed');
  assert.ok(c, 'the browser claims the second segment as usual');
  const r0 = probe(h);
  assert.deepEqual([r0.lockedBy, r0.lockIdleMs], [B, 0]);
  h.advance(25_000);
  h.progress('bw', br1.id, c.token, 30);
  h.advance(20_000);
  active(h, 'bw', 'stage');
  h.advance(3_000);
  assert.equal(probe(h).lockIdleMs, 3_000, 'the renewal recorded the node, so later busy reports still count');
  h.complete('bw', br1.id, c.token, {});
  const done = probe(h);
  assert.deepEqual([done.lockIdleMs, done.lockUndone], [0, 0]);
});

test('QM-D-06 old page (does not report node.active): the reply matches the algorithm from before the change (now minus the last output), and takeover still happens even while connected', () => {
  const h = setup();
  lockOnBrowser(h);
  const seen = [];
  for (const step of [5_000, 10_000, 15_000, 1, 30_000]) {
    h.advance(step);
    const r = probe(h);
    seen.push(r.lockIdleMs);
    assert.equal(r.lockIdleMs, h.now() - T0, 'the last output was at T0 (the first segment completed)');
  }
  assert.deepEqual(seen, [5_000, 15_000, 30_000, 30_001, 60_001]);
  assert.equal(h.nodeInfo('node-bw').connected, true, 'the old page stays connected');
  assert.equal(takes(probe(h)), true, 'takes over as before even while connected (same behavior as before the change)');
  assert.equal('activeAt' in h.nodeInfo('node-bw'), false);
});

test('QM-D-07 busy reports from other nodes do not count: another page with the same fingerprint and the same user; the original node that checked in again with a changed fingerprint', () => {
  const h = setup();
  lockOnBrowser(h);
  h.node('bw2', 'node-bw2', { profile: 'browser', watch: ['p1'], hello: { envFingerprint: B } });
  h.node('bw3', 'node-bw3', { profile: 'browser', userId: 'u2', watch: ['p1'], hello: { envFingerprint: B } });
  for (let i = 0; i < 4; i++) { h.advance(NODE_ACTIVE_INTERVAL_MS); active(h, 'bw2'); active(h, 'bw3'); }
  assert.equal(probe(h).lockIdleMs, 40_000, 'the lock is recorded for node-bw; busy reports from other nodes do not count');
  // node-bw checks in again with new fingerprint: reporting busy no longer counts
  // (locked on B, it is no longer B's environment)
  h.hello('bw', 'node-bw', { profile: 'browser', envFingerprint: X });
  active(h, 'bw');
  h.advance(1_000);
  assert.equal(probe(h).lockIdleMs, 41_000);
});

test('QM-D-08 format of node.active: busy that is not a string or is over 32 characters returns bad-message; a connection that has not checked in returns not-registered; success sends no reply', () => {
  const h = setup();
  const ok = active(h, 'bw', 'bake');
  assert.deepEqual(ok.types('bw'), [], 'success sends no reply');
  const none = h.handle('bw', { type: 'node.active', reqId: 'r1' });
  assert.deepEqual(none.types('bw'), [], 'accepted without busy too; no reply even with a reqId');
  for (const busy of [1, true, {}, 'x'.repeat(33)]) {
    const out = h.handle('bw', { type: 'node.active', busy, reqId: 'r2' });
    const e = out.one('bw', 'error');
    assert.deepEqual([e.reason, e.reqId], ['bad-message', 'r2'], JSON.stringify(busy));
  }
  h.publisher('p2', 'pub-2');
  const out = h.handle('p2', { type: 'node.active' });
  assert.equal(out.one('p2', 'error').reason, 'not-registered');
});

test('QM-D-09 describe: a node that has reported busy gets extra activeAt / activeBusy, other nodes keep the same shape', () => {
  const h = setup();
  h.advance(1_234);
  active(h, 'bw', 'stage');
  const bw = h.nodeInfo('node-bw');
  assert.deepEqual([bw.activeAt, bw.activeBusy], [T0 + 1_234, 'stage']);
  assert.equal('activeAt' in h.nodeInfo('node-pc'), false);
});

/* ------------------------------------------------------------------ In-process: real queue + real splitter */

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const weightOf = () => ({ class: 'medium', estMs: null });

function inproc() {
  let t = T0;
  const routes = new Map();
  const log = [];
  const q = createRenderQueue({ now: () => t, send: (connId, message) => { const m = JSON.parse(JSON.stringify(message)); log.push({ connId, m }); routes.get(connId)?.(m); } });
  const endpointOf = (connId, principal) => {
    q.connect(connId, principal);
    return { send: (m) => q.handle(connId, JSON.parse(JSON.stringify(m))), onMessage: (h) => routes.set(connId, h) };
  };
  return { q, log, now: () => t, advance(ms) { t += ms; q.tick(); }, endpointOf, of: (connId, type) => log.filter((e) => e.connId === connId && e.m.type === type).map((e) => e.m) };
}

function control(clipId, contentKey, count) {
  return {
    key: `png-${clipId}`, snapshotKey: rk(contentKey, P), contentKey, tier: 'shared', capabilities: { frameMode: 'stateful', compositing: 'independent' },
    clipId, nodeId: `n:${clipId}`, start: 0, end: count / 30, count,
    sampling: { firstFrame: 0, fps: { numerator: 30, denominator: 1 }, phase: { numerator: 0, denominator: 1 } }, compositing: 'independent', envFingerprint: P,
  };
}

function pcSplitter(env, cardPlan) {
  const endpoint = env.endpointOf('pc', { userId: 'rig@pc', tenantId: 't1' });
  const local = createLocalNode({
    nodeId: 'pc-1', node: { profile: 'pc', envFingerprint: P, codeVersions: [CV] }, endpoint, now: env.now, codeVersion: CV,
    executor: { plan: async () => ({ entryKey: 'entry-1', cardPlan, weightOf, anchorFrames: [] }), render: async () => null },
    sink: { has: async () => false, put: async () => ({ complete: true }) },
    // Do not let pc execute fine-grained tasks: split only, lock transitions are controlled by test
    isIdle: () => local.session.known().some((t) => t.kind === 'plan'), takeoverLocked: idleLockTakeover,
  });
  local.start();
  return local;
}

test('QM-D-10 in-process: the browser holds the lock on a card and is busy with something else for 60 s (reports busy, produces no output): the new plan version is not taken over by pc; after the browser disconnects, the version after that is taken over by pc', async () => {
  const env = inproc();
  const a = control('a', 'ck-a', 120);
  const pc = pcSplitter(env, [a]);
  const page = env.endpointOf('page', { userId: 'zoe@devA', tenantId: 't1' });
  page.send({ type: 'publisher.hello', publisherId: 'pub-page' });
  const br = env.endpointOf('br', { userId: 'zoe@devA', tenantId: 't1' });
  br.send({ type: 'node.hello', nodeId: 'n-br', profile: 'browser', envFingerprint: B });
  br.send({ type: 'queue.watch', projects: ['p1'] });
  assert.equal(env.of('br', 'node.welcome')[0].activeIntervalMs, NODE_ACTIVE_INTERVAL_MS);

  const plan1 = clipsPlanTaskOf({ projectId: 'p1', projectRev: 1, clips: ['a'], codeVersion: CV });
  page.send({ type: 'task.publish', tasks: [plan1] });
  pc.tick();
  await flush();
  const brTasks = env.q.describe().tasks.filter((t) => t.id.startsWith(`snapshot:${rk('ck-a', B)}`));
  assert.equal(brTasks.length, 2);
  br.send({ type: 'task.claim', id: brTasks[0].id, expectVersion: 1 });
  const token = env.of('br', 'task.claimed').find((m) => m.id === brTasks[0].id).token;
  br.send({ type: 'task.progress', id: brTasks[0].id, token, done: 60 });
  br.send({ type: 'task.complete', id: brTasks[0].id, token, result: {} });

  // Page is busy with other work (other cards, measurement): no output for this card for 60 s,
  // but reports busy every 10 s
  for (let i = 0; i < 6; i++) { env.advance(NODE_ACTIVE_INTERVAL_MS); br.send({ type: 'node.active', busy: 'stage' }); }
  const plan2 = clipsPlanTaskOf({ projectId: 'p1', projectRev: 2, clips: ['a'], codeVersion: CV });
  const mark = env.log.length;
  page.send({ type: 'task.publish', tasks: [plan2] });
  pc.tick();
  await flush();
  assert.ok(env.of('pc', 'task.claimed').some((m) => m.id === plan2.id), 'The second version of the plan was claimed and split by pc');
  let d = env.q.describe();
  assert.equal(d.locks.find((l) => l.lockKey === 'snapshot:ck-a').envFingerprint, B, 'the page is merely busy: the lock stays with the browser');
  assert.equal(d.tasks.find((t) => t.id === brTasks[1].id).state, 'open', 'the second segment copy of the browser is still open, waiting for it to come back and do it');
  assert.equal(d.tasks.find((t) => t.id === brTasks[0].id).state, 'done', 'the segment already done is not wasted');
  assert.ok(!env.log.slice(mark).some((e) => e.connId === 'pc' && e.m.type === 'task.published' && e.m.results.some((r) => r.created && r.id.includes(rk('ck-a', P)))),
    'pc did not start a separate set of keys under its own fingerprint');

  // Browser is gone: disconnects; after grace period expires, pc takes over whole card in next
  // plan revision
  env.q.disconnect('br');
  env.advance(11_000);
  env.advance(5_000);
  const plan3 = clipsPlanTaskOf({ projectId: 'p1', projectRev: 3, clips: ['a'], codeVersion: CV });
  page.send({ type: 'task.publish', tasks: [plan3] });
  pc.tick();
  await flush();
  d = env.q.describe();
  assert.equal(d.locks.find((l) => l.lockKey === 'snapshot:ck-a').envFingerprint, P, 'the page is gone: the lock is handed to pc');
  assert.equal(d.tasks.find((t) => t.id === brTasks[1].id).lastError, 'superseded');
  pc.stop();
  await pc.settled();
});
