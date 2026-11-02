/**
 * M2 render node session state machine (contract B.5), plus one "session × real queue" joint test
 * (last line of contract Section C).
 * Run: node --test server/test/render-node-session.test.mjs
 *
 * Written strictly to `docs/plan/render-queue-contract.md` (hereafter "contract") B.5, Section A
 * message format, and `docs/plan/distributed-prerender-queue.md` Sections 4 and 4.4, without looking
 * at the implementation.
 *
 * Unit test part: session `send` is collected into an array, and queue responses are handwritten by
 * the test (shapes following contract A.6 / A.7). The clock is a local fake clock; session `random`
 * injects constants or fixed-seed pseudorandom numbers, making results deterministic.
 *
 * Asserts only what is explicitly specified in the contract. The test intentionally bypasses a few
 * places left unspecified where implementations may choose either approach:
 *   - Whether the session keeps the task in its own `known()` after a successful claim (the queue
 *     sends `task.taken` only to "other" watchers, so this depends on the session itself): all
 *     scenarios affected by it produce the same result under both approaches;
 *   - Whether outbound messages include `reqId` beyond the fields listed in the contract: compares
 *     only the listed fields.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeSession } from '../render-node/session.mjs';
import { createRenderQueue, taskIdOf } from '../render-queue/index.mjs';

const FP = '0123456789abcdef';
const CV = 'c0de5a';
const EPOCH = 'epoch-test';
const LEASE = 30_000;       // Default value of LEASE_MS in contract A.2, used only to fill leaseUntil in handwritten responses
const RENEW = 10_000;       // Default value of RENEW_INTERVAL_MS in contract A.2

const NODE = Object.freeze({
  profile: 'host', userId: 'u1', envFingerprint: FP, codeVersions: [CV], cardSourceVersions: {},
  capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 8000 },
});

/** Create an open TaskView (contract A.4). */
function view(name, { projectId = 'p1', priority = 10, publishedAt = 1, version = 1, userId = 'u1', weight = 'medium', requires = {} } = {}) {
  return {
    id: `snapshot:${name}:0-59`, kind: 'snapshot', tier: 'shared', resultKey: name,
    range: { unit: 'localFrame', from: 0, to: 59 },
    source: { userId, tenantId: 't1', projectId, projectRev: 1, publisher: { id: 'P' }, publishedAt, derivedFrom: null },
    // M7 D4 (filter.mjs rule 7): browser-only only accepts shared tier standalone cards;
    // splitter writes input.compositing in the browser copy
    input: { compositing: 'independent' }, weight: { class: weight, estMs: null, frames: 60 },
    requires: { envFingerprint: FP, codeVersion: CV, ...requires },
    priority, state: 'open', version, attempts: 0,
  };
}

// Messages from the queue (contract A.6 / A.7; all carry epoch)
const msg = {
  snapshot: tasks => ({ type: 'queue.snapshot', epoch: EPOCH, tasks }),
  opened: task => ({ type: 'task.opened', epoch: EPOCH, task }),
  taken: (id, version) => ({ type: 'task.taken', epoch: EPOCH, id, version }),
  closed: (id, state) => ({ type: 'task.closed', epoch: EPOCH, id, state }),
  claimed: (task, token, at) => ({
    type: 'task.claimed', epoch: EPOCH, id: task.id, token, version: token, leaseUntil: at + LEASE,
    task: { ...task, state: 'claimed', version: token },
  }),
  rejected: (id, reason, extra = {}) => ({ type: 'task.claim-rejected', epoch: EPOCH, id, reason, ...extra }),
  leaseLost: (id, token, reason) => ({ type: 'task.lease-lost', epoch: EPOCH, id, token, reason }),
  welcome: (nodeId, resumed, lost) => ({ type: 'node.welcome', epoch: EPOCH, nodeId, resumed, lost }),
  renewed: (id, token, at) => ({ type: 'task.renewed', epoch: EPOCH, id, token, leaseUntil: at + LEASE }),
};

/** Extract only the fields listed in the contract for comparison. */
const fields = (m, keys) => Object.fromEntries(keys.map(k => [k, m[k]]));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * A session plus its fake clock, outbox, and callback log. By default start() has been called and
 * the outbox is emptied. `over` overrides parameters of createNodeSession.
 */
