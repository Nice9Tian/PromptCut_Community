/**
 * SP 阶段 sp-routing 的实现方自测（契约 `docs/plan/shared-project-contract.md` 第 3、4、5 节；验收 SP2、SP4、SP5、SP6）。
 * 用例名带编号 SPR-*：
 *   SPR-2*  令牌的边界（三种角色与独立主机凭项目凭证进入、凭证错被拒、托管端管理接口无令牌 401、
 *           局域网主机的管理接口非回环连不上、回环无令牌成功；局域网主机缺凭证存储拒绝启动）
 *   SPR-4*  局域网发现（纯函数：选网卡、广播地址、收包网卡、目标、包；两个 dgram 套接字在本机回环上模拟：
 *           查询与应答、周期通告与 45 s 过期、去重、网卡变化；编辑器里广播的起停）
 *   SPR-5*  打开时的路由（四种组合、手填、连不上不抛、发现 + 进入不连托管端）
 *   SPR-6*  缺省托管地址（守门：源码里只在 hosted-default.mjs 出现；三种覆盖顺序）
 *
 * UDP 只绑 127.0.0.1（不开防火墙口子），网卡列表注入成回环一块。跑：node --test server/test/sp-routing.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startSharedService, createProject, join, deviceId as newDeviceId, tempDir } from './fake-shared-env.mjs';
import { byReq, rawHandshake, randomToken, refusingPort, waitFor } from './fake-ws-kit.mjs';
import {
  LAN_DISCOVERY, selectInterfaces, broadcastOf, interfaceFor, interfaceSignature, queryTargets, encodePacket, parsePacket,
  buildQuery, buildAnnounce, nextAnnounceDelay, createLanHost, createLanClient, discoverLan, ipv4ToInt,
} from '../lan/discovery.mjs';
import { findSharedProject, pickRoute, createSharedProject, wsBaseOf, manualBaseOf, candidateBaseOf } from '../auth/route.mjs';
import { DEFAULT_HOSTED_URL, hostedUrlChoice, resolveHostedUrl } from '../auth/hosted-default.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LO = Object.freeze([{ name: 'lo-test', address: '127.0.0.1', netmask: '255.0.0.0', broadcast: null }]);
const lo = () => LO;
const PID = 'sp_abcdefghijklmnopqrstuvwxyz';

delete process.env.PROMPTCUT_HOSTED_URL;
delete process.env.PROMPTCUT_LAN_HOST;

/* ================================================================== SPR-2 令牌的边界 */

for (const mode of ['hosted', 'lan']) {
  test(`SPR-2a ${mode}：page、agent、render 三种角色与独立主机都不带集群令牌，凭项目凭证从非回环来源进入成功`, async (t) => {
    let loop = true;
    const s = await startSharedService({ mode, isLoopback: () => loop, clusterToken: mode === 'hosted' ? randomToken() : undefined });
    t.after(() => s.close());
    const p = await createProject(s.base, { password: 'pw-ok' });
    loop = false; // 之后的连接都当局域网 / 公网来的
    const dev = newDeviceId('r');
    for (const [role, extra] of [['page', {}], ['agent', { conversation: 7 }], ['render', {}]]) {
      const c = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: dev, password: 'pw-ok', role, ...extra });
      await c.opened;
      assert.equal(c.ws.protocol, 'promptcut.v1', role);
      c.close();
    }
    // 独立主机：render 角色、profile host 报到
    const hostConn = await join(s.base, { projectId: p.projectId, username: 'host-a', deviceId: newDeviceId('h'), password: 'pw-ok', role: 'render' });
    await hostConn.opened;
    hostConn.send({ type: 'node.hello', reqId: 'h1', nodeId: 'host-a', profile: 'host', capabilities: {}, codeVersions: [], maxConcurrent: 1 });
    assert.equal((await hostConn.next(byReq('h1'))).type, 'node.welcome');
    hostConn.close();
  });

  test(`SPR-2b ${mode}：凭证错被拒（401）`, async (t) => {
    let loop = true;
    const s = await startSharedService({ mode, isLoopback: () => loop });
    t.after(() => s.close());
    const p = await createProject(s.base, { password: 'pw-ok' });
    loop = false;
    const c = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: newDeviceId('w'), password: 'pw-wrong' });
    await assert.rejects(c.opened);
  });
}

test('SPR-2c 托管端：管理接口不带令牌 401、令牌错 401、令牌对能登记；成员登记服务地址回 forbidden', async (t) => {
  const token = randomToken();
  const s = await startSharedService({ mode: 'hosted', isLoopback: () => false, clusterToken: token });
  t.after(() => s.close());
  const none = await rawHandshake(s.port, { protocols: ['promptcut.v1'] });
  none.sock.destroy();
  assert.equal(none.status, 401, '不带任何鉴权项');
  const wrong = await rawHandshake(s.port, { protocols: ['promptcut.v1', `promptcut.token.${randomToken()}`] });
  wrong.sock.destroy();
  assert.equal(wrong.status, 401, '令牌错');
  const { wsClient } = await import('./fake-ws-kit.mjs');
  const admin = wsClient(s.url, ['promptcut.v1', `promptcut.token.${token}`]);
  await admin.opened;
  admin.send({ type: 'service.announce', reqId: 'a1', announcerId: 'asset-1', kind: 'asset', urls: ['http://203.0.113.5:8788/api/asset'] });
  assert.equal((await admin.next(byReq('a1'))).type, 'service.announced');
  admin.close();
  const p = await createProject(s.base);
  const m = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: newDeviceId('m'), password: 'project-pw' });
  await m.opened;
  m.send({ type: 'service.announce', reqId: 'a2', announcerId: 'x', kind: 'asset', urls: ['http://203.0.113.6/api/asset'] });
  const r = await m.next(byReq('a2'));
  assert.equal(r.type, 'error');
  assert.equal(r.reason, 'forbidden');
  m.close();
});

