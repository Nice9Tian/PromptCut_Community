/**
 * Cluster token authentication for the document service (contract
 * `docs/plan/render-queue-contract.md` G.5, test cases A1-A6).
 *
 * Modified in M6a (`docs/plan/auth-contract.md` Sections 5 and 10): cluster tokens are removed
 * from the data plane; connections with valid tokens have admin identity
 * `{ userId: 'admin', tenantId: null, scope: 'admin' }` and can only use management interfaces
 * (service address registration), returning `forbidden` when sending data plane messages;
 * standalone mode fail-closed condition changed from "non-loopback with no token set" to
 * "non-loopback with unavailable credential store". Changes are listed item by item in
 * `docs/archive/agent-reports/AGENT-m6-auth.md` "Modified old tests".
 * Run: node --test server/test/docservice-auth.test.mjs
 *
 * Written strictly against the contract, ignoring implementation details. Tokens are generated
 * on the fly in the test (32-byte base64url), not hardcoded.
 *
 * Wiring follows contract G.12: `createDocService({ authenticate: auth.authenticate, log })`,
 * `auth = createClusterAuth({ token, allowAnonymous, log })`, passing the same `log` to both sides
 * (A5 collects `auth.reject`); subprotocol echo is handled by the assembly layer itself
 * (`protocol` option defaults to `promptcut.v1`), with no extra configuration needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDocService } from '../docservice/service.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { endpointsModule } from '../docservice/modules/endpoints.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { rawHandshake, randomToken, wsClient, byReq, byType, waitFor } from './fake-ws-kit.mjs';
import { startSharedService, createProject, join, deviceId as newDeviceId, tempDir } from './fake-shared-env.mjs';

const ADMIN = Object.freeze({ userId: 'admin', tenantId: null, scope: 'admin' });

const MAIN = fileURLToPath(new URL('../docservice/main.mjs', import.meta.url));

async function loadAuth() {
  return import('../docservice/auth.mjs');
}

/**
 * Starts the service: token mode if token is provided, otherwise anonymous mode.
 * Collects logs into logs (both from the assembly layer and the authentication module).
 */
async function startService({ token, allowAnonymous = token === undefined, mount = true } = {}) {
  const { createClusterAuth } = await loadAuth();
  const logs = [];
  const log = (event, fields) => logs.push({ event, ...fields });
  const auth = createClusterAuth({ token, allowAnonymous, log });
  const service = createDocService({ log, authenticate: auth.authenticate, autoTick: false });
  let queue = null;
  if (mount) {
    queue = createRenderQueue({ now: Date.now, send: service.send });
    service.mountRenderQueue(queue);
    // M6a: mount service address registration (management interface), test that admin identity can use it (A2, A6)
    service.mount(endpointsModule());
  }
  const { port } = await service.listen(0, '127.0.0.1');
  return { service, queue, port, logs, auth, url: `ws://127.0.0.1:${port}` };
}

const tokenProtocols = (token) => ['promptcut.v1', `promptcut.token.${token}`];

/** Creates a fake request with only headers / socket to test the auth module itself */
function fakeReq(protocolHeader, remote = '10.0.0.5') {
  const headers = {};
  if (protocolHeader !== undefined) headers['sec-websocket-protocol'] = protocolHeader;
  return { headers, socket: { remoteAddress: remote }, url: '/', method: 'GET' };
}

// ------------------------------------------------------------------ A1

test('A1 token mode: no subprotocol, only promptcut.v1, wrong token → 401', async (t) => {
  const token = randomToken();
  const { service, port } = await startService({ token });
  t.after(() => service.close());

  const cases = [
    ['No subprotocol', undefined],
    ['Only promptcut.v1', ['promptcut.v1']],
    ['wrong token', tokenProtocols(randomToken())],
    ['Only the token entry, missing promptcut.v1', [`promptcut.token.${token}`]],
    ['Correct token prefix but truncated', tokenProtocols(token.slice(0, -1))],
  ];
  for (const [what, protocols] of cases) {
    const r = await rawHandshake(port, { protocols });
    r.sock.destroy();
    assert.equal(r.status, 401, `${what}: ${r.rawHead}`);
  }
  assert.equal(service.describe().connections, 0);
});

