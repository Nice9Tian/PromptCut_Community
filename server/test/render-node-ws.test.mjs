/**
 * Node-side WebSocket endpoint and endpoint resolution (contract
 * `docs/plan/render-queue-contract.md` G.7, G.11, test cases T1-T9).
 * Run: node --test server/test/render-node-ws.test.mjs
 *
 * Written to the contract only, without looking at the implementation. Runs against a real
 * document service (port 0); "server forcibly disconnects", "cannot connect", and
 * "switch to another service" are handled via the test's TCP proxy (createTcpProxy in
 * `fake-ws-kit.mjs`): cutAll disconnects, mode = 'reject' drops new connections as soon as
 * they connect, retarget switches targets.
 *
 * Reconnect wait is verified against the G.7 formula and G.11 "jitter multiplied after capping":
 * attempt n (0-based) waits `min(maxMs, baseMs × factor^n) × (1 + jitter × (2·random() − 1))`.
 * Timer injection:
 *   manualTimers  holds reconnect timers without running them; tests manually fire them (T2, T3, T7);
 *   fastTimers    records requested milliseconds, actually waits only a few milliseconds (T4, T5, T8).
 * Timers with milliseconds ≤ 0 are not treated as reconnect waits and run immediately as usual.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocService } from '../docservice/service.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createLocalNode } from '../render-node/local-node.mjs';
import { createArtifactSink } from './fake-artifact-sink.mjs';
import {
  wsClient, byReq, byType, waitFor, sleep, randomToken, createTcpProxy, createSleepExecutor,
  snapshotTaskInput, healthServer, refusingPort,
} from './fake-ws-kit.mjs';
import { startSharedService, createProject, deviceId as newDeviceId } from './fake-shared-env.mjs';
import { buildAuthProtocols } from '../auth/client.mjs';

const BACKOFF = { baseMs: 500, factor: 2, maxMs: 15_000, jitter: 0.2 };
// M6c X3: host watch 'all' receives only summaries (discovering projects by scan cycle);
// T series tests transport, node switched to pc to receive full data as before (originally host)
const NODE = Object.freeze({ profile: 'pc', envFingerprint: 'fp-ws-test', codeVersions: [], capabilities: {} });

const loadTransport = () => import('../render-node/ws-transport.mjs');
const loadResolver = () => import('../render-node/endpoint.mjs');

const approx = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: expected ${expected}, got ${actual}`);
const expectedDelay = (n, r, b = BACKOFF) => Math.min(b.maxMs, b.baseMs * b.factor ** n) * (1 + b.jitter * (2 * r - 1));

/** Start document service (port 0) with real queue attached; token mode if token is provided. */
async function startQueueService({ token, modules } = {}) {
  const options = { log: () => {} };
  if (token !== undefined) {
    const { createClusterAuth } = await import('../docservice/auth.mjs');
    const auth = createClusterAuth({ token, allowAnonymous: false });
    options.authenticate = auth.authenticate;
  }
  if (modules) options.modules = modules;
  const service = createDocService(options);
  const queue = createRenderQueue({ now: Date.now, send: service.send });
  service.mountRenderQueue(queue);
  const { port } = await service.listen(0, '127.0.0.1');
  return { service, queue, port, url: `ws://127.0.0.1:${port}` };
}

/** Accumulate reconnect timers; test fires them manually. */
function manualTimers() {
  const pending = [];
  const delays = [];
  return {
    pending,
    delays,
    setTimeout(fn, ms, ...args) {
      const h = { fn: () => fn(...args), ms, unref() { return h; }, ref() { return h; }, hasRef: () => false };
      if (!(ms > 0)) { h.real = setTimeout(h.fn, 0); return h; }
      delays.push(ms);
      pending.push(h);
      return h;
    },
    clearTimeout(h) {
      if (!h) return;
      if (h.real) clearTimeout(h.real);
      const i = pending.indexOf(h);
      if (i >= 0) pending.splice(i, 1);
    },
    async waitPending(ms = 3000) {
      await waitFor(() => pending.length > 0, ms, 'Reconnect timer');
      return pending[0].ms;
    },
    fire() {
      const h = pending.shift();
      h.fn();
      return h.ms;
    },
  };
}

