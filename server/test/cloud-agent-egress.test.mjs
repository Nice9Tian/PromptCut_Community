/**
 * Cloud Agent egress gate and workspace isolated by "project × chat"
 * (`server/agent/service/egress.mjs`, `workspace.mjs`).
 * Task brief `docs/plan/cloud-agent-task.md` J; contract `docs/plan/cloud-agent-contract.md`
 * Sections 9.5 and 9.6.
 * Run: node scripts/test-suite.mjs server/test/cloud-agent-egress.test.mjs
 *
 *   CA-EGRESS-01  Address blacklist: loopback, link-local (including 169.254.169.254), private
 *                 subnets, carrier-grade NAT, reserved and multicast ranges, local network
 *                 interface addresses, and corresponding IPv6 ranges and various formats embedding
 *                 IPv4, all rejected; public addresses allowed
 *   CA-EGRESS-02  Various address formats: decimal, hexadecimal, octal, omitted-segment IPv4,
 *                 bracketed IPv6, hostnames ending with a dot: still rejected after normalization;
 *                 non-http(s), with username/passphrase, ports not on manifest rejected
 *   CA-EGRESS-03  Hostname resolution: if resolution results contain any intranet address, reject
 *                 entirely (mixed records); unresolvable rejected
 *   CA-EGRESS-04  Connect using resolution results, no secondary resolution (prevents DNS
 *                 rebinding): resolver returns allowed address first time, returns intranet address
 *                 afterward, request connects only to the one verified the first time, resolver is
 *                 called only once per hop
 *   CA-EGRESS-05  Recheck each redirect hop: allowed addresses that 302 to loopback, intranet, or
 *                 file: are all rejected and never connected to; hop count has an upper limit;
 *                 cross-origin hops do not carry authorization headers
 *   CA-EGRESS-06  Response body limit: does not read if declared length exceeds limit, aborts
 *                 immediately if exceeded while reading; reports timeout when time limit is reached
 *   CA-EGRESS-07  Test exceptions only recognize explicitly named "IP:port": other ports on the same
 *                 address are still rejected; allows nothing when no exception is given
 *   CA-EGRESS-08  Forward proxy for child processes: CONNECT and plaintext HTTP targets both pass
 *                 through the same gate, loopback and intranet return 403, allowed exceptions can
 *                 connect
 *   CA-WORK-01    Path literal checks: absolute paths, drive letters, UNC, device paths, `..`, NUL,
 *                 reserved device names, alternate data streams, trailing dots and spaces, all
 *                 rejected
 *   CA-WORK-02    Working directories of two chats and two projects are mutually invisible: files
 *                 written by each cannot be read by the other, concatenating the other's directory
 *                 name in paths cannot escape
 *   CA-WORK-03    Symbolic link (junction) pointing outside working directory: reading and writing
 *                 through it are both rejected, outside files are not touched
 *   CA-WORK-04    Total limits: single file, chat, project, file count, writing is rejected when
 *                 exceeded; writing chunk by chunk deletes partial file immediately when exceeded
 *   CA-WORK-05    Child process: working directory is the chat directory; environment variables
 *                 rebuilt from whitelist, omitting `PROMPTCUT_*`, proxy, and any other variables;
 *                 temporary directory is inside chat directory
 *   CA-WORK-06    Directory is removed after chat deletion and project deletion, while other projects
 *                 remain
 *
 * Completely no network egress: all targets are services started by this test on 127.0.0.1, allowed
 * via test exceptions; fake credentials use placeholder strings only.
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
    assert.ok(err instanceof EgressError, `Expected EgressError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, code);
    return true;
  });
};

test('CA-EGRESS-01 address blocklist', () => {
  const gate = createEgressGate({ localAddresses: () => ['203.0.113.77', '8.8.4.4', '2606:4700::99'] });
  const blocked = [
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '192.0.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe',
    '64:ff9b::7f00:1', '2002:7f00:1::1', '2001::1', '::127.0.0.1',
    // Local network interface address (fake public IP given here: even if the interface has a public
    // IP, connecting back to self is disallowed)
    '8.8.4.4', '2606:4700::99',
  ];
  for (const ip of blocked) assert.equal(gate.addressRefusal(ip), 'blocked-address', `${ip} should be rejected`);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111']) {
    assert.equal(gate.addressRefusal(ip), null, `${ip} should be allowed`);
  }
  assert.equal(embeddedV4('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(embeddedV4('::ffff:192.168.0.1'), '192.168.0.1');
  assert.equal(embeddedV4('2606:4700::1'), null);
});

test('CA-EGRESS-02 the various address notations, protocols, embedded credentials, ports', async () => {
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

test('CA-EGRESS-03 hostname resolution: mixed records are rejected as a whole, unresolvable ones are rejected', async () => {
  const mixed = createEgressGate({ resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }], localAddresses: () => [] });
  await refusedWith(mixed.admitUrl('http://mixed.example/'), 'blocked-address');
  const v6 = createEgressGate({ resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }], localAddresses: () => [] });
  await refusedWith(v6.admitUrl('http://mixed6.example/'), 'blocked-address');
  const none = createEgressGate({ resolve: async () => { throw new Error('ENOTFOUND'); } });
  await refusedWith(none.admitUrl('http://nowhere.example/'), 'unresolved');
  const junk = createEgressGate({ resolve: async () => [{ address: 'not-an-ip', family: 4 }] });
  await refusedWith(junk.admitUrl('http://junk.example/'), 'unresolved');
});

test('CA-EGRESS-04 connect by the resolved result, no second resolution', async (t) => {
  let hits = 0;
  const good = await listen((req, res) => { hits += 1; res.end(`ok ${req.headers.host}`); });
  t.after(() => good.close());
  let internalHits = 0;
  const internal = await listen((_req, res) => { internalHits += 1; res.end(FAKE); });
  t.after(() => internal.close());
  // "Test-only external address": 127.0.0.1:<good port> is allowed via exception; internal port is
  // not in exception
  let calls = 0;
  const gate = createEgressGate({
    testAllow: [`127.0.0.1:${good.port}`],
    // Returns the allowed one the first time; returns an intranet address afterward (rebinding)
    resolve: async () => { calls += 1; return calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.9', family: 4 }]; },
  });
  const r = await gate.request(`http://rebind.example:${good.port}/a`);
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), `ok rebind.example:${good.port}`);
  assert.equal(calls, 1, 'Only one resolution per hop');
  assert.equal(hits, 1);
  // Second request re-resolves, this time an intranet address: rejected, and no connection was sent
  await refusedWith(gate.request(`http://rebind.example:${good.port}/b`), 'port');
  assert.equal(hits, 1);
  assert.equal(internalHits, 0);
});

test('CA-EGRESS-05 every redirect hop is re-checked', async (t) => {
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
  // Jump to another port on the same machine (not named): rejected, did not connect
  await refusedWith(gate.request(`${base}/?to=${encodeURIComponent(`http://127.0.0.1:${secret.port}/`)}`), 'port');
  await refusedWith(gate.request(`${base}/?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`), 'blocked-address');
  await refusedWith(gate.request(`${base}/?to=${encodeURIComponent('http://[::1]/')}`), 'blocked-address');
  await refusedWith(gate.request(`${base}/?to=${encodeURIComponent('http://10.0.0.1/')}`), 'blocked-address');
  await refusedWith(gate.request(`${base}/?to=${encodeURIComponent('file:///etc/passwd')}`), 'protocol');
  assert.equal(secretHits, 0, 'The rejected hop was never connected to at all');
  await refusedWith(gate.request(`${base}/loop`), 'redirects');
  // Same-origin hops carry authorization headers, cross-origin ones do not
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

test('CA-EGRESS-06 response body limit and time limit', async (t) => {
  const srv = await listen((req, res) => {
    if (req.url === '/declared') { res.writeHead(200, { 'content-length': '5000' }); return res.end(Buffer.alloc(5000, 1)); }
    if (req.url === '/stream') { res.writeHead(200); const iv = setInterval(() => res.write(Buffer.alloc(1024, 2)), 2); res.on('close', () => clearInterval(iv)); return; }
    if (req.url === '/slow') return; // Does not respond
    res.end('small');
  });
  t.after(() => srv.close());
  const gate = createEgressGate({ testAllow: [`127.0.0.1:${srv.port}`], maxBytes: 4096 });
  const base = `http://127.0.0.1:${srv.port}`;
  await refusedWith(gate.request(`${base}/declared`), 'too-large');
  await refusedWith(gate.request(`${base}/stream`), 'too-large');
  await refusedWith(gate.request(`${base}/slow`, { timeoutMs: 150 }), 'timeout');
  // The limit provided by this request cannot exceed the gate's limit
  await refusedWith(gate.request(`${base}/declared`, { maxBytes: 1024 * 1024 }), 'too-large');
  const chunks = [];
  const r = await gate.request(`${base}/ok`, { onChunk: (c) => { chunks.push(c); } });
  assert.equal(r.body, null);
  assert.equal(Buffer.concat(chunks).toString(), 'small');
  assert.equal(r.bytes, 5);
});

test('CA-EGRESS-07 the test exception only recognizes the named "IP:port"', async (t) => {
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
  assert.ok(logs.some((l) => l.event === 'agent.egress.test-allow'), 'Enabling the exception must leave a line in the log');
  assert.equal((await gate.request(`http://127.0.0.1:${a.port}/`)).body.toString(), 'a');
  await refusedWith(gate.request(`http://127.0.0.1:${b.port}/`), 'port');
  await refusedWith(gate.request('http://127.0.0.1/'), 'blocked-address');
  assert.deepEqual(parseTestAllow(`127.0.0.1:${a.port}, [::1]:8080, example.com:80, junk`), [`127.0.0.1:${a.port}`, '::1:8080']);
  assert.deepEqual(parseTestAllow(undefined), []);
});

test('CA-EGRESS-08 the forward proxy given to the subprocess goes through the same gate', async (t) => {
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

/* ---------------- Workspace ---------------- */

