import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createDocService } from '../docservice/service.mjs';
import { assetWiringPki } from './fixtures/asset-wiring-pki.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
// This is a transport-only fixture principal. It is deliberately not a production
// instance proof or run authority: crypto/ledger bindings have separate targets.
const fixtureAgent = { userId: 'fixture-agent', tenantId: 'fixture-project', realm: 'account', role: 'agent',
  identityVersion: 2, projectId: 'fixture-project', instanceId: 'fixture-instance', instanceGeneration: 1 };

test('Agent WS full dispatch holds ALS through module await, serializes frames and rejects superseded transport', { timeout: 12000 }, async t => {
  const first = deferred(), firstEntered = deferred(), ctx = new AsyncLocalStorage(), handled = [], released = [], wrappers = [];
  const service = createDocService({ authenticate: () => fixtureAgent, autoTick: false,
    modules: [{ name: 'fixture', types: ['fixture.'], async handle(api, connId, msg) {
      const cap = ctx.getStore(); assert.equal(cap.live, true); await Promise.resolve();
      assert.equal(ctx.getStore(), cap); assert.equal(cap.live, true); handled.push(msg.n);
      api.send(connId, { type: 'fixture.ok', reqId: msg.reqId, n: msg.n });
    } }],
    async dispatchInvocation(input, next) {
      if (input.kind === 'resume') return next();
      const frame = JSON.parse(input.text); wrappers.push(frame.n);
      if (frame.n === 1) { firstEntered.resolve(); await first.promise; }
      const cap = { live: true, n: frame.n };
      try { return await ctx.run(cap, () => next(input.text)); } finally { cap.live = false; released.push(frame.n); }
    } });
  const address = await service.listen(0, '127.0.0.1'), clients = [];
  t.after(async () => { first.resolve(); for (const client of clients) client.close(); await Promise.all(clients.map(c => c.closed));
    await service.close(); t.diagnostic(`owned WS port=${address.port}; actual close complete`); });
  const client = wsClient(`ws://127.0.0.1:${address.port}`, ['promptcut.v1', 'promptcut.session.new']); clients.push(client);
  await client.opened; const welcome = await client.next(m => m.type === 'session.welcome'); assert.match(welcome.connId, /^conn-/);
  client.send({ type: 'fixture.test', seq: 1, ack: 0, reqId: 'one', n: 1 }); await firstEntered.promise;
  client.send({ type: 'fixture.test', seq: 2, ack: 0, reqId: 'two', n: 2 });
  const resumed = wsClient(`ws://127.0.0.1:${address.port}`, ['promptcut.v1', `promptcut.session.${welcome.sid}.0`]); clients.push(resumed);
  await resumed.opened; const reconnect = await resumed.next(m => m.type === 'session.welcome'); assert.equal(reconnect.connId, welcome.connId);
  first.resolve(); await waitFor(() => released.includes(1));
  assert.deepEqual(handled, [], 'old awaited frame cannot enter replaced transport');
  assert.deepEqual(wrappers, [1], 'queued old frame 2 is skipped before invocation');
  resumed.send({ type: 'fixture.test', seq: 1, ack: 0, reqId: 'retry', n: 3 });
  assert.equal((await resumed.next(m => m.reqId === 'retry')).n, 3);
  resumed.send({ type: 'fixture.test', seq: 2, ack: 1, reqId: 'next', n: 4 });
  assert.equal((await resumed.next(m => m.reqId === 'next')).n, 4);
  assert.deepEqual(handled, [3, 4]); await waitFor(() => released.includes(4));
});

