/**
 * Asset service address registration (contract `docs/plan/asset-store-contract.md` Section 5,
 * test cases N1-N4).
 * Run: node --test server/test/asset-announce.test.mjs
 *
 * Written strictly against the contract, without looking at the implementation. N2 and N3 use mock
 * endpoints in this file (shaped like `createWsEndpoint`: send, onMessage, onOpen, onClose, close,
 * connected); "sending" counts only messages dispatched while the endpoint is connected (real
 * endpoints discard send when disconnected).
 * N4 starts a real document service (M5a's `createDocService` with `endpointsModule`, port 0,
 * cluster token mode); `startAssetAnnounce` uses the default `createWsEndpoint`.
 */
import os from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDocService } from '../docservice/service.mjs';
import { endpointsModule } from '../docservice/modules/endpoints.mjs';
import { createClusterAuth } from '../docservice/auth.mjs';
import { wsClient, byType, waitFor, randomToken } from './fake-ws-kit.mjs';

let mod = null;
let loadError = null;
try { mod = await import('../asset-announce.mjs'); } catch (err) { loadError = err; }
function need() {
  if (loadError) throw new Error(`cannot load server/asset-announce.mjs: ${loadError.message}`);
  return mod;
}

/* ------------------------------------------------------------------ *
 * N1
 * ------------------------------------------------------------------ */

