/**
 * Render queue (M1) fault tolerance table test cases F1.1–F9.3.
 * Run: node --test server/test/render-queue-fault.test.mjs
 *
 * Based on: `docs/plan/distributed-prerender-queue.md` Section 5 fault tolerance table and
 * Section 5.1 C1–C6 (design), `docs/plan/render-queue-contract.md` Section A (contract),
 * `docs/plan/TASK-distributed-prerender-queue.md` Section 5.2 (matrix).
 * Numbering F<row>.<seq> corresponds to the row order in Section 5 fault tolerance table of
 * the design.
 *
 * Each test case asserts three things: task state (state / version / claim / attempts), messages
 * sent to each connection at this step, and that `describe()` matches the former two. Driven only
 * through the public interface of Contract A.3; constants use baseline values, clock uses a fake
 * clock, and `tick()` is invoked manually.
 *
 * Common setup (`setup`): publisher P (connection p, identity pub-1, user u1) publishes task T;
 * nodes A, B, C (connections a, b, c, profile pc) and watch-only W (connection w, profile pc; host
 * before M6c X3) all `queue.watch('all')`.
 * When T is newly created, version = 1; after A claims with expectVersion 1, version = token = 2
 * (Contract A.7.2 step 5).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createQueueHarness, makeTaskInput, T0 } from './fake-render-queue-env.mjs';

// Baseline values from Section 8 Q4 of the design (Contract A.2)
const LEASE = 30_000;
const GRACE = 10_000;
const STALL = 120_000;
const TTL = 600_000;

const WATCHERS = ['a', 'b', 'c', 'w'];
const T_IN = makeTaskInput({ resultKey: 'rk1' });           // snapshot:rk1:0-59
const T1_IN = makeTaskInput({ resultKey: 'rk1', range: [0, 59] });
const T2_IN = makeTaskInput({ resultKey: 'rk1', range: [60, 119] });

function setup({ tasks = [T_IN], ...options } = {}) {
  const h = createQueueHarness(createRenderQueue, options);
  h.publisher('p', 'pub-1');
  h.node('a', 'node-A');
  h.node('b', 'node-B');
  h.node('c', 'node-C');
  h.node('w', 'node-W', { profile: 'pc' });   // M6c X3: host watch 'all' only receives summaries, watch-only W switched to pc (formerly host)
  const out = h.publish('p', tasks);
  for (const r of out.one('p', 'task.published').results) assert.equal(r.created, true, 'Setup: tasks should be newly created');
  h.bus.clear();
  return { h, id: tasks[0].id, ids: tasks.map(t => t.id) };
}

/** Claim succeeded: returns `task.claimed`, token = version = expectVersion + 1, lease starts from now (Contract A.7.2 step 5). */
function claimOk(h, conn, id, expectVersion) {
  const out = h.claim(conn, id, expectVersion);
  const m = out.one(conn, 'task.claimed');
  assert.equal(m.id, id);
  assert.equal(m.version, expectVersion + 1, 'claimed.version');
  assert.equal(m.token, m.version, 'token takes the version at the moment of claiming');
  assert.equal(m.leaseUntil, h.now() + LEASE, 'leaseUntil = now + LEASE_MS');
  assert.equal(m.task.id, id);
  // Other visible watchers each receive one task.taken, while the claimer does not receive it
  for (const w of WATCHERS) {
    if (w === conn) assert.equal(out.of(w, 'task.taken').length, 0, 'The claimer itself does not receive task.taken');
  }
  return { msg: m, out };
}

/** Assert task via `describe()`; `exp === null` indicates it should be deleted. */
function assertTask(h, id, exp) {
  const t = h.task(id);
  if (exp === null) { assert.equal(t, null, `${id} should have been deleted`); return null; }
  assert.ok(t, `${id} should exist`);
  for (const k of ['state', 'version', 'attempts', 'lastError', 'finishedAt', 'projectId']) {
    if (k in exp) assert.deepEqual(t[k], exp[k], `${id}.${k}`);
  }
  if ('subscribers' in exp) assert.deepEqual(t.subscribers, exp.subscribers, `${id}.subscribers`);
  if ('claim' in exp) {
    if (exp.claim === null) assert.equal(t.claim, null, `${id}.claim should be null`);
    else {
      assert.ok(t.claim, `${id}.claim should not be null`);
      for (const [k, v] of Object.entries(exp.claim)) assert.deepEqual(t.claim[k], v, `${id}.claim.${k}`);
    }
  }
  return t;
}

/** Each connection in `conns` receives exactly one `task.opened` for `id`, with task view open, version, attempts. */
function assertOpened(out, conns, id, { version, attempts }) {
  for (const c of conns) {
    const list = out.of(c, 'task.opened').filter(m => m.task?.id === id);
    assert.equal(list.length, 1, `${c} should receive one task.opened for ${id}`);
    assert.equal(list[0].task.state, 'open');
    assert.equal(list[0].task.version, version);
    assert.equal(list[0].task.attempts, attempts);
    assert.equal('claim' in list[0].task, false, 'TaskView does not contain claim');
    assert.equal('subscribers' in list[0].task, false, 'TaskView does not contain subscribers');
  }
}

function assertClosed(out, conns, id, state) {
  for (const c of conns) {
    const list = out.of(c, 'task.closed').filter(m => m.id === id);
    assert.equal(list.length, 1, `${c} should receive one task.closed for ${id}`);
    assert.equal(list[0].state, state);
  }
}

