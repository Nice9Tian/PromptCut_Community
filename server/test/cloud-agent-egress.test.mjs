/**
 * 云端 Agent 的出网闸与按「项目 × 对话」隔离的工作区(`server/agent/service/egress.mjs`、`workspace.mjs`)。
 * 任务书 `docs/plan/cloud-agent-task.md` J;契约 `docs/plan/cloud-agent-contract.md` 第 9.5、9.6 节。
 * 跑:node scripts/test-suite.mjs server/test/cloud-agent-egress.test.mjs
 *
 *   CA-EGRESS-01  地址黑名单:回环、链路本地(含 169.254.169.254)、私有网段、运营商级 NAT、保留与组播段、本机网卡地址,
 *                 以及 IPv6 的对应范围与各种把 IPv4 包进去的写法,全拒;公网地址放行
 *   CA-EGRESS-02  地址的各种写法:十进制、十六进制、八进制、缺段的 IPv4,带方括号的 IPv6,结尾带点的主机名——规范化后照样被拒;
 *                 非 http(s)、带用户名口令、不在清单里的端口被拒
 *   CA-EGRESS-03  主机名解析:解析结果里有一个内网地址就整个拒(混合记录);解析不了的拒
 *   CA-EGRESS-04  按解析结果连接,不二次解析(防 DNS 重绑定):解析函数第一次回放行的地址、之后回内网地址,请求只连第一次核过的那个,
 *                 解析函数在一跳里只被调一次
 *   CA-EGRESS-05  重定向每一跳重查:放行的地址 302 到回环、到内网、到 file:,都被拒,而且根本没有连过去;跳数有上限;
 *                 跨源的跳不带鉴权头
 *   CA-EGRESS-06  响应体上限:声明长度超了不读,边读边超了当场断;时限到了报超时
 *   CA-EGRESS-07  测试例外只认点了名的「IP:端口」:同一地址别的端口照拒;没给例外时一条都不放
 *   CA-EGRESS-08  给子进程的正向代理:CONNECT 与明文 HTTP 的目标都过同一道闸,回环与内网 403,例外放行的能通
 *   CA-WORK-01    路径字面检查:绝对路径、盘符、UNC、设备路径、`..`、NUL、保留设备名、备用数据流、结尾的点与空格,全拒
 *   CA-WORK-02    两个对话、两个项目的工作目录互不可见:各自写的文件对方读不到,路径里拼对方的目录名也出不去
 *   CA-WORK-03    符号链接(junction)指到工作目录外面:经它读、写都被拒,外面的文件没被动
 *   CA-WORK-04    总量上限:单个文件、对话、项目、文件个数,超了拒写;逐块写超了当场删掉半个文件
 *   CA-WORK-05    子进程:工作目录是对话目录;环境变量按白名单重建,`PROMPTCUT_*`、代理与任意别的变量都不带;临时目录在对话目录里
 *   CA-WORK-06    对话删除、项目删除后目录没了,别的项目的还在
 *
 * 全部不出网:目标都是本测试在 127.0.0.1 上起的服务,经测试例外放行;假凭证只用占位字符串。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createEgressGate, embeddedV4, parseTestAllow, EgressError } from '../agent/service/egress.mjs';
import { createWorkspaces, splitRelative, childEnv, isInside, WorkspaceError } from '../agent/service/workspace.mjs';

const FAKE = 'FAKE-CREDENTIAL-DO-NOT-USE';

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}

const refusedWith = async (p, code) => {
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof EgressError, `要是 EgressError,实际 ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, code);
    return true;
  });
};

test('CA-EGRESS-01 地址黑名单', () => {
  const gate = createEgressGate({ localAddresses: () => ['203.0.113.77', '8.8.4.4', '2606:4700::99'] });
  const blocked = [
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '192.0.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe',
    '64:ff9b::7f00:1', '2002:7f00:1::1', '2001::1', '::127.0.0.1',
    // 本机网卡地址(这里给的是公网段的假地址:就算网卡上是公网地址,也不许连回自己)
    '8.8.4.4', '2606:4700::99',
  ];
  for (const ip of blocked) assert.equal(gate.addressRefusal(ip), 'blocked-address', `${ip} 应当被拒`);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111']) {
    assert.equal(gate.addressRefusal(ip), null, `${ip} 应当放行`);
  }
  assert.equal(embeddedV4('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(embeddedV4('::ffff:192.168.0.1'), '192.168.0.1');
  assert.equal(embeddedV4('2606:4700::1'), null);
});

test('CA-EGRESS-02 地址的各种写法、协议、口令、端口', async () => {
  const gate = createEgressGate({ resolve: async () => [{ address: '93.184.216.34', family: 4 }], localAddresses: () => [] });
  for (const u of [
    'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0x7f.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/', 'http://169.254.169.254/latest/meta-data/', 'http://[fd00::1]/', 'http://0/', 'https://10.1.2.3/',
  ]) await refusedWith(gate.admitUrl(u), 'blocked-address');
  for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/', 'data:text/plain,hi', 'javascript:alert(1)', 'ws://example.com/', 'not a url']) {
    await refusedWith(gate.admitUrl(u), 'protocol');
  }
  await refusedWith(gate.admitUrl('http://user:pw@example.com/'), 'credentials');
  for (const u of ['http://example.com:22/', 'http://example.com:8787/', 'http://example.com:6379/', 'https://example.com:5432/']) await refusedWith(gate.admitUrl(u), 'port');
  const ok = await gate.admitUrl('https://example.com./path?q=1');
  assert.equal(ok.target.address, '93.184.216.34');
  assert.equal(ok.target.port, 443);
  assert.equal(ok.target.hostname, 'example.com');
});

test('CA-EGRESS-03 主机名解析:混合记录整个拒,解析不了的拒', async () => {
  const mixed = createEgressGate({ resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }], localAddresses: () => [] });
  await refusedWith(mixed.admitUrl('http://mixed.example/'), 'blocked-address');
  const v6 = createEgressGate({ resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }], localAddresses: () => [] });
  await refusedWith(v6.admitUrl('http://mixed6.example/'), 'blocked-address');
  const none = createEgressGate({ resolve: async () => { throw new Error('ENOTFOUND'); } });
  await refusedWith(none.admitUrl('http://nowhere.example/'), 'unresolved');
  const junk = createEgressGate({ resolve: async () => [{ address: 'not-an-ip', family: 4 }] });
  await refusedWith(junk.admitUrl('http://junk.example/'), 'unresolved');
});

test('CA-EGRESS-04 按解析结果连接,不二次解析', async (t) => {
  let hits = 0;
  const good = await listen((req, res) => { hits += 1; res.end(`ok ${req.headers.host}`); });
  t.after(() => good.close());
  let internalHits = 0;
  const internal = await listen((_req, res) => { internalHits += 1; res.end(FAKE); });
  t.after(() => internal.close());
  // 「测试专用外部地址」:127.0.0.1:<good 端口> 经例外放行;internal 的端口不在例外里
  let calls = 0;
  const gate = createEgressGate({
    testAllow: [`127.0.0.1:${good.port}`],
    // 第一次回放行的那个;之后(重绑定)回一个内网地址
    resolve: async () => { calls += 1; return calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.9', family: 4 }]; },
  });
  const r = await gate.request(`http://rebind.example:${good.port}/a`);
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), `ok rebind.example:${good.port}`);
  assert.equal(calls, 1, '一跳里只解析一次');
  assert.equal(hits, 1);
  // 第二次请求重新解析,这回是内网地址:拒,且没有连接发出去
  await refusedWith(gate.request(`http://rebind.example:${good.port}/b`), 'port');
  assert.equal(hits, 1);
  assert.equal(internalHits, 0);
});

test('CA-EGRESS-05 重定向每一跳重查', async (t) => {
  let secretHits = 0;
  const secret = await listen((_req, res) => { secretHits += 1; res.end(FAKE); });
  t.after(() => secret.close());
  const seen = [];
  const hop = await listen((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? null });
    const to = new URL(req.url, 'http://x').searchParams.get('to');
    if (req.url.startsWith('/loop')) { res.writeHead(302, { location: `/loop?n=${Date.now()}` }); return res.end(); }
    if (to) { res.writeHead(302, { location: to }); return res.end(); }
    res.end('landed');
  });
  t.after(() => hop.close());
  const other = await listen((req, res) => { seen.push({ other: true, auth: req.headers.authorization ?? null }); res.end('other'); });
  t.after(() => other.close());
  const gate = createEgressGate({ testAllow: [`127.0.0.1:${hop.port}`, `127.0.0.1:${other.port}`], maxRedirects: 3 });
  const base = `http://127.0.0.1:${hop.port}`;
  // 跳到同机别的端口(没点名):拒,没连过去
  await refusedWith(gate.request(`${base}/?to=${encodeURIComponent(`http://127.0.0.1:${secret.port}/`)}`), 'port');
  await refusedWith(gate.request(`${base}/?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`), 'blocked-address');
  await refusedWith(gate.request(`${base}/?to=${encodeURIComponent('http://[::1]/')}`), 'blocked-address');
  await refusedWith(gate.request(`${base}/?to=${encodeURIComponent('http://10.0.0.1/')}`), 'blocked-address');
  await refusedWith(gate.request(`${base}/?to=${encodeURIComponent('file:///etc/passwd')}`), 'protocol');
  assert.equal(secretHits, 0, '被拒的那一跳根本没有连过去');
  await refusedWith(gate.request(`${base}/loop`), 'redirects');
  // 同源的跳带着鉴权头,跨源的不带
  seen.length = 0;
  const same = await gate.request(`${base}/?to=${encodeURIComponent('/landed')}`, { headers: { authorization: `Bearer ${FAKE}` } });
  assert.equal(same.body.toString(), 'landed');
  assert.equal(same.hops, 1);
  assert.deepEqual(seen.map((s) => s.auth), [`Bearer ${FAKE}`, `Bearer ${FAKE}`]);
  seen.length = 0;
  const cross = await gate.request(`${base}/?to=${encodeURIComponent(`http://127.0.0.1:${other.port}/`)}`, { headers: { authorization: `Bearer ${FAKE}`, cookie: `k=${FAKE}` } });
  assert.equal(cross.body.toString(), 'other');
  assert.deepEqual(seen.find((s) => s.other), { other: true, auth: null });
});

test('CA-EGRESS-06 响应体上限与时限', async (t) => {
  const srv = await listen((req, res) => {
    if (req.url === '/declared') { res.writeHead(200, { 'content-length': '5000' }); return res.end(Buffer.alloc(5000, 1)); }
    if (req.url === '/stream') { res.writeHead(200); const iv = setInterval(() => res.write(Buffer.alloc(1024, 2)), 2); res.on('close', () => clearInterval(iv)); return; }
    if (req.url === '/slow') return; // 不回
    res.end('small');
  });
  t.after(() => srv.close());
  const gate = createEgressGate({ testAllow: [`127.0.0.1:${srv.port}`], maxBytes: 4096 });
  const base = `http://127.0.0.1:${srv.port}`;
  await refusedWith(gate.request(`${base}/declared`), 'too-large');
  await refusedWith(gate.request(`${base}/stream`), 'too-large');
  await refusedWith(gate.request(`${base}/slow`, { timeoutMs: 150 }), 'timeout');
  // 这次请求自己给的上限不能超过闸的上限
  await refusedWith(gate.request(`${base}/declared`, { maxBytes: 1024 * 1024 }), 'too-large');
  const chunks = [];
  const r = await gate.request(`${base}/ok`, { onChunk: (c) => { chunks.push(c); } });
  assert.equal(r.body, null);
  assert.equal(Buffer.concat(chunks).toString(), 'small');
  assert.equal(r.bytes, 5);
});

test('CA-EGRESS-07 测试例外只认点了名的「IP:端口」', async (t) => {
  const a = await listen((_req, res) => res.end('a'));
  const b = await listen((_req, res) => res.end(FAKE));
  t.after(() => a.close());
  t.after(() => b.close());
  const none = createEgressGate();
  assert.equal(none.testAllowActive, false);
  await refusedWith(none.request(`http://127.0.0.1:${a.port}/`), 'port');
  await refusedWith(none.request('http://127.0.0.1/'), 'blocked-address');
  await refusedWith(none.request('http://localhost/'), 'blocked-address');
  const logs = [];
  const gate = createEgressGate({ testAllow: [`127.0.0.1:${a.port}`], log: (event, fields) => logs.push({ event, ...fields }) });
  assert.equal(gate.testAllowActive, true);
  assert.ok(logs.some((l) => l.event === 'agent.egress.test-allow'), '开了例外要在日志里留一行');
  assert.equal((await gate.request(`http://127.0.0.1:${a.port}/`)).body.toString(), 'a');
  await refusedWith(gate.request(`http://127.0.0.1:${b.port}/`), 'port');
  await refusedWith(gate.request('http://127.0.0.1/'), 'blocked-address');
  assert.deepEqual(parseTestAllow(`127.0.0.1:${a.port}, [::1]:8080, example.com:80, junk`), [`127.0.0.1:${a.port}`, '::1:8080']);
  assert.deepEqual(parseTestAllow(undefined), []);
});

test('CA-EGRESS-08 给子进程的正向代理过同一道闸', async (t) => {
  const pub = await listen((req, res) => res.end(`pub ${req.url}`));
  const secret = await listen((_req, res) => res.end(FAKE));
  t.after(() => pub.close());
  t.after(() => secret.close());
  const gate = createEgressGate({ testAllow: [`127.0.0.1:${pub.port}`] });
  const proxy = await gate.startProxy();
  t.after(() => proxy.close());
  const viaProxy = (target) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, path: target, method: 'GET', headers: { host: new URL(target).host }, agent: false });
    req.once('response', (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, refused: res.headers['x-egress-refused'] ?? null, body: Buffer.concat(c).toString() })); });
    req.once('error', reject);
    req.end();
  });
  const ok = await viaProxy(`http://127.0.0.1:${pub.port}/hello`);
  assert.deepEqual({ status: ok.status, body: ok.body }, { status: 200, body: 'pub /hello' });
  for (const [target, code] of [
    [`http://127.0.0.1:${secret.port}/`, 'port'], ['http://169.254.169.254/latest/', 'blocked-address'], ['http://10.0.0.1/', 'blocked-address'], ['http://[::1]/', 'blocked-address'],
  ]) {
    const r = await viaProxy(target);
    assert.equal(r.status, 403, target);
    assert.equal(r.refused, code, target);
    assert.ok(!r.body.includes(FAKE));
  }
  const connect = (hostPort) => new Promise((resolve, reject) => {
    const s = net.connect(proxy.port, '127.0.0.1', () => s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      if (!buf.includes('\r\n\r\n')) return;
      const status = Number(buf.split(' ')[1]);
      if (status !== 200) { s.destroy(); return resolve({ status, body: '' }); }
      if (buf.endsWith('\r\n\r\n') && !buf.includes('pub')) s.write(`GET /tunnel HTTP/1.1\r\nHost: ${hostPort}\r\nConnection: close\r\n\r\n`);
    });
    s.on('close', () => resolve({ status: Number(buf.split(' ')[1]), body: buf }));
    s.on('error', reject);
  });
  const tunnel = await connect(`127.0.0.1:${pub.port}`);
  assert.equal(tunnel.status, 200);
  assert.ok(tunnel.body.includes('pub /tunnel'));
  assert.equal((await connect(`127.0.0.1:${secret.port}`)).status, 403);
  assert.equal((await connect('169.254.169.254:80')).status, 403);
  assert.equal((await connect('[::1]:443')).status, 403);
  assert.equal((await connect('localhost:443')).status, 403);
});

/* ---------------- 工作区 ---------------- */