const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` });
const v6 = (address, internal = false) => ({ address, family: 'IPv6', internal, netmask: 'ffff:ffff:ffff:ffff::', mac: '00:00:00:00:00:00', scopeid: 0, cidr: `${address}/64` });

const IFACES = {
  lo: [v4('127.0.0.1', true), v6('::1', true)],
  eth0: [v4('192.168.1.20'), v6('fe80::1'), v6('fd00::5')],
  wlan0: [v4('10.0.0.9'), v4('8.8.8.8'), v4('10.0.0.10')],
  vpn: [
    v4('172.16.0.1'), v4('172.31.255.254'), v4('172.32.0.1'), v4('172.15.255.255'),
    v4('192.168.1.20'), // Duplicate
    v4('169.254.3.4'), // Link-local, not in the three private subnets
    v4('100.64.0.1'), // CGNAT, not in the three private subnets
    v4('11.0.0.1'), v4('192.169.0.1'),
  ],
  hidden: [v4('10.9.9.9', true)], // Exclude internal private addresses as well
};

test('N1 lanAssetUrls takes only non-internal private-range IPv4 addresses, sorted and deduplicated; returns [] when there is no port', () => {
  const { lanAssetUrls } = need();
  const urls = lanAssetUrls({ interfaces: IFACES, port: 5173 });
  // By address lexicographical order: '10.0.0.10' < '10.0.0.9'
  assert.deepEqual(urls, [
    'http://10.0.0.10:5173/api/asset',
    'http://10.0.0.9:5173/api/asset',
    'http://172.16.0.1:5173/api/asset',
    'http://172.31.255.254:5173/api/asset',
    'http://192.168.1.20:5173/api/asset',
  ]);
  assert.deepEqual(lanAssetUrls({ interfaces: IFACES, port: 8080, basePath: '/x/asset' }), urls.map((u) => u.replace(':5173/api/asset', ':8080/x/asset')), 'basePath is configurable');
  assert.deepEqual(lanAssetUrls({ interfaces: IFACES }), [], 'no port');
  assert.deepEqual(lanAssetUrls({ interfaces: IFACES, port: undefined }), [], 'port is undefined');
  assert.deepEqual(lanAssetUrls({ interfaces: {}, port: 5173 }), []);
  assert.deepEqual(lanAssetUrls({ interfaces: { lo: IFACES.lo, eth0: [v6('fe80::1')] }, port: 5173 }), [], 'only loopback and IPv6');
  assert.deepEqual(lanAssetUrls({ interfaces: { a: undefined, b: [v4('192.168.0.2')] }, port: 1 }), ['http://192.168.0.2:1/api/asset'], 'undefined entries in the network interface table are skipped');

  // Defaults to getting the local network interface list: results are all valid LAN addresses
  const real = lanAssetUrls({ port: 5173 });
  assert.ok(Array.isArray(real));
  for (const u of real) assert.match(u, /^http:\/\/(10\.\d+|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+:5173\/api\/asset$/);
  assert.deepEqual(real, [...new Set(real)].sort());
});

/* ------------------------------------------------------------------ *
 * Fake endpoint
 * ------------------------------------------------------------------ */

function fakeFactory() {
  const made = [];
  const events = [];
  const createEndpoint = (options) => {
    const handlers = { message: [], open: [], close: [] };
    const ep = {
      options,
      connected: false,
      closed: false,
      delivered: [],
      dropped: [],
      send(msg) {
        if (!ep.connected) { ep.dropped.push(msg); return false; }
        ep.delivered.push(JSON.parse(JSON.stringify(msg)));
        events.push(`send:${msg.type}`);
        return true;
      },
      onMessage(fn) { handlers.message.push(fn); },
      onOpen(fn) { handlers.open.push(fn); },
      onClose(fn) { handlers.close.push(fn); },
      close() { events.push('close'); ep.closed = true; ep.connected = false; },
      stats: () => ({ opens: 0, closes: 0, sent: ep.delivered.length, received: 0, dropped: ep.dropped.length, badFrames: 0 }),
      // Test manipulation
      fireOpen() { ep.connected = true; for (const fn of handlers.open) fn(); },
      fireClose(info = { code: 1006, reason: '' }) { ep.connected = false; for (const fn of handlers.close) fn(info); },
      fireMessage(m) { for (const fn of handlers.message) fn(m); },
    };
    made.push(ep);
    return ep;
  };
  return { createEndpoint, made, events };
}
const announces = (ep) => ep.delivered.filter((m) => m.type === 'service.announce');
const withdraws = (ep) => ep.delivered.filter((m) => m.type === 'service.withdraw');
const URLS = ['http://192.168.1.20:5173/api/asset'];
const pickAnnounce = (m) => ({ type: m.type, announcerId: m.announcerId, kind: m.kind, urls: m.urls });

/* ------------------------------------------------------------------ *
 * N2
 * ------------------------------------------------------------------ */

test('N2 startAssetAnnounce with a fake endpoint: sends service.announce once per onOpen with correct fields; on receiving error it only logs and does not retry', async () => {
  const { startAssetAnnounce } = need();
  const f = fakeFactory();
  const logs = [];
  const token = randomToken();
  const handle = startAssetAnnounce({ url: 'ws://10.0.0.1:8787', token, announcerId: 'asset:pc-1', urls: URLS, createEndpoint: f.createEndpoint, log: (...a) => logs.push(a) });
  assert.equal(typeof handle?.stop, 'function');
  assert.equal(f.made.length, 1, 'creates one endpoint');
  const ep = f.made[0];
  assert.equal(ep.options?.url, 'ws://10.0.0.1:8787');
  assert.equal(ep.options?.token, token, 'the cluster token is handed to the endpoint');
  assert.deepEqual(announces(ep), [], 'nothing counts as sent before it connects');

  ep.fireOpen();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(announces(ep).map(pickAnnounce), [{ type: 'service.announce', announcerId: 'asset:pc-1', kind: 'asset', urls: URLS }]);

  // Disconnect, reconnect: register once more
  ep.fireClose();
  ep.fireOpen();
  await new Promise((r) => setImmediate(r));
  assert.equal(announces(ep).length, 2, 'once per onOpen');
  assert.deepEqual(pickAnnounce(announces(ep)[1]), pickAnnounce(announces(ep)[0]));

  // Received error: log, do not retry
  const before = ep.delivered.length;
  const logsBefore = logs.length;
  ep.fireMessage({ type: 'error', reason: 'bad-message', detail: 'x' });
  ep.fireMessage({ type: 'error', reason: 'limit' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ep.delivered.length, before, 'no resend on receiving error');
  assert.ok(logs.length > logsBefore, 'logs on receiving error');
  // Other messages (receipts, pushes) do not trigger resends
  ep.fireMessage({ type: 'service.announced', announcerId: 'asset:pc-1', kind: 'asset', urls: URLS });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ep.delivered.length, before);
  handle.stop();
});

test('N2 announcerId defaults to asset:<hostname> (contract section 8, item 1); does nothing when url is empty', async () => {
  const { startAssetAnnounce } = need();
  const f = fakeFactory();
  const h = startAssetAnnounce({ url: 'wss://docs.example.lan/', token: randomToken(), urls: URLS, createEndpoint: f.createEndpoint, log: () => {} });
  f.made[0].fireOpen();
  await new Promise((r) => setImmediate(r));
  assert.equal(announces(f.made[0])[0]?.announcerId, `asset:${os.hostname()}`);
  h.stop();

  for (const url of ['', undefined, null]) {
    const g = fakeFactory();
    const e = startAssetAnnounce({ url, token: randomToken(), urls: URLS, createEndpoint: g.createEndpoint, log: () => {} });
    assert.equal(g.made.length, 0, `url=${JSON.stringify(url)}: no endpoint created`);
    assert.equal(typeof e?.stop, 'function');
    e.stop();
    assert.deepEqual(g.events, []);
  }
});

/* ------------------------------------------------------------------ *
 * N3
 * ------------------------------------------------------------------ */

test('N3 empty urls are not registered (logs one line); stop() sends service.withdraw first, then closes', async () => {
  const { startAssetAnnounce } = need();

  // urls is empty
  const f = fakeFactory();
  const logs = [];
  const h = startAssetAnnounce({ url: 'ws://10.0.0.1:8787', token: randomToken(), urls: [], createEndpoint: f.createEndpoint, log: (...a) => logs.push(a) });
  for (const ep of f.made) ep.fireOpen();
  await new Promise((r) => setImmediate(r));
  for (const ep of f.made) assert.deepEqual(announces(ep), [], 'empty urls are not registered');
  assert.ok(logs.length >= 1, 'logs one line of explanation');
  h.stop();

  // stop(): when connected, withdraw first, then close
  const g = fakeFactory();
  const s = startAssetAnnounce({ url: 'ws://10.0.0.1:8787', token: randomToken(), announcerId: 'asset:n3', urls: URLS, createEndpoint: g.createEndpoint, log: () => {} });
  const ep = g.made[0];
  ep.fireOpen();
  await new Promise((r) => setImmediate(r));
  s.stop();
  assert.deepEqual(g.events, ['send:service.announce', 'send:service.withdraw', 'close'], 'withdraw first, then close');
  const w = withdraws(ep)[0];
  assert.deepEqual({ type: w.type, announcerId: w.announcerId, kind: w.kind }, { type: 'service.withdraw', announcerId: 'asset:n3', kind: 'asset' });
  assert.equal(ep.closed, true);

  // stop() while disconnected: do not send withdraw, close as usual
  const k = fakeFactory();
  const t = startAssetAnnounce({ url: 'ws://10.0.0.1:8787', token: randomToken(), urls: URLS, createEndpoint: k.createEndpoint, log: () => {} });
  const e2 = k.made[0];
  e2.fireOpen();
  e2.fireClose();
  t.stop();
  assert.deepEqual(withdraws(e2), [], 'withdraw cannot be sent while disconnected');
  assert.equal(e2.closed, true);
});

/* ------------------------------------------------------------------ *
 * N4
 * ------------------------------------------------------------------ */

test('N4 against the real document service (port 0, with the service address registration module mounted): after registration, another connection doing service.watch { kinds: [asset] } receives this address', async (t) => {
  const { startAssetAnnounce } = need();
  const token = randomToken();
  const auth = createClusterAuth({ token });
  const service = createDocService({ log: () => {}, autoTick: false, authenticate: (req) => auth.authenticate(req), modules: [endpointsModule()] });
  const { port } = await service.listen(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${port}`;
  const watcher = wsClient(url, ['promptcut.v1', `promptcut.token.${token}`]);
  let handle = null;
  t.after(async () => { handle?.stop(); watcher.close(); await service.close(); });
  await watcher.opened;
  watcher.send({ type: 'service.watch', kinds: ['asset'] });
  assert.deepEqual((await watcher.next(byType('service.endpoints'))).endpoints, []);

  const urls = ['http://10.0.0.9:5173/api/asset', 'http://192.168.1.20:5173/api/asset'];
  const logs = [];
  // announcerId omitted: uses default value, same as when wiring mediaPlugin (contract section 5)
  handle = startAssetAnnounce({ url, token, urls, log: (...a) => logs.push(a) });
  let push;
  try {
    push = await watcher.next(byType('service.endpoints'), 5000);
  } catch {
    assert.fail(`The subscriber did not receive the registration. Registrant log: ${JSON.stringify(logs).slice(0, 600)}`
      + `(default announcerId should be asset:${os.hostname()}; the service address registration module's announcerId accepts only [A-Za-z0-9._:-]{1,128})`);
  }
  assert.equal(push.endpoints.length, 1);
  const id = push.endpoints[0].announcerId;
  assert.equal(id, `asset:${os.hostname()}`, 'default announcerId (contract section 8, item 1)');
  assert.deepEqual({ kind: push.endpoints[0].kind, urls: push.endpoints[0].urls }, { kind: 'asset', urls });

  // New subscribers can see it in the watch response
  const late = wsClient(url, ['promptcut.v1', `promptcut.token.${token}`]);
  t.after(() => late.close());
  await late.opened;
  late.send({ type: 'service.watch', kinds: ['asset'] });
  const seen = (await late.next(byType('service.endpoints'))).endpoints;
  assert.deepEqual(seen.map((e) => [e.announcerId, e.urls]), [[id, urls]]);

  // stop(): withdraw, subscribers receive an empty list
  handle.stop();
  handle = null;
  const gone = await watcher.next(byType('service.endpoints'), 5000);
  assert.deepEqual(gone.endpoints, []);
  await waitFor(() => service.describe().connections === 2, 3000, 'the registrant\'s connection closes');
  for (const line of logs) assert.ok(!JSON.stringify(line).includes(token), 'the logs contain no raw token');
});
