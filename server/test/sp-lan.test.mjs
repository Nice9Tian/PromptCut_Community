/**
 * SP 局域网发现（契约 `docs/plan/shared-project-contract.md` 第 4 节参数；验收第 7 节 SP4 的本机部分）。
 * 跑：node --test server/test/sp-lan.test.mjs
 *
 * 契约只定参数，没定模块与函数：全部假设见 `sp-kit.mjs` 文件头 L0。本机单测用两个 dgram 套接字模拟（回环网卡注入、
 * 单播代替组播），端口都由系统分配（主机绑 0，查询发往它实际绑到的端口），同一台机器上并行跑几份也不串。跨机（真组播、定向广播、不同网段发现不到）在 W6 验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { loadLan, LOOP_IFACE } from './sp-kit.mjs';
import { hostFor, createProject, join, waitFor } from './auth-kit.mjs';

const json = (buf) => JSON.parse(Buffer.from(buf).toString('utf8'));

function announceFields(extra = {}) {
  return {
    magic: 'promptcut-lan', v: 1, type: 'announce', nonce: 'nonce-1',
    projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'demo', mode: 'free', hostDeviceName: 'Studio-PC',
    docservice: 'ws://192.168.1.20:5173/docservice', asset: 'http://192.168.1.20:5173/api/asset', ttlMs: 45000,
    ...extra,
  };
}

// ================================================================== 参数

test('SPC4-1 parameters: 239.255.42.99:54887, TTL 1, 3 queries 500 ms apart, announce every 15 s ± 3 s, expire after 45 s, single packet ≤ 1 KiB, discovery limited to 3 s, check network interfaces every 10 s', async () => {
  const { LAN_DISCOVERY: P } = await loadLan();
  assert.equal(P.group, '239.255.42.99');
  assert.equal(P.port, 54887);
  assert.equal(P.ttl, 1);
  assert.equal(P.queryIntervalMs, 500);
  assert.equal(P.queryRepeats, 3);
  assert.equal(P.announceIntervalMs, 15_000);
  assert.equal(P.announceJitterMs, 3_000);
  assert.equal(P.expireMs, 45_000);
  assert.equal(P.maxPacketBytes, 1024);
  assert.equal(P.discoverTimeoutMs, 3_000);
  assert.equal(P.interfaceCheckMs, 10_000);
});

// ================================================================== 包格式

test('SPC4-2 query packet: { magic: promptcut-lan, v: 1, type: query, nonce, name? }, UTF-8 JSON', async () => {
  const { encodeQuery, decodePacket } = await loadLan();
  const q = json(encodeQuery({ nonce: 'abc123', name: '演示项目' }));
  assert.equal(q.magic, 'promptcut-lan');
  assert.equal(q.v, 1);
  assert.equal(q.type, 'query');
  assert.equal(q.nonce, 'abc123');
  assert.equal(q.name, '演示项目');
  const noName = json(encodeQuery({ nonce: 'n2' }));
  assert.equal(noName.name, undefined, 'name is optional');
  assert.deepEqual(decodePacket(encodeQuery({ nonce: 'abc123', name: 'x' })), { magic: 'promptcut-lan', v: 1, type: 'query', nonce: 'abc123', name: 'x' });
});

test('SPC4-3 reply packet: all fields present, ttlMs 45000; not sent when over 1 KiB (returns null)', async () => {
  const { encodeAnnounce, decodePacket } = await loadLan();
  const f = announceFields();
  const buf = encodeAnnounce(f);
  assert.ok(Buffer.isBuffer(buf) || buf instanceof Uint8Array);
  assert.ok(buf.length <= 1024);
  const a = json(buf);
  for (const k of ['magic', 'v', 'type', 'nonce', 'projectId', 'name', 'mode', 'hostDeviceName', 'docservice', 'asset', 'ttlMs']) {
    assert.deepEqual(a[k], f[k], `field ${k}`);
  }
  assert.deepEqual(decodePacket(buf).projectId, f.projectId);
  assert.equal(encodeAnnounce(announceFields({ hostDeviceName: 'x'.repeat(1100) })), null, 'not sent when over 1 KiB');
  // 刚好按 UTF-8 字节算：多字节字符
  assert.equal(encodeAnnounce(announceFields({ hostDeviceName: '设'.repeat(330) })), null, 'counted in UTF-8 bytes, not characters');
});

test('SPC4-4 decodePacket: a wrong magic, v or type, non-JSON, or more than 1 KiB all return null', async () => {
  const { decodePacket } = await loadLan();
  const enc = (o) => Buffer.from(JSON.stringify(o), 'utf8');
  assert.equal(decodePacket(enc({ ...announceFields(), magic: 'other' })), null);
  assert.equal(decodePacket(enc({ ...announceFields(), v: 2 })), null);
  assert.equal(decodePacket(enc({ ...announceFields(), type: 'hello' })), null);
  assert.equal(decodePacket(Buffer.from('{not json', 'utf8')), null);
  assert.equal(decodePacket(Buffer.from([0xff, 0xfe, 0x00])), null);
  assert.equal(decodePacket(enc({ ...announceFields(), pad: 'y'.repeat(1100) })), null, 'packets over 1 KiB are not accepted');
  assert.equal(decodePacket(enc(announceFields())).type, 'announce');
});

// ================================================================== 选网卡

test('SPC4-5 selecting network interfaces: enabled, non-loopback, non-link-local, with IPv4; computes the subnet-directed broadcast address', async () => {
  const { selectInterfaces } = await loadLan();
  const ifs = {
    Loopback: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00' }],
    'Wi-Fi': [
      { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, mac: 'aa:bb:cc:dd:ee:01' },
      { address: '192.168.1.23', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:01' },
    ],
    Ethernet: [{ address: '10.2.3.4', netmask: '255.255.0.0', family: 4, internal: false, mac: 'aa:bb:cc:dd:ee:02' }],
    APIPA: [{ address: '169.254.10.20', netmask: '255.255.0.0', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:03' }],
    V6only: [{ address: '2001:db8::5', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, mac: 'aa:bb:cc:dd:ee:04' }],
  };
  const got = selectInterfaces(ifs).map((x) => ({ address: x.address, broadcast: x.broadcast })).sort((a, b) => a.address.localeCompare(b.address));
  assert.deepEqual(got, [
    { address: '10.2.3.4', broadcast: '10.2.255.255' },
    { address: '192.168.1.23', broadcast: '192.168.1.255' },
  ]);
});

// ================================================================== 过期

test('SPC4-6 a client is removed if not seen for 45 s; seeing it again in the meantime renews it', async () => {
  const { createLanTable } = await loadLan();
  let now = 1_000_000;
  const table = createLanTable({ now: () => now });
  table.see(announceFields());
  assert.equal(table.list().length, 1);
  now += 44_000;
  assert.equal(table.list().length, 1, 'still there at 44 s');
  table.see(announceFields());
  now += 44_000;
  assert.equal(table.list().length, 1, 'still there 44 s after renewal');
  now += 2_000;
  assert.equal(table.list().length, 0, 'removed once more than 45 s have passed since it was last seen');
  table.see(announceFields({ projectId: 'sp_bbbbbbbbbbbbbbbbbbbbbbbbbb' }));
  table.see(announceFields({ projectId: 'sp_bbbbbbbbbbbbbbbbbbbbbbbbbb' }));
  assert.equal(table.list().length, 1, 'the same project on the same host counts as one entry');
});

// ================================================================== 两个 dgram 套接字

async function udpSocket(t, port = 0) {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((resolve, reject) => { s.once('error', reject); s.bind(port, '127.0.0.1', resolve); });
  t.after(() => { try { s.close(); } catch { /* 已关 */ } });
  return s;
}