const tmpRoot = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-work-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 留给系统清 */ } });
  return dir;
};
const OWNER_A = 'a'.repeat(32);
const OWNER_B = 'b'.repeat(32);
const bad = (fn, code) => assert.throws(fn, (err) => { assert.ok(err instanceof WorkspaceError, String(err)); if (code) assert.equal(err.code, code); return true; });

test('CA-WORK-01 路径字面检查', () => {
  for (const p of [
    '', '/etc/passwd', '\\Windows\\win.ini', 'C:\\Windows\\win.ini', 'C:/Windows/win.ini', 'c:secret.txt', '\\\\server\\share\\x', '//server/share/x',
    '\\\\?\\C:\\x', '\\\\.\\pipe\\x', '../x', 'a/../../x', 'a\\..\\..\\x', '..', 'a/..', 'x\0y', 'nul', 'NUL.txt', 'con', 'a/COM1', 'a/lpt9.log',
    'file.txt:stream', 'a/b:$DATA', 'trailing.', 'trailing ', 'a/dir./x', '.', './', 'a'.repeat(1025),
  ]) bad(() => splitRelative(p), 'bad-path');
  assert.deepEqual(splitRelative('a/b\\c.txt'), ['a', 'b', 'c.txt']);
  assert.deepEqual(splitRelative('./a//b'), ['a', 'b']);
  assert.deepEqual(splitRelative('..hidden/x..y'), ['..hidden', 'x..y']);
  assert.equal(isInside(path.resolve('/a/b'), path.resolve('/a/b/c')), true);
  assert.equal(isInside(path.resolve('/a/b'), path.resolve('/a/bc')), false);
  assert.equal(isInside(path.resolve('/a/b'), path.resolve('/a')), false);
});