test('SPR-2d 局域网主机：管理接口从非回环来源连不上（不带凭证、带令牌都 401），本机回环不带令牌能登记', async (t) => {
  let loop = false;
  const token = randomToken();
  const s = await startSharedService({ mode: 'lan', isLoopback: () => loop, clusterToken: token });
  t.after(() => s.close());
  for (const protocols of [undefined, ['promptcut.v1'], ['promptcut.v1', `promptcut.token.${token}`]]) {
    const hs = await rawHandshake(s.port, { protocols, path: '/docservice' });
    hs.sock.destroy();
    assert.equal(hs.status, 401, JSON.stringify(protocols));
  }
  loop = true;
  const { wsClient } = await import('./fake-ws-kit.mjs');
  const local = wsClient(s.url);
  await local.opened;
  local.send({ type: 'service.announce', reqId: 'a1', announcerId: 'asset-local', kind: 'asset', urls: ['http://192.168.1.5:5190/api/asset'] });
  assert.equal((await local.next(byReq('a1'))).type, 'service.announced');
  local.close();
});

/* ---------------------------------------------------------------- 编辑器插件（TS 转译，同 asset-store-http.test.mjs 的办法） */

let pluginPromise = null;
function loadPlugin() {
  pluginPromise ??= (() => {
    const ts = createRequire(import.meta.url)('typescript');
    const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sp-routing-'));
    process.on('exit', () => { try { fs.rmSync(OUT, { recursive: true, force: true }); } catch { /* 忽略 */ } });
    const compiled = new Map();
    const resolveRel = (fromFile, spec) => {
      const base = path.resolve(path.dirname(fromFile), spec);
      for (const c of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      return null;
    };
    const compileTs = (absFile) => {
      if (compiled.has(absFile)) return compiled.get(absFile);
      const outFile = path.join(OUT, `${path.relative(ROOT, absFile).replace(/[\\/]/g, '__').replace(/\.ts$/, '')}.mjs`);
      const url = pathToFileURL(outFile).href;
      compiled.set(absFile, url);
      let src = fs.readFileSync(absFile, 'utf8');
      const rewrite = (spec) => {
        const hit = resolveRel(absFile, spec);
        if (!hit) return spec;
        return hit.endsWith('.ts') ? compileTs(hit) : pathToFileURL(hit).href;
      };
      src = src.replace(/(\bfrom\s*)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
      src = src.replace(/(\bimport\s*\(\s*)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
      const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
      fs.writeFileSync(outFile, js);
      return url;
    };
    return import(compileTs(path.join(ROOT, 'server', 'vite-plugin-docservice.ts')));
  })();
  return pluginPromise;
}

/** 插件 configureServer 用得到的最小 vite 服务器替身 */
function fakeVite(root) {
  const httpServer = http.createServer();
  return {
    httpServer,
    config: { root },
    middlewares: { stack: [], use(fn) { this.stack.push({ route: '', handle: fn }); } },
  };
}

test('SPR-2e 局域网主机（PROMPTCUT_LAN_HOST=1）凭证存储读不了就拒绝启动；不设时照常挂上（局域网来的一律 401）', async (t) => {
  const { docservicePlugin } = await loadPlugin();
  const logs = [];
  const origInfo = console.info;
  console.info = (...a) => logs.push(a.join(' '));
  t.after(() => { console.info = origInfo; delete process.env.PROMPTCUT_LAN_HOST; });
  const mkRoot = () => {
    const root = tempDir('pc-spr-root-');
    fs.mkdirSync(path.join(root, 'out', 'docservice'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out', 'docservice', 'auth'), 'not a directory');
    return root;
  };
  process.env.PROMPTCUT_LAN_HOST = '1';
  const a = fakeVite(mkRoot());
  await assert.rejects(docservicePlugin().configureServer(a), /PROMPTCUT_LAN_HOST/);
  a.httpServer.emit('close');
  assert.ok(logs.some((l) => l.includes('config.error') && l.includes('auth-store')));
  delete process.env.PROMPTCUT_LAN_HOST;
  const b = fakeVite(mkRoot());
  await docservicePlugin().configureServer(b);
  b.httpServer.emit('close');
});

/* ================================================================== SPR-4 局域网发现 */

test('SPR-4a 参数与契约第 4 节一致', () => {
  assert.equal(LAN_DISCOVERY.GROUP, '239.255.42.99');
  assert.equal(LAN_DISCOVERY.PORT, 54887);
  assert.equal(LAN_DISCOVERY.TTL, 1);
  assert.equal(LAN_DISCOVERY.QUERY_INTERVAL_MS, 500);
  assert.equal(LAN_DISCOVERY.QUERY_COUNT, 3);
  assert.equal(LAN_DISCOVERY.ANNOUNCE_PERIOD_MS, 15_000);
  assert.equal(LAN_DISCOVERY.ANNOUNCE_JITTER_MS, 3_000);
  assert.equal(LAN_DISCOVERY.EXPIRE_MS, 45_000);
  assert.equal(LAN_DISCOVERY.MAX_PACKET_BYTES, 1024);
  assert.equal(LAN_DISCOVERY.RESCAN_MS, 10_000);
  assert.equal(LAN_DISCOVERY.DISCOVER_TIMEOUT_MS, 3_000);
  for (let i = 0; i < 200; i++) {
    const d = nextAnnounceDelay();
    assert.ok(d >= 12_000 && d <= 18_000, String(d));
  }
  assert.equal(nextAnnounceDelay(() => 0), 12_000);
  assert.equal(nextAnnounceDelay(() => 0.5), 15_000);
});

test('SPR-4b 多网卡选择（纯函数）：只要已启用、非回环、非链路本地、有 IPv4 的；广播地址；收包网卡；目标', () => {
  const nics = {
    'Wi-Fi': [
      { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
      { address: '192.168.50.96', netmask: '255.255.255.0', family: 'IPv4', internal: false },
    ],
    'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    '以太网 2': [{ address: '169.254.10.20', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
    'vEthernet (WSL)': [{ address: '172.20.16.1', netmask: '255.255.240.0', family: 4, internal: false }],
    ppp: [{ address: '10.8.0.6', netmask: '255.255.255.255', family: 'IPv4', internal: false }],
  };
  const list = selectInterfaces(nics);
  // 按网卡名（码位序）排，指纹稳定
  assert.deepEqual(list.map((i) => i.address), ['192.168.50.96', '10.8.0.6', '172.20.16.1']);
  assert.deepEqual(list.map((i) => i.broadcast), ['192.168.50.255', null, '172.20.31.255']);
  assert.equal(broadcastOf('10.0.3.7', '255.0.0.0'), '10.255.255.255');
  assert.equal(broadcastOf('192.168.1.9', '255.255.255.254'), null);
  assert.equal(broadcastOf('x', '255.0.0.0'), null);
  assert.equal(ipv4ToInt('256.1.1.1'), null);

  // 收包网卡：地址相同 > 同一子网 > 没有
  assert.equal(interfaceFor('192.168.50.96', list)?.address, '192.168.50.96', '本机自己查自己');
  assert.equal(interfaceFor('192.168.50.23', list)?.address, '192.168.50.96');
  assert.equal(interfaceFor('::ffff:172.20.20.9', list)?.address, '172.20.16.1', 'IPv4 映射地址');
  assert.equal(interfaceFor('172.20.32.1', list), null, '子网外');
  assert.equal(interfaceFor('fe80::2', list), null);

  const targets = queryTargets(list, { group: LAN_DISCOVERY.GROUP, port: 54887 });
  assert.deepEqual(targets.map((x) => `${x.iface.address}->${x.address}:${x.port}:${x.multicast ? 'm' : 'b'}`), [
    '192.168.50.96->239.255.42.99:54887:m', '192.168.50.96->192.168.50.255:54887:b',
    '10.8.0.6->239.255.42.99:54887:m',
    '172.20.16.1->239.255.42.99:54887:m', '172.20.16.1->172.20.31.255:54887:b',
  ]);

  // 网卡变化看指纹
  const a = interfaceSignature(list);
  assert.equal(interfaceSignature(selectInterfaces(nics)), a);
  assert.notEqual(interfaceSignature(selectInterfaces({ ...nics, ppp: [] })), a);
});

test('SPR-4c 包：查询与通告的形状、≤ 1 KiB、不认识的一律丢', () => {
  const q = buildQuery({ nonce: 'abcdefgh12345678', name: 'Demo' });
  assert.deepEqual(q, { magic: 'promptcut-lan', v: 1, type: 'query', nonce: 'abcdefgh12345678', name: 'Demo' });
  assert.deepEqual(parsePacket(encodePacket(q)), { type: 'query', nonce: 'abcdefgh12345678', name: 'Demo' });
  const iface = { address: '192.168.50.96' };
  const ann = buildAnnounce({ project: { projectId: PID, name: 'Demo', mode: 'free' }, iface, hostDeviceName: 'PC-1', servicePort: 5190, nonce: 'abcdefgh12345678' });
  assert.deepEqual(ann, {
    magic: 'promptcut-lan', v: 1, type: 'announce', nonce: 'abcdefgh12345678', projectId: PID, name: 'Demo', mode: 'free',
    hostDeviceName: 'PC-1', docservice: 'ws://192.168.50.96:5190/docservice', asset: 'http://192.168.50.96:5190/api/asset', ttlMs: 45000,
  });
  const parsed = parsePacket(encodePacket(ann));
  assert.equal(parsed.docservice, ann.docservice);
  assert.equal(parsed.ttlMs, 45000);
  // 最长的合法字段（64 个 4 字节字符的名字与设备名）也在 1 KiB 以内
  const big = buildAnnounce({ project: { projectId: PID, name: '😀'.repeat(64), mode: 'restricted' }, iface: { address: '255.255.255.255' }, hostDeviceName: '😀'.repeat(64), servicePort: 65535, nonce: 'x'.repeat(64) });
  assert.ok(encodePacket(big).length <= 1024);
  assert.ok(parsePacket(encodePacket(big)));
  // 超出不发、超长不收
  assert.equal(encodePacket({ pad: 'x'.repeat(1100) }), null);
  assert.equal(parsePacket(Buffer.alloc(1025, 0x20)), null);
  for (const bad of [
    'not json', '[]', JSON.stringify({ ...q, magic: 'other' }), JSON.stringify({ ...q, v: 2 }), JSON.stringify({ ...q, nonce: 'has space' }), JSON.stringify({ ...q, nonce: 'n'.repeat(65) }),
    JSON.stringify({ ...q, name: 'a/b' }), JSON.stringify({ ...ann, projectId: 'p1' }), JSON.stringify({ ...ann, mode: 'open' }),
    JSON.stringify({ ...ann, docservice: 'http://x/docservice' }), JSON.stringify({ ...ann, asset: 'ftp://x' }), JSON.stringify({ ...ann, type: 'hello' }),
  ]) assert.equal(parsePacket(Buffer.from(bad)), null, bad.slice(0, 60));
});

/** 本机回环上的一个主机端；projects 可改 */
async function loHost(t, { projects = [{ projectId: PID, name: 'Demo', mode: 'free' }], ...opts } = {}) {
  const state = { projects };
  const logs = [];
  const host = createLanHost({
    projects: () => state.projects, hostDeviceName: 'PC-1', servicePort: 5190, port: 0, bindAddress: '127.0.0.1', interfaces: lo,
    log: (e, f) => logs.push({ e, ...f }), ...opts,
  });
  await host.start();
  t.after(() => host.stop());
  return { host, state, logs };
}

test('SPR-4d 两个 dgram 套接字：查询（500 ms × 3）→ 单播应答，按名字过滤，发现耗时 ≤ 5 s', async (t) => {
  const { host } = await loHost(t, { projects: [{ projectId: PID, name: 'Demo', mode: 'free' }, { projectId: 'sp_bbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Other', mode: 'restricted' }] });
  const t0 = Date.now();
  const r = await discoverLan({ name: 'DEMO', port: host.port(), bindAddress: '127.0.0.1', interfaces: lo });
  const took = Date.now() - t0;
  assert.ok(took <= 5000, `发现耗时 ${took} ms`);
  assert.ok(r.elapsedMs >= 1000 && r.elapsedMs <= 3000, `收集窗口 ${r.elapsedMs} ms（3 次查询、隔 500 ms、再等 500 ms）`);
  assert.equal(r.sent, 3, '每次一块网卡发一条组播（回环网卡没有广播地址）');
  assert.equal(r.hosts.length, 1);
  const h = r.hosts[0];
  assert.equal(h.projectId, PID);
  assert.equal(h.hostDeviceName, 'PC-1');
  assert.equal(h.docservice, 'ws://127.0.0.1:5190/docservice', '地址取收到查询的那块网卡的');
  assert.ok(h.firstSeenMs < 500, `第一次查询就有应答：${h.firstSeenMs} ms`);
  assert.equal(host.stats().queries, 3);
  assert.equal(host.stats().replies, 3, '每次查询都答（重发是为了抵消丢包）');
  const all = await discoverLan({ port: host.port(), bindAddress: '127.0.0.1', interfaces: lo, count: 1, graceMs: 200 });
  assert.deepEqual(all.hosts.map((x) => x.name).sort(), ['Demo', 'Other'], '不带名字：全部项目');
  const none = await discoverLan({ name: 'nope', port: host.port(), bindAddress: '127.0.0.1', interfaces: lo, count: 1, graceMs: 200 });
  assert.deepEqual(none.hosts, []);
});

test('SPR-4e 同一轮查询经组播与广播到两次只答一次；主机停了之后查不到；没有网卡时不抛', async (t) => {
  const { host } = await loHost(t);
  const c = await createLanClient({ port: host.port(), bindAddress: '127.0.0.1', interfaces: lo });
  t.after(() => c.close());
  await c.query({ name: 'Demo', count: 2, intervalMs: 0, nonce: 'same-nonce-0001' });
  await waitFor(() => host.stats().queries === 2, 2000, '两条查询');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(host.stats().replies, 1);
  assert.equal(c.list().length, 1);
  const port = host.port();
  await host.stop();
  assert.equal(host.running(), false);
  const r = await discoverLan({ name: 'Demo', port, bindAddress: '127.0.0.1', interfaces: lo, count: 1, graceMs: 200 });
  assert.deepEqual(r.hosts, []);
  const empty = await discoverLan({ name: 'Demo', port, bindAddress: '127.0.0.1', interfaces: () => [] });
  assert.deepEqual(empty.errors, [{ reason: 'no-interface' }]);
});

test('SPR-4f 周期通告（15 s ± 3 s，这里缩短）进常驻客户端；45 s 没见到就移除；项目删掉后不再通告', async (t) => {
  let skew = 0;
  const changes = [];
  const c = await createLanClient({ listen: true, port: 0, bindAddress: '127.0.0.1', interfaces: lo, now: () => Date.now() + skew, onChange: (l) => changes.push(l.length) });
  t.after(() => c.close());
  const { host, state } = await loHost(t, { announcePort: c.port(), periodMs: 80, jitterMs: 20 });
  await waitFor(() => c.list().length === 1, 2000, '周期通告');
  assert.equal(c.list()[0].hostDeviceName, 'PC-1');
  const before = host.stats().announces;
  await waitFor(() => host.stats().announces >= before + 2, 2000, '又通告了两次');
  // 删掉项目：之后的通告里没有它；客户端还记着，45 s 后过期
  state.projects = [];
  await host.refresh();
  const n = host.stats().announces;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(host.stats().announces, n, '没有项目就不发');
  skew = 44_000;
  assert.equal(c.sweep(), false);
  assert.equal(c.list().length, 1, '44 s 还在');
  skew = 46_000;
  assert.equal(c.sweep(), true);
  assert.equal(c.list().length, 0, '45 s 没见到就移除');
  assert.deepEqual(changes, [1, 0]);
});

test('SPR-4g 网卡变化：重新核对时增减成员资格并立即通告', async (t) => {
  let list = LO;
  const { host, logs } = await loHost(t, { interfaces: () => list });
  assert.deepEqual(host.interfaces().map((i) => i.address), ['127.0.0.1']);
  assert.equal(host.rescan(), false, '没变');
  list = [];
  assert.equal(host.rescan(), true);
  assert.deepEqual(host.interfaces(), []);
  const r = await discoverLan({ name: 'Demo', port: host.port(), bindAddress: '127.0.0.1', interfaces: lo, count: 1, graceMs: 200 });
  assert.deepEqual(r.hosts, [], '主机那边没有网卡：查询到了也不答（不知道拿哪块网卡的地址）');
  list = LO;
  const n = host.stats().announces;
  assert.equal(host.rescan(), true);
  await waitFor(() => host.stats().announces > n, 2000, '网卡回来后立即通告');
  assert.ok(logs.some((l) => l.e === 'lan.interfaces'));
  const back = await discoverLan({ name: 'Demo', port: host.port(), bindAddress: '127.0.0.1', interfaces: lo, count: 1, graceMs: 200 });
  assert.equal(back.hosts.length, 1);
});

test('SPR-4h 编辑器里的广播：绑非回环且有项目才起，项目删光停、再建再起，编辑器退出停；只绑回环不起', async () => {
  const { createLanHosting, isLoopbackListen } = await loadPlugin();
  assert.equal(isLoopbackListen('127.0.0.1'), true);
  assert.equal(isLoopbackListen('::1'), true);
  assert.equal(isLoopbackListen('localhost'), true);
  assert.equal(isLoopbackListen('0.0.0.0'), false);
  assert.equal(isLoopbackListen('::'), false);
  assert.equal(isLoopbackListen('192.168.50.96'), false);

  const made = [];
  const createHost = (o) => {
    const h = { o, started: 0, stopped: 0, refreshed: 0, running: () => h.started > h.stopped, async start() { h.started += 1; }, async stop() { h.stopped += 1; }, async refresh() { h.refreshed += 1; } };
    made.push(h);
    return h;
  };
  const projects = [];
  const store = { list: () => projects.slice() };
  const fake = Object.assign(new EventEmitter(), { listening: false, addr: null, address() { return this.addr; } });
  const hosting = createLanHosting(fake, { createHost, log: () => {} });
  hosting.attach({ store, hostDeviceName: 'PC-1' });
  await hosting.sync();
  assert.equal(made.length, 0, '还没在听');
  fake.addr = { address: '0.0.0.0', port: 5480, family: 'IPv4' };
  fake.listening = true;
  fake.emit('listening');
  await hosting.sync();
  assert.equal(made.length, 0, '没有项目不广播');
  projects.push({ projectId: PID, name: 'Demo', mode: 'free' });
  await hosting.sync();
  assert.equal(made.length, 1);
  assert.equal(made[0].o.servicePort, 5480);
  assert.equal(made[0].o.hostDeviceName, 'PC-1');
  assert.deepEqual(made[0].o.projects(), projects);
  assert.equal(made[0].started, 1);
  projects.push({ projectId: 'sp_bbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Two', mode: 'free' });
  await hosting.sync();
  assert.equal(made[0].refreshed, 1, '再建一个：立即通告');
  projects.length = 0;
  await hosting.sync();
  assert.equal(made[0].stopped, 1, '删光就停');
  projects.push({ projectId: PID, name: 'Demo', mode: 'free' });
  await hosting.sync();
  assert.equal(made.length, 2, '再建再起');
  fake.emit('close');
  await hosting.sync();
  assert.equal(made[1].stopped, 1, '编辑器退出就停');

  const loopOnly = Object.assign(new EventEmitter(), { listening: true, addr: { address: '127.0.0.1', port: 5481 }, address() { return this.addr; } });
  const made2 = [];
  const h2 = createLanHosting(loopOnly, { createHost: (o) => { made2.push(o); return createHost(o); }, log: () => {} });
  h2.attach({ store: { list: () => [{ projectId: PID, name: 'Demo', mode: 'free' }] }, hostDeviceName: 'PC-1' });
  await new Promise((r) => setTimeout(r, 20));
  await h2.sync();
  assert.equal(made2.length, 0, '只绑回环：别人连不上，不广播');
});

test('SPR-4i 发现之后凭项目凭证进入（文档服务挂载模式 + 真 dgram），全程不连托管端（托管端连接数不变）', async (t) => {
  let loop = true;
  const lan = await startSharedService({ mode: 'lan', isLoopback: () => loop });
  t.after(() => lan.close());
  const hosted = await startSharedService({ mode: 'hosted' });
  t.after(() => hosted.close());
  const p = await createProject(lan.base, { name: 'LanDemo', password: 'lan-pw' });
  loop = false;
  const host = createLanHost({
    projects: () => lan.store.list(), hostDeviceName: 'PC-host', servicePort: lan.port, port: 0, bindAddress: '127.0.0.1', interfaces: lo,
  });
  await host.start();
  t.after(() => host.stop());
  const connsBefore = hosted.service.describe().conns.length;
  const t0 = Date.now();
  const found = await findSharedProject({
    name: 'landemo', hostedUrl: null,
    lan: { discover: (o) => discoverLan({ ...o, port: host.port(), bindAddress: '127.0.0.1', interfaces: lo }) },
  });
  const tookMs = Date.now() - t0;
  assert.ok(tookMs <= 5000, `发现 ${tookMs} ms`);
  const route = pickRoute(found);
  assert.equal(route.action, 'enter', JSON.stringify(found));
  assert.equal(route.candidate.where, 'lan');
  assert.equal(route.candidate.projectId, p.projectId);
  assert.equal(route.candidate.hostDeviceName, 'PC-host');
  assert.equal(route.candidate.base, `http://127.0.0.1:${lan.port}/docservice/`);
  const c = await join(wsBaseOf(route.candidate.base), { projectId: route.candidate.projectId, username: 'bob', deviceId: newDeviceId('l'), password: 'lan-pw', role: 'render' });
  await c.opened;
  c.close();
  assert.equal(hosted.service.describe().conns.length, connsBefore);
  assert.deepEqual(found.errors, []);
});

/* ================================================================== SPR-5 打开时的路由 */

/** 假的发现：回给定的主机表 */
const fakeDiscover = (hosts) => async () => ({ hosts, errors: [] });
const lanEntry = (base, p, device = 'PC-1') => ({ projectId: p.projectId, name: p.name, mode: p.mode, hostDeviceName: device, docservice: base, asset: base.replace(/^ws/, 'http').replace(/\/docservice$/, '/api/asset'), firstSeenMs: 3 });

test('SPR-5a 四种组合：只有局域网 → 直接进；只有托管 → 直接进；两边都有 → 并列供挑；都没有 → 找不到', async (t) => {
  const hosted = await startSharedService({ mode: 'hosted' });
  t.after(() => hosted.close());
  let loop = true;
  const lan = await startSharedService({ mode: 'lan', isLoopback: () => loop });
  t.after(() => lan.close());
  const onlyLan = await createProject(lan.base, { name: 'only-lan' });
  const onlyHosted = await createProject(hosted.base, { name: 'only-hosted' });
  const bothL = await createProject(lan.base, { name: 'both' });
  const bothH = await createProject(hosted.base, { name: 'both' });
  loop = false;
  const discoverOf = (...ps) => fakeDiscover(ps.map((p) => lanEntry(lan.url, p)));

  // 1. 只有局域网
  let r = await findSharedProject({ name: 'only-lan', hostedUrl: hosted.url, lan: { discover: discoverOf(onlyLan) } });
  let route = pickRoute(r);
  assert.equal(route.action, 'enter');
  assert.deepEqual({ ...route.candidate, firstSeenMs: undefined, asset: undefined }, {
    where: 'lan', base: candidateBaseOf(lan.url), projectId: onlyLan.projectId, name: 'only-lan', mode: 'free', hostDeviceName: 'PC-1', via: 'discover', firstSeenMs: undefined, asset: undefined,
  });
  assert.deepEqual(r.errors, [], '托管端 404 不算错误');

  // 2. 只有托管（局域网谁也没应答：记超时，不抛）
  r = await findSharedProject({ name: 'only-hosted', hostedUrl: hosted.url, lan: { discover: fakeDiscover([]) } });
  route = pickRoute(r);
  assert.equal(route.action, 'enter');
  assert.deepEqual(route.candidate, { where: 'hosted', base: candidateBaseOf(hosted.url), projectId: onlyHosted.projectId, name: 'only-hosted', mode: 'free' });
  assert.deepEqual(r.errors, [{ where: 'lan', reason: 'timeout' }]);

  // 3. 两边都有：都列出，局域网在前，谁也不挑
  r = await findSharedProject({ name: 'BOTH', hostedUrl: hosted.url, lan: { discover: discoverOf(bothL) } });
  route = pickRoute(r);
  assert.equal(route.action, 'choose');
  assert.deepEqual(route.candidates.map((c) => [c.where, c.projectId]), [['lan', bothL.projectId], ['hosted', bothH.projectId]]);

  // 4. 都没有
  r = await findSharedProject({ name: 'nothing', hostedUrl: hosted.url, lan: { discover: fakeDiscover([]) } });
  route = pickRoute(r);
  assert.equal(route.action, 'not-found');
  assert.deepEqual(route.errors, [{ where: 'lan', reason: 'timeout' }]);
});

test('SPR-5b 局域网里同名的两台主机并列（带主机设备名），同一项目多块网卡只列一次', async () => {
  const a = { projectId: PID, name: 'Demo', mode: 'free' };
  const b = { projectId: 'sp_bbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'demo', mode: 'restricted' };
  const r = await findSharedProject({
    name: 'Demo', hostedUrl: null,
    lan: { discover: fakeDiscover([lanEntry('ws://192.168.1.2:5190/docservice', a, 'PC-A'), lanEntry('ws://10.0.0.2:5190/docservice', a, 'PC-A'), lanEntry('ws://192.168.1.3:5190/docservice', b, 'PC-B'), { ...lanEntry('ws://192.168.1.4:5190/docservice', b, 'PC-C'), name: 'other' }]) },
  });
  const route = pickRoute(r);
  assert.equal(route.action, 'choose');
  assert.deepEqual(route.candidates.map((c) => [c.hostDeviceName, c.base]), [['PC-A', 'http://192.168.1.2:5190/docservice/'], ['PC-B', 'http://192.168.1.3:5190/docservice/']]);
});

test('SPR-5c 手填兜底（浏览器只能用这一路）：直接查 /docservice/shared/lookup；连不上、托管端连不上都进 errors 不抛', async (t) => {
  let loop = true;
  const lan = await startSharedService({ mode: 'lan', isLoopback: () => loop });
  t.after(() => lan.close());
  const p = await createProject(lan.base, { name: 'manual-demo' });
  loop = false;
  const dead = await refusingPort();
  t.after(() => dead.close());
  const r = await findSharedProject({
    name: 'manual-demo', hostedUrl: `http://127.0.0.1:${dead.port}`,
    lan: { manual: [`http://127.0.0.1:${lan.port}`, `127.0.0.1:${dead.port}`, 'http://[::1'] },
  });
  assert.deepEqual(r.candidates, [{ where: 'lan', base: `http://127.0.0.1:${lan.port}/docservice/`, projectId: p.projectId, name: 'manual-demo', mode: 'free', via: 'manual' }]);
  const reasons = r.errors.map((e) => `${e.where}:${e.reason}`).sort();
  assert.deepEqual(reasons, ['hosted:unreachable', 'lan:bad-address', 'lan:unreachable']);
  assert.equal(pickRoute(r).action, 'enter');
  // 发现抛错也不抛
  const r2 = await findSharedProject({ name: 'x', hostedUrl: null, lan: { discover: async () => { throw new Error('boom'); } } });
  assert.deepEqual(r2.errors.map((e) => e.reason), ['discover-failed']);
  assert.equal(pickRoute(r2).action, 'not-found');
});

test('SPR-5f 手填与发现按 base 去重（契约第 11 节裁定）：同一地址只列一次、发现的在前；base 是 http://<ip>:<端口>/docservice/', async (t) => {
  let loop = true;
  const lan = await startSharedService({ mode: 'lan', isLoopback: () => loop });
  t.after(() => lan.close());
  const p = await createProject(lan.base, { name: 'dedupe-demo' });
  loop = false;
  const r = await findSharedProject({
    name: 'dedupe-demo', hostedUrl: null,
    lan: { discover: fakeDiscover([lanEntry(lan.url, p)]), manual: [`http://127.0.0.1:${lan.port}`] },
  });
  assert.deepEqual(r.candidates.map((c) => [c.where, c.via, c.base]), [['lan', 'discover', `http://127.0.0.1:${lan.port}/docservice/`]]);
  assert.equal(candidateBaseOf('ws://h:1/docservice'), 'http://h:1/docservice/');
  assert.equal(candidateBaseOf('http://h:8787'), 'http://h:8787/');
  assert.equal(candidateBaseOf('wss://h/x/'), 'https://h/x/');
});

test('SPR-5d 地址写法：wsBaseOf、manualBaseOf', () => {
  assert.equal(wsBaseOf('http://8.8.8.8:8787'), 'ws://8.8.8.8:8787');
  assert.equal(wsBaseOf('https://h/x/'), 'wss://h/x');
  assert.equal(wsBaseOf('ws://h:1/docservice'), 'ws://h:1/docservice');
  assert.throws(() => wsBaseOf('ftp://h'));
  assert.equal(manualBaseOf('http://192.168.1.5:5190'), 'ws://192.168.1.5:5190/docservice');
  assert.equal(manualBaseOf('http://192.168.1.5:5190/'), 'ws://192.168.1.5:5190/docservice');
  assert.equal(manualBaseOf('192.168.1.5:5190'), 'ws://192.168.1.5:5190/docservice');
  assert.equal(manualBaseOf('ws://192.168.1.5:5190/docservice'), 'ws://192.168.1.5:5190/docservice');
  assert.throws(() => manualBaseOf('  '));
});

test('SPR-5e 新建：托管端向托管地址 POST shared/create；局域网向本机编辑器，只有回环能建', async (t) => {
  const hosted = await startSharedService({ mode: 'hosted' });
  t.after(() => hosted.close());
  let loop = true;
  const lan = await startSharedService({ mode: 'lan', isLoopback: () => loop });
  t.after(() => lan.close());
  const creator = { username: 'alice', password: 'c-pw' };
  const kdf = { alg: 'pbkdf2-sha256', iter: 100000 };
  const h = await createSharedProject({ where: 'hosted', hostedUrl: `http://127.0.0.1:${hosted.port}`, name: 'H1', mode: 'free', creator, password: 'p', kdf });
  assert.equal(h.where, 'hosted');
  assert.equal(h.base, candidateBaseOf(hosted.url));
  assert.ok(hosted.store.peek(h.projectId));
  const l = await createSharedProject({ where: 'lan', lanBase: lan.url, name: 'L1', mode: 'restricted', creator, list: [], kdf });
  assert.equal(l.base, candidateBaseOf(lan.url));
  assert.ok(lan.store.peek(l.projectId));
  loop = false;
  await assert.rejects(createSharedProject({ where: 'lan', lanBase: lan.url, name: 'L2', mode: 'free', creator, password: 'p', kdf }), (err) => err.status === 403 && err.reason === 'forbidden');
  await assert.rejects(createSharedProject({ where: 'lan', name: 'L3', mode: 'free', creator, password: 'p', kdf }), TypeError, 'Node 里局域网模式要给 lanBase');
  await assert.rejects(createSharedProject({ where: 'moon', name: 'L4' }), TypeError);
});

/* ================================================================== SPR-6 缺省托管地址 */

test('SPR-6b 覆盖顺序：界面值 → PROMPTCUT_HOSTED_URL → 缺省；空值往下找；写错的地址抛错不回落', () => {
  assert.deepEqual(hostedUrlChoice({ env: {} }), { url: DEFAULT_HOSTED_URL, from: 'default' });
  assert.deepEqual(hostedUrlChoice({ env: { PROMPTCUT_HOSTED_URL: 'http://10.0.0.5:9000/' } }), { url: 'http://10.0.0.5:9000', from: 'env' });
  assert.deepEqual(hostedUrlChoice({ ui: 'ws://ui.example:1', env: { PROMPTCUT_HOSTED_URL: 'http://10.0.0.5:9000' } }), { url: 'ws://ui.example:1', from: 'ui' });
  assert.deepEqual(hostedUrlChoice({ ui: '  ', env: { PROMPTCUT_HOSTED_URL: '' } }), { url: DEFAULT_HOSTED_URL, from: 'default' });
  assert.deepEqual(hostedUrlChoice({ ui: null, env: { PROMPTCUT_HOSTED_URL: ' http://e:1 ' } }), { url: 'http://e:1', from: 'env' });
  assert.throws(() => hostedUrlChoice({ ui: 'not a url', env: {} }), TypeError);
  assert.throws(() => hostedUrlChoice({ env: { PROMPTCUT_HOSTED_URL: 'ftp://x' } }), TypeError);
  // 缺省读 process.env
  process.env.PROMPTCUT_HOSTED_URL = 'http://127.0.0.9:1';
  try {
    assert.equal(resolveHostedUrl(), 'http://127.0.0.9:1');
    assert.equal(resolveHostedUrl({ ui: 'http://u:2' }), 'http://u:2');
  } finally {
    delete process.env.PROMPTCUT_HOSTED_URL;
  }
  assert.equal(resolveHostedUrl(), DEFAULT_HOSTED_URL);
});

test('SPR-6c 路由按覆盖顺序连托管端：不设覆盖连缺省、设了环境变量连它、界面上改了连界面上的', async (t) => {
  const envSvc = await startSharedService({ mode: 'hosted' });
  t.after(() => envSvc.close());
  const uiSvc = await startSharedService({ mode: 'hosted' });
  t.after(() => uiSvc.close());
  const pe = await createProject(envSvc.base, { name: 'same' });
  const pu = await createProject(uiSvc.base, { name: 'same' });
  // 缺省：不真连外网，只看它往哪儿发。公开版没有缺省托管端，什么都不发
  const seen = [];
  const spy = async (url) => { seen.push(String(url)); throw new TypeError('fetch failed'); };
  const d = await findSharedProject({ name: 'same', fetch: spy });
  if (DEFAULT_HOSTED_URL) {
    assert.equal(new URL(seen[0]).origin, new URL(DEFAULT_HOSTED_URL).origin);
    assert.deepEqual(d.errors, [{ where: 'hosted', reason: 'unreachable' }]);
  } else {
    assert.deepEqual(seen, []);
  }

  process.env.PROMPTCUT_HOSTED_URL = `http://127.0.0.1:${envSvc.port}`;
  t.after(() => { delete process.env.PROMPTCUT_HOSTED_URL; });
  let r = await findSharedProject({ name: 'same' });
  assert.deepEqual(r.candidates.map((c) => c.projectId), [pe.projectId]);
  r = await findSharedProject({ name: 'same', uiHostedUrl: `http://127.0.0.1:${uiSvc.port}` });
  assert.deepEqual(r.candidates.map((c) => c.projectId), [pu.projectId]);
  const created = await createSharedProject({ where: 'hosted', name: 'via-env', mode: 'free', creator: { username: 'a', password: 'b' }, password: 'c', kdf: { alg: 'pbkdf2-sha256', iter: 100000 } });
  assert.ok(envSvc.store.peek(created.projectId), '新建也按覆盖顺序');
});