async function lanHostFor(t, { projects, docservicePort = 5173, assetPort = 5173 }) {
  const { createLanHost } = await loadLan();
  const host = createLanHost({ port: 0, interfaces: [LOOP_IFACE], projects: () => projects, deviceName: 'Studio-PC', docservicePort, assetPort });
  await host.start();
  t.after(() => host.stop());
  return host;
}

test('SPC4-7 when the host receives a query it replies by unicast: nonce unchanged, address taken from the network interface that received the query, ttlMs 45000, packet ≤ 1 KiB', async (t) => {
  const { encodeQuery } = await loadLan();
  const proj = { projectId: 'sp_cccccccccccccccccccccccccc', name: 'lan-demo', mode: 'restricted' };
  const host = await lanHostFor(t, { projects: [proj], docservicePort: 5188, assetPort: 5188 });
  const client = await udpSocket(t);
  const nonce = randomBytes(8).toString('hex');
  const got = new Promise((resolve) => client.on('message', (msg, rinfo) => resolve({ msg, rinfo })));
  client.send(encodeQuery({ nonce, name: 'lan-demo' }), host.port(), '127.0.0.1');
  const { msg, rinfo } = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no reply received within 5 s')), 5000))]);
  assert.ok(msg.length <= 1024);
  assert.equal(rinfo.address, '127.0.0.1');
  const a = json(msg);
  assert.equal(a.magic, 'promptcut-lan');
  assert.equal(a.v, 1);
  assert.equal(a.type, 'announce');
  assert.equal(a.nonce, nonce);
  assert.equal(a.projectId, proj.projectId);
  assert.equal(a.name, proj.name);
  assert.equal(a.mode, 'restricted');
  assert.equal(a.hostDeviceName, 'Studio-PC');
  assert.equal(a.docservice, 'ws://127.0.0.1:5188/docservice');
  assert.equal(a.asset, 'http://127.0.0.1:5188/api/asset');
  assert.equal(a.ttlMs, 45000);
});