function assertLeaseLost(out, conn, { id, token, reason }) {
  const m = out.one(conn, 'task.lease-lost');
  assert.equal(m.id, id);
  assert.equal(m.token, token);
  if (reason !== undefined) assert.equal(m.reason, reason);
  return m;
}

/** Contract A.9: node check-in response `node.welcome { nodeId, resumed, lost }`. */
function assertWelcome(out, conn, { nodeId, resumed, lost }) {
  const m = out.one(conn, 'node.welcome');
  assert.equal(m.nodeId, nodeId);
  assert.deepEqual([...m.resumed].sort(), [...resumed].sort(), 'welcome.resumed');
  assert.deepEqual([...m.lost].sort(), [...lost].sort(), 'welcome.lost');
  return m;
}

/** Make T failed: A, B, C each claim once and then `fail` (MAX_ATTEMPTS = 3). Returns timestamp entering failed. */
function failThrice(h, id) {
  let v = h.task(id).version;
  for (const [conn, err] of [['a', 'e1'], ['b', 'e2'], ['c', 'e3']]) {
    const { msg } = claimOk(h, conn, id, v);
    h.fail(conn, id, msg.token, { error: err });
    v = h.task(id).version;
  }
  assertTask(h, id, { state: 'failed', attempts: 3, version: 7 });
  return h.now();
}

/* ============================================================ F1 Claimer WebSocket disconnected */

test('F1.1 claimer WebSocket disconnects: within the grace period (9.9 s) T is still held by A, with no broadcast', () => {
  const { h, id } = setup();
  const { msg } = claimOk(h, 'a', id, 1);
  assert.equal(msg.token, 2);

  h.disconnect('a').assertSilent('disconnected');
  const n = h.nodeInfo('node-A');
  assert.equal(n.connected, false);
  assert.equal(n.disconnectedAt, T0);

  h.advance(9_900).assertSilent('Tick within the grace period');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2, leaseUntil: T0 + LEASE } });

  // Exactly 10 s: comparison is strictly greater than (Contract A.8), still not reclaimed
  h.at(T0 + GRACE).assertSilent('Tick exactly when the grace period expires');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2 } });
  assert.equal(h.nodeInfo('node-A').connected, false);
});

test('F1.2 claimer WebSocket disconnects: after 5 s the same nodeId reconnects and resumes, the continuation succeeds, the token and lease are unchanged, and later progress is accepted', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.disconnect('a');

  h.clock.set(T0 + 5_000);
  const out = h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });
  assertWelcome(out, 'a2', { nodeId: 'node-A', resumed: [id], lost: [] });
  assert.deepEqual(out.types('a2'), ['node.welcome'], 'A successful continuation does not send lease-lost');
  assert.deepEqual(out.conns(), ['a2'], 'Other connections receive nothing');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2, leaseUntil: T0 + LEASE } });
  assert.deepEqual(h.nodeInfo('node-A'), { ...h.nodeInfo('node-A'), connected: true, disconnectedAt: null });

  const p = h.progress('a2', id, 2, 5);
  const r = p.one('a2', 'task.renewed');
  assert.deepEqual([r.id, r.token, r.leaseUntil], [id, 2, T0 + 5_000 + LEASE]);
  assert.deepEqual(p.conns(), ['a2']);
  assertTask(h, id, { state: 'claimed', version: 2, claim: { token: 2, leaseUntil: T0 + 5_000 + LEASE, progress: { done: 5, changedAt: T0 + 5_000 } } });

  // Original grace period cleared: not reclaimed even after T0 + 10 s
  h.at(T0 + GRACE + 100).assertSilent('tick after reconnect');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2 } });
});

test('F1.3 Claimant WebSocket disconnects: grace period expires (10.1 s), T returns to open, version +1, claim cleared, attempts = 1, watchers receive task.opened', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.disconnect('a');

  const out = h.at(T0 + 10_100);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, subscribers: ['pub-1'], lastError: 'disconnected' });
  assertOpened(out, ['b', 'c', 'w'], id, { version: 3, attempts: 1 });
  assert.deepEqual(out.conns(), ['b', 'c', 'w'], 'A is disconnected and does not receive it (lease-lost is not sent either); the publisher does not receive it');
  for (const c of ['b', 'c', 'w']) assert.deepEqual(out.types(c), ['task.opened']);
  assert.equal(h.nodeInfo('node-A'), null, 'The node record is deleted after the grace period expires (contract A.8 item 3)');
});

test('F1.4 Claimant WebSocket disconnects: resuming with the old token after the grace period gets lease-lost, T unchanged (still open or already claimed by another node)', () => {
  // Case 1: T is still open
  {
    const { h, id } = setup();
    claimOk(h, 'a', id, 1);
    h.disconnect('a');
    h.at(T0 + 10_100);
    h.clock.advance(1_000);
    const out = h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });
    assertWelcome(out, 'a2', { nodeId: 'node-A', resumed: [], lost: [id] });
    // Task exists, not claimed → reason 'token' (Contract A.9 "other (not claimed, token mismatch)")
    assertLeaseLost(out, 'a2', { id, token: 2, reason: 'token' });
    assert.deepEqual(out.sortedTypes('a2'), ['node.welcome', 'task.lease-lost']);
    assert.deepEqual(out.conns(), ['a2'], 'Other connections receive nothing');
    assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null });
  }
  // Case 2: T has already been claimed by B
  {
    const { h, id } = setup();
    claimOk(h, 'a', id, 1);
    h.disconnect('a');
    h.at(T0 + 10_100);
    claimOk(h, 'b', id, 3);
    const out = h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });
    assertWelcome(out, 'a2', { nodeId: 'node-A', resumed: [], lost: [id] });
    // Task exists but claimer is B → reason 'not-owner' (Contract A.9)
    assertLeaseLost(out, 'a2', { id, token: 2, reason: 'not-owner' });
    assert.deepEqual(out.conns(), ['a2']);
    assertTask(h, id, { state: 'claimed', version: 4, attempts: 1, claim: { nodeId: 'node-B', token: 4 } });
  }
});