/** Record requested milliseconds; actually wait only realMs. */
function fastTimers(realMs = 5) {
  const delays = [];
  return {
    delays,
    setTimeout(fn, ms, ...args) {
      if (ms > 0) delays.push(ms);
      return setTimeout(fn, ms > 0 ? realMs : 0, ...args);
    },
    clearTimeout: (h) => clearTimeout(h),
  };
}

/** Create endpoint and record events. */
async function endpoint(options) {
  const { createWsEndpoint } = await loadTransport();
  const ep = createWsEndpoint({ log: () => {}, ...options });
  const rec = { opens: 0, closes: [], messages: [] };
  ep.onOpen(() => { rec.opens += 1; });
  ep.onClose((info) => { rec.closes.push(info); });
  ep.onMessage((m) => { rec.messages.push(m); });
  return { ep, rec };
}

/** Connect local node to endpoint (contract convention in G.7) and start tick. */
function attachNode(ep, { nodeId, executor = createSleepExecutor({ taskMs: 30 }), sink = createArtifactSink(), maxConcurrent = 1, tickMs = 10 }) {
  const events = [];
  const node = createLocalNode({
    nodeId, node: NODE, endpoint: ep, now: Date.now, maxConcurrent, executor, sink,
    onEvent: (e) => events.push(e),
  });
  ep.onOpen(() => node.start(node.session.held().map(({ id, token }) => ({ id, token }))));
  if (ep.connected) node.start([]);
  const timer = setInterval(() => { try { node.tick(); } catch { /* Send failures upon disconnection are swallowed by endpoint */ } }, tickMs);
  return { node, events, executor, sink, stop() { clearInterval(timer); node.stop(); } };
}

/** Page publisher: connect directly to service. */
async function publisher(url, publisherId = 'page-1') {
  const c = wsClient(url);
  await c.opened;
  c.send({ type: 'publisher.hello', reqId: 'ph', publisherId });
  await c.next(byReq('ph'));
  return c;
}

// ------------------------------------------------------------------ T1

// M6a: The original "token mode" tested that "endpoints with credential handshakes can also connect
// and check in". After cluster tokens exited the data plane, changed to entering via shared project
// proof (`protocols()` fetches challenge fresh before each connection, auth-contract Section 11),
// role render; principal is this member identity.
for (const mode of ['anonymous', 'shared']) {
  test(`T1 createWsEndpoint against the real document service (${mode === 'shared' ? 'shared project credentials' : 'Anonymous mode'}): onOpen fires and local-node receives node.welcome`, async (t) => {
    let env;
    let options;
    if (mode === 'shared') {
      const shared = await startSharedService({ mode: 'hosted' });
      t.after(() => shared.close());
      const { projectId } = await createProject(shared.base, { password: 'pw-t1' });
      const dev = newDeviceId('t1');
      const queueOf = () => shared.service.describe().modules['render-queue'].spaces?.[projectId];
      env = { service: shared.service, url: shared.url, get queue() { return { epoch: queueOf()?.epoch }; }, projectId, dev };
      options = { url: shared.url, protocols: () => buildAuthProtocols({ base: shared.base, projectId, username: 'bob', deviceId: dev, deviceName: 'Bob', password: 'pw-t1', role: 'render' }) };
    } else {
      env = await startQueueService({});
      t.after(() => env.service.close());
      options = { url: env.url };
    }
    const { ep, rec } = await endpoint(options);
    t.after(() => ep.close());
    const n = attachNode(ep, { nodeId: `n-${mode}` });
    t.after(() => n.stop());

    await waitFor(() => rec.opens === 1, 3000, 'onOpen');
    assert.equal(ep.connected, true);
    assert.equal(ep.closed, false);
    const welcome = await waitFor(() => rec.messages.find(byType('node.welcome')), 3000, 'node.welcome');
    assert.equal(welcome.nodeId, `n-${mode}`);
    assert.equal(welcome.epoch, env.queue.epoch);
    assert.equal(n.node.session.epoch, env.queue.epoch, 'The session of local-node received welcome');
    const d = env.service.describe();
    assert.equal(d.conns.length, 1);
    assert.deepEqual(d.conns[0].roles.sort(), ['node', 'publisher'], 'local-node.start sends publisher.hello first, then node.hello');
    if (mode === 'shared') {
      assert.deepEqual(d.conns[0].principal, {
        userId: `bob@${env.dev}`, tenantId: env.projectId, scope: 'member', username: 'bob', deviceId: env.dev, deviceName: 'Bob',
        creator: false, role: 'render', conversation: null, owner: null,
      });
    }
    const s = ep.stats();
    assert.equal(s.opens, 1);
    assert.equal(s.closes, 0);
    assert.ok(s.sent >= 2 && s.received >= 1, JSON.stringify(s));
    assert.equal(s.dropped, 0);
    assert.equal(s.badFrames, 0);
  });
}

