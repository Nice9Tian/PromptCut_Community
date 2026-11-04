/**
 * Attached mode for the document service (contract `docs/plan/docservice-contract.md` Section 4,
 * test cases M1-M4).
 * Run: node --test server/test/docservice-attach.test.mjs
 *
 * Written strictly against the contract, ignoring implementation details.
 * `createDocService({ server })` attaches to an HTTP server started by the test (port 0).
 * The host server has another `upgrade` handler taking over `/other`, simulating Vite's HMR:
 * it only recognizes its own paths and leaves the rest untouched.
 * principal is provided by the test's `authenticate` based on query string `?user=`
 * (see `fake-docservice-env.mjs`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createDocService } from '../docservice/service.mjs';
import { wsClient, rawHandshake, byType, sleep } from './fake-ws-kit.mjs';
import { loadStore, loadProject, authByQuery } from './fake-docservice-env.mjs';

const PATH = '/docservice';

/**
 * Start host HTTP server: normal requests return `host:<url>`; `/other` upgrades
 * are taken over by its handler (101 after 30 ms)
 */
async function startHost() {
  const other = [];
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-host': '1' });
    res.end(`host:${req.url}`);
  });
  const hmr = (req, socket) => {
    const p = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (p !== '/other') return; // Only recognizes its own paths
    other.push(req.url);
    socket.on('error', () => {});
    setTimeout(() => {
      if (socket.destroyed) return;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nx-handled-by: other\r\n\r\n');
      socket.end();
    }, 30);
  };
  server.on('upgrade', hmr);
  // Upgraded sockets are not managed by HTTP server and cannot be closed by closeAllConnections;
  // record them ourselves and close all on teardown to prevent close from hanging
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const close = () => new Promise((resolve) => {
    for (const s of sockets) s.destroy();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  return { server, port, other, hmr, close };
}

/**
 * Raw upgrade request: check for response or closed socket within ms (tests "document service
 * leaves this upgrade untouched")
 */
async function silentUpgrade(port, path, ms = 200) {
  const sock = netConnect(port, '127.0.0.1');
  sock.on('error', () => {});
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  let data = '';
  let closed = false;
  sock.on('data', (d) => { data += d.toString('latin1'); });
  sock.on('close', () => { closed = true; });
  sock.write([
    `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', '', '',
  ].join('\r\n'));
  await sleep(ms);
  sock.destroy();
  return { data, closed };
}

async function httpGet(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, host: res.headers.get('x-host'), text: await res.text() };
}

/**
 * Example module `text.` unrelated to rendering (R1, C1 style):
 *   text.count { text } → text.counted { lines, chars }
 *   text.whoami        → text.me { principal }
 *   text.sub { room }  → text.subbed { ok } (subscribes to text:<room>)
 *   text.pub { room, v } → text.published { n }, and publishes text.msg { room, v } on text:<room>
 */
function textModule() {
  const principals = new Map();
  return {
    name: 'text',
    types: ['text.'],
    channels: ['text'],
    connect(ctx, connId, principal) { principals.set(connId, principal); },
    disconnect(ctx, connId) { principals.delete(connId); },
    handle(ctx, connId, m) {
      const r = m.reqId === undefined ? {} : { reqId: m.reqId };
      if (m.type === 'text.count') {
        const text = String(m.text ?? '');
        ctx.send(connId, { type: 'text.counted', lines: text.split('\n').length, chars: text.length, ...r });
      } else if (m.type === 'text.whoami') {
        ctx.send(connId, { type: 'text.me', principal: principals.get(connId) ?? null, ...r });
      } else if (m.type === 'text.sub') {
        ctx.send(connId, { type: 'text.subbed', ok: ctx.subscribe(connId, `text:${m.room}`), ...r });
      } else if (m.type === 'text.pub') {
        const n = ctx.publish(`text:${m.room}`, { type: 'text.msg', room: m.room, v: m.v });
        ctx.send(connId, { type: 'text.published', n, ...r });
      } else {
        ctx.send(connId, { type: 'text.error', ...r });
      }
    },
  };
}

async function makeModules() {
  const { createMemoryStore } = await loadStore();
  const makeProject = await loadProject();
  return [textModule(), makeProject({ store: createMemoryStore() })];
}

/** Attached mode: host + document service */
async function startAttached({ modules, ...options } = {}) {
  const mods = modules ?? await makeModules(); // Fetch modules first: fail before starting host if missing, leaving no listening server
  const host = await startHost();
  const logs = [];
  let service;
  try {
    service = createDocService({
      server: host.server, path: PATH, autoTick: false, authenticate: authByQuery,
      log: (event, fields) => logs.push({ event, ...fields }), modules: mods, ...options,
    });
  } catch (err) {
    await host.close();
    throw err;
  }
  const clients = [];
  const connect = async (user) => {
    const c = wsClient(`ws://127.0.0.1:${host.port}${PATH}${user ? `?user=${user}` : ''}`);
    clients.push(c);
    await c.opened;
    return c;
  };
  let done = false;
  const cleanup = async () => {
    if (done) return;
    done = true;
    for (const c of clients) c.close();
    try { await within(Promise.resolve(service.close()), 3000, 'service.close()'); } catch { /* Already closed or hanging; force-close host below */ }
    await host.close();
  };
  // Fail immediately if not attached (e.g. `server` option ignored, created own server),
  // avoiding subsequent handshakes timing out one by one
  if (host.server.listenerCount('upgrade') !== 2) {
    await cleanup();
    assert.fail(`Attached mode must add one upgrade listener on the host, but the host now has ${host.server.listenerCount('upgrade')}`);
  }
  return { host, service, port: host.port, connect, cleanup, logs, health: async () => service.health() };
}

/** Standalone mode: same paths and modules */
async function startStandaloneSame({ modules } = {}) {
  const service = createDocService({
    path: PATH, autoTick: false, authenticate: authByQuery, log: () => {}, modules: modules ?? await makeModules(),
  });
  const { port } = await service.listen(0, '127.0.0.1');
  const clients = [];
  const connect = async (user) => {
    const c = wsClient(`ws://127.0.0.1:${port}${PATH}${user ? `?user=${user}` : ''}`);
    clients.push(c);
    await c.opened;
    return c;
  };
  let done = false;
  const cleanup = async () => {
    if (done) return;
    done = true;
    for (const c of clients) c.close();
    await service.close();
  };
  return { service, port, connect, cleanup, health: async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json() };
}

let seq = 0;
async function ask(c, message) {
  const reqId = `m-${++seq}`;
  c.send({ ...message, reqId });
  return c.next((m) => m.reqId === reqId || (m.type === 'error' && m.reqId === undefined));
}

/** Wait for a Promise with timeout (close() must not hang) */
function within(promise, ms, what) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} exceeded ${ms} ms`)), ms))]);
}

// ------------------------------------------------------------------ M1

test('M1 attached to an existing http server: the /docservice WebSocket works; upgrades for /other are still handled by the original handler, and the document service does not touch it', async (t) => {
  const env = await startAttached();
  t.after(env.cleanup);
  assert.equal(env.host.server.listenerCount('upgrade'), 2, 'The document service adds only one upgrade listener');
  assert.equal(env.host.server.listenerCount('request'), 1, 'The document service does not answer HTTP requests and adds no request listener');

  // Document service WebSocket
  const a = await env.connect('alice');
  const st = await ask(a, { type: 'project.open', projectId: 'm1' });
  assert.deepEqual({ type: st.type, projectRev: st.projectRev }, { type: 'project.state', projectRev: 0 });
  const counted = await ask(a, { type: 'text.count', text: 'a\nb' });
  assert.deepEqual({ type: counted.type, lines: counted.lines, chars: counted.chars }, { type: 'text.counted', lines: 2, chars: 3 });
  await ask(a, { type: 'project.announce', projectId: 'm1', digest: 'ab'.repeat(16) });
  assert.equal((await a.next(byType('project.rev'))).actor?.userId, 'alice');

  // /other: handled by original handler, document service neither returns 404 nor closes it
  const hs = await rawHandshake(env.port, { path: '/other' });
  hs.sock.destroy();
  assert.equal(hs.status, 101, `The upgrade for /other should be answered with 101 by the original handler: ${hs.rawHead}`);
  assert.equal(hs.headers['x-handled-by'], 'other');
  assert.deepEqual(env.host.other, ['/other']);
  const hs2 = await rawHandshake(env.port, { path: '/other?token=x' });
  hs2.sock.destroy();
  assert.equal(hs2.headers['x-handled-by'], 'other', '/other with a query string is also left alone');

  // Paths claimed by neither: document service also leaves them untouched (no 404, does not close)
  const silent = await silentUpgrade(env.port, '/nobody');
  assert.deepEqual(silent, { data: '', closed: false }, 'Upgrades on other paths are never touched by the document service');
  const prefix = await silentUpgrade(env.port, '/docservice-other');
  assert.deepEqual(prefix, { data: '', closed: false }, 'Only paths whose pathname is exactly equal are recognized');

  // HTTP: host responds as usual, document service does not respond (including /healthz)
  assert.deepEqual(await httpGet(env.port, '/healthz'), { status: 200, host: '1', text: 'host:/healthz' });
  assert.deepEqual(await httpGet(env.port, PATH), { status: 200, host: '1', text: `host:${PATH}` });

  // Document service path works as usual
  assert.equal((await ask(a, { type: 'text.count', text: 'x' })).chars, 1);
});

// ------------------------------------------------------------------ M2

test('M2 after close() the host server is still listening, other paths work as usual; all document service connections are dropped; the upgrade listener is removed', async (t) => {
  const env = await startAttached();
  t.after(env.cleanup);
  const a = await env.connect('alice');
  const b = await env.connect('bob');
  await ask(a, { type: 'project.open', projectId: 'm2' });
  assert.equal(env.host.server.listenerCount('upgrade'), 2);
  const requestListeners = env.host.server.listenerCount('request');

  await within(Promise.resolve(env.service.close()), 3000, 'close()');
  const [ca, cb] = await within(Promise.all([a.closed, b.closed]), 3000, 'Waiting for the document service connections to drop');
  assert.ok(ca && cb, 'Both connections received the close');

  assert.equal(env.host.server.listening, true, 'The host server is still listening');
  assert.equal(env.host.server.listenerCount('upgrade'), 1, 'Its own upgrade listener has been removed');
  assert.ok(env.host.server.listeners('upgrade').includes(env.host.hmr), 'The original handler is still there');
  assert.equal(env.host.server.listenerCount('request'), requestListeners, 'The request listeners are unchanged');
  assert.deepEqual(await httpGet(env.port, '/x'), { status: 200, host: '1', text: 'host:/x' });
  const hs = await rawHandshake(env.port, { path: '/other' });
  hs.sock.destroy();
  assert.equal(hs.headers['x-handled-by'], 'other', '/other works as usual');
  assert.deepEqual(await silentUpgrade(env.port, PATH, 150), { data: '', closed: false }, 'After close the document service no longer handles its own path');
});

// ------------------------------------------------------------------ M3

test('M3 in attached mode listen() throws; health() has the same fields as /healthz in standalone mode', async (t) => {
  const env = await startAttached();
  t.after(env.cleanup);
  // Contract Section 10, Item 1: throws synchronously
  assert.throws(() => env.service.listen(0, '127.0.0.1'), 'listen() throws synchronously in attached mode');
  assert.equal(env.host.server.listening, true, 'The host is unaffected');
  assert.equal(typeof env.service.health, 'function', 'Attached mode exposes health()');

  const solo = await startStandaloneSame();
  t.after(solo.cleanup);
  await env.connect('alice');
  await solo.connect('alice');

  const h1 = await env.health();
  const h2 = await solo.health();
  assert.deepEqual(Object.keys(h1).sort(), Object.keys(h2).sort(), 'Same fields');
  assert.equal(h1.ok, true);
  assert.equal(h1.service, h2.service);
  assert.equal(h1.protocol, h2.protocol);
  assert.deepEqual(h1.modules, h2.modules, 'Same module list');
  assert.ok(h1.modules.includes('project') && h1.modules.includes('text'));
  assert.equal(h1.connections, 1);
  assert.equal(h2.connections, 1);
  assert.equal(typeof h1.uptimeMs, 'number');
  assert.deepEqual(JSON.parse(JSON.stringify(h1)), h1, 'health() can be serialized as is for the host\'s route');
});

// ------------------------------------------------------------------ M4

/**
 * Same set of assertions (R1-style module routing without crosstalk, C1-style channels delivery
 * only to subscribers, authentication and principal), returning comparable records.
 */
async function scenario(env) {
  const out = {};
  // Authentication: rejected → 401; passed with promptcut.v1 → 101 and echoed
  const denied = await rawHandshake(env.port, { path: `${PATH}?user=deny`, protocols: ['promptcut.v1'] });
  denied.sock.destroy();
  out.denied = denied.status;
  const okHs = await rawHandshake(env.port, { path: `${PATH}?user=zed`, protocols: ['promptcut.v1'] });
  okHs.sock.destroy();
  out.accepted = [okHs.status, okHs.headers['sec-websocket-protocol']];
  assert.equal(out.denied, 401, 'authenticate returns null → 401');
  assert.deepEqual(out.accepted, [101, 'promptcut.v1']);

  const a = await env.connect('alice');
  const b = await env.connect('bob');
  const c = await env.connect('carol');

  // principal comes from authenticate, self-reported values in messages are ignored
  const me = await ask(a, { type: 'text.whoami', userId: 'mallory' });
  out.principal = me.principal;
  assert.deepEqual(me.principal, { userId: 'alice', tenantId: 't-test' });

  // R1 style: two modules alternate, each correct without crosstalk; unclaimed types → unsupported;
  // bad messages → bad-message
  const r1 = [];
  for (let i = 0; i < 3; i++) {
    const t1 = await ask(a, { type: 'text.count', text: 'x\n'.repeat(i) });
    const p1 = await ask(a, { type: 'project.open', projectId: `m4-${i}` });
    r1.push([t1.type, t1.lines, p1.type, p1.projectRev]);
  }
  out.r1 = r1;
  assert.deepEqual(r1, [['text.counted', 1, 'project.state', 0], ['text.counted', 2, 'project.state', 0], ['text.counted', 3, 'project.state', 0]]);
  out.unsupported = (await ask(a, { type: 'nobody.here' })).reason;
  assert.equal(out.unsupported, 'unsupported');
  a.send('not json');
  out.badJson = (await a.next(byType('error'))).reason;
  assert.equal(out.badJson, 'bad-message');
  out.queue = (await ask(a, { type: 'node.hello' })).reason;

  // C1 style: channels only reach subscribers; return value equals delivery count;
  // duplicate subscriptions return false
  assert.equal((await ask(a, { type: 'text.sub', room: 'r' })).ok, true);
  assert.equal((await ask(b, { type: 'text.sub', room: 'r' })).ok, true);
  out.resub = (await ask(b, { type: 'text.sub', room: 'r' })).ok;
  assert.equal(out.resub, false, 'A repeated subscription returns false');
  const pub = await ask(c, { type: 'text.pub', room: 'r', v: 7 });
  out.published = pub.n;
  assert.equal(pub.n, 2, 'publish returns the delivery count');
  assert.deepEqual([(await a.next(byType('text.msg'))).v, (await b.next(byType('text.msg'))).v], [7, 7]);
  assert.deepEqual(await c.quiet(byType('text.msg'), 100), [], 'Those not subscribed receive nothing');

  // Project channels: only reach connections that open-ed this project, actor comes from principal
  await ask(b, { type: 'project.open', projectId: 'm4-0' });
  const ann = await ask(c, { type: 'project.announce', projectId: 'm4-0', digest: 'cd'.repeat(16), session: 's' });
  out.announced = [ann.type, ann.projectRev, ann.changed];
  const revA = await a.next(byType('project.rev'));
  const revB = await b.next(byType('project.rev'));
  out.rev = [revA.projectRev, revA.actor, revB.projectRev];
  assert.deepEqual(out.rev, [1, { userId: 'carol', session: 's' }, 1]);
  assert.deepEqual(await c.quiet(byType('project.rev'), 100), [], 'The initiator does not receive it without having opened it');

  // Subscriptions cleared after disconnect
  a.close();
  await a.closed;
  await sleep(50);
  out.afterClose = (await ask(c, { type: 'text.pub', room: 'r', v: 8 })).n;
  assert.equal(out.afterClose, 1, 'Dropped connections no longer count toward delivery');
  return out;
}

test('M4 attached mode and standalone mode behave the same for modules, channels, and authentication: the same set of R1 and C1 style assertions runs once in each', async (t) => {
  const attached = await startAttached();
  t.after(attached.cleanup);
  const solo = await startStandaloneSame();
  t.after(solo.cleanup);

  const r2 = await scenario(solo);
  const r1 = await scenario(attached);
  assert.deepEqual(r1, r2, 'The records of the two modes are identical item by item');
  assert.equal(r1.queue, 'queue-unavailable', 'Without a queue attached, the placeholder module still replies queue-unavailable');
});
