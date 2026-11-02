/**
 * HTTP long polling transport for document service, server side (contract
 * `docs/plan/http-transport-contract.md` version 2 section 6).
 * Run: node --test server/test/docservice-http-transport.test.mjs
 *
 * In this phase (HT-a), long polling is not wired up: `createDocService` does not answer `/lp/…`.
 * Here we build a minimal assembly ourselves: core `createRouter`, session layer
 * `createSessionLayer`, `createHttpTransport`, and an http server bound only to loopback (port 0),
 * to verify transport is attached under session layer per section 6, for use when wiring HT-b.
 * Directly hits four endpoints (`fake-transport-kit.mjs`'s `lp`), bypassing node-side client.
 * The WebSocket portion of HT1 / HT2 is in `ht1-session.test.mjs` and `ht2-backpressure.test.mjs`
 * (test suite `claude/ht-tests`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRouter } from '../docservice/router.mjs';
import { createSessionLayer } from '../docservice/session.mjs';
import { createHttpTransport } from '../docservice/http-transport.mjs';
import { lp, recvUntil, authByProtocols } from './fake-transport-kit.mjs';
import { sleep, waitFor } from './fake-ws-kit.mjs';

const SID_RE = /^[A-Za-z0-9_-]{43}$/;
const NEW = 'promptcut.session.new';

/** Test module: `t.echo { n }` replies with `t.echoed`, `t.sink` does not reply */
function echoModule() {
  const mod = {
    name: 't', types: ['t.'], seen: [], connects: [], disconnects: [], ctx: null,
    connect(ctx, connId, principal) { mod.ctx = ctx; mod.connects.push({ connId, principal }); },
    disconnect(ctx, connId) { mod.disconnects.push(connId); },
    handle(ctx, connId, msg) {
      mod.seen.push(msg);
      if (msg.type === 't.echo') ctx.send(connId, { type: 't.echoed', n: msg.n });
    },
  };
  return mod;
}