test('A1 the auth module itself: in token mode a missing protocol, a missing token, or a wrong token all return null; constants and utility functions', async () => {
  const { createClusterAuth, PROTOCOL, isLoopbackHost, checkTokenFormat } = await loadAuth();
  assert.equal(PROTOCOL, 'promptcut.v1');
  const token = randomToken();
  const auth = createClusterAuth({ token, allowAnonymous: false });
  assert.equal(auth.authenticate(fakeReq(undefined)), null);
  assert.equal(auth.authenticate(fakeReq('promptcut.v1')), null);
  assert.equal(auth.authenticate(fakeReq(`promptcut.v1, promptcut.token.${randomToken()}`)), null);
  // M6a: matching token yields admin identity (originally was { userId: 'cluster', tenantId: 'cluster' })
  assert.deepEqual(auth.authenticate(fakeReq(`promptcut.v1, promptcut.token.${token}`)), ADMIN);
  assert.equal(auth.protocolFor(fakeReq(`promptcut.v1, promptcut.token.${token}`)), 'promptcut.v1');
  assert.equal(auth.protocolFor(fakeReq(undefined)), null);

  for (const h of ['127.0.0.1', '::1', 'localhost']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['0.0.0.0', '192.168.1.2', '', '::']) assert.equal(isLoopbackHost(h), false, h);

  assert.equal(checkTokenFormat(token), true);
  assert.equal(checkTokenFormat('a'.repeat(32)), true);
  assert.equal(checkTokenFormat('a'.repeat(256)), true);
  assert.equal(checkTokenFormat('a'.repeat(31)), false);
  assert.equal(checkTokenFormat('a'.repeat(257)), false);
  assert.equal(checkTokenFormat(`${'a'.repeat(32)}=`), false);
  assert.equal(checkTokenFormat(`${'a'.repeat(32)} `), false);
  assert.equal(checkTokenFormat(''), false);
  assert.equal(checkTokenFormat(undefined), false);
});

// ------------------------------------------------------------------ A2

test('A2 correct token → 101, and the Sec-WebSocket-Protocol response header is exactly promptcut.v1; the built-in WebSocket can connect and can only use the admin interface', async (t) => {
  const token = randomToken();
  const { service, port, url } = await startService({ token });
  t.after(() => service.close());

  const r = await rawHandshake(port, { protocols: tokenProtocols(token) });
  r.sock.destroy();
  assert.equal(r.status, 101, r.rawHead);
  assert.equal(r.acceptOk, true);
  assert.equal(r.headers['sec-websocket-protocol'], 'promptcut.v1', 'Only echoes promptcut.v1, never echoes the token entry');
  assert.ok(!r.rawHead.includes(token), 'The token does not appear in the response headers');

  // Same even if the order provided by the client is reversed
  const r2 = await rawHandshake(port, { protocols: [`promptcut.token.${token}`, 'promptcut.v1'] });
  r2.sock.destroy();
  assert.equal(r2.status, 101);
  assert.equal(r2.headers['sec-websocket-protocol'], 'promptcut.v1');

  const c = wsClient(url, tokenProtocols(token));
  t.after(() => c.close());
  await c.opened;
  assert.equal(c.ws.protocol, 'promptcut.v1');
  // M6a: Originally sent publisher.hello waiting for publisher.welcome here; admin identity sending
  // data plane messages returns forbidden, management interface works as usual
  c.send({ type: 'publisher.hello', reqId: 1, publisherId: 'pg' });
  const denied = await c.next(byReq(1));
  assert.equal(denied.type, 'error');
  assert.equal(denied.reason, 'forbidden');
  c.send({ type: 'service.watch', reqId: 2, kinds: 'all' });
  assert.equal((await c.next(byReq(2))).type, 'service.endpoints');
});

// ------------------------------------------------------------------ A3

test('A3 the principal of a token connection is the admin identity, and any data plane message gets forbidden', async (t) => {
  const token = randomToken();
  const { service, url } = await startService({ token });
  t.after(() => service.close());
  const c = wsClient(url, tokenProtocols(token));
  t.after(() => c.close());
  await c.opened;
  const dataPlane = [
    { type: 'node.hello', nodeId: 'nd', profile: 'host' },
    { type: 'publisher.hello', publisherId: 'pg' },
    { type: 'queue.watch', projects: 'all' },
    { type: 'task.publish', tasks: [] },
  ];
  for (const [i, m] of dataPlane.entries()) {
    c.send({ ...m, reqId: `d${i}`, userId: 'mallory', tenantId: 'evil' });
    const r = await c.next(byReq(`d${i}`));
    assert.equal(r.type, 'error', m.type);
    assert.equal(r.reason, 'forbidden', m.type);
  }
  for (const conn of service.describe().conns) assert.deepEqual(conn.principal, ADMIN);
});