test('F1.5 Claimant WebSocket disconnects: A holds T1, T2, both return to open when the grace period expires, each with version +1', () => {
  const { h, ids: [id1, id2] } = setup({ tasks: [T1_IN, T2_IN] });
  claimOk(h, 'a', id1, 1);
  claimOk(h, 'a', id2, 1);
  h.disconnect('a');
  h.at(T0 + GRACE).assertSilent('Exactly at the deadline');

  const out = h.at(T0 + GRACE + 1);
  for (const id of [id1, id2]) {
    assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'disconnected' });
    assertOpened(out, ['b', 'c', 'w'], id, { version: 3, attempts: 1 });
  }
  assert.deepEqual(out.conns(), ['b', 'c', 'w']);
  for (const c of ['b', 'c', 'w']) assert.deepEqual(out.types(c), ['task.opened', 'task.opened']);
});

test('F1.6 Claimant WebSocket disconnects: within the grace period another nodeId resumes with A\'s token and gets lease-lost (not-owner), T still belongs to A', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.disconnect('a');

  h.clock.set(T0 + 3_000);
  const out = h.node('x', 'node-X', { resume: [{ id, token: 2 }], watch: null });
  assertWelcome(out, 'x', { nodeId: 'node-X', resumed: [], lost: [id] });
  assertLeaseLost(out, 'x', { id, token: 2, reason: 'not-owner' });  // C4
  assert.deepEqual(out.conns(), ['x']);
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2, leaseUntil: T0 + LEASE } });

  // A returns within grace period and can still resume: another's resume did not break the claim
  h.clock.set(T0 + 5_000);
  const back = h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });
  assertWelcome(back, 'a2', { nodeId: 'node-A', resumed: [id], lost: [] });
  assertTask(h, id, { state: 'claimed', version: 2, claim: { nodeId: 'node-A', token: 2 } });
});

/* ============================================================ F2 Processing timeout */

test('F2.1 Processing timeout: leaseUntil = t0 + 30 s, after advancing 29.9 s (and exactly 30 s) T is still claimed', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  assertTask(h, id, { claim: { leaseUntil: T0 + LEASE } });

  h.advance(29_900).assertSilent('Lease not yet expired');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2, leaseUntil: T0 + LEASE } });

  h.at(T0 + LEASE).assertSilent('Exactly at expiry: reclaimed only when strictly greater');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0 });
});

test('F2.2 Processing timeout: after advancing 30.1 s, T returns to open, attempts = 1, version +1; A receives lease-lost, watchers receive task.opened', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);

  const out = h.advance(30_100);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'lease-expired' });
  assertLeaseLost(out, 'a', { id, token: 2, reason: 'lease-expired' });
  // A is also a watcher and receives task.opened as well
  assertOpened(out, WATCHERS, id, { version: 3, attempts: 1 });
  assert.deepEqual(out.sortedTypes('a'), ['task.lease-lost', 'task.opened']);
  for (const c of ['b', 'c', 'w']) assert.deepEqual(out.types(c), ['task.opened']);
  assert.deepEqual(out.conns(), WATCHERS, 'The publisher does not receive it');
});

test('F2.3 Processing timeout: a progress every 10 s (done increasing), 5 times in total, leaseUntil extended to now + 30 s each time, still claimed after 50 s', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);

  for (let i = 1; i <= 5; i++) {
    h.clock.advance(10_000);
    const now = h.now();
    const out = h.progress('a', id, 2, i * 10);
    const r = out.one('a', 'task.renewed');
    assert.deepEqual([r.id, r.token, r.leaseUntil], [id, 2, now + LEASE], `Lease renewal #${i}`);
    assert.deepEqual(out.conns(), ['a'], 'Lease renewal is not broadcast');
    h.tick().assertSilent(`tick after lease renewal #${i}`);
    // progress is not a state transition, version remains unchanged (Contract A.7)
    assertTask(h, id, { state: 'claimed', version: 2, attempts: 0,
      claim: { token: 2, leaseUntil: now + LEASE, progress: { done: i * 10, changedAt: now } } });
  }
  assert.equal(h.now(), T0 + 50_000);
  assertTask(h, id, { state: 'claimed', claim: { nodeId: 'node-A' } });
});

test('F2.4 Processing timeout: renew the lease once after advancing 20 s, then advance 25 s, T is still claimed; reclaimed only after the new lease runs out', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.advance(20_000).assertSilent();
  const r = h.progress('a', id, 2, 1).one('a', 'task.renewed');
  assert.equal(r.leaseUntil, T0 + 20_000 + LEASE);

  h.advance(25_000).assertSilent('Not timed out after lease renewal');
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { leaseUntil: T0 + 50_000 } });

  h.at(T0 + 50_000).assertSilent('New lease exactly at the deadline');
  const out = h.at(T0 + 50_001);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'lease-expired' });
  assertLeaseLost(out, 'a', { id, token: 2, reason: 'lease-expired' });
});

