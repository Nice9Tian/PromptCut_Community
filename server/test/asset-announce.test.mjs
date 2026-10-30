/**
 * 素材服务地址登记（契约 `docs/plan/asset-store-contract.md` 第 5 节，用例 N1～N4）。
 * 跑：node --test server/test/asset-announce.test.mjs
 *
 * 只照契约写，不看实现。N2、N3 用本文件里的假端点（形状照 `createWsEndpoint`：send、onMessage、onOpen、
 * onClose、close、connected）；「发」只算端点连着时送出去的消息（断线时 send 会被真端点丢弃）。
 * N4 起真文档服务（M5a 的 `createDocService` 挂 `endpointsModule`，端口 0，集群令牌模式），
 * `startAssetAnnounce` 用缺省的 `createWsEndpoint`。
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
  if (loadError) throw new Error(`载不进 server/asset-announce.mjs：${loadError.message}`);
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
    v4('192.168.1.20'), // 重复
    v4('169.254.3.4'), // 链路本地，不在三个私有网段里
    v4('100.64.0.1'), // CGNAT，不在三个私有网段里
    v4('11.0.0.1'), v4('192.169.0.1'),
  ],
  hidden: [v4('10.9.9.9', true)], // internal 的私有地址也不要
};

test('N1 lanAssetUrls 只取非 internal 的私有网段 IPv4，排序去重；没有 port 返回 []', () => {
  const { lanAssetUrls } = need();
  const urls = lanAssetUrls({ interfaces: IFACES, port: 5173 });
  // 按地址字典序：'10.0.0.10' < '10.0.0.9'
  assert.deepEqual(urls, [
    'http://10.0.0.10:5173/api/asset',
    'http://10.0.0.9:5173/api/asset',
    'http://172.16.0.1:5173/api/asset',
    'http://172.31.255.254:5173/api/asset',
    'http://192.168.1.20:5173/api/asset',
  ]);
  assert.deepEqual(lanAssetUrls({ interfaces: IFACES, port: 8080, basePath: '/x/asset' }), urls.map((u) => u.replace(':5173/api/asset', ':8080/x/asset')), 'basePath 可改');
  assert.deepEqual(lanAssetUrls({ interfaces: IFACES }), [], '没有 port');
  assert.deepEqual(lanAssetUrls({ interfaces: IFACES, port: undefined }), [], 'port 为 undefined');
  assert.deepEqual(lanAssetUrls({ interfaces: {}, port: 5173 }), []);
  assert.deepEqual(lanAssetUrls({ interfaces: { lo: IFACES.lo, eth0: [v6('fe80::1')] }, port: 5173 }), [], '只有回环和 IPv6');
  assert.deepEqual(lanAssetUrls({ interfaces: { a: undefined, b: [v4('192.168.0.2')] }, port: 1 }), ['http://192.168.0.2:1/api/asset'], '网卡表里的 undefined 项跳过');

  // 缺省取本机网卡表：结果都是合法的局域网地址
  const real = lanAssetUrls({ port: 5173 });
  assert.ok(Array.isArray(real));
  for (const u of real) assert.match(u, /^http:\/\/(10\.\d+|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+:5173\/api\/asset$/);
  assert.deepEqual(real, [...new Set(real)].sort());
});

/* ------------------------------------------------------------------ *
 * 假端点
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
      // 测试操纵
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

test('N2 startAssetAnnounce 用假端点：每次 onOpen 发一次 service.announce，字段正确；收到 error 只打日志不重试', async () => {
  const { startAssetAnnounce } = need();
  const f = fakeFactory();
  const logs = [];
  const token = randomToken();
  const handle = startAssetAnnounce({ url: 'ws://10.0.0.1:8787', token, announcerId: 'asset:pc-1', urls: URLS, createEndpoint: f.createEndpoint, log: (...a) => logs.push(a) });
  assert.equal(typeof handle?.stop, 'function');
  assert.equal(f.made.length, 1, '建一个端点');
  const ep = f.made[0];
  assert.equal(ep.options?.url, 'ws://10.0.0.1:8787');
  assert.equal(ep.options?.token, token, '集群令牌交给端点');
  assert.deepEqual(announces(ep), [], '连上之前不算发');

  ep.fireOpen();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(announces(ep).map(pickAnnounce), [{ type: 'service.announce', announcerId: 'asset:pc-1', kind: 'asset', urls: URLS }]);

  // 断线、重连：再登记一次
  ep.fireClose();
  ep.fireOpen();
  await new Promise((r) => setImmediate(r));
  assert.equal(announces(ep).length, 2, '每次 onOpen 一次');
  assert.deepEqual(pickAnnounce(announces(ep)[1]), pickAnnounce(announces(ep)[0]));

  // 收到 error：打日志，不重试
  const before = ep.delivered.length;
  const logsBefore = logs.length;
  ep.fireMessage({ type: 'error', reason: 'bad-message', detail: 'x' });
  ep.fireMessage({ type: 'error', reason: 'limit' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ep.delivered.length, before, '收到 error 不重发');
  assert.ok(logs.length > logsBefore, '收到 error 打日志');
  // 别的消息（回执、推送）不引起重发
  ep.fireMessage({ type: 'service.announced', announcerId: 'asset:pc-1', kind: 'asset', urls: URLS });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ep.delivered.length, before);
  handle.stop();
});

test('N2 announcerId 缺省是 asset:<hostname>（契约第 8 节第 1 条）；url 为空时什么都不做', async () => {
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
    assert.equal(g.made.length, 0, `url=${JSON.stringify(url)}：不建端点`);
    assert.equal(typeof e?.stop, 'function');
    e.stop();
    assert.deepEqual(g.events, []);
  }
});

/* ------------------------------------------------------------------ *
 * N3
 * ------------------------------------------------------------------ */