test('T1 exports and arguments: index.mjs also exports these names; BACKOFF_DEFAULTS; invalid arguments throw TypeError synchronously', async () => {
  const idx = await import('../render-node/index.mjs');
  for (const name of ['createWsEndpoint', 'BACKOFF_DEFAULTS', 'resolveDocservice', 'watchServiceEndpoints']) {
    assert.equal(name in idx, true, `index.mjs is missing ${name}`);
  }
  const { createWsEndpoint, BACKOFF_DEFAULTS } = await loadTransport();
  assert.deepEqual({ ...BACKOFF_DEFAULTS }, BACKOFF);
  assert.throws(() => createWsEndpoint({}), TypeError);
  assert.throws(() => createWsEndpoint({ url: 'not a url' }), TypeError);
});

// ------------------------------------------------------------------ T2

test('T2 server disconnect: the reconnect wait follows the G.7 formula (fixed random) and resets to zero after connecting; a handshake failure does not count as a disconnect', async (t) => {
  const env = await startQueueService();
  t.after(() => env.service.close());
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const timers = manualTimers();
  const r = 0.75;
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => r });
  t.after(() => ep.close());
  await waitFor(() => rec.opens === 1, 3000, 'First connection');
  assert.equal(timers.pending.length, 0);

  proxy.mode = 'reject';
  proxy.cutAll();
  approx(await timers.waitPending(), expectedDelay(0, r), 'Attempt 0');
  await waitFor(() => rec.closes.length === 1, 2000, 'onClose');
  assert.equal(typeof rec.closes[0].code, 'number');
  assert.equal(ep.connected, false);
  timers.fire();
  approx(await timers.waitPending(), expectedDelay(1, r), 'Attempt 1');
  timers.fire();
  approx(await timers.waitPending(), expectedDelay(2, r), 'Attempt 2');
  assert.equal(rec.closes.length, 1, 'A handshake failure does not call onClose (G.11)');
  assert.equal(ep.stats().closes, 1, 'A handshake failure is not counted in closes (G.11)');

  proxy.mode = 'pass';
  timers.fire();
  await waitFor(() => rec.opens === 2, 3000, 'Reconnected');
  assert.equal(ep.connected, true);
  assert.equal(timers.pending.length, 0);

  proxy.cutAll();
  approx(await timers.waitPending(), expectedDelay(0, r), 'Resets to zero after connecting');
  await waitFor(() => rec.closes.length === 2, 2000, 'Second onClose');
  assert.deepEqual({ opens: ep.stats().opens, closes: ep.stats().closes }, { opens: 2, closes: 2 });
});

// ------------------------------------------------------------------ T3

test('T3 while disconnected, send returns false and the stats().dropped count is correct; when connected, send returns true and is counted in sent', async (t) => {
  const env = await startQueueService();
  t.after(() => env.service.close());
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const timers = manualTimers();
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  t.after(() => ep.close());
  await waitFor(() => rec.opens === 1, 3000, 'Connected');

  const sent0 = ep.stats().sent;
  assert.equal(ep.send({ type: 'publisher.hello', reqId: 'x', publisherId: 'p' }), true);
  assert.equal(ep.stats().sent, sent0 + 1);
  await waitFor(() => rec.messages.find(byReq('x')), 2000, 'reply');

  proxy.mode = 'reject';
  proxy.cutAll();
  await timers.waitPending();
  assert.equal(ep.connected, false);
  const before = ep.stats();
  for (let i = 0; i < 3; i++) assert.equal(ep.send({ type: 'queue.watch', projects: 'all' }), false);
  const after = ep.stats();
  assert.equal(after.dropped, before.dropped + 3);
  assert.equal(after.sent, before.sent, 'Dropped messages are not counted in sent');

  // Do not replay messages from during disconnection after reconnecting
  proxy.mode = 'pass';
  const seen = rec.messages.length;
  timers.fire();
  await waitFor(() => rec.opens === 2, 3000, 'reconnect');
  await sleep(150);
  // Dropped during disconnection is queue.watch sent before check in: if replayed,
  // queue returns error { reason: 'not-registered' }
  assert.deepEqual(rec.messages.slice(seen), [], 'Messages during a disconnect are always dropped, not cached for replay');
  assert.equal(ep.stats().sent, after.sent, 'Nothing is resent after reconnecting');
});