/* ============================================================ F3 Progress stall */

test('F3.1 Progress stall: done=24 reported every 10 s from t=10 s, the stall counts from t=10 s, not reclaimed before t=130 s, reclaimed on the first tick after that', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);

  for (let s = 10; s <= 130; s += 10) {
    h.clock.set(T0 + s * 1000);
    h.progress('a', id, 2, 24).one('a', 'task.renewed');
    h.tick().assertSilent(`t=${s} s`);
    assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { progress: { done: 24, changedAt: T0 + 10_000 } } });
  }

  const out = h.at(T0 + 130_001);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'stalled' });
  assertLeaseLost(out, 'a', { id, token: 2, reason: 'stalled' });
  assertOpened(out, WATCHERS, id, { version: 3, attempts: 1 });
  assert.deepEqual(out.conns(), WATCHERS);
});

test('F3.2 Progress stall: done stays unchanged after becoming 25 at t=100 s, the stall restarts counting from t=100 s, not reclaimed before t=220 s, reclaimed on the first tick after that', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);

  for (let s = 10; s <= 220; s += 10) {
    h.clock.set(T0 + s * 1000);
    const done = s < 100 ? 24 : 25;
    h.progress('a', id, 2, done).one('a', 'task.renewed');
    h.tick().assertSilent(`t=${s} s`);
    assertTask(h, id, { state: 'claimed', version: 2, attempts: 0,
      claim: { progress: { done, changedAt: T0 + (s < 100 ? 10_000 : 100_000) } } });
  }

  const out = h.at(T0 + 220_001);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'stalled' });
  assertLeaseLost(out, 'a', { id, token: 2, reason: 'stalled' });
  assertOpened(out, WATCHERS, id, { version: 3, attempts: 1 });
});

test('F3.3 Progress stall: a task that never reported progress is governed only by the lease, reclaimed by lease at 30.1 s, STALL is not consulted', () => {
  {
    const { h, id } = setup();
    claimOk(h, 'a', id, 1);
    assertTask(h, id, { claim: { progress: { done: null, changedAt: T0 } } });
    const out = h.advance(30_100);
    assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'lease-expired' });
    assertLeaseLost(out, 'a', { id, token: 2, reason: 'lease-expired' });
    assertOpened(out, WATCHERS, id, { version: 3, attempts: 1 });
  }
  // Setting STALL shorter than lease shows clearly stall scan ignores it when done === null (Contract A.8 item 2)
  {
    const { h, id } = setup({ constants: { STALL_MS: 1_000 } });
    claimOk(h, 'a', id, 1);
    h.at(T0 + 5_000).assertSilent('STALL has passed but progress was never reported');
    h.at(T0 + LEASE).assertSilent('Lease exactly at the deadline');
    assertTask(h, id, { state: 'claimed', version: 2, attempts: 0 });
    const out = h.at(T0 + LEASE + 1);
    assertTask(h, id, { state: 'open', version: 3, attempts: 1, lastError: 'lease-expired' });
    assertLeaseLost(out, 'a', { id, token: 2, reason: 'lease-expired' });
  }
});

/* ============================================================ F4 Repeatedly failing task */

test('F4.1 Repeatedly failing task: A, B, C claim in turn and then fail, the first two return to open (attempts 1, 2), the third enters failed, the subscriber receives a failure notice carrying lastError', () => {
  const { h, id } = setup();

  const steps = [
    { conn: 'a', expect: 1, error: 'e1', retryable: true, state: 'open', version: 3, attempts: 1 },
    { conn: 'b', expect: 3, error: 'e2', retryable: undefined, state: 'open', version: 5, attempts: 2 },
    { conn: 'c', expect: 5, error: 'e3', retryable: true, state: 'failed', version: 7, attempts: 3 },
  ];
  for (const s of steps) {
    const { msg } = claimOk(h, s.conn, id, s.expect);
    h.clock.advance(1_000);
    const out = h.fail(s.conn, id, msg.token, { error: s.error, retryable: s.retryable });
    const ack = out.one(s.conn, 'task.fail-ack');
    assert.deepEqual([ack.id, ack.state], [id, s.state]);
    if (s.state === 'open') {
      assertTask(h, id, { state: 'open', version: s.version, attempts: s.attempts, claim: null, lastError: s.error });
      assertOpened(out, WATCHERS, id, { version: s.version, attempts: s.attempts });
      assert.equal(out.of('p').length, 0, 'Subscribers are not notified when the task returns to open');
    } else {
      assertTask(h, id, { state: 'failed', version: 7, attempts: 3, claim: null, lastError: 'e3', finishedAt: h.now() });
      const f = out.one('p', 'task.failed');
      assert.deepEqual([f.id, f.error], [id, 'e3']);
      assert.deepEqual(out.types('p'), ['task.failed']);
      assertClosed(out, WATCHERS, id, 'failed');
      assert.equal(out.ofType('task.opened').length, 0);
    }
  }
  assert.equal(h.bus.ofType('task.failed').length, 1, 'The failure notice is sent only once');

  // After failed, any attempt to claim results in taken
  const rej = h.claim('a', id, 7).one('a', 'task.claim-rejected');
  assert.deepEqual([rej.reason, rej.state, rej.version], ['taken', 'failed', 7]);
});

