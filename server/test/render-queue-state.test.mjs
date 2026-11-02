/**
 * Render queue (M1) state machine test cases S-1-S-4.
 * Run: node --test server/test/render-queue-state.test.mjs
 *
 * Based on: `docs/plan/render-queue-contract.md` A.7-A.10a (contract),
 * `docs/plan/distributed-prerender-queue.md` sections 3-5 (design),
 * `docs/plan/TASK-distributed-prerender-queue.md` section 5.2 "State machine test cases" (matrix).
 *
 * S-4 is a fixed-seed random operation sequence: every step derives expected responses, broadcasts,
 * notifications, and state transitions using "previous step's describe() + this step's operation",
 * reconciles item by item with actual results, and checks the invariants listed in the task brief.
 * Driven and asserted only via public interfaces (including describe()).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createQueueHarness, makeTaskInput, T0 } from './fake-render-queue-env.mjs';

const LEASE = 30_000;
const GRACE = 10_000;
const STALL = 120_000;
const TTL = 600_000;
const MAX_ATTEMPTS = 3;

const T_IN = makeTaskInput({ resultKey: 'rk1' });

function setup({ tasks = [T_IN], ...options } = {}) {
  const h = createQueueHarness(createRenderQueue, options);
  h.publisher('p', 'pub-1');
  h.node('a', 'node-A');
  h.node('b', 'node-B');
  h.node('w', 'node-W', { profile: 'pc' });   // M6c X3: host watch 'all' only receives summaries, watch-only W switched to pc (formerly host)
  if (tasks.length) h.publish('p', tasks);
  h.bus.clear();
  return { h, id: tasks[0]?.id };
}

const claimOk = (h, conn, id, v) => {
  const m = h.claim(conn, id, v).one(conn, 'task.claimed');
  assert.equal(m.token, v + 1);
  return m;
};

test('After a retryable failure another node takes over first, and the original node can still retry after the backoff', () => {
  const { h, id } = setup();
  claimOk(h, 'a', id, 1);
  h.fail('a', id, 2, { error: 'sink-incomplete', retryable: true });
  const rejected = h.claim('a', id, 3).one('a', 'task.claim-rejected');
  assert.equal(rejected.reason, 'retry-backoff');
  assert.ok(rejected.retryInMs > 0);
  claimOk(h, 'b', id, 3);
  h.complete('b', id, 4);
  assert.equal(h.task(id).state, 'done');

  const second = setup();
  claimOk(second.h, 'a', second.id, 1);
  second.h.fail('a', second.id, 2, { error: 'sink-incomplete', retryable: true });
  second.h.clock.set(T0 + 5_000);
  claimOk(second.h, 'a', second.id, 3);
});

/* ============================================================ S-1 Full set of valid transitions */