const tmpRoot = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-work-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Left for the system to clean */ } });
  return dir;
};
const OWNER_A = 'a'.repeat(32);
const OWNER_B = 'b'.repeat(32);
const bad = (fn, code) => assert.throws(fn, (err) => { assert.ok(err instanceof WorkspaceError, String(err)); if (code) assert.equal(err.code, code); return true; });

test('CA-WORK-01 literal path check', () => {
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

test('CA-WORK-02 the working directories of two chats and two projects are invisible to each other', (t) => {
  const ws = createWorkspaces({ dataDir: tmpRoot(t) });
  const p1c1 = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c1' });
  const p1c2 = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c2' });
  const p2c1 = ws.open({ projectId: 'proj-2', ownerKey: OWNER_B, conversationId: 'c1' });
  p1c1.write('note.txt', `one-${FAKE}`);
  p2c1.write('note.txt', 'two');
  assert.equal(p1c1.read('note.txt').toString(), `one-${FAKE}`);
  assert.equal(p2c1.read('note.txt').toString(), 'two');
  bad(() => p1c2.read('note.txt'), 'not-found');
  // Concatenating the other's directory name also cannot escape
  for (const p of [`../c1/note.txt`, `../../${OWNER_A}/c1/note.txt`, `../../../proj-1/${OWNER_A}/c1/note.txt`, path.join(p1c1.dir(), 'note.txt')]) {
    bad(() => p2c1.read(p), 'bad-path');
    bad(() => p1c2.read(p), 'bad-path');
    bad(() => p2c1.write(p, 'x'), 'bad-path');
  }
  assert.deepEqual(p1c1.list(), [{ path: 'note.txt', size: `one-${FAKE}`.length }]);
  assert.deepEqual(p1c2.list(), []);
  // Invalid identity cannot create a workspace (project, owner key, chat id come only from server;
  // validates shape here)
  bad(() => ws.open({ projectId: '../x', ownerKey: OWNER_A, conversationId: 'c1' }), 'bad-path');
  bad(() => ws.open({ projectId: 'proj-1', ownerKey: '../../x', conversationId: 'c1' }), 'bad-path');
  bad(() => ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: '../c2' }), 'bad-path');
  // Colons in project id are folded into underscores, directory remains under work/
  const colon = ws.open({ projectId: 'p:1', ownerKey: OWNER_A, conversationId: 'c1' });
  assert.ok(isInside(ws.root, colon.dir()));
});