test('F4.2 Repeatedly failing task: timeout, disconnect, stall and fail share one attempts count (C3), the third reclaim moves T to failed', () => {
  // Matrix as is: first two times timed out and reclaimed, third time timed out again after claiming
  {
    const { h, id } = setup();
    let v = 1;
    for (let i = 1; i <= 2; i++) {
      claimOk(h, 'a', id, v);
      h.advance(LEASE + 1);
      v = h.task(id).version;
      assertTask(h, id, { state: 'open', attempts: i, version: 1 + 2 * i });
    }
    claimOk(h, 'a', id, 5);
    h.bus.clear();
    const out = h.advance(LEASE + 1);
    assertTask(h, id, { state: 'failed', version: 7, attempts: 3, claim: null, lastError: 'lease-expired', finishedAt: h.now() });
    assertLeaseLost(out, 'a', { id, token: 6, reason: 'lease-expired' });
    const f = out.one('p', 'task.failed');
    assert.deepEqual([f.id, f.error], [id, 'lease-expired']);
    assertClosed(out, WATCHERS, id, 'failed');
    assert.equal(out.ofType('task.opened').length, 0);
  }
  // Mixed: fail → disconnect grace → stall
  {
    const { h, id } = setup();
    const { msg: m1 } = claimOk(h, 'a', id, 1);
    assert.equal(h.fail('a', id, m1.token, { error: 'e1' }).one('a', 'task.fail-ack').state, 'open');
    assertTask(h, id, { state: 'open', version: 3, attempts: 1, lastError: 'e1' });

    claimOk(h, 'b', id, 3);
    h.disconnect('b');
    h.advance(GRACE + 1);
    assertTask(h, id, { state: 'open', version: 5, attempts: 2, lastError: 'disconnected' });

    const { msg: m3 } = claimOk(h, 'c', id, 5);
    const x = h.now();
    h.progress('c', id, m3.token, 1);
    for (let s = 10; s <= 120; s += 10) {
      h.clock.set(x + s * 1000);
      h.progress('c', id, m3.token, 1).one('c', 'task.renewed');
      h.tick().assertSilent(`Stall timer ${s} s`);
    }
    h.bus.clear();
    const out = h.at(x + STALL + 1);
    assertTask(h, id, { state: 'failed', version: 7, attempts: 3, claim: null, lastError: 'stalled' });
    assertLeaseLost(out, 'c', { id, token: 6, reason: 'stalled' });
    assert.equal(out.one('p', 'task.failed').error, 'stalled');
    assertClosed(out, ['a', 'c', 'w'], id, 'failed');
  }
});

test('F4.3 Repeatedly failing task: a failed task republished within DONE_TTL is still failed and is not reopened (C1); after the TTL the old task is deleted and republishing creates a new open task', () => {
  const { h, id } = setup();
  const tf = failThrice(h, id);
  h.bus.clear();

  h.clock.set(tf + TTL);
  const again = h.publish('p', [T_IN]);
  const [r] = again.one('p', 'task.published').results;
  assert.deepEqual(r, { id, state: 'failed', version: 7, created: false });
  assert.deepEqual(again.conns(), ['p'], 'task.opened is not broadcast');
  assert.deepEqual(again.types('p'), ['task.published'], 'A repeated publish of a failed task sends no additional notice');
  assertTask(h, id, { state: 'failed', version: 7, attempts: 3, finishedAt: tf });

  h.tick().assertSilent('TTL exactly at the deadline');
  assertTask(h, id, { state: 'failed' });

  h.at(tf + TTL + 1).assertSilent('TTL deletion sends no message');
  assertTask(h, id, null);

  const fresh = h.publish('p', [T_IN]);
  assert.deepEqual(fresh.one('p', 'task.published').results[0], { id, state: 'open', version: 1, created: true });
  assertOpened(fresh, WATCHERS, id, { version: 1, attempts: 0 });
  assertTask(h, id, { state: 'open', version: 1, attempts: 0, claim: null, subscribers: ['pub-1'], finishedAt: null, lastError: null });
});

test('F4.4 Repeatedly failing task: a new id with a different result key opens normally, unrelated to the failed T', () => {
  const { h, id } = setup();
  failThrice(h, id);
  h.bus.clear();
  const T2 = makeTaskInput({ resultKey: 'rk2' });
  const out = h.publish('p', [T2]);
  assert.deepEqual(out.one('p', 'task.published').results[0], { id: T2.id, state: 'open', version: 1, created: true });
  assertOpened(out, WATCHERS, T2.id, { version: 1, attempts: 0 });
  assertTask(h, T2.id, { state: 'open', version: 1, attempts: 0 });
  assertTask(h, id, { state: 'failed', version: 7, attempts: 3 });
});

test('F4.5 Repeatedly failing task: A releases voluntarily, T returns to open, attempts not incremented (C2)', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  const out = h.release('a', id, 2, 'busy');
  assert.equal(out.one('a', 'task.released').id, id);
  // release does not write lastError (Contract A.10a): null for new tasks remains unchanged
  assertTask(h, id, { state: 'open', version: 3, attempts: 0, claim: null, lastError: null });
  assertOpened(out, WATCHERS, id, { version: 3, attempts: 0 });
  assert.deepEqual(out.sortedTypes('a'), ['task.opened', 'task.released']);
  assert.equal(out.of('p').length, 0);
});