test('N3 urls 为空不登记（打一行 log）；stop() 先发 service.withdraw 再关', async () => {
  const { startAssetAnnounce } = need();

  // urls 为空
  const f = fakeFactory();
  const logs = [];
  const h = startAssetAnnounce({ url: 'ws://10.0.0.1:8787', token: randomToken(), urls: [], createEndpoint: f.createEndpoint, log: (...a) => logs.push(a) });
  for (const ep of f.made) ep.fireOpen();
  await new Promise((r) => setImmediate(r));
  for (const ep of f.made) assert.deepEqual(announces(ep), [], 'urls 为空不登记');
  assert.ok(logs.length >= 1, '打一行 log 说明');
  h.stop();

  // stop()：连着时先 withdraw 再 close
  const g = fakeFactory();
  const s = startAssetAnnounce({ url: 'ws://10.0.0.1:8787', token: randomToken(), announcerId: 'asset:n3', urls: URLS, createEndpoint: g.createEndpoint, log: () => {} });
  const ep = g.made[0];
  ep.fireOpen();
  await new Promise((r) => setImmediate(r));
  s.stop();
  assert.deepEqual(g.events, ['send:service.announce', 'send:service.withdraw', 'close'], '先 withdraw 后 close');
  const w = withdraws(ep)[0];
  assert.deepEqual({ type: w.type, announcerId: w.announcerId, kind: w.kind }, { type: 'service.withdraw', announcerId: 'asset:n3', kind: 'asset' });
  assert.equal(ep.closed, true);

  // 断着时 stop()：不发 withdraw，照样关
  const k = fakeFactory();
  const t = startAssetAnnounce({ url: 'ws://10.0.0.1:8787', token: randomToken(), urls: URLS, createEndpoint: k.createEndpoint, log: () => {} });
  const e2 = k.made[0];
  e2.fireOpen();
  e2.fireClose();
  t.stop();
  assert.deepEqual(withdraws(e2), [], '断着时 withdraw 发不出去');
  assert.equal(e2.closed, true);
});

/* ------------------------------------------------------------------ *
 * N4
 * ------------------------------------------------------------------ */

test('N4 对真文档服务（端口 0，挂服务地址登记模块）：登记后另一条连接 service.watch { kinds: [asset] } 收到这份地址', async (t) => {
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
  // announcerId 不传：走缺省值，和 mediaPlugin 接线时一样（契约第 5 节）
  handle = startAssetAnnounce({ url, token, urls, log: (...a) => logs.push(a) });
  let push;
  try {
    push = await watcher.next(byType('service.endpoints'), 5000);
  } catch {
    assert.fail(`订阅方没收到登记。登记方日志：${JSON.stringify(logs).slice(0, 600)}`
      + `（缺省 announcerId 应为 asset:${os.hostname()}；服务地址登记模块的 announcerId 只认 [A-Za-z0-9._:-]{1,128}）`);
  }
  assert.equal(push.endpoints.length, 1);
  const id = push.endpoints[0].announcerId;
  assert.equal(id, `asset:${os.hostname()}`, '缺省 announcerId（契约第 8 节第 1 条）');
  assert.deepEqual({ kind: push.endpoints[0].kind, urls: push.endpoints[0].urls }, { kind: 'asset', urls });

  // 新来的订阅者在 watch 的回包里就能看到
  const late = wsClient(url, ['promptcut.v1', `promptcut.token.${token}`]);
  t.after(() => late.close());
  await late.opened;
  late.send({ type: 'service.watch', kinds: ['asset'] });
  const seen = (await late.next(byType('service.endpoints'))).endpoints;
  assert.deepEqual(seen.map((e) => [e.announcerId, e.urls]), [[id, urls]]);

  // stop()：撤回，订阅者收到空表
  handle.stop();
  handle = null;
  const gone = await watcher.next(byType('service.endpoints'), 5000);
  assert.deepEqual(gone.endpoints, []);
  await waitFor(() => service.describe().connections === 2, 3000, '登记方的连接关掉');
  for (const line of logs) assert.ok(!JSON.stringify(line).includes(token), '日志里没有令牌原文');
});