function harness(over = {}, { start = true } = {}) {
  let t = 1_000;
  let idle = true;
  const sent = [], started = [], lost = [];
  const session = createNodeSession({
    nodeId: 'node-1', node: NODE, send: m => sent.push(m), now: () => t, random: () => 0,
    isIdle: () => idle,
    onTask: (task, info) => started.push({ task, info }),
    onLost: (id, reason) => lost.push({ id, reason }),
    ...over,
  });
  const h = {
    session, sent, started, lost,
    get now() { return t; },
    set: ms => { t = ms; },
    advance: ms => { t += ms; },
    setIdle: v => { idle = v; },
    /** Retrieve and clear a specific type of (or all) messages in the outbox. */
    drain(type) {
      const out = type ? sent.filter(m => m.type === type) : sent.slice();
      sent.length = 0;
      return out;
    },
    of: type => sent.filter(m => m.type === type),
    /** Tick once, replying to the task.claim sent this time. */
    tickClaims() { sent.length = 0; session.tick(); return sent.filter(m => m.type === 'task.claim'); },
    /** Complete one claim round-trip per contract: tick → exactly one task.claim → reply task.claimed. Returns token. */
    claim(task, token) {
      const claims = h.tickClaims();
      assert.equal(claims.length, 1, 'This tick should send exactly one claim');
      assert.equal(claims[0].id, task.id, `Should claim ${task.id}, got ${claims[0].id}`);
      session.receive(msg.claimed(task, token, t));
      sent.length = 0;
      return token;
    },
  };
  if (start) { session.start(); sent.length = 0; }
  return h;
}

// ---------------------------------------------------------------- start

test('B.5 start: sends node.hello first (with the node description and resume), then immediately sends queue.watch { projects: \'all\' }', () => {
  const h = harness({}, { start: false });
  h.session.start();
  assert.equal(h.sent.length, 2, 'Exactly two');
  const [hello, watch] = h.sent;
  assert.equal(hello.type, 'node.hello');
  assert.deepEqual(fields(hello, ['nodeId', 'profile', 'envFingerprint', 'capabilities', 'codeVersions', 'maxConcurrent', 'resume']), {
    nodeId: 'node-1', profile: 'host', envFingerprint: FP, capabilities: NODE.capabilities, codeVersions: [CV], maxConcurrent: 1, resume: [],
  });
  assert.equal(watch.type, 'queue.watch');
  assert.equal(watch.projects, 'all');
});

test('B.5 start: resume is passed as is; maxConcurrent and projects come from the arguments', () => {
  const h = harness({ maxConcurrent: 3, projects: ['p1', 'p2'] }, { start: false });
  const resume = [{ id: 'snapshot:a:0-59', token: 4 }, { id: 'snapshot:b:0-59', token: 9 }];
  h.session.start(resume);
  assert.deepEqual(h.sent.map(m => m.type), ['node.hello', 'queue.watch']);
  assert.deepEqual(h.sent[0].resume, resume);
  assert.equal(h.sent[0].maxConcurrent, 3);
  assert.deepEqual(h.sent[1].projects, ['p1', 'p2']);
});

// ---------------------------------------------------------------- Local view

test('B.5 local view: queue.snapshot replaces it wholesale, known() is in ascending id order', () => {
  const { session } = harness();
  const a = view('a'), b = view('b'), c = view('c');
  session.receive(msg.snapshot([c, a]));
  assert.deepEqual(session.known().map(t => t.id), [a.id, c.id]);
  session.receive(msg.snapshot([b]));
  assert.deepEqual(session.known().map(t => t.id), [b.id], 'All old ones are replaced');
  assert.deepEqual(session.known()[0], b);
  session.receive(msg.snapshot([]));
  assert.deepEqual(session.known(), []);
});

test('B.5 local view: task.opened adds; the same id again is an update, not a duplicate', () => {
  const { session } = harness();
  const a = view('a'), b = view('b');
  session.receive(msg.snapshot([b]));
  session.receive(msg.opened(a));
  assert.deepEqual(session.known().map(t => t.id), [a.id, b.id]);
  session.receive(msg.opened({ ...a, version: 3, priority: 50 }));
  assert.equal(session.known().length, 2);
  const got = session.known().find(t => t.id === a.id);
  assert.equal(got.version, 3);
  assert.equal(got.priority, 50);
});

test('B.5 local view: task.taken and task.closed (done / failed / removed) remove', () => {
  const { session } = harness();
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(n => view(n));
  session.receive(msg.snapshot([a, b, c, d, e]));
  session.receive(msg.taken(a.id, 2));
  session.receive(msg.closed(b.id, 'done'));
  session.receive(msg.closed(c.id, 'failed'));
  session.receive(msg.closed(d.id, 'removed'));
  assert.deepEqual(session.known().map(t => t.id), [e.id]);
  // Unknown ids have no effect
  session.receive(msg.taken('snapshot:zz:0-59', 7));
  session.receive(msg.closed('snapshot:zz:0-59', 'done'));
  assert.deepEqual(session.known().map(t => t.id), [e.id]);
});

// ---------------------------------------------------------------- Claim

test('B.5 claim: tick sends task.claim { id, expectVersion: task.version }; at most one per tick', () => {
  const h = harness({ maxConcurrent: 3 });
  const tasks = [view('a', { publishedAt: 1, version: 4, projectId: 'p1' }), view('b', { publishedAt: 2, projectId: 'p2' }), view('c', { publishedAt: 3, projectId: 'p3' })];
  h.session.receive(msg.snapshot(tasks));
  const claims = h.tickClaims();
  assert.equal(claims.length, 1);
  assert.deepEqual(fields(claims[0], ['type', 'id', 'expectVersion']), { type: 'task.claim', id: tasks[0].id, expectVersion: 4 });
});