test('SPC4-8 discoverLan finds the host within 5 s through two dgram sockets; a non-matching name finds nothing; a stopped host is not found', { timeout: 30_000 }, async (t) => {
  const { discoverLan } = await loadLan();
  const proj = { projectId: 'sp_dddddddddddddddddddddddddd', name: 'Found-Me', mode: 'free' };
  const host = await lanHostFor(t, { projects: [proj] });
  const opts = { port: host.port(), interfaces: [LOOP_IFACE], targets: ['127.0.0.1'], timeoutMs: 3000 };
  const t0 = Date.now();
  const found = await discoverLan({ name: 'Found-Me', ...opts });
  const ms = Date.now() - t0;
  assert.ok(ms <= 5000, `discovery took ${ms} ms ≤ 5 s`);
  assert.deepEqual(found.map((a) => a.projectId), [proj.projectId]);
  const none = await discoverLan({ name: 'someone-else', ...opts });
  assert.deepEqual(none, [], 'a non-matching name finds nothing');
  await host.stop();
  const gone = await discoverLan({ name: 'Found-Me', ...opts });
  assert.deepEqual(gone, [], 'a stopped host is not found');
});

test('SPC4-9 the hosted side\'s connection count is unchanged while discovering and joining the LAN host', { timeout: 30_000 }, async (t) => {
  const { discoverLan } = await loadLan();
  const hosted = await hostFor(t);
  const lanHost = await hostFor(t, { attached: true });
  const proj = await createProject(lanHost, { mode: 'free' });
  const lan = await lanHostFor(t, { projects: [{ projectId: proj.projectId, name: proj.name, mode: 'free' }], docservicePort: lanHost.port, assetPort: lanHost.port });
  const before = hosted.service.describe().conns.length;
  const found = await discoverLan({ name: proj.name, port: lan.port(), interfaces: [LOOP_IFACE], targets: ['127.0.0.1'], timeoutMs: 3000 });
  assert.equal(found.length, 1);
  assert.equal(found[0].docservice, `ws://127.0.0.1:${lanHost.port}/docservice`);
  const c = await join(lanHost, proj, { username: 'bob', remote: '192.168.1.70' });
  await waitFor(() => lanHost.principals().some((p) => p?.username === 'bob'), 2000, 'bob joins the LAN host');
  assert.equal(hosted.service.describe().conns.length, before, 'hosted side connection count unchanged');
  c.close();
});