async function startLp(t, { retainMs = 60_000, waitMs = 2000, highWaterBytes, maxPendingBytes, corsOrigins, maxFrameBytes } = {}) {
  const logs = [];
  const log = (event, fields) => logs.push({ event, ...fields });
  let n = 0;
  let sessions = null;
  const router = createRouter({
    log,
    write: (id, text) => sessions.write(id, text),
    buffered: (id) => sessions.buffered(id),
    close: (id, code, reason) => { sessions.close(id, code, reason); },
    highWaterBytes,
    maxPendingBytes,
  });
  sessions = createSessionLayer({ router, nextConnId: () => `conn-${++n}`, log, retainMs });
  const mod = echoModule();
  router.mount(mod);
  // Transport clock can be dialed (idle criterion is waitMs + 15 s, test does not actually wait)
  const clock = { offset: 0 };
  const transport = createHttpTransport({
    sessions, authenticate: authByProtocols, retainMs, waitMs, corsOrigins, maxFrameBytes, log, now: () => Date.now() + clock.offset,
  });
  const server = http.createServer((req, res) => {
    if (!transport.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await sessions.closeAll(1001, 'test done');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return { router, sessions, transport, mod, logs, base, c: lp(base), server, clock };
}

const openNew = async (env, user = 'alice', headers = {}) => {
  const r = await env.c.open(['promptcut.v1', `x-user.${user}`, NEW], headers);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

test('LP-open creates a session: replies sid, resumed false, ack 0, retainMs, waitMs, maxFrameBytes, protocol, transport http; a missing header, a first item that is not v1, or no session item gives 400; failed authentication gives 401', async (t) => {
  const env = await startLp(t, { retainMs: 45_000, waitMs: 5000 });
  const o = await openNew(env);
  assert.match(o.sid, SID_RE);
  assert.deepEqual({ ...o, sid: 'x' }, { ok: true, sid: 'x', resumed: false, ack: 0, retainMs: 45_000, waitMs: 5000, maxFrameBytes: 1024 * 1024, protocol: 'promptcut.v1', transport: 'http' });
  assert.equal(env.mod.connects.length, 1);
  assert.equal(env.mod.connects[0].principal.userId, 'alice');
  assert.equal((await env.c.open(null)).status, 400, 'missing X-Promptcut-Protocols');
  assert.equal((await env.c.open(['x-user.bob', 'promptcut.v1', NEW])).status, 400, 'first item is not promptcut.v1');
  assert.equal((await env.c.open(['promptcut.v1', 'x-user.bob'])).status, 400, 'long polling has no old clients: a session item is required');
  assert.equal((await env.c.open(['promptcut.v1', 'x-user.deny', NEW])).status, 401);
  const s = env.sessions.stats();
  assert.deepEqual({ total: s.total, http: s.http, ws: s.ws }, { total: 1, http: 1, ws: 0 });
  assert.ok(!JSON.stringify(env.logs).includes(o.sid), 'the session id stays out of the log');
});

test('LP-send-recv frames carry seq: modules do not see seq / ack; replies are in order and carry seq and ack; POST returns the ack for everything the server has fully received; a resend is dropped; a skipped number ends the session with 1002, and 410 afterwards', async (t) => {
  const env = await startLp(t);
  const { sid } = await openNew(env);
  const s1 = await env.c.send(sid, [{ type: 't.echo', n: 1, seq: 1 }, { type: 't.echo', n: 2, seq: 2 }]);
  assert.deepEqual(s1.body, { ok: true, ack: 2 });
  const got = await recvUntil(env.c, sid, (m) => m.n === 2);
  assert.deepEqual(got.frames.map((m) => [m.type, m.n, m.seq, m.ack]), [['t.echoed', 1, 1, 2], ['t.echoed', 2, 2, 2]]);
  assert.deepEqual(env.mod.seen, [{ type: 't.echo', n: 1 }, { type: 't.echo', n: 2 }], 'modules do not see seq / ack');
  // Resend the same batch: discard, still return ack
  assert.deepEqual((await env.c.send(sid, [{ type: 't.echo', n: 2, seq: 2 }])).body, { ok: true, ack: 2 });
  assert.equal(env.mod.seen.length, 2);
  // Skip sequence number
  const bad = await env.c.send(sid, [{ type: 't.echo', n: 9, seq: 9 }]);
  assert.equal(bad.status, 410);
  assert.equal(bad.body.code, 1002);
  await waitFor(() => env.mod.disconnects.length === 1, 1000, 'session ended');
  const after = await env.c.recv(sid, 2, 0);
  assert.equal(after.status, 200, 'the remaining frames and closed are returned to the client first');
  assert.deepEqual(after.body.closed, { code: 1002, reason: 'bad-seq' });
  const gone = await env.c.recv(sid, 2, 0);
  assert.equal(gone.status, 410);
  assert.equal(gone.body.error, 'session-closed');
});

test('LP-recv with no frames the GET hangs and returns empty when wait elapses; a new frame returns immediately; a new GET replaces the old one (the old one replies superseded); drained after ack releases', async (t) => {
  const env = await startLp(t);
  const { sid } = await openNew(env);
  const t0 = Date.now();
  const empty = await env.c.recv(sid, 0, 200);
  assert.deepEqual(empty.body, { ok: true, frames: [], closed: null });
  assert.ok(Date.now() - t0 >= 150, 'hung for the full wait');
  const hanging = env.c.recv(sid, 0, 1500);
  await sleep(50);
  const connId = env.mod.connects[0].connId;
  env.mod.ctx.send(connId, { type: 't.pushed' });
  const woke = await hanging;
  assert.equal(woke.body.frames.length, 1);
  assert.equal(JSON.parse(woke.body.frames[0]).seq, 1);
  // Replace
  const first = env.c.recv(sid, 1, 1500);
  await sleep(50);
  const second = env.c.recv(sid, 1, 100);
  assert.equal((await first).body.superseded, true);
  assert.equal((await second).status, 200);
  assert.equal(env.sessions.buffered(connId), 0, 'ack 1 released');
});

test('LP-resume resumes via open: no re-authentication, resumed true, ack is what the server has fully received; unacknowledged frames are resent (original seq); a resume with an out-of-range ack gets 410', async (t) => {
  const env = await startLp(t);
  const { sid } = await openNew(env);
  await env.c.send(sid, [{ type: 't.echo', n: 1, seq: 1 }, { type: 't.echo', n: 2, seq: 2 }]);
  await recvUntil(env.c, sid, (m) => m.n === 2);
  // Client only acknowledges up to 1, then assumes transport is broken and re-opens to resume
  const r = await env.c.open(['promptcut.v1', `promptcut.session.${sid}.1`], { 'x-promptcut-fallback': 'ws-error' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual({ sid: r.body.sid, resumed: r.body.resumed, ack: r.body.ack }, { sid, resumed: true, ack: 2 });
  const again = await env.c.recv(sid, 1, 0);
  assert.deepEqual(again.body.frames.map((f) => JSON.parse(f).seq), [2], 'resend seq 2');
  const s = env.sessions.stats();
  assert.equal(s.resumed, 1);
  assert.equal(s.fallbacks, 1);
  assert.equal(s.list[0].fallback, 'ws-error');
  assert.equal(env.mod.connects.length, 1, 'the module sees connect only once');
  // Providing both resume and auth items gives 400; session does not exist 404
  assert.equal((await env.c.open(['promptcut.v1', 'x-user.alice', `promptcut.session.${sid}.2`])).status, 400);
  assert.equal((await env.c.open(['promptcut.v1', `promptcut.session.${'A'.repeat(43)}.0`])).status, 404);
  // Out-of-bounds ack: session ends with 1002, returns 410
  const over = await env.c.open(['promptcut.v1', `promptcut.session.${sid}.99`]);
  assert.equal(over.status, 410);
  assert.equal(over.body.code, 1002);
  await waitFor(() => env.mod.disconnects.length === 1, 1000, 'session ended');
});

test('LP-close the client POSTs /lp/close: the session ends immediately (the module sees a disconnect), then 410; when the server closes (4003), the hanging GET first returns the remaining frames and then carries closed', async (t) => {
  const env = await startLp(t);
  const a = await openNew(env, 'alice');
  assert.equal((await env.c.close(a.sid, { code: 1000, reason: 'bye' })).status, 200);
  await waitFor(() => env.mod.disconnects.length === 1, 1000, 'disconnects immediately');
  const r = await env.c.recv(a.sid, 0, 0);
  assert.equal(r.status, 410);
  assert.deepEqual({ code: r.body.code, reason: r.body.reason }, { code: 1000, reason: 'bye' });

  const b = await openNew(env, 'bob');
  const connId = env.mod.connects[1].connId;
  env.mod.ctx.send(connId, { type: 't.pushed', k: 1 });
  const hanging = env.c.recv(b.sid, 0, 1500);
  await sleep(30);
  // Previous message was already fetched by this GET (unconfirmed); after another arrives, server kicks
  const waitAll = hanging.then(async (first) => {
    const rest = await env.c.recv(b.sid, 0, 1500);
    return [first, rest];
  });
  env.mod.ctx.send(connId, { type: 't.pushed', k: 2 });
  env.mod.ctx.close(connId, 4003, 'kicked');
  const [, rest] = await waitAll;
  assert.equal(rest.status, 200);
  assert.deepEqual(rest.body.frames.map((f) => JSON.parse(f).k), [1, 2], 'all frames unacknowledged when the session ended are returned first');
  assert.deepEqual(rest.body.closed, { code: 4003, reason: 'kicked' });
  assert.equal((await env.c.recv(b.sid, 0, 0)).status, 410);
});

test('LP-idle with no hanging GET and no request at all: sweep treats the transport as disconnected, the session only detaches (the module sees no disconnect), and it resumes later via open', async (t) => {
  const env = await startLp(t, { waitMs: 50, retainMs: 60_000 });
  const { sid } = await openNew(env);
  env.transport.sweep();
  assert.equal(env.sessions.stats().detached, 0, 'idle limit not reached yet');
  // Idle criterion is waitMs + 15 s: dial the transport clock forward
  env.clock.offset = 20_000;
  env.transport.sweep();
  env.clock.offset = 0;
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 1000, 'detached');
  assert.equal(env.sessions.stats().detached, 1);
  assert.equal(env.mod.disconnects.length, 0);
  assert.equal((await env.c.recv(sid, 0, 0)).status, 409, 'a disconnected transport must resume via open first');
  const r = await env.c.open(['promptcut.v1', `promptcut.session.${sid}.0`]);
  assert.equal(r.body.resumed, true);
  assert.equal(env.sessions.stats().detached, 0);
});

test('LP-413 a single frame over maxFrameBytes: 413, the session ends with 1009', async (t) => {
  const env = await startLp(t, { maxFrameBytes: 1000 });
  const { sid } = await openNew(env);
  const r = await env.c.send(sid, [{ type: 't.echo', n: 1, seq: 1, pad: 'x'.repeat(2000) }]);
  assert.equal(r.status, 413);
  await waitFor(() => env.mod.disconnects.length === 1, 1000, 'session ended');
  const after = await env.c.recv(sid, 0, 0);
  assert.equal(after.body.closed?.code ?? after.body.code, 1009);
});

test('LP-busy only one POST /lp/send per session is in flight at a time: the second replies 409 busy', async (t) => {
  const env = await startLp(t);
  const { sid } = await openNew(env);
  const url = new URL(`${env.base}/lp/send`);
  // First POST only sends request headers without finishing request body, holding it open
  const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { authorization: `Bearer ${sid}`, 'content-type': 'application/json', 'content-length': '100' } });
  req.on('error', () => {});
  req.write('{"frames":');
  await sleep(100);
  const second = await env.c.send(sid, [{ type: 't.echo', n: 1, seq: 1 }]);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'busy');
  req.destroy();
});

test('LP-backpressure the client does not fetch: unacknowledged bytes grow past maxPendingBytes, the core ends the session with 1013, and the next GET gets closed', async (t) => {
  const env = await startLp(t, { highWaterBytes: 4 * 1024, maxPendingBytes: 16 * 1024 });
  const { sid } = await openNew(env);
  const connId = env.mod.connects[0].connId;
  const pad = 'y'.repeat(1024);
  for (let i = 0; i < 40 && env.mod.disconnects.length === 0; i++) env.mod.ctx.send(connId, { type: 't.blob', i, pad });
  await waitFor(() => env.mod.disconnects.length === 1, 1000, 'ended by backpressure');
  const r = await env.c.recv(sid, 0, 0);
  assert.equal(r.status, 200);
  let closed = r.body.closed;
  while (!closed) closed = (await env.c.recv(sid, 0, 0)).body.closed;
  assert.equal(closed.code, 1013);
});

test('LP-cors an Origin on the list gets ACAO and Vary; the preflight 204 carries the allowed methods and headers (including X-Promptcut-Fallback); an empty list sends no CORS headers', async (t) => {
  const env = await startLp(t, { corsOrigins: ['https://ok.example'] });
  const pre = await env.c.options('open', { origin: 'https://ok.example' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://ok.example');
  assert.match(pre.headers.get('access-control-allow-headers'), /X-Promptcut-Fallback/);
  const bad = await env.c.options('open', { origin: 'https://evil.example' });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const o = await env.c.open(['promptcut.v1', 'x-user.a', NEW], { origin: 'https://ok.example' });
  assert.equal(o.headers.get('access-control-allow-origin'), 'https://ok.example');
  assert.equal(o.headers.get('vary'), 'Origin');
});