test('B.5 claim: picks by pickCandidate among the tasks that pass filterClaimable (higher priority first)', () => {
  const h = harness();
  const low = view('low', { priority: 10, publishedAt: 1 });
  const high = view('high', { priority: 50, publishedAt: 9 });
  const wrongEnv = view('wrong-env', { priority: 100, requires: { envFingerprint: 'ffffffffffffffff' } });
  const wrongCode = view('wrong-code', { priority: 100, requires: { codeVersion: 'other' } });
  h.session.receive(msg.snapshot([low, wrongEnv, high, wrongCode]));
  const claims = h.tickClaims();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].id, high.id);
});

test('B.5 claim: tick sends nothing when there is no claimable task', () => {
  const h = harness();
  h.session.tick();
  assert.deepEqual(h.drain(), []);
  h.session.receive(msg.snapshot([view('x', { requires: { envFingerprint: 'ffffffffffffffff' } })]));
  h.session.tick();
  assert.deepEqual(h.drain(), []);
});

test('B.5 claim: a browser node does not claim tasks of other users, heavy tasks or plan tasks (via filterClaimable)', () => {
  const browser = { ...NODE, profile: 'browser', userId: 'u1', capabilities: { transcode: false, userCards: false, graphCards: false } };
  const h = harness({ node: browser });
  const others = view('others', { priority: 100, userId: 'u2' });
  const heavy = view('heavy', { priority: 100, weight: 'heavy' });
  const plan = { ...view('plan'), id: 'plan:p1@1', kind: 'plan', resultKey: 'p1@1', range: null, priority: 100, requires: {} };
  delete plan.tier;
  const mine = view('mine', { priority: 1 });
  h.session.receive(msg.snapshot([others, heavy, plan, mine]));
  const claims = h.tickClaims();
  assert.deepEqual(claims.map(m => m.id), [mine.id]);
});

test('B.5 claim: tick does not claim again while a claim is in flight, even if maxConcurrent has room left', () => {
  const h = harness({ maxConcurrent: 3 });
  h.session.receive(msg.snapshot([view('a', { projectId: 'p1' }), view('b', { projectId: 'p2' }), view('c', { projectId: 'p3' })]));
  assert.equal(h.tickClaims().length, 1);
  assert.equal(h.tickClaims().length, 0, 'In flight');
  h.advance(5_000);
  assert.equal(h.tickClaims().length, 0, 'Still in flight even after time has passed');
});

test('B.5 claim result task.claimed: adds to held (lastSentAt = now), clears in flight, calls onTask(task, { token })', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  const [claim] = h.tickClaims();
  assert.equal(claim.id, a.id);
  h.advance(40);
  const reply = msg.claimed(a, 2, h.now);
  h.session.receive(reply);
  assert.deepEqual(h.session.held(), [{ id: a.id, token: 2, lastSentAt: h.now }]);
  assert.equal(h.started.length, 1);
  assert.deepEqual(h.started[0].task, reply.task);
  assert.equal(h.started[0].info.token, 2);
  // In-flight cleared: continue claiming if capacity remains (second one, and from another project)
  const next = h.tickClaims();
  assert.deepEqual(next.map(m => m.id), [b.id]);
});

test('B.5 claim: no more claims once the number held reaches maxConcurrent (default 1)', () => {
  const h = harness();
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  assert.equal(h.tickClaims().length, 0);
  h.advance(1_000);
  assert.equal(h.tickClaims().length, 0);
});

test('B.5 claim: with maxConcurrent 2, claims one at a time up to 2', () => {
  const h = harness({ maxConcurrent: 2 });
  const [a, b, c] = [['a', 'p1'], ['b', 'p2'], ['c', 'p3']].map(([n, p], i) => view(n, { projectId: p, publishedAt: i + 1 }));
  h.session.receive(msg.snapshot([a, b, c]));
  h.claim(a, 2);
  h.claim(b, 2);
  assert.equal(h.tickClaims().length, 0, 'Holding 2, full');
  assert.deepEqual(h.session.held().map(x => x.id).sort(), [a.id, b.id].sort());
});

test('B.5 claim-rejected stale: sets the version of the local task to the version in the reply, clears in flight, and claims again with the new version on the next tick', () => {
  const h = harness();
  const a = view('a', { version: 1 });
  h.session.receive(msg.snapshot([a]));
  assert.deepEqual(h.tickClaims().map(m => [m.id, m.expectVersion]), [[a.id, 1]]);
  h.session.receive(msg.rejected(a.id, 'stale', { state: 'open', version: 4 }));
  assert.equal(h.session.known().find(t => t.id === a.id)?.version, 4);
  assert.deepEqual(h.tickClaims().map(m => [m.id, m.expectVersion]), [[a.id, 4]]);
  assert.equal(h.started.length, 0, 'onTask is not called when rejected');
});