/* ============================================================ F5 Late completion report */

/** A claims (t1 = 2) → timeout reclaim (v3) → B claims (t2 = 4). */
function lateSetup() {
  const s = setup();
  claimOk(s.h, 'a', s.id, 1);
  s.h.advance(LEASE + 1);
  claimOk(s.h, 'b', s.id, 3);
  s.h.bus.clear();
  return s;
}

test('F5.1 Late completion report: A completes with the expired token t1 and gets lease-lost; T is still held by B with t2, the subscriber did not receive task.done', () => {
  const { h, id } = lateSetup();
  const out = h.complete('a', id, 2, { ranges: [[0, 59]] });
  assertLeaseLost(out, 'a', { id, token: 2, reason: 'token' });
  assert.deepEqual(out.conns(), ['a']);
  assertTask(h, id, { state: 'claimed', version: 4, attempts: 1, claim: { nodeId: 'node-B', token: 4 } });
  assert.equal(h.bus.ofType('task.done').length, 0);
});

test('F5.2 Late completion report: B completes with t2, T enters done; the subscriber receives task.done once, watchers receive task.closed', () => {
  const { h, id } = lateSetup();
  h.complete('a', id, 2);
  const out = h.complete('b', id, 4, { ranges: [[0, 59]] });
  assert.equal(out.one('b', 'task.completed').id, id);
  assertTask(h, id, { state: 'done', version: 5, attempts: 1, claim: null, finishedAt: h.now() });
  const d = out.one('p', 'task.done');
  assert.deepEqual({ id: d.id, resultKey: d.resultKey, projectId: d.projectId, projectRev: d.projectRev, result: d.result },
    { id, resultKey: 'rk1', projectId: 'proj-1', projectRev: 1, result: { ranges: [[0, 59]] } });
  assertClosed(out, WATCHERS, id, 'done');
  assert.equal(h.bus.ofType('task.done').length, 1);
});

test('F5.3 Late completion report: T is already done, any node that completes again (with any token) gets lease-lost, no duplicate notice', () => {
  const { h, id } = lateSetup();
  h.complete('b', id, 4, { ranges: [[0, 59]] });
  h.bus.clear();
  for (const [conn, token] of [['a', 2], ['b', 4], ['c', 5], ['w', 5]]) {
    const out = h.complete(conn, id, token);
    assertLeaseLost(out, conn, { id, token, reason: 'token' });
    assert.deepEqual(out.conns(), [conn]);
  }
  assertTask(h, id, { state: 'done', version: 5, claim: null });
  assert.equal(h.bus.ofType('task.done').length, 0);
});

test('F5.4 Late completion report: after T is reclaimed and open, A sends progress / release with t1 and gets lease-lost, T is still open and version is unchanged', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.advance(LEASE + 1);
  h.bus.clear();
  const p = h.progress('a', id, 2, 10);
  assertLeaseLost(p, 'a', { id, token: 2, reason: 'token' });
  assert.deepEqual(p.conns(), ['a']);
  const r = h.release('a', id, 2, 'busy');
  assertLeaseLost(r, 'a', { id, token: 2, reason: 'token' });
  assert.deepEqual(r.conns(), ['a']);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null });
});

/* ============================================================ F6 Node crashed halfway through pushing artifacts */

test('F6.1 A node crashes halfway through pushing output: after reporting progress it neither completes nor disconnects, the lease expires and T returns to open, where it can be claimed again', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.clock.set(T0 + 5_000);
  h.progress('a', id, 2, 10);
  h.at(T0 + 5_000 + LEASE).assertSilent('New lease exactly at the deadline');
  assertTask(h, id, { state: 'claimed', version: 2 });

  const out = h.at(T0 + 5_000 + LEASE + 1);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'lease-expired' });
  assertLeaseLost(out, 'a', { id, token: 2, reason: 'lease-expired' });
  assertOpened(out, WATCHERS, id, { version: 3, attempts: 1 });
  assert.equal(h.bus.ofType('task.done').length, 0, 'Without complete it does not count as done');

  claimOk(h, 'b', id, 3);
  assertTask(h, id, { state: 'claimed', version: 4, claim: { nodeId: 'node-B', token: 4 } });
});

test('F6.2 a node crashes halfway through pushing output: A disconnects and never returns, reclaimed when the grace period expires (same as F1.3), no intermediate state', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.progress('a', id, 2, 10);
  h.disconnect('a');
  for (const t of [T0 + 1, T0 + 5_000, T0 + GRACE]) {
    h.at(t).assertSilent();
    assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2 } });
  }
  const out = h.at(T0 + GRACE + 1);
  assertTask(h, id, { state: 'open', version: 3, attempts: 1, claim: null, lastError: 'disconnected' });
  assertOpened(out, ['b', 'c', 'w'], id, { version: 3, attempts: 1 });
  assert.deepEqual(out.conns(), ['b', 'c', 'w']);
  assert.equal(h.nodeInfo('node-A'), null);
  claimOk(h, 'b', id, 3);
});

/* ============================================================ F7 Publisher disconnected */