test('S-1 The full set of legal transitions: open→claimed, claimed→open (release / timeout / stall / grace period / retryable fail / not resumed), claimed→done, claimed→failed; all other transitions never occur', () => {
  // open → claimed
  {
    const { h, id } = setup();
    claimOk(h, 'a', id, 1);
    assert.deepEqual([h.task(id).state, h.task(id).version], ['claimed', 2]);
  }
  // claimed → open: six paths; release does not increment attempts, the rest increment by one
  // and record lastError (contract A.10a)
  const reopen = [
    ['release', (h, id) => h.release('a', id, 2, 'busy'), 0, null],
    ['lease', h => h.at(T0 + LEASE + 1), 1, 'lease-expired'],
    ['stall', (h, id) => { h.progress('a', id, 2, 1); for (let s = 10; s <= 120; s += 10) { h.clock.set(T0 + s * 1000); h.progress('a', id, 2, 1); h.tick(); } h.at(T0 + STALL + 1); }, 1, 'stalled'],
    ['grace', h => { h.disconnect('a'); h.at(T0 + GRACE + 1); }, 1, 'disconnected'],
    ['fail', (h, id) => h.fail('a', id, 2, { error: 'oops' }), 1, 'oops'],
    ['fail without error', (h, id) => h.fail('a', id, 2), 1, 'failed'],
    ['not-resumed', h => { h.disconnect('a'); h.node('a2', 'node-A', { resume: [], watch: null }); }, 1, 'not-resumed'],
  ];
  for (const [why, act, attempts, lastError] of reopen) {
    const { h, id } = setup();
    claimOk(h, 'a', id, 1);
    act(h, id);
    const t = h.task(id);
    assert.deepEqual([t.state, t.version, t.attempts, t.claim, t.lastError], ['open', 3, attempts, null, lastError], why);
  }
  // Unresumed claims: dropped, do not send lease-lost to this node again (contract A.10a); keep resumed ones
  {
    const T2 = makeTaskInput({ resultKey: 'rk2' });
    const { h, id } = setup({ tasks: [T_IN, T2] });
    claimOk(h, 'a', id, 1);
    claimOk(h, 'a', T2.id, 1);
    h.disconnect('a');
    const out = h.node('a2', 'node-A', { resume: [{ id, token: 2 }], watch: null });
    const w = out.one('a2', 'node.welcome');
    assert.deepEqual([w.resumed, w.lost], [[id], []]);
    assert.equal(out.of('a2', 'task.lease-lost').length, 0);
    assert.deepEqual([h.task(id).state, h.task(T2.id).state, h.task(T2.id).lastError], ['claimed', 'open', 'not-resumed']);
    assert.equal(out.one('w', 'task.opened').task.id, T2.id);
  }
  // claimed → done
  {
    const { h, id } = setup();
    claimOk(h, 'a', id, 1);
    h.complete('a', id, 2, { ranges: [[0, 59]] });
    assert.deepEqual([h.task(id).state, h.task(id).version, h.task(id).attempts], ['done', 3, 0]);
  }
  // claimed → failed: attempts reaches limit; or retryable: false enters directly (contract A.7.6 [ruling])
  {
    const { h, id } = setup({ constants: { MAX_ATTEMPTS: 1 } });
    claimOk(h, 'a', id, 1);
    h.at(T0 + LEASE + 1);
    assert.deepEqual([h.task(id).state, h.task(id).attempts, h.task(id).lastError], ['failed', 1, 'lease-expired']);
  }
  {
    const { h, id } = setup();
    claimOk(h, 'a', id, 1);
    const out = h.fail('a', id, 2, { error: 'fatal', retryable: false });
    assert.equal(out.one('a', 'task.fail-ack').state, 'failed');
    assert.deepEqual([h.task(id).state, h.task(id).version, h.task(id).attempts, h.task(id).lastError], ['failed', 3, 1, 'fatal']);
    assert.equal(out.one('p', 'task.failed').error, 'fatal');
  }
  // Tasks without subscribers returning to open via drop or release are deleted immediately,
  // fail-ack state is removed (contract A.7.6)
  for (const [why, act, ackState] of [
    ['fail', h => h.fail('a', T_IN.id, 2, { error: 'x' }), 'removed'],
    ['release', h => h.release('a', T_IN.id, 2), null],
    ['lease', h => h.at(T0 + LEASE + 1), null],
  ]) {
    const { h, id } = setup();
    claimOk(h, 'a', id, 1);
    h.unsubscribe('p', { ids: [id] });
    assert.deepEqual([h.task(id).state, h.task(id).subscribers], ['claimed', []]);
    const out = act(h);
    assert.equal(h.task(id), null, why);
    const closed = out.one('w', 'task.closed');
    assert.deepEqual([closed.id, closed.state], [id, 'removed'], why);
    assert.equal(out.ofType('task.opened').length, 0, why);
    if (ackState) assert.equal(out.one('a', 'task.fail-ack').state, ackState);
  }

  // Transitions that do not occur: complete / release / fail / progress on open all yield lease-lost,
  // state unchanged
  {
    const { h, id } = setup();
    for (const [what, act] of [
      ['complete', () => h.complete('a', id, 1)], ['release', () => h.release('a', id, 1)],
      ['fail', () => h.fail('a', id, 1)], ['progress', () => h.progress('a', id, 1, 1)],
    ]) {
      const before = h.describe();
      const out = act();
      assert.equal(out.one('a', 'task.lease-lost').reason, 'token', what);
      assert.deepEqual(h.describe(), before, `${what} on an open task does not change the state`);
    }
    // Claim by another on claimed: taken; lease renewal does not change version
    claimOk(h, 'a', id, 1);
    assert.equal(h.claim('b', id, 2).one('b', 'task.claim-rejected').reason, 'taken');
    h.progress('a', id, 2, 3);
    assert.deepEqual([h.task(id).state, h.task(id).version], ['claimed', 2]);
    // Other nodes cannot modify even with the correct token (the node sending the message is not
    // the current claimant, contract A.6)
    for (const act of [() => h.complete('b', id, 2), () => h.release('b', id, 2), () => h.fail('b', id, 2), () => h.progress('b', id, 2, 9)]) {
      const before = h.describe();
      assert.equal(act().one('b', 'task.lease-lost').reason, 'token');
      assert.deepEqual(h.describe(), before);
    }
  }
  // done / failed are terminal states: claim yields taken, token operations yield lease-lost,
  // duplicate publish does not modify, tick does not touch before TTL
  for (const terminal of ['done', 'failed']) {
    const { h, id } = setup();
    claimOk(h, 'a', id, 1);
    if (terminal === 'done') h.complete('a', id, 2);
    else h.fail('a', id, 2, { retryable: false });
    const before = h.describe();
    const rej = h.claim('b', id, 3).one('b', 'task.claim-rejected');
    assert.deepEqual([rej.reason, rej.state, rej.version], ['taken', terminal, 3]);
    for (const act of [() => h.complete('a', id, 2), () => h.release('a', id, 2), () => h.fail('a', id, 2), () => h.progress('a', id, 2, 1)]) {
      assert.equal(act().one('a', 'task.lease-lost').reason, 'token');
    }
    h.publish('p', [T_IN]);
    h.at(h.task(id).finishedAt + TTL);
    assert.deepEqual(h.describe(), before, `${terminal} no longer transitions`);
  }
});

/* ============================================================ S-2 Monotonicity of version and token */

test('S-2 version is strictly monotonic: each state change adds exactly one, lease renewal adds nothing; token equals the version at the moment of the claim', () => {
  const { h, id } = setup();
  const seen = [];     // [step, state, version]
  const tokens = [];
  const snap = what => { const t = h.task(id); seen.push([what, t.state, t.version]); return t; };
  snap('publish');
  const claim = (conn, what) => {
    const v = h.task(id).version;
    const m = claimOk(h, conn, id, v);
    assert.equal(m.token, m.version);
    assert.equal(h.task(id).claim.token, h.task(id).version, 'The token in describe equals the version after the claim');
    tokens.push(m.token);
    snap(what);
    return m.token;
  };
  let tk = claim('a', 'claim#1');
  for (let i = 0; i < 3; i++) { h.clock.advance(1_000); h.progress('a', id, tk, i); snap(`progress#${i}`); }
  h.release('a', id, tk); snap('release');
  tk = claim('b', 'claim#2');
  h.at(h.now() + LEASE + 1); snap('lease');
  tk = claim('a', 'claim#3');
  h.fail('a', id, tk, { error: 'e' }); snap('fail');
  tk = claim('b', 'claim#4');
  h.complete('b', id, tk, { ranges: [[0, 59]] }); snap('complete');

  for (let i = 1; i < seen.length; i++) {
    const [what, state, version] = seen[i];
    const [, pState, pVersion] = seen[i - 1];
    if (state === pState) assert.equal(version, pVersion, `${what}: state unchanged, version unchanged`);
    else assert.equal(version, pVersion + 1, `${what}: a state change adds exactly one`);
  }
  assert.deepEqual(tokens, [2, 4, 6, 8]);
  for (let i = 1; i < tokens.length; i++) assert.ok(tokens[i] > tokens[i - 1], 'Tokens of the same task increase monotonically');

  // Version seen by watchers is also monotonic (version carried by opened / taken)
  const vs = h.bus.of('w').filter(m => m.type === 'task.opened' || m.type === 'task.taken')
    .map(m => (m.type === 'task.opened' ? m.task.version : m.version));
  for (let i = 1; i < vs.length; i++) assert.ok(vs[i] > vs[i - 1], `The version seen by watchers is monotonic: ${vs}`);

  // A path leading to failed: attempts and version advance together
  const { h: g, id: gid } = setup();
  let v = 1;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    claimOk(g, 'a', gid, v);
    g.at(g.now() + LEASE + 1);
    const t = g.task(gid);
    assert.deepEqual([t.version, t.attempts], [v + 2, i]);
    v = t.version;
  }
  assert.equal(g.task(gid).state, 'failed');
});