for (const reason of ['taken', 'gone', 'forbidden']) {
  test(`B.5 claim-rejected ${reason}: removed from the local view, in flight cleared, and another task is claimed on the next tick`, () => {
    const h = harness();
    const a = view('a', { publishedAt: 1 }), b = view('b', { publishedAt: 2, version: 3 });
    h.session.receive(msg.snapshot([a, b]));
    assert.deepEqual(h.tickClaims().map(m => m.id), [a.id]);
    const extra = reason === 'taken' ? { state: 'claimed', version: 2 } : {};
    h.session.receive(msg.rejected(a.id, reason, extra));
    assert.deepEqual(h.session.known().map(t => t.id), [b.id]);
    assert.deepEqual(h.tickClaims().map(m => [m.id, m.expectVersion]), [[b.id, 3]]);
    assert.equal(h.started.length, 0);
    assert.deepEqual(h.session.held(), []);
  });
}

test('B.5 claim: lastProjectId is the project of the last successful claim, and within the same priority it switches project', () => {
  const h = harness({ maxConcurrent: 2 });
  // Ranking: A(p1) B(p1) C(p2), same priority; random is always 0
  const a = view('a', { projectId: 'p1', publishedAt: 1 });
  const b = view('b', { projectId: 'p1', publishedAt: 2 });
  const c = view('c', { projectId: 'p2', publishedAt: 3 });
  h.session.receive(msg.snapshot([a, b, c]));
  h.claim(a, 2);
  // Last successful was p1: only keep C with p2 among the same priority
  assert.deepEqual(h.tickClaims().map(m => m.id), [c.id]);
});

test('B.5 claim: a rejected attempt does not count as a "successful claim" and does not change lastProjectId', () => {
  const h = harness();
  const a = view('a', { projectId: 'p1', publishedAt: 1 });
  const b = view('b', { projectId: 'p1', publishedAt: 2 });
  const c = view('c', { projectId: 'p2', publishedAt: 3 });
  h.session.receive(msg.snapshot([a, b, c]));
  assert.deepEqual(h.tickClaims().map(m => m.id), [a.id]);
  h.session.receive(msg.rejected(a.id, 'taken', { state: 'claimed', version: 2 }));
  // Never succeeded: do not filter by project; random 0 picks top rank B
  assert.deepEqual(h.tickClaims().map(m => m.id), [b.id]);
});

test('B.5 claim: the candidate count k comes from constants.PICK_K (default 4), and random comes from the arguments', () => {
  const five = [1, 2, 3, 4, 5].map(n => view(`t${n}`, { publishedAt: n }));
  const pickWith = (over) => {
    const h = harness({ random: () => 0.999999, ...over });
    h.session.receive(msg.snapshot(five));
    return h.tickClaims().map(m => m.id);
  };
  assert.deepEqual(pickWith({}), [five[3].id], 'Default K = 4');
  assert.deepEqual(pickWith({ constants: { PICK_K: 1 } }), [five[0].id]);
  assert.deepEqual(pickWith({ constants: { PICK_K: 5 } }), [five[4].id]);
  const mid = harness({ random: () => 0.5 });
  mid.session.receive(msg.snapshot(five));
  assert.deepEqual(mid.tickClaims().map(m => m.id), [five[2].id]);
});

test('B.5 not idle: tick does not claim; claims once it is idle again', () => {
  const h = harness();
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.setIdle(false);
  h.session.tick();
  assert.deepEqual(h.drain(), []);
  h.advance(RENEW * 3);
  h.session.tick();
  assert.deepEqual(h.drain(), []);
  h.setIdle(true);
  assert.deepEqual(h.tickClaims().map(m => m.id), [a.id]);
});

// ---------------------------------------------------------------- Renew

test('B.5 renewal: task.progress is sent only when now - lastSentAt >= RENEW_INTERVAL_MS, and done is null if it was never reported', () => {
  const h = harness();
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 2);
  const claimedAt = h.now;
  h.set(claimedAt + RENEW - 1);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress'), [], 'Not sent when 1 ms short');
  h.set(claimedAt + RENEW);
  h.session.tick();
  const [p] = h.drain('task.progress');
  assert.deepEqual(fields(p, ['type', 'id', 'token', 'done']), { type: 'task.progress', id: a.id, token: 2, done: null });
  assert.equal(h.session.held()[0].lastSentAt, claimedAt + RENEW);
  // Just renewed: will not send again at the same timestamp or next millisecond
  h.session.tick();
  h.advance(1);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress'), []);
  // Next full interval
  h.set(claimedAt + 2 * RENEW);
  h.session.tick();
  assert.equal(h.drain('task.progress').length, 1);
});

