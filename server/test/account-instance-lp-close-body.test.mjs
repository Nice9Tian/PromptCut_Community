import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRouter } from '../docservice/router.mjs';
import { createSessionLayer } from '../docservice/session.mjs';
import { createHttpTransport } from '../docservice/http-transport.mjs';

const agent = Object.freeze({ userId: 'fixture-agent', tenantId: 'fixture-project', realm: 'account', role: 'agent',
  projectId: 'fixture-project', instanceId: 'fixture-instance', instanceGeneration: 1 });
const ordinary = Object.freeze({ userId: 'fixture-page', tenantId: 'fixture-project', role: 'editor' });
const openProtocols = 'promptcut.v1, promptcut.session.new';

function dispatch(env, method, path, { body = '', headers = {}, chunks, abort = false } = {}) {
  const encoded = Buffer.from(body);
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  req.headers = { ...(body.length ? { 'content-length': String(encoded.length) } : {}), ...headers };
  if (chunks) delete req.headers['content-length'];
  req.socket = Object.assign(new EventEmitter(), { remoteAddress: '127.0.0.1', closed: true });
  req.aborted = false;
  req.resume = () => {};
  const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writableEnded: false, closed: true,
    writeHead(statusCode, responseHeaders) { this.statusCode = statusCode; this.responseHeaders = responseHeaders; this.headersSent = true; },
    end(responseBody = '') { this.body = responseBody; this.writableEnded = true; this.emit('finish'); },
    destroy() { this.destroyed = true; this.closed = true; this.emit('close'); },
  });
  const done = new Promise(resolve => res.once('finish', resolve));
  assert.equal(env.transport.handle(req, res), true);
  if (abort) {
    req.aborted = true;
    req.emit('aborted');
  } else if (!(Number(req.headers['content-length']) > 4096)) {
    for (const chunk of chunks ?? [encoded]) if (chunk.length) req.emit('data', chunk);
    req.emit('end');
  }
  return { req, res, done };
}

async function start(t, principal = agent) {
  let seq = 0;
  let currentTime = Date.now();
  let sessions;
  const router = createRouter({ write: (id, text) => sessions.write(id, text),
    buffered: id => sessions.buffered(id), close: (id, code, reason) => sessions.close(id, code, reason) });
  sessions = createSessionLayer({ router, nextConnId: () => `conn-${++seq}`, now: () => currentTime });
  const invocations = [];
  let abortedCloseResolve;
  const transport = createHttpTransport({ sessions, authenticate: () => principal, principalOf: () => principal,
    needsInvocation: value => value?.realm === 'account' && value?.role === 'agent', waitMs: 1,
    now: () => currentTime,
    dispatchInvocation(input, next) { invocations.push({ kind: input.kind, bodyText: input.bodyText }); return next(input.bodyText); } });
  t.after(() => sessions.closeAll(1001, 'test done'));
  return { sessions, transport, invocations, setTime(value) { currentTime = value; } };
}

async function openSession(env) {
  const result = dispatch(env, 'POST', '/lp/open', { body: '{}', headers: { 'x-promptcut-protocols': openProtocols } });
  await result.done;
  assert.equal(result.res.statusCode, 200, result.res.body);
  return JSON.parse(result.res.body);
}

async function primePending(env, opened) {
  env.sessions.write(opened.connId, JSON.stringify({ type: 'fixture.pending', n: 1 }));
  assert.equal(env.sessions.hasPending(opened.connId), true);
}

async function assertStillUnchanged(env, opened, beforeDispatch) {
  assert.equal(env.invocations.length, beforeDispatch, 'invalid close body never reaches signature dispatch');
  assert.equal(env.sessions.has(opened.connId), true, 'the session remains live');
  assert.equal(env.sessions.tombOf(opened.sid), null, 'no close tombstone is written');
  assert.equal(env.sessions.hasPending(opened.connId), true, 'queued outbound data remains cached');
  assert.equal(env.transport.stats().transports, 1, 'the HTTP transport remains attached');
}

async function assertIdleClockNotRefreshed(env, opened) {
  // waitMs=1 plus the existing 15s idle slack; sweep detaches only if close did
  // not mutate lastSeen. The pending frame and session remain available to resume.
  env.setTime(Date.now() + 16_000);
  env.transport.sweep();
  assert.equal(env.sessions.describeConn(opened.connId).detached, true, 'malformed close does not refresh lastSeen');
  assert.equal(env.sessions.hasPending(opened.connId), true, 'idle detach preserves the unacknowledged frame');
  assert.equal(env.sessions.has(opened.connId), true);
}