function httpRequest(port, tls, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = https.request({ host: '127.0.0.1', port, path: url, method, agent: false,
      key: tls.key, cert: tls.cert, ca: tls.ca, headers: { ...(encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(encoded);
  });
}

test('Agent LP waits for full module and holds read lease until fresh cache check/response; ordinary welcome unchanged', { timeout: 12000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-instance-core-')), pki = assetWiringPki(dir), ctx = new AsyncLocalStorage();
  const moduleGate = deferred(), moduleEntered = deferred(), recvEntered = deferred(); let live = true, recvReleased = false, checks = 0;
  const service = createDocService({ enableHttpTransport: true, autoTick: false, authenticate: () => fixtureAgent,
    modules: [{ name: 'fixture', types: ['fixture.'], async handle(api, connId, msg) {
      assert.equal(ctx.getStore()?.live, true); moduleEntered.resolve(); await moduleGate.promise;
      assert.equal(ctx.getStore()?.live, true); api.send(connId, { type: 'fixture.ok', reqId: msg.reqId });
    } }], async dispatchInvocation(input, next) {
      assert.equal(input.transport.internal, true); assert.equal(input.transport.socket.encrypted, true);
      assert.equal(input.transport.socket.authorized, true);
      const cap = { live: true }; const check = async () => { checks++; assert.equal(cap.live, true);
        if (!live) throw Object.assign(Error('revoked'), { status: 403, code: 'fixture-revoked' }); };
      await check(); if (input.kind === 'recv') recvEntered.resolve();
      try { return await ctx.run(cap, () => next(input.text, check)); }
      finally { cap.live = false; if (input.kind === 'recv') recvReleased = true; }
    } });
  const server = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    if (!service.handleTransportHttp(req, res)) { res.writeHead(404); res.end('{}'); }
  }); service.attachTransportServer(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  t.after(async () => { moduleGate.resolve(); await service.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); t.diagnostic(`owned TLS LP port=${port}; actual close complete`); });
  const request = (...args) => httpRequest(port, pki.asset, ...args);
  const opened = await request('POST', '/lp/open', {}, { 'x-promptcut-protocols': 'promptcut.v1, promptcut.session.new' });
  assert.equal(opened.status, 200); assert.match(opened.body.connId, /^conn-/); const auth = { authorization: `Bearer ${opened.body.sid}` };
  let sendDone = false;
  const sending = request('POST', '/lp/send', { frames: [JSON.stringify({ type: 'fixture.test', seq: 1, ack: 0, reqId: 'held' })] }, auth).then(value => { sendDone = true; return value; });
  await moduleEntered.promise; assert.equal(sendDone, false, 'LP ACK waits for async module under invocation'); moduleGate.resolve();
  assert.equal((await sending).body.ack, 1);
  const firstReply = await request('GET', '/lp/recv?ack=0&wait=0', undefined, auth); assert.equal(firstReply.status, 200);
  assert.equal(firstReply.body.frames.length, 1); await waitFor(() => recvReleased);
  recvReleased = false; const waiting = request('GET', '/lp/recv?ack=1&wait=100', undefined, auth); await recvEntered.promise;
  // The first recv resolved this gate too: identify the actual pending request by
  // waiting until the wrapper has performed another check and is not released.
  await waitFor(() => checks >= 4 && !recvReleased); live = false;
  const denied = await waiting; assert.equal(denied.status, 403); assert.equal(denied.body.error, 'fixture-revoked');
  assert.equal(denied.body.frames, undefined); await waitFor(() => recvReleased);
});