test('B.5 renewal: one tick renews each held task at most once; each is computed by its own lastSentAt', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  const tA = h.now;
  h.advance(3_000);
  h.claim(b, 7);
  const tB = h.now;
  h.set(tA + RENEW);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress').map(m => [m.id, m.token]), [[a.id, 2]]);
  h.set(tB + RENEW);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress').map(m => [m.id, m.token]), [[b.id, 7]]);
  // Large jump skipping several intervals: send only one message per task as well
  h.advance(RENEW * 5);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress').map(m => m.id).sort(), [a.id, b.id].sort());
});

test('B.5 renewal: the interval comes from constants.RENEW_INTERVAL_MS', () => {
  const h = harness({ constants: { RENEW_INTERVAL_MS: 1_000 } });
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 2);
  const t0 = h.now;
  h.set(t0 + 999);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress'), []);
  h.set(t0 + 1_000);
  h.session.tick();
  assert.equal(h.drain('task.progress').length, 1);
});

test('B.5 not idle: does not claim new tasks but renews as usual', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  const t0 = h.now;
  h.setIdle(false);
  h.set(t0 + RENEW);
  h.session.tick();
  const out = h.drain();
  assert.deepEqual(out.map(m => [m.type, m.id]), [['task.progress', a.id]], 'Only renews, does not claim B');
});

test('B.5 progress(): records the progress and sends task.progress immediately, refreshing lastSentAt; later renewals carry the latest value', () => {
  const h = harness();
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 2);
  const t0 = h.now;
  h.set(t0 + 4_000);
  h.session.progress(a.id, 12);
  const [p] = h.drain('task.progress');
  assert.deepEqual(fields(p, ['type', 'id', 'token', 'done']), { type: 'task.progress', id: a.id, token: 2, done: 12 });
  assert.equal(h.session.held()[0].lastSentAt, t0 + 4_000);
  h.set(t0 + 5_000);
  h.session.progress(a.id, 20);
  assert.deepEqual(h.drain('task.progress').map(m => m.done), [20]);
  // Renewal is calculated starting from the most recent progress()
  h.set(t0 + 5_000 + RENEW - 1);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress'), []);
  h.set(t0 + 5_000 + RENEW);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress').map(m => [m.token, m.done]), [[2, 20]]);
});

test('B.5 progress(): sends nothing when the task is not held', () => {
  const h = harness();
  h.session.progress('snapshot:nope:0-59', 3);
  assert.deepEqual(h.drain(), []);
});

// ---------------------------------------------------------------- Done, fail, yield

test('B.5 complete(): sends task.complete { id, token, result }, removes the hold locally, and no longer renews afterwards', () => {
  const h = harness();
  const a = view('a', { publishedAt: 1 }), b = view('b', { publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  const t0 = h.now;
  const result = { ranges: [[0, 59]] };
  h.session.complete(a.id, result);
  const out = h.drain();
  assert.equal(out.length, 1);
  assert.deepEqual(fields(out[0], ['type', 'id', 'token', 'result']), { type: 'task.complete', id: a.id, token: 2, result });
  assert.deepEqual(h.session.held(), []);
  // The real queue then sends task.closed to all visible watchers (including this node)
  h.session.receive(msg.closed(a.id, 'done'));
  h.set(t0 + RENEW * 2);
  const next = h.tickClaims();
  assert.deepEqual(h.of('task.progress'), []);
  assert.deepEqual(next.map(m => m.id), [b.id], 'Nothing held anymore, so the next one can be claimed');
});

test('B.5 fail(): sends task.fail { id, token, error, retryable } (retryable defaults to true) and removes the hold locally', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  h.claim(b, 5);
  const t0 = h.now;
  h.session.fail(a.id, 'boom');
  h.session.fail(b.id, 'bad input', false);
  const out = h.drain();
  assert.deepEqual(out.map(m => fields(m, ['type', 'id', 'token', 'error', 'retryable'])), [
    { type: 'task.fail', id: a.id, token: 2, error: 'boom', retryable: true },
    { type: 'task.fail', id: b.id, token: 5, error: 'bad input', retryable: false },
  ]);
  assert.deepEqual(h.session.held(), []);
  h.set(t0 + RENEW);
  h.session.tick();
  assert.deepEqual(h.of('task.progress'), []);
});

test('B.5 yieldAll(): sends task.release for each held task (reason defaults to busy) and clears the holds locally', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  h.claim(b, 5);
  const t0 = h.now;
  h.session.yieldAll();
  const out = h.drain();
  assert.deepEqual(out.map(m => fields(m, ['type', 'id', 'token', 'reason'])).sort(byId), [
    { type: 'task.release', id: a.id, token: 2, reason: 'busy' },
    { type: 'task.release', id: b.id, token: 5, reason: 'busy' },
  ]);
  assert.deepEqual(h.session.held(), []);
  h.set(t0 + RENEW);
  h.setIdle(false);
  h.session.tick();
  assert.deepEqual(h.drain(), [], 'Not idle: neither renewal nor claim');
});