/* ============================================================ S-3 describe() matches state */

test('S-3 describe() matches the state field by field: shape, ordering, consistency with messages, deep copy', () => {
  const h = createQueueHarness(createRenderQueue, { epoch: 'ep-s3' });
  h.publisher('pz', 'pub-z');
  h.publisher('pa', 'pub-a', { userId: 'u2' });
  h.node('a', 'node-A');
  h.node('br', 'node-BR', { profile: 'browser', userId: 'u2' });
  const tasks = [
    makeTaskInput({ resultKey: 'zz' }), makeTaskInput({ kind: 'plan', projectRev: 4 }),
    makeTaskInput({ kind: 'stream', resultKey: 'ss', projectId: 'proj-2' }), makeTaskInput({ resultKey: 'aa', tier: 'local' }),
  ];
  h.publish('pz', tasks);
  h.publish('pa', [tasks[0]]);

  let d = h.describe();
  assert.equal(d.epoch, 'ep-s3');
  assert.deepEqual(d.tasks.map(t => t.id), tasks.map(t => t.id).sort(), 'tasks are sorted by id in ascending order');
  const z = d.tasks.find(t => t.id === tasks[0].id);
  assert.deepEqual(z.subscribers, ['pub-a', 'pub-z'], 'subscribers are sorted in ascending order');
  for (const t of d.tasks) {
    for (const k of ['id', 'projectId', 'state', 'version', 'attempts', 'lastError', 'claim', 'subscribers', 'finishedAt']) assert.ok(k in t, `task.${k}`);
    assert.deepEqual([t.state, t.version, t.attempts, t.claim, t.finishedAt, t.lastError], ['open', 1, 0, null, null, null]);
  }
  assert.equal(d.tasks.find(t => t.id === tasks[2].id).projectId, 'proj-2');
  const nodes = Object.fromEntries(d.nodes.map(n => [n.nodeId, n]));
  assert.deepEqual(nodes['node-A'], { ...nodes['node-A'], profile: 'pc', connected: true, disconnectedAt: null });
  assert.deepEqual(nodes['node-BR'], { ...nodes['node-BR'], profile: 'browser', connected: true, disconnectedAt: null });
  assert.deepEqual(d.publishers.map(p => p.publisherId).sort(), ['pub-a', 'pub-z']);

  // Matches messages
  const c = h.claim('a', tasks[0].id, 1).one('a', 'task.claimed');
  d = h.describe();
  let t = d.tasks.find(x => x.id === tasks[0].id);
  assert.deepEqual([t.state, t.version, t.claim.nodeId, t.claim.token, t.claim.leaseUntil], ['claimed', c.version, 'node-A', c.token, c.leaseUntil]);
  assert.deepEqual(t.claim.progress, { done: null, changedAt: T0 });
  h.clock.advance(2_000);
  const r = h.progress('a', tasks[0].id, c.token, 7).one('a', 'task.renewed');
  t = h.task(tasks[0].id);
  assert.deepEqual([t.claim.leaseUntil, t.claim.progress], [r.leaseUntil, { done: 7, changedAt: T0 + 2_000 }]);
  h.complete('a', tasks[0].id, c.token);
  t = h.task(tasks[0].id);
  assert.deepEqual([t.state, t.claim, t.finishedAt], ['done', null, T0 + 2_000]);
  const opened = h.bus.of('a', 'task.opened').map(m => m.task).find(v => v.id === tasks[1].id);
  const t1 = h.task(tasks[1].id);
  assert.deepEqual([opened.state, opened.version, opened.attempts], [t1.state, t1.version, t1.attempts]);

  h.disconnect('br');
  h.disconnect('pa');
  d = h.describe();
  assert.deepEqual(d.nodes.find(n => n.nodeId === 'node-BR'), { ...d.nodes.find(n => n.nodeId === 'node-BR'), connected: false, disconnectedAt: T0 + 2_000 });
  assert.deepEqual(d.publishers.find(p => p.publisherId === 'pub-a'), { publisherId: 'pub-a', connected: false, disconnectedAt: T0 + 2_000 });

  // Deep copy: modifying the return value does not affect the queue
  const before = JSON.stringify(h.describe());
  const m = h.describe();
  m.epoch = 'x';
  m.tasks[0].state = 'bogus';
  m.tasks[0].subscribers.push('intruder');
  m.tasks.find(x => x.claim)?.claim && (m.tasks.find(x => x.claim).claim.token = 999);
  m.tasks.pop();
  m.nodes[0].connected = !m.nodes[0].connected;
  m.publishers.length = 0;
  assert.equal(JSON.stringify(h.describe()), before);
});