test('Agent LP rejects unproved oversize/empty sends and superseded recv/close before session side effects', { timeout: 12000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-instance-lp-boundary-')), pki = assetWiringPki(dir);
  const gates = new Map(); let invocations = 0;
  const service = createDocService({ enableHttpTransport: true, maxPayload: 256, autoTick: false,
    authenticate: () => fixtureAgent,
    modules: [{ name: 'fixture', types: ['fixture.'], handle(api, connId, msg) {
      api.send(connId, { type: 'fixture.ok', reqId: msg.reqId });
    } }], async dispatchInvocation(input, next) {
      invocations++;
      if (input.transport.req.headers['x-fixture-proof'] !== 'yes')
        throw Object.assign(Error('proof-required'), { status: 403, code: 'fixture-proof-required' });
      const gate = gates.get(input.transport.req.headers['x-fixture-held']);
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      return next(input.text, async () => {});
    } });
  const server = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    if (!service.handleTransportHttp(req, res)) { res.writeHead(404); res.end('{}'); }
  }); service.attachTransportServer(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  t.after(async () => { for (const gate of gates.values()) gate.release.resolve(); await service.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true }); t.diagnostic(`owned LP boundary port=${port}; actual close complete`); });
  const request = (...args) => httpRequest(port, pki.asset, ...args);
  const opened = await request('POST', '/lp/open', {}, { 'x-promptcut-protocols': 'promptcut.v1, promptcut.session.new' });
  const auth = { authorization: `Bearer ${opened.body.sid}` }, proof = { ...auth, 'x-fixture-proof': 'yes' };
  assert.equal((await request('POST', '/lp/send', { frames: ['x'.repeat(70000)] }, auth)).status, 413);
  assert.equal((await request('POST', '/lp/send', { frames: ['x'.repeat(257)] }, auth)).status, 413);
  const empty = await request('POST', '/lp/send', { frames: [] }, auth);
  assert.equal(empty.status, 400); assert.equal(empty.body.ack, undefined); assert.equal(invocations, 0);
  assert.equal((await request('POST', '/lp/send', { frames: [JSON.stringify({ type: 'fixture.echo', reqId: 'first', seq: 1, ack: 0 })] }, proof)).body.ack, 1);
  for (const kind of ['recv', 'close']) {
    const gate = { entered: deferred(), release: deferred() }; gates.set(kind, gate);
    const stale = request(kind === 'recv' ? 'GET' : 'POST', kind === 'recv' ? '/lp/recv?ack=1&wait=0' : '/lp/close',
      kind === 'recv' ? undefined : {}, { ...proof, 'x-fixture-held': kind });
    await gate.entered.promise;
    const resumed = await request('POST', '/lp/open', {}, { 'x-fixture-proof': 'yes',
      'x-promptcut-protocols': `promptcut.v1, promptcut.session.${opened.body.sid}.0` });
    assert.equal(resumed.status, 200); assert.equal(resumed.body.connId, opened.body.connId);
    gate.release.resolve(); const result = await stale;
    assert.equal(result.status, 409); assert.equal(result.body.error, 'superseded');
    assert.equal(result.body.ack, undefined); assert.equal(result.body.frames, undefined);
    const received = await request('GET', '/lp/recv?ack=0&wait=0', undefined, proof);
    assert.equal(received.status, 200); assert.equal(received.body.frames.length, 1, 'old recv cannot release cached frame; old close cannot end resumed session');
  }
});

test('instance-attempt resume cannot fall back to a cached ordinary page; ordinary public resume stays unchanged', { timeout: 12000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-instance-page-resume-')), pki = assetWiringPki(dir), clients = [];
  let invoked = 0;
  const service = createDocService({ enableHttpTransport: true, autoTick: false,
    authenticate: () => ({ userId: 'ordinary', role: 'editor' }),
    dispatchInvocation() { invoked++; throw Object.assign(Error('run-principal-invalid'), { status: 403, code: 'run-principal-invalid' }); } });
  const address = await service.listen(0, '127.0.0.1');
  const server = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    if (!service.handleTransportHttp(req, res)) { res.writeHead(404); res.end('{}'); }
  }); service.attachTransportServer(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  t.after(async () => { for (const c of clients) c.close(); await Promise.all(clients.map(c => c.closed)); await service.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
    t.diagnostic(`owned ordinary WS=${address.port}/TLS resume=${port}; actual close complete`); });
  const client = wsClient(`ws://127.0.0.1:${address.port}`, ['promptcut.v1', 'promptcut.session.new']); clients.push(client);
  await client.opened; const welcome = await client.next(m => m.type === 'session.welcome'); assert.equal(welcome.connId, undefined);
  const attempted = wsClient(`ws://127.0.0.1:${address.port}/?runGrantId=not-authority`,
    ['promptcut.v1', `promptcut.session.${welcome.sid}.0`]); clients.push(attempted);
  await attempted.opened; assert.equal((await attempted.closed).code, 4003); assert.equal(invoked, 1);
  assert.equal(attempted.all.some(m => m.type === 'session.welcome'), false);
  const denied = await httpRequest(port, pki.asset, 'POST', '/lp/open', {}, {
    'x-promptcut-protocols': `promptcut.v1, promptcut.session.${welcome.sid}.0` });
  assert.equal(denied.status, 403); assert.equal(denied.body.error, 'run-principal-invalid'); assert.equal(invoked, 2);
  const ordinary = wsClient(`ws://127.0.0.1:${address.port}`, ['promptcut.v1', `promptcut.session.${welcome.sid}.0`]); clients.push(ordinary);
  await ordinary.opened; assert.equal((await ordinary.next(m => m.type === 'session.welcome')).resumed, true);
  assert.equal(invoked, 2, 'ordinary resume follows its unchanged path');
});

