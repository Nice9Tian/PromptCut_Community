/**
 * 客户端会话层 `createDocEndpoint`（`server/render-node/session-link.mjs`，契约 `docs/plan/http-transport-contract.md`
 * 第 3、4、9、16 节）对着真的文档服务跑。跑：node --test server/test/session-link.test.mjs
 *
 * 服务端会话层在 `claude/http-transport` 上，还没合进来：这里用 `session-gateway-kit.mjs` 的会话网关（测试用的
 * 最小会话服务端桩）挡在真文档服务前面讲会话，网关背后每个会话一条旧式连接。断线用 `fake-ws-kit.mjs` 的 TCP 代理。
 * 另测对旧服务端（没有会话层）的退化、`transport` 的取值、`renew: false` 与 `onConnectFail`。
 * 假 WebSocket 逐步驱动的用例在测试方的 `ht4-client.test.mjs`（`claude/ht-tests`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocService } from '../docservice/service.mjs';
import { createDocEndpoint, transportOf, wsUrlOf, httpUrlOf, utf8Length, SESSION_DEFAULTS, closedCodeOf, FINAL_CLOSE } from '../render-node/session-link.mjs';
import { createTcpProxy, waitFor, sleep } from './fake-ws-kit.mjs';
import { startSessionGateway, startLegacyFront } from './session-gateway-kit.mjs';

const BACKOFF = { baseMs: 20, factor: 2, maxMs: 100, jitter: 0 };

/** 测试模块 `sl`：`sl.echo { n }` → `sl.echoed { n }`；记下看到的消息与连接生命周期 */
function slModule() {
  const mod = {
    name: 'sl',
    types: ['sl.'],
    seen: [],
    connects: [],
    disconnects: [],
    ctx: null,
    connect(ctx, connId) { mod.ctx = ctx; mod.connects.push(connId); },
    disconnect(ctx, connId) { mod.disconnects.push(connId); },
    handle(ctx, connId, msg) {
      mod.ctx = ctx;
      mod.seen.push({ connId, msg });
      if (msg.type === 'sl.echo') ctx.send(connId, { type: 'sl.echoed', n: msg.n });
    },
  };
  return mod;
}

async function startDoc(t, { deny = false } = {}) {
  const mod = slModule();
  const service = createDocService({
    log: () => {},
    autoTick: false,
    modules: [mod],
    authenticate: () => (deny ? null : { userId: 'u-sl', tenantId: 't-sl' }),
  });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(() => service.close());
  return { service, mod, port, url: `ws://127.0.0.1:${port}/` };
}

function watch(ep) {
  const ev = { opens: 0, resumes: 0, closes: [], got: [], fails: [] };
  ep.onOpen(() => { ev.opens += 1; });
  ep.onResume(() => { ev.resumes += 1; });
  ep.onClose((info) => ev.closes.push(info));
  ep.onMessage((m) => ev.got.push(m));
  ep.onConnectFail((info) => ev.fails.push(info));
  return ev;
}