test('T3 incoming text that is not JSON / not an object is not passed to the handler and is counted in badFrames', async (t) => {
  const junk = {
    name: 'junk', types: ['junk.'],
    handle(ctx, connId, message) {
      ctx.send(connId, 42);
      ctx.send(connId, [1, 2]);
      ctx.send(connId, 'text');
      ctx.send(connId, { type: 'junk.ok', reqId: message.reqId });
    },
  };
  const env = await startQueueService({ modules: [junk] });
  t.after(() => env.service.close());
  const { ep, rec } = await endpoint({ url: env.url });
  t.after(() => ep.close());
  await waitFor(() => rec.opens === 1, 3000, 'Connected');
  const r0 = ep.stats().received;
  ep.send({ type: 'junk.go', reqId: 'j' });
  await waitFor(() => rec.messages.find(byReq('j')), 2000, 'junk.ok');
  await sleep(50);
  assert.deepEqual(rec.messages.filter((m) => m?.reqId === 'j').map((m) => m.type), ['junk.ok']);
  assert.ok(rec.messages.every((m) => m && typeof m === 'object' && !Array.isArray(m)), 'The handler receives only objects');
  assert.equal(ep.stats().badFrames, 3);
  assert.equal(ep.stats().received, r0 + 1, 'received counts only the messages passed to the handler');
});

// ------------------------------------------------------------------ T4

test('T4 the server forcibly disconnects a node after it claims (within the grace period): after reconnecting it continues via resume, the token is unchanged, and the task completes as usual', { timeout: 20_000 }, async (t) => {
  const env = await startQueueService();
  t.after(() => env.service.close());
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const timers = fastTimers(20);
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  t.after(() => ep.close());
  const n = attachNode(ep, { nodeId: 'n-t4', executor: createSleepExecutor({ taskMs: 1500 }) });
  t.after(() => n.stop());
  await waitFor(() => rec.opens === 1, 3000, 'Connected');

  const page = await publisher(env.url);
  t.after(() => page.close());
  const task = snapshotTaskInput({ resultKey: `rk-t4-${Date.now()}` });
  page.send({ type: 'task.publish', reqId: 'pub', tasks: [task] });
  await page.next(byReq('pub'));

  const held = await waitFor(() => n.node.session.held().find((h) => h.id === task.id), 3000, 'Claim');
  await waitFor(() => n.executor.calls.includes(task.id), 2000, 'Work started');
  proxy.cutAll();
  await waitFor(() => rec.opens === 2, 3000, 'reconnect');
  const welcomes = rec.messages.filter(byType('node.welcome'));
  await waitFor(() => rec.messages.filter(byType('node.welcome')).length === 2, 2000, 'Second welcome');
  const w2 = rec.messages.filter(byType('node.welcome'))[1];
  assert.deepEqual(w2.resumed, [task.id], `Continued after reconnecting: ${JSON.stringify(w2)}; ${welcomes.length} welcome messages before`);
  assert.deepEqual(w2.lost, []);
  const heldAfter = n.node.session.held().find((h) => h.id === task.id);
  assert.ok(heldAfter, 'Still held');
  assert.equal(heldAfter.token, held.token, 'The token is unchanged');

  const done = await page.next((m) => m.type === 'task.done' && m.id === task.id, 8000);
  assert.equal(done.resultKey, task.resultKey);
  await sleep(100);
  assert.equal(page.all.filter((m) => m.type === 'task.done' && m.id === task.id).length, 1);
  const qt = env.queue.describe().tasks.find((x) => x.id === task.id);
  assert.equal(qt.state, 'done');
  assert.equal(qt.attempts, 0, 'Not reclaimed and redone');
  assert.deepEqual(n.executor.calls, [task.id], 'Rendered only once');
});