test('B.5 yieldAll(reason): carries the given reason; sends nothing when nothing is held', () => {
  const h = harness();
  h.session.yieldAll('playing');
  assert.deepEqual(h.drain(), []);
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 2);
  h.session.yieldAll('playing');
  assert.deepEqual(h.drain().map(m => fields(m, ['type', 'id', 'token', 'reason'])), [{ type: 'task.release', id: a.id, token: 2, reason: 'playing' }]);
});

// ---------------------------------------------------------------- Lost claim

test('B.5 task.lease-lost: removes the hold, calls onLost(id, reason), and no longer renews afterwards; other holds are unaffected', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  h.claim(b, 5);
  const t0 = h.now;
  h.session.receive(msg.leaseLost(a.id, 2, 'expired'));
  assert.deepEqual(h.lost, [{ id: a.id, reason: 'expired' }]);
  assert.deepEqual(h.session.held().map(x => x.id), [b.id]);
  h.set(t0 + RENEW);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress').map(m => m.id), [b.id]);
});

test('B.5 lost in node.welcome: likewise removes the hold and calls onLost; resumed ones are still held and renewed as usual', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  h.claim(b, 5);
  const t0 = h.now;
  // Reconnect: take held claims to resume
  const resume = h.session.held().map(({ id, token }) => ({ id, token }));
  h.session.start(resume);
  const hello = h.drain('node.hello')[0];
  assert.deepEqual([...hello.resume].sort(byId), [{ id: a.id, token: 2 }, { id: b.id, token: 5 }]);
  h.session.receive(msg.welcome('node-1', [a.id], [b.id]));
  assert.ok(h.lost.some(x => x.id === b.id), 'onLost was called for b');
  assert.ok(!h.lost.some(x => x.id === a.id), 'a was not lost');
  assert.deepEqual(h.session.held().map(x => x.id), [a.id]);
  h.set(t0 + RENEW);
  h.session.tick();
  assert.deepEqual(h.drain('task.progress').map(m => [m.id, m.token]), [[a.id, 2]]);
});

test('B.5 other replies (task.renewed, task.completed, task.released, task.fail-ack) do not change the holds', () => {
  const h = harness();
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 2);
  h.advance(3_000);
  const before = h.session.held();
  h.session.receive(msg.renewed(a.id, 2, h.now));
  h.session.receive({ type: 'task.completed', epoch: EPOCH, id: a.id });
  h.session.receive({ type: 'task.released', epoch: EPOCH, id: a.id });
  h.session.receive({ type: 'task.fail-ack', epoch: EPOCH, id: a.id, state: 'open' });
  assert.deepEqual(h.session.held(), before);
  assert.deepEqual(h.lost, []);
  assert.deepEqual(h.drain(), [], 'These replies trigger no messages');
});

test('B.5 resumed in node.welcome: lastSentAt is set to now - RENEW_INTERVAL_MS, so the next tick renews immediately; onLost is not called when lost is empty (B.5 supplementary rule)', () => {
  const h = harness();
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 2);
  const t0 = h.now;
  h.session.progress(a.id, 7);
  // Reconnect 2 seconds after disconnection, well before one renewal interval
  h.set(t0 + 2_000);
  h.session.start([{ id: a.id, token: 2 }]);
  h.drain();
  h.session.receive(msg.welcome('node-1', [a.id], []));
  assert.deepEqual(h.lost, []);
  assert.deepEqual(h.session.held(), [{ id: a.id, token: 2, lastSentAt: t0 + 2_000 - RENEW }]);
  h.session.tick();
  const progress = h.drain('task.progress');
  assert.equal(progress.length, 1, 'Renews immediately without waiting for the full interval');
  assert.deepEqual(fields(progress[0], ['id', 'token']), { id: a.id, token: 2 });
  assert.equal(h.session.held()[0].lastSentAt, t0 + 2_000);
});

test('B.5 after welcome.lost, a task.lease-lost with the same id no longer calls onLost again; the reason of welcome.lost is lost (B.5 supplementary rule)', () => {
  const h = harness({ maxConcurrent: 2 });
  const a = view('a', { projectId: 'p1', publishedAt: 1 }), b = view('b', { projectId: 'p2', publishedAt: 2 });
  h.session.receive(msg.snapshot([a, b]));
  h.claim(a, 2);
  h.claim(b, 5);
  h.session.start([{ id: a.id, token: 2 }, { id: b.id, token: 5 }]);
  h.session.receive(msg.welcome('node-1', [a.id], [b.id]));
  h.session.receive(msg.leaseLost(b.id, 5, 'token'));
  assert.deepEqual(h.lost, [{ id: b.id, reason: 'lost' }]);
  assert.deepEqual(h.session.held().map(x => x.id), [a.id]);
});