test('CA-WORK-03 a link pointing outside the working directory: reads and writes through it are rejected', (t) => {
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
    t.skip(`This machine cannot create links: ${err?.code ?? err}`);
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
  // Directory listing does not follow links, size does not count outside files
  assert.ok(!w.list().some((f) => f.path.includes('secret')));
  assert.equal(w.usage().bytes, 0);
});

test('CA-WORK-04 total size limit', (t) => {
  const ws = createWorkspaces({ dataDir: tmpRoot(t), limits: { maxFileBytes: 100, maxConversationBytes: 250, maxProjectBytes: 400, maxFiles: 6 } });
  const a = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c1' });
  const b = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c2' });
  bad(() => a.write('big.bin', Buffer.alloc(101)), 'too-large');
  a.write('1.bin', Buffer.alloc(100));
  a.write('2.bin', Buffer.alloc(100));
  bad(() => a.write('3.bin', Buffer.alloc(100)), 'quota');
  b.write('1.bin', Buffer.alloc(100));
  b.write('2.bin', Buffer.alloc(100));
  // Project level: two chats sum to 400, cannot write even one more byte
  bad(() => b.write('3.bin', Buffer.alloc(1)), 'quota');
  assert.equal(ws.projectUsage('proj-1').bytes, 400);
  // Writing chunk by chunk: deletes partial file immediately when exceeded
  const other = ws.open({ projectId: 'proj-2', ownerKey: OWNER_B, conversationId: 'c1' });
  const wr = other.writer('dl.bin');
  wr.write(Buffer.alloc(60));
  bad(() => wr.write(Buffer.alloc(60)), 'quota');
  assert.equal(other.exists('dl.bin'), false);
  const fine = other.writer('ok.bin');
  fine.write(Buffer.alloc(40));
  assert.deepEqual(fine.end(), { path: 'ok.bin', size: 40 });
  // File count
  for (let i = 0; i < 5; i += 1) other.write(`n${i}.txt`, 'x');
  bad(() => other.write('n9.txt', 'x'), 'quota');
});