test('F7.1 publisher disconnects: after the grace period expires, only the open task T1 subscribed by P is deleted (watchers receive task.closed), and the claimed T2 is kept', () => {
  const { h, ids: [id1, id2] } = setup({ tasks: [T1_IN, T2_IN] });
  claimOk(h, 'a', id2, 1);
  h.disconnect('p').assertSilent('Publisher disconnects');
  assert.deepEqual(h.publisherInfo('pub-1'), { publisherId: 'pub-1', connected: false, disconnectedAt: T0 });

  h.at(T0 + GRACE).assertSilent('Grace period exactly at its limit');
  assertTask(h, id1, { state: 'open', subscribers: ['pub-1'] });

  const out = h.at(T0 + GRACE + 1);
  assertTask(h, id1, null);
  assertClosed(out, WATCHERS, id1, 'removed');
  for (const c of WATCHERS) assert.deepEqual(out.types(c), ['task.closed']);
  assert.equal(out.ofType(['task.opened', 'task.taken', 'task.done']).length, 0);
  assertTask(h, id2, { state: 'claimed', version: 2, attempts: 0, subscribers: [], claim: { nodeId: 'node-A', token: 2 } });
  assert.equal(h.publisherInfo('pub-1'), null, 'Publisher record deleted after the grace period expires');
});

test('F7.2 publisher disconnects: afterwards A completes T2, T2 moves to done, task.done is not sent (no subscribers), deleted after DONE_TTL', () => {
  const { h, ids: [, id2] } = setup({ tasks: [T1_IN, T2_IN] });
  claimOk(h, 'a', id2, 1);
  h.disconnect('p');
  h.at(T0 + GRACE + 1);
  h.bus.clear();

  const out = h.complete('a', id2, 2, { ranges: [[60, 119]] });
  const tc = h.now();
  assert.equal(out.one('a', 'task.completed').id, id2);
  assertClosed(out, WATCHERS, id2, 'done');
  assert.equal(out.ofType('task.done').length, 0);
  assertTask(h, id2, { state: 'done', version: 3, subscribers: [], claim: null, finishedAt: tc });

  h.at(tc + TTL).assertSilent();
  assertTask(h, id2, { state: 'done' });
  h.at(tc + TTL + 1).assertSilent('TTL deletion sends no message');
  assertTask(h, id2, null);
  assert.equal(h.bus.ofType('task.done').length, 0);
});

test('F7.3 publisher disconnects: T has two subscribers, P and Q; after P\'s grace period expires T is kept and only Q remains as a subscriber; on completion only Q is notified', () => {
  const { h, id } = setup();
  h.publisher('q', 'pub-2', { userId: 'u2' });
  h.publish('q', [T_IN]);
  assertTask(h, id, { subscribers: ['pub-1', 'pub-2'] });
  h.bus.clear();

  h.disconnect('p');
  h.at(T0 + GRACE + 1).assertSilent('T still has subscribers, not deleted');
  assertTask(h, id, { state: 'open', version: 1, subscribers: ['pub-2'] });
  assert.equal(h.publisherInfo('pub-1'), null);
  assert.equal(h.publisherInfo('pub-2').connected, true);

  // P reconnects with same identity: record deleted, it is a new publisher, no longer a subscriber to T
  h.publisher('p2', 'pub-1');
  claimOk(h, 'a', id, 1);
  const out = h.complete('a', id, 2, { ranges: [[0, 59]] });
  assert.equal(out.one('q', 'task.done').id, id);
  assert.equal(out.of('p2', 'task.done').length, 0);
  assert.equal(out.ofType('task.done').length, 1);
});

test('F7.4 publisher disconnects: reconnects with the same identity within the grace period, subscriptions are kept, the task is not deleted', () => {
  const { h, id } = setup();
  h.disconnect('p');
  h.clock.set(T0 + 5_000);
  const hello = h.publisher('p2', 'pub-1');
  assert.equal(hello.one('p2', 'publisher.welcome').publisherId, 'pub-1');
  assert.deepEqual(h.publisherInfo('pub-1'), { publisherId: 'pub-1', connected: true, disconnectedAt: null });

  h.at(T0 + GRACE + 1).assertSilent('Reconnected, not deleted');
  assertTask(h, id, { state: 'open', version: 1, subscribers: ['pub-1'] });

  claimOk(h, 'a', id, 1);
  const out = h.complete('a', id, 2, { ranges: [[0, 59]] });
  assert.equal(out.one('p2', 'task.done').id, id, 'Completion notice goes to the new connection');
  assert.equal(out.ofType('task.done').length, 1);
});

/* ============================================================ F8 Document service restart */

/** Q1: P publishes T, A claims (t1 = 2). Q2: new instance (new epoch), same batch of identities reconnects. */
function restartSetup({ q1Done = false } = {}) {
  const h1 = createQueueHarness(createRenderQueue);
  h1.publisher('p', 'pub-1');
  h1.node('a', 'node-A');
  h1.publish('p', [T_IN]);
  claimOk(h1, 'a', T_IN.id, 1);
  if (q1Done) h1.complete('a', T_IN.id, 2, { ranges: [[0, 59]] });
  const h2 = createQueueHarness(createRenderQueue);
  return { h1, h2, id: T_IN.id };
}