// ------------------------------------------------------------------ T5

test('T5 switching to a new document service instance (new epoch): the originally held task receives lease-lost { reason: epoch } and onLost is called', { timeout: 20_000 }, async (t) => {
  const a = await startQueueService();
  t.after(() => a.service.close());
  const b = await startQueueService();
  t.after(() => b.service.close());
  assert.notEqual(a.queue.epoch, b.queue.epoch);
  const proxy = await createTcpProxy({ target: a.port });
  t.after(() => proxy.close());
  const timers = fastTimers(20);
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  t.after(() => ep.close());
  const n = attachNode(ep, { nodeId: 'n-t5', executor: createSleepExecutor({ taskMs: 5000 }) });
  t.after(() => n.stop());
  await waitFor(() => rec.opens === 1, 3000, 'Connected');

  const page = await publisher(a.url);
  t.after(() => page.close());
  const task = snapshotTaskInput({ resultKey: `rk-t5-${Date.now()}` });
  page.send({ type: 'task.publish', reqId: 'pub', tasks: [task] });
  await page.next(byReq('pub'));
  await waitFor(() => n.node.session.held().some((h) => h.id === task.id), 3000, 'Claim');

  proxy.retarget(b.port);
  proxy.cutAll();
  await waitFor(() => rec.opens === 2, 3000, 'Connected to the new instance');
  const lost = await waitFor(() => rec.messages.find((m) => m.type === 'task.lease-lost' && m.id === task.id), 3000, 'task.lease-lost');
  assert.equal(lost.reason, 'epoch');
  assert.equal(lost.epoch, b.queue.epoch);
  await waitFor(() => n.events.some((e) => e.type === 'lost' && e.id === task.id), 2000, 'onLost');
  assert.equal(n.node.session.held().some((h) => h.id === task.id), false);
  assert.equal(n.node.session.epoch, b.queue.epoch);
});

// ------------------------------------------------------------------ T6