test('B.5 a task.lease-lost whose token does not match the held one is ignored (a late message from an old claim, B.5 supplementary rule)', () => {
  const h = harness();
  const a = view('a');
  h.session.receive(msg.snapshot([a]));
  h.claim(a, 5);
  const before = h.session.held();
  h.session.receive(msg.leaseLost(a.id, 2, 'expired'));
  assert.deepEqual(h.lost, []);
  assert.deepEqual(h.session.held(), before);
  // Process normally if tokens match
  h.session.receive(msg.leaseLost(a.id, 5, 'expired'));
  assert.deepEqual(h.lost, [{ id: a.id, reason: 'expired' }]);
  assert.deepEqual(h.session.held(), []);
});

// ---------------------------------------------------------------- Joint test: session × real queue

/** Fixed-seed pseudorandom number (mulberry32), [0, 1). */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** 20 valid TaskInput items (contract A.4), alternating two projects, first 4 high priority. */
function taskInputs(n = 20) {
  return Array.from({ length: n }, (_, i) => {
    const resultKey = `rk-${String(i).padStart(2, '0')}`;
    const range = { unit: 'localFrame', from: 0, to: 59 };
    return {
      id: taskIdOf({ kind: 'snapshot', resultKey, range }), kind: 'snapshot', tier: 'shared', resultKey, range,
      source: { projectId: i % 2 ? 'pA' : 'pB', projectRev: 1 },
      input: { clipId: `clip-${i}` },
      weight: { class: 'medium', estMs: null, frames: 60 },
      requires: { envFingerprint: FP, codeVersion: CV },
      priority: i < 4 ? 50 : 10,
    };
  });
}

/**
 * One real queue, one publisher, two node sessions, with messages round-tripping via "wire"
 * (structuredClone).
 * Each step: clock advances → queue tick → node reports progress / reports completion → deliver
 * only after **both** sessions have ticked, so the two nodes often race for the same task based
 * on the same view, colliding into taken.
 */
function jointRig({ workMs = i => 1_000 + (i % 5) * 250 } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const toQueue = [];          // [connId, message]
  const toConn = new Map();    // connId → message[]
  const publisherInbox = [];
  const queue = createRenderQueue({
    now, epoch: 'epoch-joint',
    send: (connId, m) => { if (!toConn.has(connId)) toConn.set(connId, []); toConn.get(connId).push(structuredClone(m)); },
  });
  const principal = { userId: 'u1', tenantId: 't1' };
  queue.connect('conn-pub', principal);
  queue.handle('conn-pub', { type: 'publisher.hello', publisherId: 'P' });

  const inputs = taskInputs();
  const indexOf = new Map(inputs.map((x, i) => [x.id, i]));
  const nodes = ['node-a', 'node-b'].map((nodeId, k) => {
    const connId = `conn-${nodeId}`;
    queue.connect(connId, principal);
    const rec = { nodeId, connId, idle: true, work: new Map(), started: [], completed: [], lost: [] };
    rec.session = createNodeSession({
      nodeId, node: NODE, now, random: seeded(k + 7), maxConcurrent: 2,
      isIdle: () => rec.idle,
      send: m => toQueue.push([connId, structuredClone(m)]),
      onTask: (task, { token }) => {
        rec.started.push(task.id);
        rec.work.set(task.id, { token, startedAt: t, finishAt: t + workMs(indexOf.get(task.id)) });
      },
      onLost: (id, reason) => { rec.lost.push({ id, reason }); rec.work.delete(id); },
    });
    return rec;
  });
  const byConn = new Map(nodes.map(n => [n.connId, n]));

  function pump() {
    for (let guard = 0; guard < 100_000; guard++) {
      if (toQueue.length) { const [connId, m] = toQueue.shift(); queue.handle(connId, m); continue; }
      let delivered = false;
      for (const [connId, box] of toConn) {
        while (box.length) {
          const m = box.shift();
          delivered = true;
          if (connId === 'conn-pub') publisherInbox.push(m);
          else byConn.get(connId).session.receive(m);
        }
      }
      if (!delivered) return;
    }
    throw new Error('message round trips do not converge');
  }
  const publish = tasks => { queue.handle('conn-pub', { type: 'task.publish', tasks }); pump(); };

  function step(ms = 250) {
    t += ms;
    queue.tick();
    pump();
    for (const n of nodes) {
      for (const [id, w] of [...n.work]) {
        if (t >= w.finishAt) {
          n.work.delete(id);
          n.completed.push(id);
          n.session.complete(id, { ranges: [[0, 59]] });
        } else {
          n.session.progress(id, Math.floor((t - w.startedAt) / 50));
        }
      }
    }
    pump();
    for (const n of nodes) n.session.tick();
    pump();
  }
  const doneIds = () => publisherInbox.filter(m => m.type === 'task.done').map(m => m.id);
  const finished = () => new Set(doneIds()).size === inputs.length && nodes.every(n => n.work.size === 0 && n.session.held().length === 0);
  return { queue, nodes, inputs, publish, pump, step, finished, doneIds, publisherInbox, get now() { return t; } };
}