test('F8.1 document service restart: the new instance\'s epoch differs from the old one, the hello reply carries the new epoch, the task table is empty', () => {
  const { h1, h2 } = restartSetup();
  assert.equal(typeof h1.q.epoch, 'string');
  assert.equal(typeof h2.q.epoch, 'string');
  assert.ok(h2.q.epoch.length > 0);
  assert.notEqual(h2.q.epoch, h1.q.epoch);

  const ph = h2.publisher('p', 'pub-1');
  assert.equal(ph.one('p', 'publisher.welcome').epoch, h2.q.epoch);
  const nh = h2.node('a', 'node-A', { watch: null });
  const w = assertWelcome(nh, 'a', { nodeId: 'node-A', resumed: [], lost: [] });
  assert.equal(w.epoch, h2.q.epoch);
  assert.notEqual(w.epoch, h1.q.epoch);

  const d = h2.describe();
  assert.equal(d.epoch, h2.q.epoch);
  assert.deepEqual(d.tasks, []);
  const snap = h2.watch('a').one('a', 'queue.snapshot');
  assert.deepEqual(snap.tasks, []);
});

test('F8.2 document service restart: A resumes the old claim on the new instance and is answered with lease-lost (reason epoch)', () => {
  const { h2, id } = restartSetup();
  const out = h2.node('a', 'node-A', { resume: [{ id, token: 2 }], watch: null });
  assertWelcome(out, 'a', { nodeId: 'node-A', resumed: [], lost: [id] });
  const ll = assertLeaseLost(out, 'a', { id, token: 2, reason: 'epoch' });
  assert.equal(ll.epoch, h2.q.epoch);
  assert.deepEqual(h2.describe().tasks, []);
});

test('F8.3 document service restart: P republishes T on the new instance, T is open with version starting at 1, A can claim it normally', () => {
  const { h2, id } = restartSetup();
  h2.publisher('p', 'pub-1');
  h2.node('a', 'node-A');
  const out = h2.publish('p', [T_IN]);
  assert.deepEqual(out.one('p', 'task.published').results[0], { id, state: 'open', version: 1, created: true });
  assert.equal(out.one('a', 'task.opened').task.version, 1);
  assertTask(h2, id, { state: 'open', version: 1, attempts: 0, claim: null, subscribers: ['pub-1'] });
  const { msg } = claimOk(h2, 'a', id, 1);
  assert.equal(msg.token, 2);
  assertTask(h2, id, { state: 'claimed', version: 2, claim: { nodeId: 'node-A', token: 2 } });
});

test('F8.4 document service restart: T was already done on the old instance; republished on the new instance it is open (the new instance does not know about the earlier completion)', () => {
  const { h1, h2, id } = restartSetup({ q1Done: true });
  assertTask(h1, id, { state: 'done' });
  h2.publisher('p', 'pub-1');
  const out = h2.publish('p', [T_IN]);
  assert.deepEqual(out.one('p', 'task.published').results[0], { id, state: 'open', version: 1, created: true });
  assert.deepEqual(out.types('p'), ['task.published'], 'No task.done reply');
  assertTask(h2, id, { state: 'open', version: 1, attempts: 0 });
});

/* ============================================================ F9 Two nodes both believe they hold the same task during grace period */

test('F9.1 two nodes both think they hold the same task during the grace period: within A\'s grace period after disconnecting, B claims with the current version and gets taken, T stays claimed', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.disconnect('a');
  h.clock.set(T0 + 5_000);
  const out = h.claim('b', id, h.task(id).version);
  const rej = out.one('b', 'task.claim-rejected');
  assert.deepEqual([rej.id, rej.reason, rej.state, rej.version], [id, 'taken', 'claimed', 2]);
  assert.deepEqual(out.conns(), ['b']);
  assertTask(h, id, { state: 'claimed', version: 2, attempts: 0, claim: { nodeId: 'node-A', token: 2 } });
});

test('F9.2 two nodes both think they hold the same task during the grace period: after the grace period expires B claims and gets t2, A reconnects with t1 and resumes, receives lease-lost, only B holds it', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.disconnect('a');
  h.at(T0 + GRACE + 1);
  const { msg } = claimOk(h, 'b', id, 3);
  assert.equal(msg.token, 4);

  const out = h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });
  assertWelcome(out, 'a2', { nodeId: 'node-A', resumed: [], lost: [id] });
  assertLeaseLost(out, 'a2', { id, token: 2, reason: 'not-owner' });
  assert.deepEqual(out.conns(), ['a2']);
  assertTask(h, id, { state: 'claimed', version: 4, attempts: 1, claim: { nodeId: 'node-B', token: 4 } });
  assert.equal(h.progress('b', id, 4, 1).one('b', 'task.renewed').token, 4, 'B\'s token is still valid');
});

test('F9.3 two nodes both think they hold the same task during the grace period: A completes with t1 and gets lease-lost, only B\'s complete takes effect, and subscribers receive task.done only once', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.disconnect('a');
  h.at(T0 + GRACE + 1);
  claimOk(h, 'b', id, 3);
  h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });

  const late = h.complete('a2', id, 2, { ranges: [[0, 59]] });
  assertLeaseLost(late, 'a2', { id, token: 2, reason: 'token' });
  assert.deepEqual(late.conns(), ['a2']);
  assertTask(h, id, { state: 'claimed', version: 4, claim: { nodeId: 'node-B', token: 4 } });

  const ok = h.complete('b', id, 4, { ranges: [[0, 59]] });
  assert.equal(ok.one('b', 'task.completed').id, id);
  assertTask(h, id, { state: 'done', version: 5, claim: null });
  assert.equal(h.bus.of('p', 'task.done').length, 1);
  assert.equal(h.bus.ofType('task.done').length, 1);
});