test('CA-WORK-02 两个对话、两个项目的工作目录互不可见', (t) => {
  const ws = createWorkspaces({ dataDir: tmpRoot(t) });
  const p1c1 = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c1' });
  const p1c2 = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c2' });
  const p2c1 = ws.open({ projectId: 'proj-2', ownerKey: OWNER_B, conversationId: 'c1' });
  p1c1.write('note.txt', `one-${FAKE}`);
  p2c1.write('note.txt', 'two');
  assert.equal(p1c1.read('note.txt').toString(), `one-${FAKE}`);
  assert.equal(p2c1.read('note.txt').toString(), 'two');
  bad(() => p1c2.read('note.txt'), 'not-found');
  // 拼对方的目录名也出不去
  for (const p of [`../c1/note.txt`, `../../${OWNER_A}/c1/note.txt`, `../../../proj-1/${OWNER_A}/c1/note.txt`, path.join(p1c1.dir(), 'note.txt')]) {
    bad(() => p2c1.read(p), 'bad-path');
    bad(() => p1c2.read(p), 'bad-path');
    bad(() => p2c1.write(p, 'x'), 'bad-path');
  }
  assert.deepEqual(p1c1.list(), [{ path: 'note.txt', size: `one-${FAKE}`.length }]);
  assert.deepEqual(p1c2.list(), []);
  // 身份不合法的开不出工作区(项目、主人键、对话 id 都只来自服务端,这里验形状)
  bad(() => ws.open({ projectId: '../x', ownerKey: OWNER_A, conversationId: 'c1' }), 'bad-path');
  bad(() => ws.open({ projectId: 'proj-1', ownerKey: '../../x', conversationId: 'c1' }), 'bad-path');
  bad(() => ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: '../c2' }), 'bad-path');
  // 项目 id 里的冒号折成下划线,目录仍在 work/ 之下
  const colon = ws.open({ projectId: 'p:1', ownerKey: OWNER_A, conversationId: 'c1' });
  assert.ok(isInside(ws.root, colon.dir()));
});