/** Number of times each element appears in the array. */
const counts = list => list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());

test('B.5 integration: two sessions compete for 20 tasks on the same real queue, and each task completes exactly once', () => {
  const rig = jointRig();
  // Half published before node check in (arrived via queue.snapshot), half after (via task.opened)
  rig.publish(rig.inputs.slice(0, 10));
  for (const n of rig.nodes) n.session.start();
  rig.pump();
  let steps = 0;
  for (; steps < 2_000 && !rig.finished(); steps++) {
    if (steps === 3) rig.publish(rig.inputs.slice(10));
    rig.step();
  }
  assert.ok(rig.finished(), `Not finished within ${steps} steps: ${new Set(rig.doneIds()).size}/20 completed`);

  const ids = rig.inputs.map(x => x.id).sort();
  // Publisher: exactly one task.done per task
  const doneCount = counts(rig.doneIds());
  assert.deepEqual([...doneCount.keys()].sort(), ids);
  for (const [id, c] of doneCount) assert.equal(c, 1, `${id} received ${c} task.done messages`);
  // Nodes: combined, each task started exactly once and completed once; no lost claims
  const started = rig.nodes.flatMap(n => n.started), completed = rig.nodes.flatMap(n => n.completed);
  assert.deepEqual([...started].sort(), ids, 'Each task gets exactly one onTask');
  assert.deepEqual([...completed].sort(), ids, 'Each task gets exactly one complete');
  for (const n of rig.nodes) assert.deepEqual(n.lost, [], `${n.nodeId} should not lose claims`);
  // Both nodes did work (maxConcurrent 2 each; one node cannot handle all 20)
  for (const n of rig.nodes) assert.ok(n.completed.length > 0, `${n.nodeId} completed none`);
  // Queue: all done; open(1) → claimed(2) → done(3); attempts 0
  const view = rig.queue.describe();
  assert.equal(view.tasks.length, 20);
  for (const task of view.tasks) {
    assert.equal(task.state, 'done', task.id);
    assert.equal(task.version, 3, `${task.id} version`);
    assert.equal(task.attempts, 0, `${task.id} attempts`);
  }
});

test('B.5 integration: one node becomes not idle midway and calls yieldAll, the tasks it puts back are taken over, and each task still completes exactly once', () => {
  const rig = jointRig({ workMs: i => 2_000 + (i % 3) * 500 });
  rig.publish(rig.inputs);
  for (const n of rig.nodes) n.session.start();
  rig.pump();
  const [yielder] = rig.nodes;
  const yielded = [];
  let resumeAt = null, steps = 0;
  for (; steps < 2_000 && !rig.finished(); steps++) {
    rig.step();
    // First time seeing yielding node have active tasks: user starts playback → not idle, release all,
    // caller discards active tasks
    if (resumeAt === null && steps >= 2 && yielder.session.held().length > 0) {
      yielder.idle = false;
      for (const h of yielder.session.held()) yielded.push(h.id);
      yielder.session.yieldAll('playing');
      yielder.work.clear();
      rig.pump();
      resumeAt = steps + 8;
    }
    if (steps === resumeAt) yielder.idle = true;
  }
  assert.ok(yielded.length > 0, 'The yielding node should have put tasks back');
  assert.ok(rig.finished(), `Not finished within ${steps} steps: ${new Set(rig.doneIds()).size}/20 completed`);

  const ids = rig.inputs.map(x => x.id).sort();
  const doneCount = counts(rig.doneIds());
  assert.deepEqual([...doneCount.keys()].sort(), ids);
  for (const [id, c] of doneCount) assert.equal(c, 1, `${id} received ${c} task.done messages`);
  const completed = rig.nodes.flatMap(n => n.completed);
  assert.deepEqual([...completed].sort(), ids, 'Each task gets exactly one complete');
  // Released tasks start work one extra time; others exactly once
  const started = counts(rig.nodes.flatMap(n => n.started));
  for (const id of ids) assert.equal(started.get(id), yielded.includes(id) ? 2 : 1, `${id} start count`);
  for (const n of rig.nodes) assert.deepEqual(n.lost, [], `${n.nodeId} should not lose claims`);

  // Release is not considered failure (C2): attempts are all 0;
  // released ones have two extra state transitions
  const view = rig.queue.describe();
  for (const task of view.tasks) {
    assert.equal(task.state, 'done', task.id);
    assert.equal(task.attempts, 0, `${task.id} attempts`);
    assert.equal(task.version, yielded.includes(task.id) ? 5 : 3, `${task.id} version`);
  }
});