test('T6 resolveDocservice: environment variable address available → remote; unavailable and loopback available → local; both unavailable → offline; a protocol mismatch is recorded as protocol-mismatch', { timeout: 20_000 }, async (t) => {
  const { resolveDocservice } = await loadResolver();
  const good = await healthServer({ ok: true, protocol: 'promptcut.v1', service: 'promptcut-docservice' });
  const good2 = await healthServer({ ok: true, protocol: 'promptcut.v1' });
  const mismatch = await healthServer({ ok: true, protocol: 'promptcut.v0' });
  const notOk = await healthServer({ ok: false, protocol: 'promptcut.v1' });
  const hang = await healthServer(null);
  const deadServer = await refusingPort();
  const deadServer2 = await refusingPort();
  t.after(() => Promise.all([good, good2, mismatch, notOk, hang, deadServer, deadServer2].map((s) => s.close())));
  const dead = deadServer.port;
  const dead2 = deadServer2.port;
  const ws = (p, path = '') => `ws://127.0.0.1:${p}${path}`;
  // Relax servers that can respond to 5000 ms: during full npm test, CPU is saturated by parallel test
  // files, and local /healthz occasionally takes over 1 s to respond.
  // Only the hang case specifically testing timeouts (item 8) passes a shorter timeout separately.
  const run = (env, extra = {}) => resolveDocservice({ env, timeoutMs: 5000, ...extra });

  // 1. Environment variable address is available
  const r1 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(good.port), PROMPTCUT_DOCSERVICE_PORT: String(good2.port) });
  assert.equal(r1.mode, 'remote');
  assert.equal(r1.url, ws(good.port));
  assert.equal(r1.health.ok, true);
  assert.equal(r1.tried.length, 1, 'Stops trying once item 1 is available');
  assert.deepEqual([r1.tried[0].url, r1.tried[0].ok], [ws(good.port), true]);

  // 2. Environment variable address unavailable, loopback available
  const r2 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(dead), PROMPTCUT_DOCSERVICE_PORT: String(good2.port) });
  assert.equal(r2.mode, 'local');
  assert.equal(r2.url, `ws://127.0.0.1:${good2.port}`);
  assert.deepEqual(r2.tried.map((x) => x.ok), [false, true]);
  assert.equal(typeof r2.tried[0].reason, 'string');

  // 3. Neither is available
  const r3 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(dead), PROMPTCUT_DOCSERVICE_PORT: String(dead2) });
  assert.equal(r3.mode, 'offline');
  assert.equal(r3.url, undefined);
  assert.deepEqual(r3.tried.map((x) => x.ok), [false, false]);

  // 4. protocol mismatch → skip and record protocol-mismatch
  const r4 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(mismatch.port), PROMPTCUT_DOCSERVICE_PORT: String(good2.port) });
  assert.equal(r4.mode, 'local');
  assert.equal(r4.tried[0].ok, false);
  assert.equal(r4.tried[0].reason, 'protocol-mismatch');

  // 5. ok is not true → unavailable
  const r5 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(notOk.port), PROMPTCUT_DOCSERVICE_PORT: String(dead) });
  assert.equal(r5.mode, 'offline');

  // 6. Environment variable address not set (including empty string, G.11) → try loopback only
  for (const env of [{ PROMPTCUT_DOCSERVICE_PORT: String(good2.port) }, { PROMPTCUT_DOCSERVICE_URL: '', PROMPTCUT_DOCSERVICE_PORT: String(good2.port) }]) {
    const r = await run(env);
    assert.equal(r.mode, 'local', JSON.stringify(env));
    assert.equal(r.tried.length, 1, JSON.stringify(r.tried));
  }

  // 7. Not ws: / wss: → bad-url, continue trying the next item (G.11)
  const r7 = await run({ PROMPTCUT_DOCSERVICE_URL: `http://127.0.0.1:${good.port}`, PROMPTCUT_DOCSERVICE_PORT: String(good2.port) });
  assert.equal(r7.mode, 'local');
  assert.deepEqual([r7.tried[0].ok, r7.tried[0].reason], [false, 'bad-url']);

  // 8. Health check timeout → unavailable, continue to the next item
  // The slow one (hang) still uses the 1000 ms timeout as before and still must be failed within 3 s;
  // only relax "the good one" (loopback good2): when the machine is busy, its /healthz may take more
  // than 1 s to respond (see the run comment above), so the injected fetch does not pass the health
  // check abort signal to good2, leaving it exempt from the 1 s limit.
  // Requests for hang carry the signal as is, and timing only counts this health check for hang.
  let hangMs = null;
  const f8 = async (target, init = {}) => {
    const port = new URL(target).port;
    if (port === String(good2.port)) {
      const { signal, ...rest } = init;
      void signal;
      return globalThis.fetch(target, rest);
    }
    const s = Date.now();
    try { return await globalThis.fetch(target, init); } finally { if (port === String(hang.port)) hangMs = Date.now() - s; }
  };
  const r8 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(hang.port), PROMPTCUT_DOCSERVICE_PORT: String(good2.port) }, { timeoutMs: 1000, fetch: f8 });
  assert.deepEqual([r8.tried[0].ok, r8.tried[0].reason], [false, 'timeout'], `A hang is ruled out by timeout: ${JSON.stringify(r8.tried)}`);
  assert.equal(r8.mode, 'local', 'Moves on to the next item after a timeout');
  assert.ok(hangMs !== null && hangMs < 3000, `The timeout must follow timeoutMs: the liveness check of the hang took ${hangMs} ms`);

  // 9. /healthz is fetched at the origin root (G.11)
  const r9 = await run({ PROMPTCUT_DOCSERVICE_URL: ws(good.port, '/some/path'), PROMPTCUT_DOCSERVICE_PORT: String(dead) });
  assert.equal(r9.mode, 'remote');
});

test('T6 resolveDocservice uses the injected fetch: ws→http, wss→https, GET /healthz', async () => {
  const { resolveDocservice } = await loadResolver();
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ ok: true, protocol: 'promptcut.v1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const r = await resolveDocservice({ env: { PROMPTCUT_DOCSERVICE_URL: 'wss://docs.example.invalid:8443/ws' }, fetch, timeoutMs: 500 });
  assert.equal(r.mode, 'remote');
  assert.equal(r.url, 'wss://docs.example.invalid:8443/ws');
  assert.deepEqual(calls.map((c) => [c.url, c.method.toUpperCase()]), [['https://docs.example.invalid:8443/healthz', 'GET']]);

  calls.length = 0;
  const r2 = await resolveDocservice({ env: { PROMPTCUT_DOCSERVICE_PORT: '8799' }, fetch, timeoutMs: 500 });
  assert.equal(r2.mode, 'local');
  assert.equal(r2.url, 'ws://127.0.0.1:8799');
  assert.deepEqual(calls.map((c) => c.url), ['http://127.0.0.1:8799/healthz']);
});