/* ============================================================ S-4 Random operation sequence */

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('S-4 Invariants under a random operation sequence (fixed seed, 3000 steps): at most one valid token, done is notified only once, the lease of a claimed task is later than the claim time, a browser-only node receives only the user\'s own tasks', () => {
  const SEED = 20260924;
  const STEPS = 3000;
  const rnd = mulberry32(SEED);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const chance = p => rnd() < p;
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

  const h = createQueueHarness(createRenderQueue, { epoch: 'ep-s4' });

  // Task pool: 5 segments each for two projects
  const POOL = [];
  for (const projectId of ['proj-1', 'proj-2']) {
    for (let k = 0; k < 5; k++) POOL.push(makeTaskInput({ projectId, resultKey: `${projectId}-r${k}`, range: [k * 60, k * 60 + 59] }));
  }
  const projectOf = Object.fromEntries(POOL.map(t => [t.id, t.source.projectId]));
  const owner = {};          // task id → userId of the publisher that created it (current generation)
  const claimTime = {};      // task id → claim timestamp of this round
  const lastToken = {};      // task id → most recently issued token

  // Identity and connection model
  const PUBS = [{ id: 'pub-1', userId: 'u1' }, { id: 'pub-2', userId: 'u2' }, { id: 'pub-3', userId: 'u1' }]
    .map(p => ({ ...p, conn: null, exists: false, disconnectedAt: null, n: 0 }));
  const NODES = [
    { id: 'node-A', profile: 'pc', userId: 'u9' }, { id: 'node-B', profile: 'pc', userId: 'u8' },   // M6c X3: node-B was originally host (host's watch 'all' only receives summaries)
    { id: 'node-BR1', profile: 'browser', userId: 'u1' }, { id: 'node-BR2', profile: 'browser', userId: 'u2' },
  ].map(n => ({ ...n, conn: null, exists: false, disconnectedAt: null, held: new Map(), n: 0 }));
  const conns = new Map();   // Online connections: connId → { kind: 'node' | 'pub' | null, actor, watch }
  const pubById = Object.fromEntries(PUBS.map(p => [p.id, p]));
  const nodeById = Object.fromEntries(NODES.map(n => [n.id, n]));

  const stats = {};
  const bump = k => { stats[k] = (stats[k] ?? 0) + 1; };

  const visible = (c, id) => c.kind === 'node' && c.watch !== null
    && (c.watch === 'all' || c.watch.includes(projectOf[id]))
    && (c.actor.profile !== 'browser' || owner[id] === c.actor.userId);

  const sigOf = m => {
    switch (m.type) {
      case 'task.opened': return `opened|${m.task.id}|${m.task.version}`;
      case 'task.taken': return `taken|${m.id}|${m.version}`;
      case 'task.closed': return `closed|${m.id}|${m.state}`;
      case 'task.done': return `done|${m.id}`;
      case 'task.failed': return `failed|${m.id}|${m.error}`;
      case 'task.lease-lost': return `lease-lost|${m.id}|${m.token}|${m.reason}`;
      case 'task.claimed': return `claimed|${m.id}|${m.token}`;
      case 'task.claim-rejected': return `rejected|${m.id}|${m.reason}`;
      case 'task.renewed': return `renewed|${m.id}|${m.token}`;
      case 'task.completed': return `completed|${m.id}`;
      case 'task.released': return `released|${m.id}`;
      case 'task.fail-ack': return `fail-ack|${m.id}|${m.state}`;
      default: return m.type;
    }
  };

  let step = 0;
  let prev = h.describe();

  /**
   * Execute one step and reconcile. `op`: { kind, conn, ... }; `run()` actually invokes the queue;
   * `replies` gives expected response signatures for this connection via `expectReplies(P)`.
   */
  function doStep(op, run, expectReplies = () => [], checkReplies = () => {}) {
    const P = new Map(prev.tasks.map(t => [t.id, t]));
    const expected = new Map();      // connId → array of signatures
    const optional = new Map();
    const add = (map, c, s) => { if (!map.has(c)) map.set(c, []); map.get(c).push(s); };
    for (const s of expectReplies(P)) add(expected, op.conn, s);

    const out = h.act(run);
    const now = h.now();
    const cur = h.describe();
    const C = new Map(cur.tasks.map(t => [t.id, t]));
    const where = `Step ${step} ${op.kind}${op.conn ? `@${op.conn}` : ''}${op.id ? ` ${op.id}` : ''}`;

    // Publish: record creator for newly created tasks (including those recreated after expiration)
    const pubReply = op.kind === 'publish' ? out.of(op.conn, 'task.published')[0] : null;
    if (pubReply) for (const r of pubReply.results) if (r.created) owner[r.id] = op.actor.userId;

    // ---- Outbound messages: all carry epoch, sent only to online connections
    for (const e of out.entries) {
      assert.equal(e.message.epoch, 'ep-s4', `${where}: ${e.message.type} is missing epoch`);
      assert.ok(conns.has(e.connId), `${where}: sent ${e.message.type} to connection ${e.connId}, which is offline (or superseded)`);
    }

    // ---- describe shape
    assert.deepEqual(cur.tasks.map(t => t.id), [...cur.tasks.map(t => t.id)].sort(), `${where}: tasks are not sorted by id`);
    for (const t of cur.tasks) {
      assert.deepEqual(t.subscribers, [...t.subscribers].sort(), `${where}: subscribers are not sorted`);
      assert.equal(t.claim !== null, t.state === 'claimed', `${where}: claim and state of ${t.id} are inconsistent`);
      assert.equal(t.finishedAt !== null, t.state === 'done' || t.state === 'failed', `${where}: finishedAt and state of ${t.id} are inconsistent`);
      assert.ok(t.attempts <= MAX_ATTEMPTS, `${where}: attempts exceeds the limit`);
      if (t.state === 'claimed') assert.ok(cur.nodes.some(n => n.nodeId === t.claim.nodeId), `${where}: claimant ${t.claim.nodeId} has no node record`);
    }

    // ---- State transitions
    const accepted = op.accepted?.(P) ?? false;
    const events = [];
    for (const id of new Set([...P.keys(), ...C.keys()])) {
      const p = P.get(id);
      const c = C.get(id);
      if (p && c && c.version < p.version) {
        assert.equal(op.kind, 'publish', `${where}: version of ${id} went backwards`);
        assert.ok((p.state === 'done' || p.state === 'failed') && now - p.finishedAt > TTL, `${where}: ${id} was recreated before the TTL elapsed`);
        assert.deepEqual([c.state, c.version, c.attempts], ['open', 1, 0], `${where}: ${id} recreated`);
        events.push({ id, kind: 'created', c });
        continue;
      }
      if (p && c) {
        if (p.state === c.state) {
          assert.equal(c.version, p.version, `${where}: version of ${id} changed although the state did not`);
          assert.equal(c.attempts, p.attempts, `${where}: attempts of ${id} changed although the state did not`);
          if (c.state === 'claimed') assert.deepEqual([c.claim.nodeId, c.claim.token], [p.claim.nodeId, p.claim.token], `${where}: token of ${id} should not change`);
          continue;
        }
        assert.equal(c.version, p.version + 1, `${where}: ${id} ${p.state}→${c.state} version should increase by exactly one`);
        const pair = `${p.state}>${c.state}`;
        assert.ok(['open>claimed', 'claimed>open', 'claimed>done', 'claimed>failed'].includes(pair), `${where}: ${id} illegal transition ${pair}`);
        bump(`transition ${pair}`);
        if (pair === 'open>claimed') {
          assert.equal(c.attempts, p.attempts);
          assert.equal(op.kind, 'claim', where);
          assert.equal(c.claim.token, c.version, `${where}: token should equal the version at claim time`);
          events.push({ id, kind: 'claim', c });
        } else if (pair === 'claimed>done') {
          assert.equal(c.attempts, p.attempts);
          assert.ok(op.kind === 'complete' && accepted, where);
          events.push({ id, kind: 'done', p, c });
        } else if (pair === 'claimed>failed') {
          assert.equal(c.attempts, p.attempts + 1, `${where}: attempts is incremented by one when entering failed`);
          assert.ok(c.attempts >= MAX_ATTEMPTS || (op.kind === 'fail' && op.retryable === false), `${where}: entered failed before reaching the limit`);
          assert.equal(typeof c.lastError, 'string');
          events.push({ id, kind: 'failed', p, c });
        } else {
          const released = op.kind === 'release' && accepted && op.id === id;
          assert.equal(c.attempts, p.attempts + (released ? 0 : 1), `${where}: attempts of ${id} on returning to open (release adds none)`);
          events.push({ id, kind: 'reopen', p, c });
        }
      } else if (p && !c) {
        if (p.state === 'open') {
          assert.ok(['unsubscribe', 'tick'].includes(op.kind), `${where}: open ${id} was deleted by ${op.kind}`);
          events.push({ id, kind: 'removed', p });
        } else if (p.state === 'claimed') {
          assert.ok(['release', 'fail', 'tick', 'hello'].includes(op.kind), `${where}: claimed ${id} was deleted by ${op.kind}`);
          if (op.kind !== 'tick') assert.equal(p.subscribers.length, 0, `${where}: ${id}, which still has subscribers, was deleted`);
          events.push({ id, kind: 'removed', p });
        } else {
          assert.equal(op.kind, 'tick', `${where}: ${id} in state ${p.state} was deleted by ${op.kind}`);
          assert.ok(now - p.finishedAt > TTL, `${where}: ${id} was deleted before the TTL elapsed`);
          bump('TTL delete');
        }
        bump(`delete ${p.state}`);
      } else if (!p && c) {
        assert.equal(op.kind, 'publish', `${where}: ${id} appeared out of nowhere`);
        assert.deepEqual([c.state, c.version, c.attempts, c.claim, c.lastError, c.finishedAt], ['open', 1, 0, null, null, null], `${where}: newly created ${id}`);
        events.push({ id, kind: 'created', c });
      }
    }

    // ---- Expected broadcasts
    for (const [cid, cm] of conns) {
      for (const ev of events) {
        if (!visible(cm, ev.id)) continue;
        if (ev.kind === 'created') add(expected, cid, `opened|${ev.id}|1`);
        else if (ev.kind === 'claim') { if (cid !== op.conn) add(expected, cid, `taken|${ev.id}|${ev.c.version}`); }
        else if (ev.kind === 'reopen') add(expected, cid, `opened|${ev.id}|${ev.c.version}`);
        else if (ev.kind === 'done') add(expected, cid, `closed|${ev.id}|done`);
        else if (ev.kind === 'failed') add(expected, cid, `closed|${ev.id}|failed`);
        else if (ev.kind === 'removed') {
          add(expected, cid, `closed|${ev.id}|removed`);
          // In tick, first returns to open due to reclaim (broadcasts opened), then deleted due to
          // publisher grace expiry; both may occur
          if (ev.p.state === 'claimed' && op.kind === 'tick') add(optional, cid, `opened|${ev.id}|${ev.p.version + 1}`);
        }
      }
    }
    // ---- Expected notifications
    const connOfPub = pid => { const p = pubById[pid]; return p?.conn ?? null; };
    for (const ev of events) {
      if (ev.kind === 'done') for (const s of ev.p.subscribers) { const cc = connOfPub(s); if (cc) add(expected, cc, `done|${ev.id}`); }
      if (ev.kind === 'failed') for (const s of ev.p.subscribers) { const cc = connOfPub(s); if (cc) add(expected, cc, `failed|${ev.id}|${ev.c.lastError}`); }
    }
    if (op.kind === 'tick') {
      for (const [id, p] of P) {
        if (p.state !== 'claimed') continue;
        const c = C.get(id);
        if (c && c.state === 'claimed') continue;
        const holder = nodeById[p.claim.nodeId];
        // reason is the reclaim reason (contract A.12 [ruling]): if the task still exists, it is its
        // lastError; if deleted with no subscribers, infer following the scan order in A.8
        const reason = c ? c.lastError
          : now > p.claim.leaseUntil ? 'lease-expired'
            : p.claim.progress?.done !== null && now - p.claim.progress?.changedAt > STALL ? 'stalled' : 'disconnected';
        if (holder?.conn) add(expected, holder.conn, `lease-lost|${id}|${p.claim.token}|${reason}`);
      }
    }

    // ---- Reconcile per connection
    for (const cid of new Set([...expected.keys(), ...out.conns()])) {
      let actual = out.of(cid).map(sigOf);
      for (const s of optional.get(cid) ?? []) { const i = actual.indexOf(s); if (i >= 0) actual.splice(i, 1); }
      assert.deepEqual(actual.sort(), [...(expected.get(cid) ?? [])].sort(), `${where}: wrong messages sent to ${cid}`);
    }
    checkReplies(out, P, C, now);

    // ---- Browser-only receives only own tasks (task brief S-4 invariant, checked separately once more)
    for (const e of out.entries) {
      const cm = conns.get(e.connId);
      if (!cm || cm.kind !== 'node' || cm.actor.profile !== 'browser') continue;
      const m = e.message;
      // Rejections of its own requests (claim rejected, operating with another's id token / lease-lost
      // returned by resume) only echo the id it provided and carry no task content;
      // only reclaim notices actively pushed by the queue (reason is reclaim reason lease-expired /
      // stalled / disconnected) count as "messages of others' tasks"
      if (m.type === 'task.claim-rejected' || (m.type === 'task.lease-lost' && !['lease-expired', 'stalled', 'disconnected'].includes(m.reason))) continue;
      const ids = m.type === 'queue.snapshot' ? m.tasks.map(t => t.id) : m.type === 'task.opened' ? [m.task.id] : m.id ? [m.id] : [];
      for (const id of ids) assert.equal(owner[id], cm.actor.userId, `${where}: browser-only ${e.connId} received ${m.type} of another user's task ${id}`);
      if (m.type === 'task.opened') assert.equal(m.task.source.userId, cm.actor.userId);
    }

    // ---- Model update: token
    for (const e of out.entries) {
      const cm = conns.get(e.connId);
      if (!cm || cm.kind !== 'node') continue;
      const m = e.message;
      if (m.type === 'task.claimed') {
        cm.actor.held.set(m.id, m.token);
        claimTime[m.id] = now;
        lastToken[m.id] = m.token;
        bump('claim succeeded');
      } else if (m.type === 'task.lease-lost' && cm.actor.held.get(m.id) === m.token) {
        cm.actor.held.delete(m.id);
      }
    }
    if (accepted && ['complete', 'release', 'fail'].includes(op.kind)) op.actor.held.delete(op.id);
    if (accepted) {
      assert.equal(op.token, lastToken[op.id], `${where}: the accepted token is not the most recently issued one (two valid tokens appeared)`);
      bump(`accept ${op.kind}`);
    } else if (['progress', 'complete', 'release', 'fail'].includes(op.kind)) bump(`reject ${op.kind}`);

    // ---- Model update: delete records upon grace expiration
    if (op.kind === 'tick') {
      for (const a of [...NODES, ...PUBS]) {
        if (a.exists && a.conn === null && a.disconnectedAt !== null && now - a.disconnectedAt > GRACE) {
          a.exists = false; a.disconnectedAt = null; bump('grace period record delete');
        }
      }
    }

    // ---- Invariants
    const byNode = new Map(NODES.map(n => [n.id, new Map()]));
    for (const t of cur.tasks) {
      if (t.state !== 'claimed') continue;
      byNode.get(t.claim.nodeId)?.set(t.id, t.claim.token);
      assert.ok(t.claim.leaseUntil > claimTime[t.id], `${where}: leaseUntil of ${t.id} is not later than the claim time`);
      if (op.kind === 'tick') assert.ok(t.claim.leaseUntil >= now, `${where}: an expired lease is still there after tick`);
    }
    for (const n of NODES) {
      const truth = byNode.get(n.id);
      if (n.conn) {
        assert.deepEqual([...n.held].sort(), [...truth].sort(), `${where}: what online node ${n.id} believes it holds does not match the queue`);
      } else {
        for (const [id, token] of truth) assert.equal(n.held.get(id), token, `${where}: ${id} under offline node ${n.id} is not among the tasks it holds`);
      }
    }
    const nodeRows = Object.fromEntries(cur.nodes.map(n => [n.nodeId, n]));
    for (const n of NODES) {
      if (!n.exists) { assert.equal(nodeRows[n.id], undefined, `${where}: the record of ${n.id} should have been deleted`); continue; }
      assert.ok(nodeRows[n.id], `${where}: ${n.id} should have a record`);
      assert.deepEqual([nodeRows[n.id].connected, nodeRows[n.id].disconnectedAt, nodeRows[n.id].profile], [n.conn !== null, n.disconnectedAt, n.profile], `${where}: describe of ${n.id}`);
    }
    // Subscribers can only be publishers that still have records (removed from all tasks together
    // when records are deleted on grace expiration, contract A.8 item 3)
    for (const t of cur.tasks) {
      for (const s of t.subscribers) assert.ok(pubById[s]?.exists, `${where}: subscriber ${s} of ${t.id} no longer has a publisher record`);
    }
    const pubRows = Object.fromEntries(cur.publishers.map(p => [p.publisherId, p]));
    for (const p of PUBS) {
      if (!p.exists) { assert.equal(pubRows[p.id], undefined, `${where}: the record of ${p.id} should have been deleted`); continue; }
      assert.deepEqual([pubRows[p.id]?.connected, pubRows[p.id]?.disconnectedAt], [p.conn !== null, p.disconnectedAt], `${where}: describe of ${p.id}`);
    }

    prev = cur;
    step += 1;
    bump(`operation ${op.kind}`);
    return out;
  }

  /* ---- Various operations */

  const helloReplies = (n, resume) => P => {
    const sigs = ['node.welcome'];
    for (const { id, token } of resume) {
      const t = P.get(id);
      const ok = t && t.state === 'claimed' && t.claim.nodeId === n.id && t.claim.token === token;
      if (!ok) sigs.push(`lease-lost|${id}|${token}|${!t ? 'epoch' : t.state === 'claimed' && t.claim.nodeId !== n.id ? 'not-owner' : 'token'}`);
    }
    return sigs;
  };
  const helloCheck = (n, conn, resume) => (out, P) => {
    const w = out.one(conn, 'node.welcome');
    const resumed = resume.filter(({ id, token }) => { const t = P.get(id); return t && t.state === 'claimed' && t.claim.nodeId === n.id && t.claim.token === token; }).map(r => r.id);
    assert.deepEqual([...w.resumed].sort(), resumed.sort());
    assert.deepEqual([...w.lost].sort(), resume.map(r => r.id).filter(id => !resumed.includes(id)).sort());
    n.held = new Map(resume.filter(r => resumed.includes(r.id)).map(r => [r.id, r.token]));
    if (resumed.length) bump('resumed');
    if (w.lost.length) bump('resume lost');
  };

  function nodeConnect(n, { supersede = false } = {}) {
    const conn = `${n.id}#${++n.n}`;
    const old = n.conn;
    // Remaining holdings: resume all (always include all upon replacement to avoid producing
    // "not resumed" abandonment); randomly drop one and randomly add another's on offline reconnect
    let resume = [...n.held].map(([id, token]) => ({ id, token }));
    if (!supersede && resume.length && chance(0.3)) resume.splice(int(0, resume.length - 1), 1);
    if (!supersede && chance(0.25)) {
      const mine = new Set(prev.tasks.filter(t => t.state === 'claimed' && t.claim.nodeId === n.id).map(t => t.id));
      const id = pick(POOL).id;
      if (!mine.has(id) && !resume.some(r => r.id === id)) resume.push({ id, token: int(1, 9) });
    }
    doStep({ kind: 'hello', conn }, () => {
      h.q.connect(conn, { userId: n.userId, tenantId: 't1' });
      conns.set(conn, { kind: 'node', actor: n, watch: null });
      if (old) conns.get(old).kind = null;          // Replaced: no longer represents this node; watch is canceled as well
      n.conn = conn; n.exists = true; n.disconnectedAt = null;
      h.q.handle(conn, { type: 'node.hello', nodeId: n.id, profile: n.profile, resume });
    }, helloReplies(n, resume), helloCheck(n, conn, resume));
    if (old) {
      doStep({ kind: 'disconnect', conn: old }, () => { h.q.disconnect(old); conns.delete(old); });
    }
    let projects = pick(['all', 'all', ['proj-1'], ['proj-2'], ['proj-1', 'proj-2']]);
    // M6c X3: Pure browsers cannot watch 'all'; list both projects instead (same visibility,
    // random sequence unchanged)
    if (projects === 'all' && n.profile === 'browser') projects = ['proj-1', 'proj-2'];
    doStep({ kind: 'watch', conn }, () => {
      h.q.handle(conn, { type: 'queue.watch', projects });
      conns.get(conn).watch = projects;
    }, () => ['queue.snapshot'], (out, P, C) => {
      const snap = out.one(conn, 'queue.snapshot');
      const cm = conns.get(conn);
      const want = [...C.values()].filter(t => t.state === 'open' && visible(cm, t.id)).map(t => `${t.id}@${t.version}`).sort();
      assert.deepEqual(snap.tasks.map(t => `${t.id}@${t.version}`).sort(), want, `Step ${step}: snapshot of ${conn}`);
    });
  }

  function pubConnect(p) {
    const conn = `${p.id}#${++p.n}`;
    const old = p.conn;
    doStep({ kind: 'pub-hello', conn }, () => {
      h.q.connect(conn, { userId: p.userId, tenantId: 't1' });
      conns.set(conn, { kind: 'pub', actor: p, watch: null });
      if (old) conns.get(old).kind = null;
      p.conn = conn; p.exists = true; p.disconnectedAt = null;
      h.q.handle(conn, { type: 'publisher.hello', publisherId: p.id });
    }, () => ['publisher.welcome']);
    if (old) doStep({ kind: 'disconnect', conn: old }, () => { h.q.disconnect(old); conns.delete(old); });
  }

  function disconnectActor(a) {
    const conn = a.conn;
    doStep({ kind: 'disconnect', conn }, () => {
      h.q.disconnect(conn);
      conns.delete(conn);
      a.conn = null;
      a.disconnectedAt = h.now();
    });
  }

  const tokenOp = (kind, n, id, token, extra = {}) => {
    const accepted = P => { const t = P.get(id); return !!t && t.state === 'claimed' && t.claim.token === token && t.claim.nodeId === n.id; };
    const msg = { type: `task.${kind}`, id, token, ...extra };
    doStep({ kind, conn: n.conn, actor: n, id, token, accepted, retryable: extra.retryable }, () => h.q.handle(n.conn, msg), P => {
      if (!accepted(P)) return [`lease-lost|${id}|${token}|token`];
      if (kind === 'progress') return [`renewed|${id}|${token}`];
      if (kind === 'complete') return [`completed|${id}`];
      if (kind === 'release') return [`released|${id}`];
      return [];
    }, (out, P, C, now) => {
      if (!accepted(P)) return;
      if (kind === 'progress') {
        const r = out.one(n.conn, 'task.renewed');
        const c = C.get(id);
        assert.equal(r.leaseUntil, now + LEASE);
        assert.equal(c.claim.leaseUntil, now + LEASE);
        const p = P.get(id);
        const done = extra.done ?? null;
        if (done !== p.claim.progress.done) assert.deepEqual(c.claim.progress, { done, changedAt: now });
        else assert.deepEqual(c.claim.progress, p.claim.progress);
      }
    });
  };

  // The response state of fail depends on the result, wrap in a separate layer: pre-calculate
  // fail-ack into expected
  const failOp = (n, id, token, extra) => {
    const accepted = P => { const t = P.get(id); return !!t && t.state === 'claimed' && t.claim.token === token && t.claim.nodeId === n.id; };
    doStep({ kind: 'fail', conn: n.conn, actor: n, id, token, accepted, retryable: extra.retryable },
      () => h.q.handle(n.conn, { type: 'task.fail', id, token, ...extra }),
      P => {
        if (!accepted(P)) return [`lease-lost|${id}|${token}|token`];
        const t = P.get(id);
        const toFailed = extra.retryable === false || t.attempts + 1 >= MAX_ATTEMPTS;
        const state = toFailed ? 'failed' : t.subscribers.length === 0 ? 'removed' : 'open';
        if (toFailed) assert.equal(state, 'failed');
        return [`fail-ack|${id}|${state}`];
      },
      (out, P, C) => {
        if (!accepted(P)) return;
        const c = C.get(id);
        assert.equal(c?.lastError ?? null, c ? (extra.error ?? 'failed') : null);
      });
  };

  // Initial: all connected
  for (const p of PUBS) pubConnect(p);
  for (const n of NODES) nodeConnect(n);

  const onlineNodes = () => NODES.filter(n => n.conn);
  const onlinePubs = () => PUBS.filter(p => p.conn);

  while (step < STEPS) {
    const r = rnd();
    if (r < 0.14) {                                                    // Publish
      const p = pick(onlinePubs()); if (!p) { pubConnect(pick(PUBS)); continue; }
      const ids = [...new Set(Array.from({ length: int(1, 3) }, () => pick(POOL)))];
      const conn = p.conn;
      doStep({ kind: 'publish', conn, actor: p }, () => h.q.handle(conn, { type: 'task.publish', tasks: ids }), P => {
        const sigs = ['task.published'];
        for (const t of ids) { const x = P.get(t.id); if (x && x.state === 'done' && !(h.now() - x.finishedAt > TTL)) sigs.push(`done|${t.id}`); }
        return sigs;
      }, (out, P, C, now) => {
        const res = out.one(conn, 'task.published').results;
        assert.equal(res.length, ids.length);
        ids.forEach((t, i) => {
          const x = P.get(t.id);
          const expired = x && (x.state === 'done' || x.state === 'failed') && now - x.finishedAt > TTL;
          if (!x || expired) assert.deepEqual(res[i], { id: t.id, state: 'open', version: 1, created: true });
          else assert.deepEqual(res[i], { id: t.id, state: x.state, version: x.version, created: false });
          const c = C.get(t.id);
          if (!x || expired || x.state === 'open' || x.state === 'claimed') assert.ok(c.subscribers.includes(p.id), 'The publisher becomes a subscriber');
          else assert.deepEqual(c.subscribers, x.subscribers, 'A repeated publish of a done / failed task does not change the subscribers');
        });
      });
    } else if (r < 0.34) {                                             // Claim
      const n = pick(onlineNodes()); if (!n) { nodeConnect(pick(NODES)); continue; }
      const id = pick(POOL).id;
      const t = prev.tasks.find(x => x.id === id);
      const expectVersion = t && chance(0.75) ? t.version : int(1, 8);
      const conn = n.conn;
      doStep({ kind: 'claim', conn, id }, () => h.q.handle(conn, { type: 'task.claim', id, expectVersion }), P => {
        const x = P.get(id);
        let reason;
        if (!x) reason = 'gone';
        else if (n.profile === 'browser' && owner[id] !== n.userId) reason = 'forbidden';
        else if (x.state !== 'open') reason = 'taken';
        else if (expectVersion !== x.version) reason = 'stale';
        else return [`claimed|${id}|${x.version + 1}`];
        bump(`claim rejected ${reason}`);
        return [`rejected|${id}|${reason}`];
      }, (out, P, C, now) => {
        const x = P.get(id);
        const m = out.of(conn, ['task.claimed', 'task.claim-rejected'])[0];
        if (m.type === 'task.claimed') {
          assert.deepEqual([m.version, m.leaseUntil, C.get(id).claim.nodeId], [x.version + 1, now + LEASE, n.id]);
        } else if (m.reason === 'taken') {
          assert.deepEqual([m.state, m.version], [x.state, x.version]);
        } else if (m.reason === 'stale') {
          assert.deepEqual([m.state, m.version], ['open', x.version]);
        } else if (m.reason === 'forbidden') {
          assert.equal('state' in m || 'version' in m, false);
        }
      });
    } else if (r < 0.46) {                                             // Renew
      const n = pick(onlineNodes().filter(x => x.held.size) ); if (!n) continue;
      const [id, token] = chance(0.9) ? pick([...n.held]) : [pick(POOL).id, int(1, 9)];
      tokenOp('progress', n, id, token, { done: chance(0.1) ? null : int(0, 2) });
    } else if (r < 0.54) {                                             // Complete
      const n = pick(onlineNodes().filter(x => x.held.size)); if (!n) continue;
      const [id, token] = chance(0.9) ? pick([...n.held]) : [pick(POOL).id, int(1, 9)];
      tokenOp('complete', n, id, token, { result: { ranges: [[0, 1]] } });
    } else if (r < 0.555) {                                            // Misuse: use another node's currently valid token to renew / complete
      const n = pick(onlineNodes()); if (!n) continue;
      const victim = prev.tasks.filter(t => t.state === 'claimed' && t.claim.nodeId !== n.id);
      if (!victim.length) continue;
      const t = pick(victim);
      bump('token spoofing');
      if (chance(0.5)) tokenOp('complete', n, t.id, t.claim.token, { result: { ranges: [[0, 1]] } });
      else tokenOp('progress', n, t.id, t.claim.token, { done: 99 });
    } else if (r < 0.58) {                                             // Release
      const n = pick(onlineNodes().filter(x => x.held.size)); if (!n) continue;
      const [id, token] = pick([...n.held]);
      tokenOp('release', n, id, token, { reason: 'busy' });
    } else if (r < 0.64) {                                             // Fail
      const n = pick(onlineNodes().filter(x => x.held.size)); if (!n) continue;
      const [id, token] = pick([...n.held]);
      failOp(n, id, token, { ...(chance(0.5) ? { error: `e${step}` } : {}), ...(chance(0.2) ? { retryable: false } : {}) });
    } else if (r < 0.80) {                                             // Advance clock + tick
      const u = rnd();
      const ms = u < 0.7 ? int(0, 12_000) : u < 0.95 ? int(12_000, 40_000) : int(100_000, 700_000);
      doStep({ kind: 'tick' }, () => { h.clock.advance(ms); h.q.tick(); });
    } else if (r < 0.83) {
      doStep({ kind: 'tick' }, () => h.q.tick());
    } else if (r < 0.87) {                                             // Node disconnected
      const n = pick(onlineNodes()); if (!n) continue;
      disconnectActor(n);
    } else if (r < 0.92) {                                             // Node reconnect / replace
      const off = NODES.filter(x => !x.conn);
      if (off.length && chance(0.8)) nodeConnect(pick(off));
      else { const n = pick(onlineNodes()); if (n) nodeConnect(n, { supersede: true }); }
    } else if (r < 0.945) {                                            // Publisher disconnected
      const p = pick(onlinePubs()); if (!p) continue;
      disconnectActor(p);
    } else if (r < 0.975) {                                            // Publisher reconnect / replace
      const off = PUBS.filter(x => !x.conn);
      pubConnect(off.length && chance(0.8) ? pick(off) : pick(PUBS));
    } else {                                                           // Unsubscribe
      const p = pick(onlinePubs()); if (!p) continue;
      const fields = chance(0.5) ? { ids: [...new Set([pick(POOL).id, pick(POOL).id])] }
        : { projectId: pick(['proj-1', 'proj-2']), ...(chance(0.5) ? { projectRev: 1 } : {}) };
      const conn = p.conn;
      doStep({ kind: 'unsubscribe', conn }, () => h.q.handle(conn, { type: 'task.unsubscribe', ...fields }), () => ['task.unsubscribed'], (out, P, C) => {
        const hit = [...P.values()].filter(t => t.subscribers.includes(p.id)
          && (fields.ids ? fields.ids.includes(t.id) : projectOf[t.id] === fields.projectId)).map(t => t.id);
        assert.deepEqual([...out.one(conn, 'task.unsubscribed').ids].sort(), hit.sort());
        for (const id of hit) if (C.has(id)) assert.ok(!C.get(id).subscribers.includes(p.id));
      });
    }
  }

  assert.ok(step >= 2000, `At least 2000 steps, actual ${step}`);
  // Coverage: all these scenarios occurred under this seed; otherwise the random sequence did not
  // hit the key points
  for (const k of ['transition open>claimed', 'transition claimed>open', 'transition claimed>done', 'transition claimed>failed', 'TTL delete', 'delete open',
    'claim rejected taken', 'claim rejected stale', 'claim rejected gone', 'claim rejected forbidden', 'resumed', 'resume lost', 'grace period record delete',
    'accept progress', 'accept complete', 'accept release', 'accept fail', 'reject complete', 'token spoofing', 'delete claimed']) {
    assert.ok((stats[k] ?? 0) > 0, `Random sequence did not cover "${k}"; stats: ${JSON.stringify(stats)}`);
  }
});