// The other half of original A3 ("userId self-reported in message does not change principal,
// task userId uses the connection's principal") is now tested via shared project member identity:
// cluster tokens can no longer enter the data plane (auth-contract Section 5)
test('A3 member identity: the userId / tenantId self-reported in a message does not change it, and the task\'s source comes from the connection\'s principal', async (t) => {
  const shared = await startSharedService({ mode: 'hosted' });
  t.after(() => shared.close());
  const { projectId } = await createProject(shared.base, { password: 'pw-a3' });
  const devPage = newDeviceId('a3p');
  const devNode = newDeviceId('a3n');
  const page = await join(shared.base, { projectId, username: 'carol', deviceId: devPage, password: 'pw-a3', role: 'page' });
  const node = await join(shared.base, { projectId, username: 'carol', deviceId: devNode, password: 'pw-a3', role: 'render' });
  t.after(() => { page.close(); node.close(); });
  await Promise.all([page.opened, node.opened]);
  const service = shared.service;
  const principalOf = (dev) => ({ userId: `carol@${dev}`, tenantId: projectId });

  node.send({ type: 'node.hello', reqId: 'n', nodeId: 'nd', profile: 'host', userId: 'mallory', tenantId: 'evil' });
  await node.next(byReq('n'));
  // M6c X3: host watch 'all' only receives summaries, not single-task deltas; to check task.opened
  // here, changed to watch the project where the task resides (originally 'all')
  node.send({ type: 'queue.watch', reqId: 'w', projects: ['proj'] });
  await node.next(byReq('w'));

  page.send({ type: 'publisher.hello', reqId: 'p', publisherId: 'pg', userId: 'mallory', tenantId: 'evil' });
  await page.next(byReq('p'));
  const rk = 'rk-a3';
  page.send({
    type: 'task.publish', reqId: 'pub', userId: 'mallory',
    tasks: [{
      id: `snapshot:${rk}:0-9`, kind: 'snapshot', tier: 'shared', resultKey: rk, range: { unit: 'localFrame', from: 0, to: 9 },
      source: { projectId: 'proj', projectRev: 1, userId: 'mallory', tenantId: 'evil' },
    }],
  });
  await page.next(byReq('pub'));
  const opened = await node.next(byType('task.opened'));
  assert.equal(opened.task.source.userId, principalOf(devPage).userId, 'The task\'s userId comes from the connection\'s principal');
  assert.equal(opened.task.source.tenantId, projectId);

  const conns = service.describe().conns;
  assert.equal(conns.length, 2);
  for (const conn of conns) {
    const dev = conn.principal.deviceId;
    assert.ok(dev === devPage || dev === devNode);
    assert.equal(conn.principal.userId, principalOf(dev).userId);
    assert.equal(conn.principal.tenantId, projectId);
  }
});

// ------------------------------------------------------------------ A4

test('A4 anonymous mode: an old client with no subprotocol can connect; one that sends promptcut.v1 gets the echo', async (t) => {
  const { service, port, url } = await startService({ allowAnonymous: true });
  t.after(() => service.close());

  const r0 = await rawHandshake(port);
  r0.sock.destroy();
  assert.equal(r0.status, 101);
  assert.equal(r0.headers['sec-websocket-protocol'], undefined, 'If the client did not ask for a subprotocol, none is returned');

  const r1 = await rawHandshake(port, { protocols: ['promptcut.v1'] });
  r1.sock.destroy();
  assert.equal(r1.status, 101);
  assert.equal(r1.headers['sec-websocket-protocol'], 'promptcut.v1');

  // Anonymous mode ignores the token field: passes even if provided (even arbitrary), echoing only promptcut.v1
  const r2 = await rawHandshake(port, { protocols: tokenProtocols(randomToken()) });
  r2.sock.destroy();
  assert.equal(r2.status, 101);
  assert.equal(r2.headers['sec-websocket-protocol'], 'promptcut.v1');

  const old = wsClient(url);
  const modern = wsClient(url, ['promptcut.v1']);
  t.after(() => { old.close(); modern.close(); });
  await Promise.all([old.opened, modern.opened]);
  assert.equal(old.ws.protocol, '');
  assert.equal(modern.ws.protocol, 'promptcut.v1');
  // Previous three raw handshake connections only closed TCP without sending close frames;
  // the server might not clean them up immediately (see report "Risks"), here only check for at least 2
  await waitFor(() => service.describe().connections >= 2, 2000, 'Two connections registered');
  for (const conn of service.describe().conns) assert.deepEqual(conn.principal, { userId: 'anonymous', tenantId: null });
});