test('T6 watchServiceEndpoints: subscribes immediately when already connected, resubscribes on every onOpen, calls onChange upon receiving service.endpoints; no more calls after stop', { timeout: 20_000 }, async (t) => {
  const { endpointsModule } = await import('../docservice/modules/endpoints.mjs');
  const env = await startQueueService({ modules: [endpointsModule()] });
  t.after(() => env.service.close());
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const timers = fastTimers(10);
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  t.after(() => ep.close());
  await waitFor(() => rec.opens === 1, 3000, 'Connected');

  const announcer = wsClient(env.url);
  t.after(() => announcer.close());
  await announcer.opened;
  announcer.send({ type: 'service.announce', announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] });
  await announcer.next(byType('service.announced'));

  const { watchServiceEndpoints } = await loadResolver();
  const changes = [];
  const stop = watchServiceEndpoints(ep, ['asset'], (list) => changes.push(list));
  await waitFor(() => changes.length === 1, 2000, 'Reply to the immediate subscription (G.11)');
  assert.deepEqual(changes[0].map((e) => e.announcerId), ['pc-1']);

  announcer.send({ type: 'service.announce', announcerId: 'host-1', kind: 'asset', urls: ['http://10.0.0.3:8790/'] });
  await waitFor(() => changes.length === 2, 2000, 'Pushed change');
  assert.equal(changes[1].length, 2);

  proxy.cutAll();
  await waitFor(() => rec.opens === 2, 3000, 'reconnect');
  await waitFor(() => changes.length === 3, 2000, 'Resubscribes after reconnecting');
  assert.equal(changes[2].length, 2);

  stop();
  announcer.send({ type: 'service.announce', announcerId: 'nb-1', kind: 'asset', urls: ['http://10.0.0.4:8790/'] });
  await announcer.next(byType('service.announced'));
  await sleep(150);
  assert.equal(changes.length, 3, 'onChange is no longer called after stop');
});

// ------------------------------------------------------------------ T7

test('T7 no reconnect after close(): connected becomes false immediately, and onClose carries { code: 1000, reason: closed }', async (t) => {
  const env = await startQueueService();
  t.after(() => env.service.close());
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const timers = manualTimers();
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  await waitFor(() => rec.opens === 1, 3000, 'Connected');
  const accepted = proxy.accepted;

  ep.close();
  assert.equal(ep.closed, true);
  assert.equal(ep.connected, false, 'connected is false immediately after close() (G.11)');
  await waitFor(() => rec.closes.length === 1, 3000, 'onClose');
  assert.deepEqual(rec.closes[0], { code: 1000, reason: 'closed' });
  await sleep(200);
  assert.equal(timers.pending.length, 0, 'No reconnect is scheduled after close()');
  assert.equal(proxy.accepted, accepted, 'No new connections');
  assert.equal(ep.send({ type: 'x' }), false);
  ep.close(); // Repeated calls are harmless
});