test('CA-WORK-03 链接指到工作目录外面:经它读写都被拒', (t) => {
  const root = tmpRoot(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), FAKE);
  const ws = createWorkspaces({ dataDir: path.join(root, 'data') });
  const w = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c1' });
  const link = path.join(w.dir(), 'escape');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch (err) {
    t.skip(`这台机器建不了链接:${err?.code ?? err}`);
    return;
  }
  bad(() => w.read('escape/secret.txt'), 'outside');
  bad(() => w.write('escape/new.txt', 'x'), 'outside');
  bad(() => w.write('escape/sub/new.txt', 'x'), 'outside');
  bad(() => w.writer('escape/stream.bin'), 'outside');
  bad(() => w.exists('escape/secret.txt'), 'outside');
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  assert.equal(fs.existsSync(path.join(outside, 'sub')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), FAKE);
  // 列目录不跟链接,体积不把外面的算进来
  assert.ok(!w.list().some((f) => f.path.includes('secret')));
  assert.equal(w.usage().bytes, 0);
});

test('CA-WORK-04 总量上限', (t) => {
  const ws = createWorkspaces({ dataDir: tmpRoot(t), limits: { maxFileBytes: 100, maxConversationBytes: 250, maxProjectBytes: 400, maxFiles: 6 } });
  const a = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c1' });
  const b = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c2' });
  bad(() => a.write('big.bin', Buffer.alloc(101)), 'too-large');
  a.write('1.bin', Buffer.alloc(100));
  a.write('2.bin', Buffer.alloc(100));
  bad(() => a.write('3.bin', Buffer.alloc(100)), 'quota');
  b.write('1.bin', Buffer.alloc(100));
  b.write('2.bin', Buffer.alloc(100));
  // 项目级:两个对话加起来 400,再写一个字节也不行
  bad(() => b.write('3.bin', Buffer.alloc(1)), 'quota');
  assert.equal(ws.projectUsage('proj-1').bytes, 400);
  // 逐块写:超了当场删掉半个文件
  const other = ws.open({ projectId: 'proj-2', ownerKey: OWNER_B, conversationId: 'c1' });
  const wr = other.writer('dl.bin');
  wr.write(Buffer.alloc(60));
  bad(() => wr.write(Buffer.alloc(60)), 'quota');
  assert.equal(other.exists('dl.bin'), false);
  const fine = other.writer('ok.bin');
  fine.write(Buffer.alloc(40));
  assert.deepEqual(fine.end(), { path: 'ok.bin', size: 40 });
  // 文件个数
  for (let i = 0; i < 5; i += 1) other.write(`n${i}.txt`, 'x');
  bad(() => other.write('n9.txt', 'x'), 'quota');
});