test('CA-WORK-05 subprocess: working directory and environment variables locked down', async (t) => {
  const ws = createWorkspaces({ dataDir: tmpRoot(t) });
  const w = ws.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c1' });
  const before = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; });
  Object.assign(process.env, {
    PROMPTCUT_AGENT_SECRETS: `/secrets/${FAKE}`, PROMPTCUT_AGENT_DATA: `/data/${FAKE}`, PROMPTCUT_AGENT_DOC_URL: 'ws://127.0.0.1:8787',
    OPENAI_API_KEY: FAKE, ANTHROPIC_API_KEY: FAKE, AWS_SECRET_ACCESS_KEY: FAKE, HTTPS_PROXY: 'http://127.0.0.1:1', SOME_RANDOM_VAR: FAKE,
  });
  const env = childEnv(w.dir(), { MY_TOOL_OPTION: 'yes', PROMPTCUT_SNEAK: FAKE });
  assert.ok(!JSON.stringify(env).includes(FAKE), 'No variable outside the allowlist is carried');
  assert.equal(env.MY_TOOL_OPTION, 'yes');
  assert.equal(env.PROMPTCUT_SNEAK, undefined);
  assert.ok(isInside(w.dir(), env.TEMP) && isInside(w.dir(), env.TMPDIR));
  // Actually spawn a child process to verify
  const child = w.spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: process.env }))']);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0);
  const seen = JSON.parse(out);
  assert.equal(fs.realpathSync.native(seen.cwd), fs.realpathSync.native(w.dir()));
  assert.ok(!out.includes(FAKE), 'The subprocess cannot see any fake credentials in the service process');
  assert.ok(!Object.keys(seen.env).some((k) => /^PROMPTCUT_/i.test(k)));
  assert.equal(seen.env.HTTPS_PROXY, undefined);
});

test('CA-WORK-06 after a chat is deleted or a project is deleted, the directory is gone', (t) => {
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
  // Processes without a data directory (for tests that do not touch files): workspace unavailable,
  // cannot be created
  const none = createWorkspaces({ dataDir: null });
  assert.equal(none.available, false);
  bad(() => none.open({ projectId: 'proj-1', ownerKey: OWNER_A, conversationId: 'c1' }), 'not-found');
});
