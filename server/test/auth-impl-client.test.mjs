/**
 * 客户端一侧与组装层的小件（实现方自测；契约 `docs/plan/auth-contract.md` 第 6、8、11 节）：
 * ws-transport 的 `protocols()`、经文档服务取素材票据、`PROMPTCUT_SHARED_CONFIG`、按空间起实例的外壳、
 * principal 规整、本机设备信息、预渲染进程素材回退带票据。
 * 跑：node --test server/test/auth-impl-client.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWsEndpoint } from '../render-node/ws-transport.mjs';
import { createTicketSource } from '../auth/ticket-source.mjs';
import { loadSharedConfig, normalizeEntry, sharedProtocols } from '../auth/shared-config.mjs';
import { localDeviceInfo } from '../auth/device.mjs';
import { spacedModule, spaceChannel, spaceOf } from '../docservice/spaces.mjs';
import { normalizePrincipal } from '../docservice/service.mjs';
import { actorOf } from '../docservice/modules/actor.mjs';
import { mayRegisterNode } from '../docservice/modules/render-queue.mjs';
import { startSharedService, createProject, deviceId as newDeviceId, tempDir, assetTicketKit } from './fake-shared-env.mjs';
import { waitFor, sleep } from './fake-ws-kit.mjs';
import { createAssetHarness, ROOT } from './fake-asset-service.mjs';

const harness = createAssetHarness();
after(() => harness.cleanup());

test('ws-transport: protocols() is called once before each (re)connect; may be async; a throw is retried with backoff as if the connection failed; cannot be given together with token', async (t) => {
  const s = await startSharedService({ mode: 'hosted' });
  t.after(() => s.close());
  const p = await createProject(s.base, { password: 'pw' });
  const dev = newDeviceId('wt');
  const { buildAuthProtocols } = await import('../auth/client.mjs');
  let calls = 0;
  let fail = 1;
  const ep = createWsEndpoint({
    url: s.url,
    backoff: { baseMs: 5, maxMs: 20, jitter: 0 },
    protocols: async () => {
      calls += 1;
      if (fail-- > 0) throw new Error('failed to get the challenge');
      return buildAuthProtocols({ base: s.base, projectId: p.projectId, username: 'bob', deviceId: dev, deviceName: 'B', password: 'pw', role: 'render' });
    },
  });
  t.after(() => ep.close());
  let opens = 0;
  ep.onOpen(() => { opens += 1; });
  await waitFor(() => opens === 1, 5000, 'first connection opened');
  assert.equal(calls, 2, 'the first protocol fetch fails, then it is fetched again after backoff');
  // 服务端踢掉：重连时再取一次新的（nonce 只能用一次）
  for (const c of s.service.describe().conns) s.service.closeConn(c.connId, 4000, 'test');
  await waitFor(() => opens === 2, 5000, 'reconnect');
  assert.equal(calls, 3);
  assert.throws(() => createWsEndpoint({ url: s.url, protocols: 'x' }), TypeError);
  assert.throws(() => createWsEndpoint({ url: s.url, protocols: () => [], token: crypto.randomBytes(32).toString('base64url') }), TypeError);
});

test('ticket-source: cached until 1/3 remains, then renewed; refresh always renews; unreachable / rejected returns null; concurrent calls send only once', async () => {
  const sent = [];
  let handler = null;
  let connected = true;
  let reply = (m) => ({ type: 'auth.ticket.ok', reqId: m.reqId, ticket: `T${sent.length}`, exp: now + 15 * 60_000 });
  let now = 1_000_000;
  const ep = {
    send(m) {
      if (!connected) return false;
      sent.push(m);
      setImmediate(() => handler(reply(m)));
      return true;
    },
    onMessage(h) { handler = h; },
  };
  const ticket = createTicketSource(ep, { now: () => now, timeoutMs: 200 });
  const [a, b] = await Promise.all([ticket(), ticket()]);
  assert.equal(a, 'T1');
  assert.equal(b, 'T1');
  assert.equal(sent.length, 1, 'concurrent calls send only once');
  assert.deepEqual({ ...sent[0], reqId: undefined }, { type: 'auth.ticket', reqId: undefined, kind: 'asset', access: 'rw' });
  now += 9 * 60_000;
  assert.equal(await ticket(), 'T1', '6 minutes left (> 1/3): not renewed');
  now += 2 * 60_000;
  assert.equal(await ticket(), 'T2', '4 minutes left (< 1/3): renewed');
  assert.equal(await ticket({ refresh: true }), 'T3');
  reply = (m) => ({ type: 'error', reqId: m.reqId, reason: 'forbidden' });
  assert.equal(await ticket({ refresh: true }), null);
  connected = false;
  assert.equal(await ticket({ refresh: true }), null);
  connected = true;
  reply = () => ({ type: 'noise' });
  assert.equal(await ticket({ refresh: true }), null, 'timeout');
});

test('shared-config: reads the file (object or array), default device and role, validation errors do not include the passphrase; sharedProtocols looks up by name once, with a new nonce each time', async (t) => {
  const dir = tempDir('pc-cfg-');
  const file = path.join(dir, 'shared.json');
  assert.equal(loadSharedConfig({}), null, 'null when not set');
  fs.writeFileSync(file, JSON.stringify({ url: 'ws://h:1', projectId: `sp_${'a'.repeat(26)}`, username: 'bob', password: 'secret-pw' }));
  const env = { PROMPTCUT_SHARED_CONFIG: file, PROMPTCUT_DEVICE_ID: 'pc-fixed-device-0001', PROMPTCUT_DEVICE_NAME: 'Fixed' };
  const [e] = loadSharedConfig(env);
  assert.equal(e.deviceId, 'pc-fixed-device-0001');
  assert.equal(e.deviceName, 'Fixed');
  assert.equal(e.as, 'member');
  assert.equal(e.role, 'render');
  fs.writeFileSync(file, JSON.stringify([{ url: 'ws://h:1', name: 'demo', username: 'bob', key: crypto.randomBytes(32).toString('base64url') }, { url: 'ws://g:2', name: 'x', username: 'c', password: 'p' }]));
  assert.equal(loadSharedConfig(env).length, 2);
  for (const bad of [{ url: 'http://h', name: 'x', username: 'b', password: 'p' }, { url: 'ws://h', username: 'b', password: 'p' }, { url: 'ws://h', name: 'x', username: 'b' },
    { url: 'ws://h', name: 'x', username: 'b', password: 'p', role: 'boss' }, { url: 'ws://h', name: 'x', username: 'b', key: 'short' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...bad, password: bad.password ?? undefined }));
    assert.throws(() => loadSharedConfig(env), (err) => err.code === 'bad-shared-config' && !String(err.message).includes('secret-pw'), JSON.stringify(bad));
  }
  fs.writeFileSync(file, '{broken');
  assert.throws(() => loadSharedConfig(env), (err) => err.code === 'bad-shared-config');

  // 按名字查项目、只派生一次 K
  const s = await startSharedService({ mode: 'hosted' });
  t.after(() => s.close());
  const p = await createProject(s.base, { name: 'By Name', password: 'pw' });
  const entry = normalizeEntry({ url: s.url, name: 'by name', username: 'bob', password: 'pw', deviceId: newDeviceId('sc'), deviceName: 'B' });
  let fetches = 0;
  const countingFetch = (url, init) => { fetches += 1; return fetch(url, init); };
  const protocols = sharedProtocols(entry, { fetch: countingFetch, role: 'page' });
  const first = await protocols();
  const second = await protocols();
  assert.equal(first[0], 'promptcut.v1');
  const payload = (list) => JSON.parse(Buffer.from(list[1].slice('promptcut.auth.'.length), 'base64url').toString('utf8'));
  assert.equal(payload(first).p, p.projectId, 'projectId found by name');
  assert.equal(payload(first).r, 'page', 'role overrides the config');
  assert.notEqual(payload(first).nonce, payload(second).nonce, 'new nonce each time');
  assert.equal(fetches, 3, 'lookup once + challenge twice');
  // 用第二组协议真的能进
  const ws = new WebSocket(s.url, second);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.close();
});

test('spaces: channel names get a space prefix, local is unchanged (names starting with @ additionally get @local/); admin identity does not enter a space; dropSpace drops the instance and calls dispose', () => {
  assert.equal(spaceChannel('local', 'project:abc'), 'project:abc');
  assert.equal(spaceChannel('local', 'project:@x'), 'project:@local/@x');
  assert.equal(spaceChannel('sp_x', 'project:abc'), 'project:@sp_x/abc');
  assert.equal(spaceOf({ scope: 'admin' }), null);
  assert.equal(spaceOf({ userId: 'a', tenantId: null }), 'local');
  assert.equal(spaceOf({ tenantId: 'sp_x' }), 'sp_x');

  const made = [];
  const log = [];
  const mod = spacedModule({
    create: (space) => {
      made.push(space);
      return {
        name: 'demo', types: ['demo.'], channels: ['demo'],
        connect(ctx, id) { log.push(['connect', space, id]); ctx.subscribe(id, 'demo:c'); },
        disconnect(ctx, id) { log.push(['disconnect', space, id]); },
        handle(ctx, id, msg) { ctx.publish('demo:c', { from: space, n: msg.n }); },
        dispose() { log.push(['dispose', space]); },
        describeConn: () => ({ demoField: space }),
      };
    },
  });
  const subs = [];
  const sent = [];
  const ctx = {
    send: (id, m) => sent.push([id, m]), now: () => 0, log() {},
    subscribe: (id, ch) => subs.push([id, ch]), unsubscribe() {}, publish: (ch, m) => sent.push([ch, m]),
  };
  assert.deepEqual(made, ['local'], 'local is created at construction');
  mod.connect(ctx, 'c1', { userId: 'u', tenantId: 'sp_a', scope: 'member' });
  mod.connect(ctx, 'c2', { userId: 'u', tenantId: 'local', scope: 'local' });
  mod.connect(ctx, 'c3', { userId: 'admin', tenantId: null, scope: 'admin' });
  assert.deepEqual(subs, [['c1', 'demo:@sp_a/c'], ['c2', 'demo:c']]);
  mod.handle(ctx, 'c1', { type: 'demo.x', n: 1 });
  mod.handle(ctx, 'c3', { type: 'demo.x', reqId: 'r' });
  assert.deepEqual(sent, [['demo:@sp_a/c', { from: 'sp_a', n: 1 }], ['c3', { type: 'error', reason: 'forbidden', detail: 'This connection is not in any space', reqId: 'r' }]]);
  assert.deepEqual(mod.describeConn('c1'), { demoField: 'sp_a' });
  assert.deepEqual(mod.describeConn('nope'), { demoField: 'local' }, 'an unknown connection uses the fields of local');
  assert.deepEqual(mod.spaces().sort(), ['local', 'sp_a']);
  assert.equal(mod.dropSpace('local'), false, 'local cannot be dropped');
  assert.equal(mod.dropSpace('sp_a'), true);
  assert.deepEqual(log.slice(-2), [['disconnect', 'sp_a', 'c1'], ['dispose', 'sp_a']]);
  assert.deepEqual(mod.spaces(), ['local']);
  mod.disconnect(ctx, 'c1');
  assert.equal(log.filter((l) => l[0] === 'disconnect' && l[2] === 'c1').length, 1, 'connections in a dropped space are not disconnected again');
});

test('principal normalization, write identity, whether it can check in as a node', () => {
  assert.deepEqual(normalizePrincipal({ userId: 'a', tenantId: 't', extra: 1 }), { userId: 'a', tenantId: 't' });
  assert.deepEqual(normalizePrincipal({ userId: 'a' }), { userId: 'a', tenantId: null });
  const full = { userId: 'u@d', tenantId: 'sp', scope: 'member', username: 'u', deviceId: 'd', deviceName: 'D', creator: false, role: 'render', conversation: null, owner: { kind: 'user' } };
  assert.deepEqual(normalizePrincipal(full), full);
  assert.deepEqual(actorOf({ userId: 'alice', tenantId: 't' }, null), { userId: 'alice', session: null }, 'actor of a legacy identity is the same as in M5');
  assert.deepEqual(actorOf({ ...full, role: 'agent', conversation: 3 }, 's'), { userId: 'u@d', deviceId: 'd', role: 'agent', conversation: 3, session: 's' });
  assert.deepEqual(actorOf({ userId: 'local', tenantId: 'local', scope: 'local', role: 'page' }, null), { userId: 'local', deviceId: null, role: 'page', conversation: null, session: null });
  assert.equal(mayRegisterNode({ userId: 'anonymous', tenantId: null }), true);
  assert.equal(mayRegisterNode({ scope: 'local', role: 'page' }), true);
  assert.equal(mayRegisterNode({ scope: 'member', role: 'render' }), true);
  assert.equal(mayRegisterNode({ scope: 'member', role: 'page' }), false);
  assert.equal(mayRegisterNode({ scope: 'member', role: 'agent' }), false);
  assert.equal(mayRegisterNode({ scope: 'admin' }), false);
});

test('local device info: stable and valid; environment variables can override it', () => {
  const a = localDeviceInfo({});
  const b = localDeviceInfo({});
  assert.deepEqual(a, b);
  assert.match(a.deviceId, /^pc-[A-Za-z0-9_-]{22}$/);
  assert.ok(a.deviceName.length > 0 && a.deviceName.length <= 64);
  assert.deepEqual(localDeviceInfo({ PROMPTCUT_DEVICE_ID: 'my-device-000000001', PROMPTCUT_DEVICE_NAME: 'Mine' }), { deviceId: 'my-device-000000001', deviceName: 'Mine' });
  assert.equal(localDeviceInfo({ PROMPTCUT_DEVICE_ID: 'bad id' }).deviceId, a.deviceId, 'an invalid override is ignored');
});

test('prerender process asset fallback: the asset service on another machine requires a ticket; once setMediaFallbackTicket provides one, Bearer is sent', async (t) => {
  const client = await import(harness.compileTs(path.join(ROOT, 'server', 'asset-client.ts')));
  const kit = await assetTicketKit();
  const remote = await harness.serve({ chunkSize: 1024, isTrusted: () => false, tickets: kit.tickets });
  const buf = crypto.randomBytes(3000);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const rw = kit.issue('rw');
  for (let n = 0; n < 3; n++) {
    const r = await fetch(`${remote.base}/media/${hash}/${n}`, { method: 'PUT', body: buf.subarray(n * 1024, (n + 1) * 1024), headers: { 'X-Media-Size': String(buf.length), Authorization: `Bearer ${rw}` } });
    assert.equal(r.status, 200);
  }
  assert.equal((await fetch(`${remote.base}/media/${hash}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${rw}` } })).status, 200);
  // 主源：什么都没有，一律 404
  const primary = http.createServer((req, res) => { res.statusCode = 404; res.end('nope'); });
  await new Promise((resolve) => primary.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => primary.close(() => resolve())));
  let fn;
  client.assetProxyPlugin(`http://127.0.0.1:${primary.address().port}`).configureServer({ middlewares: { use(f) { fn = f; } } });
  const proxy = http.createServer((req, res) => fn(req, res, () => { res.statusCode = 418; res.end(); }));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { proxy.closeAllConnections?.(); proxy.close(() => resolve()); }));
  const via = `http://127.0.0.1:${proxy.address().port}/@media/${hash}`;
  client.setMediaFallbackBases([remote.base]);
  t.after(() => { client.setMediaFallbackBases([]); client.setMediaFallbackTicket(null); });
  client.setMediaFallbackTicket(null);
  assert.equal((await fetch(via)).status, 401, 'no ticket: the other machine returns 401');
  client.setMediaFallbackTicket(async () => kit.issue('r'));
  const got = await fetch(via, { headers: { Range: 'bytes=0-9' } });
  assert.equal(got.status, 206);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), buf.subarray(0, 10));
  await sleep(10);
});