test('CA-WORK-05 子进程:工作目录与环境变量收紧', async (t) => {
  const ws = createWorkspaces({ dataDir: tmpRoot(t) });
  const w = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c1' });
  const before = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; });
  Object.assign(process.env, {
    PROMPTCUT_AGENT_SECRETS: `/secrets/${FAKE}`, PROMPTCUT_AGENT_DATA: `/data/${FAKE}`, PROMPTCUT_AGENT_DOC_URL: 'ws://127.0.0.1:8787',
    OPENAI_API_KEY: FAKE, ANTHROPIC_API_KEY: FAKE, AWS_SECRET_ACCESS_KEY: FAKE, HTTPS_PROXY: 'http://127.0.0.1:1', SOME_RANDOM_VAR: FAKE,
  });
  const env = childEnv(w.dir(), { MY_TOOL_OPTION: 'yes', PROMPTCUT_SNEAK: FAKE });
  assert.ok(!JSON.stringify(env).includes(FAKE), '白名单之外的变量一个都不带');
  assert.equal(env.MY_TOOL_OPTION, 'yes');
  assert.equal(env.PROMPTCUT_SNEAK, undefined);
  assert.ok(isInside(w.dir(), env.TEMP) && isInside(w.dir(), env.TMPDIR));
  // 真起一个子进程核对
  const child = w.spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: process.env }))']);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0);
  const seen = JSON.parse(out);
  assert.equal(fs.realpathSync.native(seen.cwd), fs.realpathSync.native(w.dir()));
  assert.ok(!out.includes(FAKE), '子进程看不到服务进程里的任何假凭证');
  assert.ok(!Object.keys(seen.env).some((k) => /^PROMPTCUT_/i.test(k)));
  assert.equal(seen.env.HTTPS_PROXY, undefined);
});

test('CA-WORK-06 对话删除、项目删除后目录没了', (t) => {
  const ws = createWorkspaces({ dataDir: tmpRoot(t) });
  const a = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c1' });
  const b = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c2' });
  const c = ws.open({ projectId: 'proj-2', ownerKey: OWNER_B, conversationId: 'c1' });
  a.write('x.txt', 'a'); b.write('x.txt', 'b'); c.write('x.txt', 'c');
  const dirA = a.dir();
  a.destroy();
  assert.equal(fs.existsSync(dirA), false);
  assert.equal(b.read('x.txt').toString(), 'b');
  ws.removeProject('proj-1');
  assert.equal(fs.existsSync(path.join(ws.root, 'proj-1')), false);
  assert.equal(c.read('x.txt').toString(), 'c');
  // 没有数据目录的进程(只给不碰文件的测试):工作区不可用,开不出来
  const none = createWorkspaces({ dataDir: null });
  assert.equal(none.available, false);
  bad(() => none.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c1' }), 'not-found');
});