async function gatewayPair(t, { retainMs = 60_000 } = {}) {
  const doc = await startDoc(t);
  const gw = await startSessionGateway({ upstream: doc.url, retainMs });
  t.after(() => gw.close());
  const proxy = await createTcpProxy({ target: gw.port });
  t.after(() => proxy.close());
  const logs = [];
  const ep = createDocEndpoint({
    url: `http://127.0.0.1:${proxy.port}/`,
    protocols: () => ['promptcut.v1'],
    backoff: BACKOFF,
    transport: 'ws',
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  t.after(() => ep.close());
  const ev = watch(ep);
  await waitFor(() => ev.opens === 1, 3000, 'session created');
  return { doc, gw, proxy, ep, ev, logs };
}

test('SL-resume transport cut: resumes automatically, messages from both sides during the break arrive exactly once and in order; the core sees only one connection; the log contains no session id', async (t) => {
  const { doc, gw, proxy, ep, ev, logs } = await gatewayPair(t);
  assert.equal(ep.stats().legacy, false);
  ep.send({ type: 'sl.echo', n: 1 });
  await waitFor(() => ev.got.some((m) => m.n === 1), 2000, 'reply 1');
  proxy.cutAll();
  ep.send({ type: 'sl.echo', n: 2 });
  ep.send({ type: 'sl.echo', n: 3 });
  await waitFor(() => gw.stats.resumed >= 0 && [...gw.sessions.values()].some((s) => s.ws === null), 2000, 'Gateway detached');
  doc.mod.ctx.send(doc.mod.connects[0], { type: 'sl.pushed' });
  await waitFor(() => ev.got.filter((m) => m.type === 'sl.echoed').length === 3 && ev.got.some((m) => m.type === 'sl.pushed'), 5000, 'All arrived after resume');
  assert.equal(ev.resumes, 1);
  assert.equal(ev.opens, 1);
  assert.deepEqual(ev.closes, []);
  assert.deepEqual(doc.mod.seen.map((s) => s.msg.n), [1, 2, 3], 'The module gets each message once, in order');
  assert.deepEqual(ev.got.filter((m) => m.type === 'sl.echoed').map((m) => m.n), [1, 2, 3]);
  for (const m of ev.got) assert.ok(!('seq' in m) && !('ack' in m), `the upper layer cannot see seq / ack: ${JSON.stringify(m)}`);
  assert.equal(doc.mod.connects.length, 1);
  assert.equal(doc.mod.disconnects.length, 0);
  assert.equal(ep.stats().resumes, 1);
  assert.equal(ep.stats().transport, 'ws');
  await waitFor(() => ep.stats().pendingBytes === 0, 3000, 'Acknowledgement released');
  const sid = [...gw.sessions.keys()][0];
  assert.ok(!JSON.stringify(logs).includes(sid), 'the session id stays out of the log');
  assert.ok(logs.some((l) => l.event === 'session.detach') && logs.some((l) => l.event === 'session.resume'));
});

test('SL-drop-transport dropTransport() only cuts the transport: the session resumes, onClose is not called', async (t) => {
  const { gw, ep, ev } = await gatewayPair(t);
  assert.equal(ep.dropTransport(), true);
  ep.send({ type: 'sl.echo', n: 7 });
  await waitFor(() => ev.got.some((m) => m.n === 7), 3000, 'Reply after resume');
  assert.equal(ev.resumes, 1);
  assert.deepEqual(ev.closes, []);
  assert.equal(gw.stats.opened, 1);
});

test('SL-4410 the session has expired on the server: resume is closed with 4410, onClose once, session rebuilt', async (t) => {
  const { doc, proxy, ev } = await gatewayPair(t, { retainMs: 200 });
  proxy.mode = 'reject';
  proxy.cutAll();
  await waitFor(() => doc.mod.disconnects.length === 1, 3000, 'Gateway retention period elapsed, upstream disconnected');
  proxy.mode = 'pass';
  await waitFor(() => ev.opens === 2, 5000, 'session rebuilt');
  assert.equal(ev.closes.length, 1);
  assert.ok([4410, 1006].includes(ev.closes[0].code), JSON.stringify(ev.closes));
  assert.equal(doc.mod.connects.length, 2);
});

test('SL-4404 swapped to a different server (session does not exist): resume is closed with 4404, rebuilt immediately without waiting for the retention period', async (t) => {
  const { proxy, ev } = await gatewayPair(t, { retainMs: 60_000 });
  const doc2 = await startDoc(t);
  const gw2 = await startSessionGateway({ upstream: doc2.url });
  t.after(() => gw2.close());
  proxy.retarget(gw2.port);
  const t0 = Date.now();
  proxy.cutAll();
  await waitFor(() => ev.opens === 2, 5000, 'session rebuilt on the new service');
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(ev.closes.map((c) => c.code), [4404]);
  assert.equal(doc2.mod.connects.length, 1);
});

test('SL-server-end the server ends the session with 4003: onClose { 4003 }, no resume, new session', async (t) => {
  const { gw, ev } = await gatewayPair(t);
  gw.endAll(4003, 'kicked');
  await waitFor(() => ev.closes.length === 1, 3000, 'onClose');
  assert.deepEqual(ev.closes[0], { code: 4003, reason: 'kicked' });
  await waitFor(() => ev.opens === 2, 3000, 'New session');
  assert.equal(ev.resumes, 0);
  assert.equal(gw.stats.resumed, 0);
});

test('SL-close close(): the server ends the session immediately (upstream disconnected), the endpoint no longer reconnects', async (t) => {
  const { doc, gw, ep, ev } = await gatewayPair(t);
  ep.close();
  await waitFor(() => doc.mod.disconnects.length === 1, 3000, 'Upstream disconnected');
  assert.equal(gw.sessions.size, 0);
  await sleep(150);
  assert.equal(gw.stats.opened, 1);
  assert.deepEqual(ev.closes, [{ code: 1000, reason: 'closed' }]);
});

test('SL-legacy old server (no session layer): degrades to one session per transport, send and receive work as usual, the probe error is not passed to the upper layer, a disconnect reports onClose and then rebuilds', async (t) => {
  const doc = await startDoc(t);
  const front = await startLegacyFront({ upstream: doc.url });
  t.after(() => front.close());
  const proxy = await createTcpProxy({ target: front.port });
  t.after(() => proxy.close());
  const ep = createDocEndpoint({ url: `ws://127.0.0.1:${proxy.port}/`, backoff: BACKOFF, transport: 'ws', log: () => {} });
  t.after(() => ep.close());
  const ev = watch(ep);
  await waitFor(() => ev.opens === 1, 3000, 'Established on the old server');
  assert.equal(ep.stats().legacy, true);
  ep.send({ type: 'sl.echo', n: 1 });
  await waitFor(() => ev.got.some((m) => m.n === 1), 2000, 'reply');
  await sleep(100);
  assert.deepEqual(ev.got, [{ type: 'sl.echoed', n: 1 }], 'The probe error unsupported is not passed to the upper layer, messages unchanged');
  assert.deepEqual(doc.mod.seen.map((s) => s.msg), [{ type: 'sl.echo', n: 1 }], 'Messages received by the old server carry no seq');
  proxy.cutAll();
  await waitFor(() => ev.closes.length === 1, 3000, 'A disconnect means the session ends');
  assert.equal(ep.send({ type: 'sl.echo', n: 2 }), false, 'Dropped while disconnected');
  await waitFor(() => ev.opens === 2, 3000, 'Rebuilt');
  assert.equal(ev.resumes, 0);
});

test('SL-renew-false handshake rejected: onConnectFail, the endpoint closes itself and does not retry; when the session ends it closes in the same way', async (t) => {
  const doc = await startDoc(t, { deny: true });
  const ep = createDocEndpoint({ url: doc.url, backoff: BACKOFF, transport: 'ws', renew: false, log: () => {} });
  t.after(() => ep.close());
  const ev = watch(ep);
  await waitFor(() => ev.fails.length === 1, 3000, 'onConnectFail');
  assert.equal(ep.closed, true);
  await sleep(150);
  assert.equal(ev.fails.length, 1);
  assert.equal(ev.opens, 0);

  const { gw } = await gatewayPair(t);
  const ep2 = createDocEndpoint({ url: gw.url, backoff: BACKOFF, transport: 'ws', renew: false, log: () => {} });
  t.after(() => ep2.close());
  const ev2 = watch(ep2);
  await waitFor(() => ev2.opens === 1, 3000, 'session created');
  gw.endAll(4003, 'kicked');
  await waitFor(() => ev2.closes.length === 1, 3000, 'onClose');
  assert.equal(ep2.closed, true);
  await sleep(150);
  assert.equal(ev2.opens, 1, 'No new session is created');
});

test('SL-transport transport values: auto / ws are accepted, http returns not enabled in HT-a, anything else throws; the environment variable comes after the options', () => {
  assert.equal(transportOf(undefined, undefined), 'auto');
  assert.equal(transportOf('WS', undefined), 'ws');
  assert.equal(transportOf(undefined, 'ws'), 'ws');
  assert.equal(transportOf('auto', 'ws'), 'auto');
  assert.throws(() => transportOf('http', undefined), (e) => e.code === 'transport-unavailable');
  assert.throws(() => transportOf(undefined, 'http'), (e) => e.code === 'transport-unavailable');
  assert.throws(() => transportOf('sse', undefined), TypeError);
  assert.throws(() => createDocEndpoint({ url: 'ws://127.0.0.1:1/', transport: 'http' }), (e) => e.code === 'transport-unavailable');
  assert.equal(wsUrlOf('https://h.test/hosted'), 'wss://h.test/hosted');
  assert.equal(wsUrlOf('ws://h.test:8787/'), 'ws://h.test:8787/');
  assert.equal(httpUrlOf('wss://h.test/hosted'), 'https://h.test/hosted');
  assert.throws(() => wsUrlOf('ftp://h.test/'), TypeError);
  assert.equal(utf8Length('aé中😀'), 1 + 2 + 3 + 4);
});

test('SL-agent-link the Agent server connection (doc-link) goes through a session: when the transport is cut, in-flight requests still get their replies, and the connection does not count as disconnected', async (t) => {
  const http = await import('node:http');
  const { createSharedDocService } = await import('../docservice/shared-service.mjs');
  const { createAgentLink } = await import('../agent/doc-link.mjs');
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await built.service.close(); await new Promise((resolve) => server.close(resolve)); });
  const gw = await startSessionGateway({ upstream: `ws://127.0.0.1:${server.address().port}/docservice` });
  t.after(() => gw.close());
  const proxy = await createTcpProxy({ target: gw.port });
  t.after(() => proxy.close());
  const logs = [];
  const link = createAgentLink({ url: `ws://127.0.0.1:${proxy.port}/`, projectId: 'p-sl', protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`], log: (event, fields) => logs.push({ event, ...fields }) });
  t.after(() => link.close());
  const conv = link.conversation(1);
  await link.ready(5000);
  proxy.cutAll();
  const reply = await conv.request({ type: 'project.op', projectId: 'p-sl', opId: 'sl-op-1', session: 'agent-sl', ops: [{ op: 'set', path: '', value: { id: 'p-sl', tracks: [] } }] });
  assert.equal(reply.type, 'project.op.ok', JSON.stringify(reply));
  assert.ok(logs.some((l) => l.event === 'agent.link.resume'), `Resumed: ${JSON.stringify(logs.map((l) => l.event))}`);
  assert.ok(!logs.some((l) => l.event === 'agent.link.close'), 'No disconnect');
  assert.equal(gw.stats.opened, 1, 'Only one session was ever created');
  assert.equal(link.describe().conversations[0].state, 'open');
});

/** 最小的假 WebSocket：测试手动触发 open / message，记下客户端发出的消息 */
function fakeSocketClass() {
  const sockets = [];
  class FakeWs {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; this.l = {};
      sockets.push(this);
    }
    addEventListener(type, fn) { (this.l[type] ??= []).push(fn); }
    emit(type, ev) { for (const fn of this.l[type] ?? []) fn(ev); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
    open(welcome) { this.readyState = 1; this.emit('open', {}); this.emit('message', { data: JSON.stringify({ type: 'session.welcome', sid: 'S'.repeat(43), resumed: false, ack: 0, retainMs: 60_000, transport: 'ws', ...welcome }) }); }
    push(msg) { this.emit('message', { data: JSON.stringify(msg) }); }
    acks() { return this.sent.filter((m) => m.type === 'session.ack'); }
  }
  return { FakeWs, sockets };
}

test('SL-resume-route resume carries the new routing capability', async () => {
  const { FakeWs, sockets } = fakeSocketClass();
  let release, calls = 0;
  const ep = createDocEndpoint({ url: 'ws://relay.test/', WebSocket: FakeWs, transport: 'ws', legacyProbeMs: -1,
    resumeProtocols: () => { calls++; return new Promise(r => { release = r; }); },
    backoff: { baseMs: 1, factor: 2, maxMs: 1, jitter: 0 } });
  sockets[0].open();
  assert.equal(ep.dropTransport(), true);
  await waitFor(() => calls === 1, 1000, 'resume route requested');
  release(['promptcut.route.fresh-route']); await waitFor(() => sockets.length === 2, 1000, 'resume socket');
  assert.ok(sockets[1].protocols.includes('promptcut.route.fresh-route'));
  assert.ok(sockets[1].protocols.some(p => p.startsWith('promptcut.session.')));
  ep.close();
});

test('SL-resume-route-error a temporary routing failure keeps the session and retries; after close, a late result does not create a connection', async () => {
  const { FakeWs, sockets } = fakeSocketClass();
  let release, calls = 0;
  const ep = createDocEndpoint({ url: 'ws://relay.test/', WebSocket: FakeWs, transport: 'ws', legacyProbeMs: -1,
    resumeProtocols: () => { calls++; if (calls === 1) throw new TypeError('network'); return new Promise(r => { release = r; }); },
    backoff: { baseMs: 1, factor: 2, maxMs: 1, jitter: 0 } });
  sockets[0].open(); ep.dropTransport();
  await waitFor(() => calls === 2, 1000, 'route retry');
  assert.equal(ep.connected, true); assert.equal(ep.stats().detached, true);
  ep.close(); release(['promptcut.route.late']); await new Promise(r => setImmediate(r));
  assert.equal(sockets.length, 1);
});

test('SL-ack-bytes once 64 KiB of unacknowledged raw text has been received, send session.ack immediately on its own without waiting 1 s ([ruling] 2026-09-27, same rule on both ends)', () => {
  const { FakeWs, sockets } = fakeSocketClass();
  const ep = createDocEndpoint({ url: 'ws://doc.test/', WebSocket: FakeWs, transport: 'ws', log: () => {}, legacyProbeMs: -1 });
  try {
    const got = [];
    ep.onMessage((m) => got.push(m));
    const s = sockets[0];
    s.open();
    const pad = 'p'.repeat(40 * 1024);
    s.push({ type: 'x', seq: 1, pad });
    assert.deepEqual(s.acks(), [], '40 KiB: not yet 64 KiB, no immediate ack');
    s.push({ type: 'x', seq: 2, pad });
    assert.deepEqual(s.acks(), [{ type: 'session.ack', ack: 2 }], 'Over 64 KiB cumulatively: acknowledges up to 2 on the spot');
    s.push({ type: 'x', seq: 3, pad: 'q' });
    assert.equal(s.acks().length, 1, 'Counting restarts from the ack point: a single small message is not acknowledged immediately');
    for (let n = 4; n <= 34; n++) s.push({ type: 'x', seq: n });
    assert.deepEqual(s.acks().at(-1), { type: 'session.ack', ack: 34 }, 'Reaching 32 messages still acknowledges immediately as before');
    assert.equal(got.length, 34);
    assert.deepEqual(SESSION_DEFAULTS.ackBytes, 64 * 1024);
  } finally {
    ep.close();
  }
});

// ------------------------------------------------------------------ 4410 的上报（〔裁〕2026-09-27 主会话，契约第 17 节）
// 用户看得到的行为不许因会话层而变：脱开期间会话因「连着时收到也不会重连」的码（4003 / 4004）结束，接续得到 4410 时，
// 上层收到的是原关闭码，与连着时收到一样；原关闭码属于会重连的那类（或 reason 里没有原关闭码）才报 4410 并重建。

/** 真服务（有会话层）前面挡一个 TCP 代理，端点经代理连 */
async function realPair(t, { retainMs = 60_000, renew = true } = {}) {
  const mod = slModule();
  const service = createDocService({
    log: () => {}, autoTick: false, modules: [mod], retainMs,
    authenticate: () => ({ userId: 'u-sl', tenantId: 't-sl' }),
  });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(() => service.close());
  const proxy = await createTcpProxy({ target: port });
  t.after(() => proxy.close());
  const logs = [];
  const ep = createDocEndpoint({
    url: `ws://127.0.0.1:${proxy.port}/`, protocols: () => ['promptcut.v1'], backoff: BACKOFF, transport: 'ws', renew,
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  t.after(() => ep.close());
  const ev = watch(ep);
  await waitFor(() => ev.opens === 1, 3000, 'session created');
  const health = async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  return { service, mod, port, proxy, ep, ev, logs, health };
}

/** 让会话脱开（代理拒绝新连接、掐断现有的），等服务端看到脱开 */
async function detach(pair) {
  pair.proxy.mode = 'reject';
  pair.proxy.cutAll();
  await waitFor(async () => (await pair.health()).sessions.detached === 1, 3000, 'server detached');
}

test('SL-closed-code extract the original close code from the reason of 4410: session-closed <code>[ <reason>]; any other form returns null', () => {
  assert.deepEqual(closedCodeOf('session-closed 4004 deleted'), { code: 4004, reason: 'deleted' });
  assert.deepEqual(closedCodeOf('session-closed 4003 removed'), { code: 4003, reason: 'removed' });
  assert.deepEqual(closedCodeOf('session-closed 1006 timeout'), { code: 1006, reason: 'timeout' });
  assert.deepEqual(closedCodeOf('session-closed 1000'), { code: 1000, reason: '' });
  assert.equal(closedCodeOf('session-closed'), null);
  assert.equal(closedCodeOf('no-session'), null);
  assert.equal(closedCodeOf(undefined), null);
  assert.deepEqual([...FINAL_CLOSE].sort(), [4003, 4004]);
});

for (const [code, reason] of [[4004, 'deleted'], [4003, 'kicked'], [4003, 'removed']]) {
  test(`SL-4410-final the server ends the session with ${code} ${reason} while detached: resume gets 4410, the upper layer receives ${code} ${reason}, same as when connected`, async (t) => {
    const pair = await realPair(t, { renew: false });
    const connId = pair.mod.connects[0];
    await detach(pair);
    assert.equal(pair.mod.ctx.close(connId, code, reason), true, 'The server closed the detached session');
    await waitFor(() => pair.mod.disconnects.length === 1, 3000, 'Server disconnected');
    pair.proxy.mode = 'pass';
    await waitFor(() => pair.ev.closes.length === 1, 5000, 'onClose');
    assert.deepEqual(pair.ev.closes, [{ code, reason }], 'Reported with the original close code and reason');
    assert.equal(pair.ev.resumes, 0);
    assert.ok(pair.logs.some((l) => l.event === 'session.lost' && l.code === 4410 && l.closedCode === code), 'The log records 4410 and the original code');
    // 对照：连着时收到同一个码，上层看到的一样
    const live = await realPair(t, { renew: false });
    live.mod.ctx.close(live.mod.connects[0], code, reason);
    await waitFor(() => live.ev.closes.length === 1, 3000, 'onClose while connected');
    assert.deepEqual(live.ev.closes, pair.ev.closes, 'The upper layer receives the same thing while detached as while connected');
  });
}

test('SL-4410-final-renew endpoint with the default renew (node): the project is deleted while detached, and after onClose { 4004 } a new session is created with backoff, same as when connected', async (t) => {
  const pair = await realPair(t);
  await detach(pair);
  pair.mod.ctx.close(pair.mod.connects[0], 4004, 'deleted');
  await waitFor(() => pair.mod.disconnects.length === 1, 3000, 'Server disconnected');
  pair.proxy.mode = 'pass';
  await waitFor(() => pair.ev.opens === 2, 5000, 'New session');
  assert.deepEqual(pair.ev.closes, [{ code: 4004, reason: 'deleted' }]);
});

for (const [code, reason] of [[1013, 'backpressure'], [1001, 'shutdown'], [1000, '']]) {
  test(`SL-4410-renew the session ends with ${code}, a code that reconnects, while detached: 4410 is still reported and the session is rebuilt`, async (t) => {
    const pair = await realPair(t);
    await detach(pair);
    pair.mod.ctx.close(pair.mod.connects[0], code, reason);
    await waitFor(() => pair.mod.disconnects.length === 1, 3000, 'Server disconnected');
    pair.proxy.mode = 'pass';
    await waitFor(() => pair.ev.opens === 2, 5000, 'session rebuilt');
    assert.equal(pair.ev.closes.length, 1);
    assert.equal(pair.ev.closes[0].code, 4410);
    assert.equal(closedCodeOf(pair.ev.closes[0].reason)?.code, code, `The reason carries the original code: ${pair.ev.closes[0].reason}`);
  });
}

test('SL-4410-expired retention period elapsed: reports 4410 (tombstone 1006 timeout) or this end decides it expired first (1006 retain-expired), both rebuild, and 4003 / 4004 are not reported', async (t) => {
  const pair = await realPair(t, { retainMs: 300 });
  await detach(pair);
  await waitFor(() => pair.mod.disconnects.length === 1, 3000, 'Retention period elapsed');
  pair.proxy.mode = 'pass';
  await waitFor(() => pair.ev.opens === 2, 5000, 'session rebuilt');
  assert.equal(pair.ev.closes.length, 1);
  const c = pair.ev.closes[0];
  assert.ok(c.code === 1006 || (c.code === 4410 && closedCodeOf(c.reason)?.code === 1006), JSON.stringify(c));
});