test('A4 the auth module itself: anonymous mode returns anonymous, and protocolFor returns promptcut.v1 only when the client offered it', async () => {
  const { createClusterAuth } = await loadAuth();
  const auth = createClusterAuth({ allowAnonymous: true });
  assert.deepEqual(auth.authenticate(fakeReq(undefined)), { userId: 'anonymous', tenantId: null });
  assert.deepEqual(auth.authenticate(fakeReq('promptcut.v1')), { userId: 'anonymous', tenantId: null });
  assert.equal(auth.protocolFor(fakeReq(undefined)), null);
  assert.equal(auth.protocolFor(fakeReq('promptcut.v1')), 'promptcut.v1');
  assert.equal(auth.protocolFor(fakeReq('other.proto')), null);
});

// ------------------------------------------------------------------ A5

test('A5 after several rejected and several accepted attempts: the raw token cannot be found in any log, describe, or healthz; a rejection logs auth.reject', async (t) => {
  const token = randomToken();
  const wrong = randomToken();
  // Collect together with stdout / stderr: if implementation bypasses injected log to write to stdout, catch it too
  const captured = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return origOut(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return origErr(chunk, ...rest); };
  const restore = () => { process.stdout.write = origOut; process.stderr.write = origErr; };
  t.after(restore);

  const { service, port, url, logs } = await startService({ token });
  t.after(() => service.close());

  for (let i = 0; i < 3; i++) {
    for (const protocols of [undefined, ['promptcut.v1'], tokenProtocols(wrong), tokenProtocols(token)]) {
      const r = await rawHandshake(port, { protocols });
      r.sock.destroy();
    }
  }
  const c = wsClient(url, tokenProtocols(token));
  await c.opened;
  c.send({ type: 'publisher.hello', reqId: 1, publisherId: 'pg' });
  await c.next(byReq(1));
  c.send({ type: 'nonsense.type', reqId: 2, token });
  await c.next(byReq(2));
  const healthText = await (await fetch(`http://127.0.0.1:${port}/healthz`)).text();
  const describeText = JSON.stringify(service.describe());
  c.close();
  await c.closed;
  await new Promise((resolve) => setTimeout(resolve, 50)); // Let close logs settle
  restore();

  const logText = JSON.stringify(logs);
  for (const secret of [token, wrong]) {
    assert.ok(!logText.includes(secret), 'The token appeared in the injected log');
    assert.ok(!captured.join('').includes(secret), 'The token appeared in stdout');
    assert.ok(!describeText.includes(secret), 'The token appeared in describe()');
    assert.ok(!healthText.includes(secret), 'The token appeared in /healthz');
  }
  const rejects = logs.filter((l) => l.event === 'auth.reject');
  const reasons = new Set(rejects.map((l) => l.reason));
  // M6a: reason now uses vocabulary from auth-contract Section 5 (originally bad-token / no-protocol / no-token)
  assert.deepEqual([...reasons].sort(), ['bad-format', 'bad-proof', 'no-credential'], `auth.reject: ${JSON.stringify(rejects)}`);
  assert.ok(rejects.every((l) => 'remote' in l), 'auth.reject carries remote');
  assert.equal(rejects.length, 9, 'Each rejection logs one entry');
});

// ------------------------------------------------------------------ A6

/** Starts main.mjs child process and collects output; returns { child, output(), exited } */
function runMain(env) {
  const base = { ...process.env };
  for (const k of ['PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_DOCSERVICE_HOST', 'PROMPTCUT_DOCSERVICE_PORT', 'PROMPTCUT_DOCSERVICE_URL']) delete base[k];
  const child = spawn(process.execPath, [MAIN], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, output: () => out, exited };
}

/** Waits for child process to exit, at most ms; kills on timeout and returns { timedOut: true } */
async function exitWithin(run, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
  const r = await Promise.race([run.exited, timeout]);
  clearTimeout(timer);
  if (r.timedOut) { run.child.kill(); await run.exited; }
  return r;
}