test('T7 close() during a backoff wait: no connection is made even when the timer fires', async (t) => {
  const env = await startQueueService();
  t.after(() => env.service.close());
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const timers = manualTimers();
  const { ep, rec } = await endpoint({ url: `ws://127.0.0.1:${proxy.port}`, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  await waitFor(() => rec.opens === 1, 3000, 'Connected');
  proxy.cutAll();
  await timers.waitPending();
  const accepted = proxy.accepted;
  ep.close();
  assert.equal(ep.closed, true);
  if (timers.pending.length > 0) timers.fire(); // If the implementation fails to clear the timer, the callback upon firing must not reconnect either
  await sleep(200);
  assert.equal(proxy.accepted, accepted, 'No reconnect after close()');
  assert.equal(rec.opens, 1);
});

// ------------------------------------------------------------------ T8

test('T8 token error: when connecting keeps failing, the backoff grows until capped at maxMs, opens === 0, and it does not count as a disconnect', { timeout: 20_000 }, async (t) => {
  const token = randomToken();
  const env = await startQueueService({ token });
  t.after(() => env.service.close());

  // random fixed at 0.5: jitter is 0, cap exactly equals maxMs
  const timers = fastTimers(2);
  const { ep, rec } = await endpoint({ url: env.url, token: randomToken(), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, random: () => 0.5 });
  t.after(() => ep.close());
  await waitFor(() => timers.delays.length >= 9, 8000, '9 reconnect waits');
  ep.close();
  assert.deepEqual(timers.delays.slice(0, 9), [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000]);
  assert.equal(ep.stats().opens, 0);
  assert.equal(rec.opens, 0);
  assert.equal(ep.stats().closes, 0, 'A handshake failure is not counted in closes (G.11)');
  assert.equal(rec.closes.filter((c) => c.reason !== 'closed').length, 0, 'A handshake failure does not call onClose (G.11)');

  // random takes the upper bound: upper limit for a single wait is maxMs × (1 + jitter) (G.11)
  const timers2 = fastTimers(2);
  const { ep: ep2 } = await endpoint({ url: env.url, token: randomToken(), setTimeout: timers2.setTimeout, clearTimeout: timers2.clearTimeout, random: () => 1 });
  t.after(() => ep2.close());
  await waitFor(() => timers2.delays.length >= 8, 8000, '8 reconnect waits');
  ep2.close();
  const cap = BACKOFF.maxMs * (1 + BACKOFF.jitter);
  assert.ok(timers2.delays.every((ms) => ms <= cap + 1e-6), `Exceeds the limit: ${timers2.delays}`);
  approx(timers2.delays[7], cap, 'After capping');
  approx(timers2.delays[0], 600, 'Attempt 0');
  assert.equal(ep2.stats().opens, 0);
});

// ------------------------------------------------------------------ T9

test('T9 two nodes compete for 50 fake tasks over a real WebSocket (loopback): each task completes exactly once, and each node completes at least one', { timeout: 60_000 }, async (t) => {
  const env = await startQueueService();
  t.after(() => env.service.close());
  const nodes = [];
  for (const nodeId of ['n-a', 'n-b']) {
    const { ep, rec } = await endpoint({ url: env.url });
    t.after(() => ep.close());
    const n = attachNode(ep, { nodeId, executor: createSleepExecutor({ taskMs: 20 }), maxConcurrent: 2, tickMs: 5 });
    t.after(() => n.stop());
    nodes.push({ nodeId, ep, rec, n });
  }
  await waitFor(() => nodes.every((x) => x.rec.messages.some(byType('node.welcome'))), 3000, 'Both nodes check in');

  const page = await publisher(env.url);
  t.after(() => page.close());
  const run = `t9-${Date.now()}`;
  const tasks = Array.from({ length: 50 }, (_, i) => snapshotTaskInput({ resultKey: `rk-${run}-${i}`, projectId: run }));
  page.send({ type: 'task.publish', reqId: 'pub', tasks });
  const published = await page.next(byReq('pub'));
  assert.equal(published.results.filter((r) => r.created).length, 50);

  const doneOf = () => page.all.filter(byType('task.done'));
  await waitFor(() => new Set(doneOf().map((m) => m.id)).size === 50, 40_000, '50 task.done');
  await sleep(300);
  const counts = new Map();
  for (const m of doneOf()) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
  assert.equal(counts.size, 50);
  assert.ok([...counts.values()].every((c) => c === 1), `Some tasks completed more than once: ${JSON.stringify([...counts].filter(([, c]) => c > 1))}`);

  const completedBy = nodes.map((x) => x.n.events.filter((e) => e.type === 'completed' || e.type === 'dedup').map((e) => e.id));
  assert.equal(completedBy[0].length + completedBy[1].length, 50, `Completion counts of the two nodes: ${completedBy.map((l) => l.length)}`);
  assert.equal(new Set([...completedBy[0], ...completedBy[1]]).size, 50);
  assert.ok(completedBy[0].length >= 1 && completedBy[1].length >= 1, `At least one per node: ${completedBy.map((l) => l.length)}`);
  assert.ok(env.queue.describe().tasks.filter((x) => x.projectId === run).every((x) => x.state === 'done'));
  for (const x of nodes) assert.equal(x.ep.stats().badFrames, 0);
});