test('aborted signed LP-close body is ignored without dispatch, session/cache mutation, or lastSeen refresh', async t => {
  const env = await start(t);
  const opened = await openSession(env);
  await primePending(env, opened);
  const beforeDispatch = env.invocations.length;
  const result = dispatch(env, 'POST', '/lp/close', { headers: { authorization: `Bearer ${opened.sid}`,
    'content-type': 'application/json', 'content-length': '100' }, abort: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.res.writableEnded, false, 'an aborted request gets no response');
  await assertStillUnchanged(env, opened, beforeDispatch);
  await assertIdleClockNotRefreshed(env, opened);
});

for (const mode of ['declared-too-large', 'streamed-too-large']) {
  test(`${mode} LP-close body returns 413 before dispatch or session side effects`, async t => {
    const env = await start(t);
    const opened = await openSession(env);
    await primePending(env, opened);
    const beforeDispatch = env.invocations.length;
    const headers = { authorization: `Bearer ${opened.sid}`, 'content-type': 'application/json' };
    let result;
    if (mode === 'declared-too-large') {
      result = dispatch(env, 'POST', '/lp/close', { body: ' '.repeat(4097), headers });
    } else {
      result = dispatch(env, 'POST', '/lp/close', { headers: { ...headers, 'transfer-encoding': 'chunked' },
        chunks: [Buffer.from(' '.repeat(4096)), Buffer.from(' ')] });
    }
    await result.done;
    assert.equal(result.res.statusCode, 413);
    assert.deepEqual(JSON.parse(result.res.body), { ok: false, error: 'too-large' });
    await assertStillUnchanged(env, opened, beforeDispatch);
    await assertIdleClockNotRefreshed(env, opened);
  });
}

test('empty scoped close body is rejected rather than normalized into a signature input', async t => {
  const env = await start(t);
  const opened = await openSession(env);
  await primePending(env, opened);
  const beforeDispatch = env.invocations.length;
  const result = dispatch(env, 'POST', '/lp/close', { headers: { authorization: `Bearer ${opened.sid}` } });
  await result.done;
  assert.equal(result.res.statusCode, 400);
  assert.deepEqual(JSON.parse(result.res.body), { ok: false, error: 'bad-request' });
  await assertStillUnchanged(env, opened, beforeDispatch);
  await assertIdleClockNotRefreshed(env, opened);
});

test('valid scoped close body is dispatched exactly once; ordinary close and resume remain supported', async t => {
  const scoped = await start(t, agent);
  const agentSession = await openSession(scoped);
  const signedBody = JSON.stringify({ code: 1000, reason: 'agent done', fixtureSignature: 'controlled-valid-proof' });
  const closed = dispatch(scoped, 'POST', '/lp/close', { body: signedBody,
    headers: { authorization: `Bearer ${agentSession.sid}` } });
  await closed.done;
  assert.equal(closed.res.statusCode, 200, closed.res.body);
  assert.deepEqual(scoped.invocations, [{ kind: 'close', bodyText: signedBody }]);
  assert.equal(scoped.sessions.has(agentSession.connId), false);
  assert.deepEqual(scoped.sessions.tombOf(agentSession.sid), { code: 1000, reason: 'agent done' });

  const lan = await start(t, ordinary);
  const pageSession = await openSession(lan);
  const resumed = dispatch(lan, 'POST', '/lp/open', { body: '{}', headers: {
    'x-promptcut-protocols': `promptcut.v1, promptcut.session.${pageSession.sid}.0`,
  } });
  await resumed.done;
  assert.equal(resumed.res.statusCode, 200, resumed.res.body);
  assert.equal(JSON.parse(resumed.res.body).resumed, true);
  const pageClose = dispatch(lan, 'POST', '/lp/close', { body: JSON.stringify({ code: 1000, reason: 'page done' }),
    headers: { authorization: `Bearer ${pageSession.sid}` } });
  await pageClose.done;
  assert.equal(pageClose.res.statusCode, 200);
  assert.deepEqual(lan.invocations, []);
  assert.equal(lan.sessions.has(pageSession.connId), false);
});