// M6a: Fail-closed condition changed from "non-loopback with no token set" (token-required)
// to "non-loopback unable to load credential store" (auth-store, auth-contract Section 10).
// "non-loopback" uses 127.0.0.2: main.mjs literally only treats 127.0.0.1 / ::1 / localhost as loopback,
// while 127.0.0.2 is actually still on local loopback adapter, so test does not need to bind
// to 0.0.0.0 (which triggers firewall popups on Windows)
test('A6 main.mjs: non-loopback address with the credential store unavailable → exit code 1, output contains auth-store', { timeout: 20_000 }, async () => {
  const dir = tempDir('pc-a6-');
  const notADir = path.join(dir, 'data-is-a-file');
  fs.writeFileSync(notADir, 'x');
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '127.0.0.2', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_DOCSERVICE_DATA: notADir });
  const r = await exitWithin(run, 8000);
  assert.ok(!r.timedOut, `did not exit (should fail closed); output: ${run.output()}`);
  assert.equal(r.code, 1, run.output());
  assert.match(run.output(), /auth-store/);
  assert.match(run.output(), /config\.error/);
});

test('A6 main.mjs: non-loopback address, no token set, credential store available → starts as usual; a handshake with a token gets 401', { timeout: 20_000 }, async (t) => {
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '127.0.0.2', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_DOCSERVICE_DATA: tempDir('pc-a6-') });
  t.after(async () => { if (run.child.exitCode === null) { run.child.kill(); await run.exited; } });
  const port = await listenPort(run);
  const h = await (await fetch(`http://127.0.0.2:${port}/healthz`)).json();
  assert.equal(h.ok, true);
  const admin = wsClient(`ws://127.0.0.2:${port}`, tokenProtocols(randomToken()));
  await assert.rejects(admin.opened, 'no token set: all admin interfaces return 401');
});

test('A6 main.mjs: malformed token → exit code 1, output contains bad-token-format, and the token is not echoed', { timeout: 20_000 }, async () => {
  const bad = 'short-token!';
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_CLUSTER_TOKEN: bad });
  const r = await exitWithin(run, 8000);
  assert.ok(!r.timedOut, `Did not exit; output: ${run.output()}`);
  assert.equal(r.code, 1, run.output());
  assert.match(run.output(), /bad-token-format/);
  assert.ok(!run.output().includes(bad), 'The raw token appeared in the output');
});

/** Waits for child process to print the listen line, extracts port */
async function listenPort(run, ms = 8000) {
  return waitFor(() => {
    for (const line of run.output().split('\n')) {
      try {
        const j = JSON.parse(line);
        if (j.event === 'listen' && Number.isInteger(j.port)) return j.port;
      } catch { /* Not a JSON line */ }
    }
    return null;
  }, ms, `main.mjs prints the listen line (output so far: ${run.output().slice(0, 400)})`);
}

test('A6 main.mjs: loopback with no token set → starts up, /healthz is fine, anonymous connections allowed', { timeout: 20_000 }, async (t) => {
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0' });
  t.after(async () => { if (run.child.exitCode === null) { run.child.kill(); await run.exited; } });
  const port = await listenPort(run);
  const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.protocol, 'promptcut.v1');
  assert.equal(h.queue, true, 'main.mjs has the queue attached');
  assert.ok(Array.isArray(h.modules));
  const r = await rawHandshake(port);
  r.sock.destroy();
  assert.equal(r.status, 101, 'Anonymous mode');
});

test('A6 main.mjs: a valid token set → wrong token 401, correct token 101 and only the admin interface usable, no token in the output', { timeout: 20_000 }, async (t) => {
  const token = randomToken();
  const run = runMain({ PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_CLUSTER_TOKEN: token, PROMPTCUT_DOCSERVICE_DATA: tempDir('pc-a6-') });
  t.after(async () => { if (run.child.exitCode === null) { run.child.kill(); await run.exited; } });
  const port = await listenPort(run);
  // M6a: Loopback origin without token is local identity (originally asserted only promptcut.v1 → 401);
  // changed to invalid token → 401
  const r0 = await rawHandshake(port, { protocols: tokenProtocols(randomToken()) });
  r0.sock.destroy();
  assert.equal(r0.status, 401);
  const r1 = await rawHandshake(port, { protocols: tokenProtocols(token) });
  r1.sock.destroy();
  assert.equal(r1.status, 101);
  assert.equal(r1.headers['sec-websocket-protocol'], 'promptcut.v1');
  const admin = wsClient(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  t.after(() => admin.close());
  await admin.opened;
  admin.send({ type: 'publisher.hello', reqId: 'p', publisherId: 'pg' });
  assert.equal((await admin.next(byReq('p'))).reason, 'forbidden');
  admin.send({ type: 'service.announce', reqId: 'a', announcerId: 'asset:t', kind: 'asset', urls: ['http://10.0.0.1:1/api/asset'] });
  assert.equal((await admin.next(byReq('a'))).type, 'service.announced');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!run.output().includes(token), 'The raw token appeared in the output');
});