test('unproved partial Agent LP bodies own no send slot or idle clock', { timeout: 12000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-instance-partial-body-')), pki = assetWiringPki(dir), partials = [];
  let offset = 0;
  const service = createDocService({ enableHttpTransport: true, autoTick: false, heartbeatMs: 10, now: () => Date.now() + offset,
    authenticate: () => fixtureAgent, dispatchInvocation(input, next) {
      if (input.transport.req.headers['x-fixture-proof'] !== 'yes')
        throw Object.assign(Error('proof-required'), { status: 403, code: 'fixture-proof-required' });
      return next(input.text, async () => {});
    } });
  const server = https.createServer({ ...pki.doc, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    if (!service.handleTransportHttp(req, res)) { res.writeHead(404); res.end('{}'); }
  }); service.attachTransportServer(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  t.after(async () => { for (const owner of partials) owner.req.destroy(); await Promise.all(partials.map(owner => owner.closed));
    await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true }); t.diagnostic(`owned partial-body TLS=${port}; actual close complete`); });
  const request = (...args) => httpRequest(port, pki.asset, ...args);
  const open = () => request('POST', '/lp/open', {}, { 'x-promptcut-protocols': 'promptcut.v1, promptcut.session.new' });
  const partial = async sid => {
    const owner = {}, flushed = deferred(), received = new Promise(resolve => server.once('request', resolve));
    owner.req = https.request({ host: '127.0.0.1', port, path: '/lp/send', method: 'POST', agent: false, ...pki.asset,
      headers: { authorization: `Bearer ${sid}`, 'content-length': 100 } }); owner.req.on('error', () => {});
    owner.req.on('socket', socket => { owner.closed = new Promise(resolve => socket.once('close', resolve));
      socket.once('secureConnect', () => owner.req.write('{', () => flushed.resolve())); });
    partials.push(owner); await flushed.promise; await received;
    // The server observes actual request bytes. Wait for its request callback,
    // without allowing a response or completing the unproved body.
    await new Promise(resolve => setImmediate(resolve)); return owner;
  };
  const first = await open(); await partial(first.body.sid);
  const sent = await request('POST', '/lp/send', { frames: [JSON.stringify({ type: 'fixture.none', seq: 1, ack: 0 })] },
    { authorization: `Bearer ${first.body.sid}`, 'x-fixture-proof': 'yes' });
  assert.equal(sent.status, 200, 'unproved partial body cannot force legitimate send busy'); assert.equal(sent.body.ack, 1);
  const second = await open(); await partial(second.body.sid); offset = 41000;
  await waitFor(() => service.describe().conns.find(conn => conn.connId === second.body.connId)?.detached, 1000,
    'unproved partial body cannot claim sending or refresh idle state');
});
