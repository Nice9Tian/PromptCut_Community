/**
 * M8 探针公共件（`scripts/probes/m8/`）的纯逻辑与代理控制命令的用例。计划 `docs/plan/m8-plan.md` 第 4 节第 1～3 项。
 * 跑：node --test server/test/m8-kit.test.mjs
 *
 * 只用端口 0（系统给号），不连外网、不起编辑器与 Chrome。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  newRunId, deviceIdOf, fingerprintOf, FINGERPRINT_RE, placeParams, docTargetOf, hostPortOf, checkPorts, CLOUD,
  judgeAllDone, judgeExactlyOnce, judgePureLayers, layerObservations, parseTaskId, fakeLayerTasks, sha256Of, judgeIdenticalBytes,
  judgeEachWorked, summarizeTimeline, takeoverMs, createResult, mergeRoleResults, lastJsonLine, judgeLastCommit,
} from '../../scripts/probes/m8/lib.mjs';
import { kvKey, kvClient, roleKv, resolveRun } from '../../scripts/probes/m8/kv.mjs';
import { parseRemoteSample, diffSamples, remoteSampleScript } from '../../scripts/probes/m8/resources.mjs';
import { startProxy, fingerprintEnv, childEnv } from '../../scripts/probes/m8/procs.mjs';
import { startCoordServer } from '../../scripts/probes/probe-coord.mjs';

/* ------------------------------------------------------------------ 约定与部署参数 */

test('M8K-1 本轮 id、设备 id、测试指纹的格式', () => {
  const run = newRunId();
  assert.match(run, /^[a-z0-9]{10,16}$/);
  assert.match(deviceIdOf('host-a', run), /^[A-Za-z0-9_-]{16,64}$/);
  assert.match(deviceIdOf('x', 'y'), /^[A-Za-z0-9_-]{16,64}$/, '太短时补齐到 16');
  assert.match(fingerprintOf('seed'), FINGERPRINT_RE);
  assert.equal(fingerprintOf('seed'), fingerprintOf('seed'));
  assert.notEqual(fingerprintOf('a'), fingerprintOf('b'));
  assert.deepEqual(fingerprintEnv('0123456789abcdef'), { PROMPTCUT_TEST_ENV_FINGERPRINT: '0123456789abcdef' });
  assert.deepEqual(fingerprintEnv(null), {});
  assert.throws(() => fingerprintEnv('XYZ'), /16 位/);
});

test('M8K-2 放云端 / 放本机 / 本机替身的连接参数', () => {
  const c = placeParams('cloud');
  assert.equal(c.hosted, CLOUD.hosted);
  assert.equal(c.ws, 'wss://203-0-113-16.sslip.io/hosted');
  assert.equal(c.healthz, 'https://203-0-113-16.sslip.io/hosted/healthz');
  assert.equal(c.docPlain, CLOUD.docPlain, 'TLS 托管端的代理目标是明文 8787');
  assert.equal(c.coord, CLOUD.coord);
  const c2 = placeParams('cloud', { hosted: 'http://203.0.113.16:8787/', coord: 'http://x:1/' });
  assert.equal(c2.docPlain, '203.0.113.16:8787');
  assert.equal(c2.ws, 'ws://203.0.113.16:8787');
  assert.equal(c2.coord, 'http://x:1');

  const l = placeParams('lan', { lanHost: '192.168.50.96:5780', coord: 'http://192.168.50.96:5781' });
  assert.equal(l.ws, 'ws://192.168.50.96:5780/docservice');
  assert.equal(l.hosted, 'http://192.168.50.96:5780/docservice');
  assert.equal(l.healthz, 'http://192.168.50.96:5780/api/docservice/healthz');
  assert.equal(l.docPlain, '192.168.50.96:5780');
  assert.equal(l.cloudHealthz, `${CLOUD.hosted}/healthz`, '放本机要核「全程不连阿里云」');
  assert.equal(placeParams('lan', { lanHost: 'http://10.0.0.2:5780/', coord: 'c' }).ws, 'ws://10.0.0.2:5780/docservice');
  assert.throws(() => placeParams('lan', { coord: 'c' }), /lanHost/);
  assert.throws(() => placeParams('lan', { lanHost: '1.2.3.4:5' }), /coord/);

  const s = placeParams('local', { hosted: 'http://127.0.0.1:8797', coord: 'http://127.0.0.1:8799' });
  assert.equal(s.ws, 'ws://127.0.0.1:8797');
  assert.equal(s.docPlain, '127.0.0.1:8797');
  assert.throws(() => placeParams('local', {}), /hosted 与 coord/);
  assert.throws(() => placeParams('moon'), /cloud \/ lan \/ local/);
});

test('M8K-3 代理目标：明文基址可推，TLS 基址要显式给', () => {
  assert.deepEqual(docTargetOf('ws://127.0.0.1:8797'), { host: '127.0.0.1', port: 8797, text: '127.0.0.1:8797' });
  assert.equal(hostPortOf('http://h'), 'h:80');
  assert.equal(hostPortOf('wss://h/x'), null);
  assert.throws(() => docTargetOf('https://203-0-113-16.sslip.io/hosted'), /TLS/);
  assert.equal(docTargetOf('https://x/hosted', '203.0.113.16:8787').port, 8787);
  assert.throws(() => docTargetOf('ws://a:1', 'nonsense'), /host:port/);
});

test('M8K-4 端口护栏：禁区、分配的段、三连号重叠', () => {
  assert.deepEqual(checkPorts([5734], { band: [5730, 5739] }), [5734, 5735, 5736]);
  assert.deepEqual(checkPorts([0, 5733], { triple: false }), [5733]);
  assert.throws(() => checkPorts([5190]), /用户常驻/);
  assert.throws(() => checkPorts([5201]), /5203/, '三连号碰到 dev-test 的 5203');
  assert.throws(() => checkPorts([5738], { band: [5730, 5739] }), /不在分配的段/);
  assert.throws(() => checkPorts([5734, 5735]), /重叠/);
});

/* ------------------------------------------------------------------ 判据 */

test('M8K-5 J-全完', () => {
  assert.equal(judgeAllDone(['a', 'b'], { a: 'done', b: 'done' }).ok, true);
  const r = judgeAllDone(['a', 'b', 'c'], new Map([['a', 'done'], ['b', 'failed']]));
  assert.equal(r.ok, false);
  assert.deepEqual(r.notDone, [{ id: 'b', state: 'failed' }, { id: 'c', state: null }]);
  assert.equal(judgeAllDone([], {}).ok, false, '一个任务都没有不算过');
});

test('M8K-6 J-恰一：按 epoch 计（D3），重启后的新 epoch 再完成一次是对的', () => {
  const ids = ['t1', 't2'];
  const ok = judgeExactlyOnce(ids, [{ id: 't1', epoch: 'e1' }, { id: 't2', epoch: 'e1' }, { id: 't1', epoch: 'e2' }, { id: 'other', epoch: 'e1' }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.epochs, ['e1', 'e2']);
  assert.equal(ok.stray, 1);
  const strict = judgeExactlyOnce(ids, [{ id: 't1', epoch: 'e1' }, { id: 't2', epoch: 'e1' }, { id: 't1', epoch: 'e2' }], { perEpoch: false });
  assert.equal(strict.ok, false, '口径 (b)：跨 epoch 也只许一次');
  assert.deepEqual(strict.dup, [{ id: 't1', epoch: null, n: 2 }]);
  const dup = judgeExactlyOnce(ids, [{ id: 't1', epoch: 'e1' }, { id: 't1', epoch: 'e1' }]);
  assert.equal(dup.ok, false);
  assert.deepEqual(dup.dup, [{ id: 't1', epoch: 'e1', n: 2 }]);
  assert.deepEqual(dup.missing, ['t2']);
  assert.equal(judgeExactlyOnce(['t1'], [{ id: 't1' }]).ok, true, '没带 epoch 也能数');
});

test('M8K-7 J-纯层：一层混了两种指纹、指纹缺失都不过', () => {
  assert.equal(judgePureLayers([{ layer: 'L0', fingerprint: 'x' }, { layer: 'L0', fingerprint: 'x' }, { layer: 'L1', fingerprint: 'y' }]).ok, true);
  const mixed = judgePureLayers([{ layer: 'L0', fingerprint: 'x', ref: 'a' }, { layer: 'L0', fingerprint: 'y', ref: 'b' }]);
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.mixed, [{ layer: 'L0', fingerprints: { x: 1, y: 1 }, refs: ['a', 'b'] }]);
  const unknown = judgePureLayers([{ layer: 'L0', fingerprint: null }]);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.unknown, 1);
  assert.equal(judgePureLayers([]).ok, false);
});

test('M8K-8 假任务、任务 id 解析、由任务与完成者拼 J-纯层的观察', () => {
  const tasks = fakeLayerTasks({ run: 'r1', projectId: 'p', layers: [{ fingerprint: 'aaaaaaaaaaaaaaaa', segments: 2 }, { fingerprint: 'bbbbbbbbbbbbbbbb', segments: 1 }] });
  assert.deepEqual(tasks.map((t) => t.id), ['snapshot:m8-r1-L0:0-59', 'snapshot:m8-r1-L0:60-119', 'snapshot:m8-r1-L1:0-59']);
  assert.equal(tasks[0].requires.envFingerprint, 'aaaaaaaaaaaaaaaa');
  assert.equal(tasks[0].source.projectId, 'p');
  assert.deepEqual(parseTaskId(tasks[1].id), { kind: 'snapshot', resultKey: 'm8-r1-L0', from: 60, to: 119 });
  assert.equal(parseTaskId('plan:xyz'), null);
  const fps = { A: 'aaaaaaaaaaaaaaaa', B: 'bbbbbbbbbbbbbbbb' };
  const good = layerObservations(tasks, { [tasks[0].id]: 'A', [tasks[1].id]: 'A', [tasks[2].id]: 'B' }, fps);
  assert.equal(good.length, 6);
  assert.equal(judgePureLayers(good).ok, true);
  const bad = layerObservations(tasks, { [tasks[0].id]: 'A', [tasks[1].id]: 'B', [tasks[2].id]: 'B' }, fps);
  assert.equal(judgePureLayers(bad).ok, false, '第 0 层的第二段被另一种指纹的节点做了');
});

test('M8K-9 产物逐字节相同', () => {
  const a = { s1: Buffer.from('abc'), s2: 'hello' };
  assert.equal(judgeIdenticalBytes(a, { s1: sha256Of('abc'), s2: Buffer.from('hello') }).ok, true, '字节与 sha256 可以混着给');
  const r = judgeIdenticalBytes(a, new Map([['s1', Buffer.from('abd')], ['s3', 'x']]));
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatched, ['s1']);
  assert.deepEqual(r.onlyA, ['s2']);
  assert.deepEqual(r.onlyB, ['s3']);
  assert.equal(judgeIdenticalBytes({}, {}).ok, false);
});

test('M8K-10 各节点都干了活、完成数之和', () => {
  assert.equal(judgeEachWorked({ a: 3, b: 1 }, { total: 4 }).ok, true);
  assert.deepEqual(judgeEachWorked({ a: 4, b: 0 }).idle, ['b']);
  assert.equal(judgeEachWorked({ a: 3, b: 2 }, { total: 4 }).ok, false, '和多出来说明有任务被做了两遍');
  assert.deepEqual(judgeEachWorked({ a: 1 }, { expectNodes: ['a', 'c'] }).idle, ['c']);
});

test('M8K-11 旁观节点时间线：汇总与接手用时', () => {
  const ev = [{ t: 100, ev: 'opened' }, { t: 200, ev: 'taken', version: 2 }, { t: 5000, ev: 'opened' }, { t: 5200, ev: 'taken', version: 4 }, { t: 6000, ev: 'closed', state: 'done' }];
  assert.deepEqual(summarizeTimeline(ev), { taken: 2, reopenedAfterTaken: 1, closed: ['done'], versions: [2, 4] });
  assert.equal(takeoverMs(ev, 1000), 4200);
  assert.equal(takeoverMs(ev, 5300), null, 'since 之后没有放回再认领');
  assert.equal(takeoverMs([{ t: 10, ev: 'taken' }], 0), null, '没有放回不算接手');
});

test('M8K-12 结果行的形状与 --role all 汇总', () => {
  const r = createResult({ probe: 'p', role: 'creator', run: 'r', place: 'local' });
  assert.equal(r.ok, false, '没有 check 不算过');
  assert.equal(r.check('a', true), true);
  assert.equal(r.judge('b', { ok: false, why: 1 }), false);
  r.count('x', 2);
  r.set({ extra: 1 });
  const j = r.toJSON();
  assert.equal(j.ok, false);
  assert.deepEqual(j.checks[1], { name: 'b', ok: false, detail: { why: 1 } });
  assert.match(j.fails[0], /^b :: /);
  assert.deepEqual(j.counts, { x: 2 });
  assert.equal(j.extra, 1);
  assert.equal(typeof j.ms, 'number');
  for (const k of ['probe', 'role', 'run', 'place', 'ok', 'checks', 'fails', 'counts', 'ms']) assert.ok(k in j, k);

  const m = mergeRoleResults({ probe: 'p', run: 'r' }, [
    { role: 'creator', code: 0, line: { ok: true, checks: [{ name: 'c1', ok: true }], fails: [] } },
    { role: 'host', code: 1, line: { ok: false, checks: [{ name: 'h1', ok: false }], fails: ['h1'] } },
    { role: 'node', code: 7, line: null },
  ]).toJSON();
  assert.equal(m.role, 'all');
  assert.deepEqual(m.checks.map((c) => c.name), ['creator:c1', 'host:h1']);
  assert.deepEqual(m.fails, ['host: h1', 'node: 没有结果行（退出码 7）']);
  assert.equal(m.roles.creator.ok, true);
  assert.deepEqual(lastJsonLine('log\n{"a":1}\n{"b":2}\n'), { b: 2 });
  assert.deepEqual(lastJsonLine('{"a":1}\n{"b":'), { a: 1 }, '最后一行是半行时往前找');
  assert.equal(lastJsonLine(''), null);
});

/* ------------------------------------------------------------------ KV */

test('M8K-13 KV 键：拼接、校验长度', () => {
  assert.equal(kvKey('m8e', 'run1', 'ready', 'host-a'), 'm8e.run1.ready.host-a');
  assert.throws(() => kvKey('a'.repeat(40), 'b'.repeat(30)), /64/);
  assert.throws(() => kvKey('a b'), /不合法/);
});

test('M8K-14 KV 客户端：角色视图、401 记一行并重试一次、令牌不进日志', async (t) => {
  const token = 'tok-' + 'x'.repeat(24);
  const coord = await startCoordServer({ port: 0, mail: { token } });
  t.after(() => coord.close());
  const logs = [];
  const log = (event, fields) => logs.push({ event, ...fields });

  const run = await resolveRun({ coord: coord.url, prefix: 'm8t', isCreator: true, newRun: () => 'run1', deadline: Date.now() + 5000, token, log });
  assert.equal(run, 'run1');
  const kvA = roleKv({ coord: coord.url, prefix: 'm8t', run, role: 'creator', token, log });
  const kvB = roleKv({ coord: coord.url, prefix: 'm8t', run, role: 'host-a', token, log });
  const other = await resolveRun({ coord: coord.url, prefix: 'm8t', isCreator: false, newRun: () => 'no', deadline: Date.now() + 5000, token, log });
  assert.equal(other, 'run1', '别的角色从 latest 取本轮 id');
  await kvA.config({ projectId: 'p1' });
  assert.deepEqual(await kvB.takeConfig(Date.now() + 2000), { projectId: 'p1' });
  const waiting = kvA.takeReady('host-a', Date.now() + 5000);
  await kvB.ready({ fingerprint: 'f' });
  assert.equal((await waiting).fingerprint, 'f');
  await kvB.signal('holding', { held: ['t1'] });
  assert.deepEqual((await kvA.takeSignal('holding', Date.now() + 1000)).held, ['t1']);
  assert.equal(await kvA.aborted(), null);
  await kvB.abort('boom');
  assert.equal((await kvA.aborted()).reason, 'boom');
  await kvB.result({ ok: true });
  assert.deepEqual(await kvA.takeResult('host-a', Date.now() + 1000), { ok: true });
  assert.ok(coord.kv.has('m8t.run1.result.host-a'));
  assert.equal(kvA.client.stats.unauthorized, 0);

  // 令牌错：401 记一行（带响应体、有没有带令牌、令牌长度，不带令牌本身），重试一次后抛错
  const bad = kvClient(coord.url, { token: 'wrong-token-wrong-token', log });
  await assert.rejects(bad.put('m8t.x', { a: 1 }), (e) => e.status === 401 && /已重试一次/.test(e.message));
  const unauth = logs.filter((l) => l.event === 'kv.unauthorized');
  assert.equal(unauth.length, 2);
  assert.deepEqual(unauth.map((l) => l.retry), [true, false]);
  assert.equal(unauth[0].hasToken, true);
  assert.equal(unauth[0].tokenLength, 'wrong-token-wrong-token'.length);
  assert.match(unauth[0].body, /unauthorized/);
  assert.ok(!JSON.stringify(logs).includes('wrong-token-wrong-token'), '令牌不进日志');
  assert.ok(!JSON.stringify(logs).includes(token), '正确的令牌也不进日志');
  assert.equal(bad.stats.unauthorized, 2);
});

test('M8K-15 KV 客户端：协调口暂时连不上时退避重试，到时限才报错', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  const c = kvClient(`http://127.0.0.1:${port}`, { token: '' });
  const t0 = Date.now();
  assert.equal(await c.take('k', Date.now() + 1200), null, 'take 到 deadline 回 null');
  assert.ok(Date.now() - t0 >= 1000);
});

/* ------------------------------------------------------------------ 阿里云资源采样 */

const SAMPLE = `##time 1790000000000
##pm2
[{"name":"promptcut-hosted","pid":123,"status":"online","restarts":2,"uptime":1789990000000,"memory":104857600,"cpu":3.5}]
##meminfo
MemTotal:        1990000 kB
MemAvailable:     990000 kB
SwapTotal:             0 kB
SwapFree:              0 kB
##netdev
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:    1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
  eth0: 5000000    4000    0    0    0     0          0         0  9000000    5000    0    0    0     0       0          0
##loadavg
0.52 0.40 0.30 2/180 12345
##du
123456	/var/lib/promptcut/hosted
##end
`;

test('M8K-16 资源采样：解析远端输出、两次之间的差', () => {
  const a = parseRemoteSample(SAMPLE);
  assert.equal(a.complete, true);
  assert.equal(a.at, 1790000000000);
  assert.deepEqual(a.pm2[0], { name: 'promptcut-hosted', pid: 123, status: 'online', restarts: 2, uptime: 1789990000000, memory: 104857600, cpu: 3.5 });
  assert.equal(a.mem.usedKiB, 1000000);
  assert.deepEqual(a.net.eth0, { rx: 5000000, tx: 9000000 });
  assert.deepEqual(a.load, [0.52, 0.4, 0.3]);
  assert.deepEqual(a.du, { '/var/lib/promptcut/hosted': 123456 });
  const b = parseRemoteSample(SAMPLE.replace('1790000000000', '1790000010000').replace('5000000    4000', '6000000    4100').replace('"restarts":2', '"restarts":3'));
  const d = diffSamples(a, b);
  assert.equal(d.secs, 10);
  assert.deepEqual(d.net.eth0, { rx: 1000000, tx: 0, rxPerSec: 100000, txPerSec: 0 });
  assert.deepEqual(d.restarts, { 'promptcut-hosted': 1 });
  assert.equal(parseRemoteSample('##pm2\nnot json\n').complete, false);
  assert.deepEqual(parseRemoteSample('##pm2\nnot json\n').pm2, []);
  assert.match(remoteSampleScript(), /pm2 jlist/);
  assert.throws(() => remoteSampleScript(['/tmp; rm -rf /']), /只许/);
});

/* ------------------------------------------------------------------ 代理 */

async function echoServer(t) {
  const s = net.createServer((c) => { c.on('data', (d) => c.write(d)); c.on('error', () => {}); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { s.close(r); s.closeAllConnections?.(); }));
  return s.address().port;
}

function client(port) {
  const sock = net.connect(port, '127.0.0.1');
  let got = '';
  sock.on('data', (d) => { got += d.toString(); });
  sock.on('error', () => {});
  return { sock, got: () => got, closed: new Promise((r) => sock.once('close', r)) };
}

const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await delay(20); } return false; };

test('M8K-17 代理 stall / resume：扣住开着的与新来的连接，恢复后按序补发；status；quit 出汇总行', async (t) => {
  const target = await echoServer(t);
  const proxy = await startProxy({ listen: '127.0.0.1:0', target: `127.0.0.1:${target}` });
  t.after(() => proxy.stop());
  assert.ok(proxy.port > 0);
  assert.match(proxy.listen.meaning, /不是 IP 丢包/);
  assert.equal(proxy.listen.closeProb, 0);

  const a = client(proxy.port);
  await new Promise((r) => a.sock.once('connect', r));
  a.sock.write('1');
  assert.ok(await waitFor(() => a.got() === '1'), '先正常转发');

  const st = await proxy.stall();
  assert.equal(st.open, 1);
  assert.equal(st.newlyStalled, 1);
  a.sock.write('2');
  const b = client(proxy.port);
  await new Promise((r) => b.sock.once('connect', r));
  b.sock.write('x');
  await delay(400);
  assert.equal(a.got(), '1', 'stall 期间开着的连接不转发');
  assert.equal(b.got(), '', 'stall 期间新来的连接也不转发');
  const status = await proxy.status();
  assert.equal(status.stallActive, true);
  assert.equal(status.stalled, 2);

  a.sock.write('3');
  const re = await proxy.resume();
  assert.equal(re.resumed, 2);
  assert.ok(re.stalledMs >= 300);
  assert.ok(await waitFor(() => a.got() === '123' && b.got() === 'x'), `恢复后按序补发：${a.got()} / ${b.got()}`);
  assert.equal(proxy.count('conn.resume'), 2);
  a.sock.write('4');
  assert.ok(await waitFor(() => a.got() === '1234'), '恢复后新数据照常转发');

  a.sock.destroy();
  b.sock.destroy();
  const summary = await proxy.stop();
  assert.equal(summary.event, 'summary');
  assert.equal(summary.stallCommands, 1);
  assert.equal(summary.resumeCommands, 1);
  assert.match(summary.meaning, /字节从不丢/);
});

test('M8K-18 代理 --close-prob：按概率断开整条连接（不丢中间的字节）；--stall-prob 与旧名 --loss 同义', async (t) => {
  const target = await echoServer(t);
  const proxy = await startProxy({ listen: '127.0.0.1:0', target: `127.0.0.1:${target}`, closeProb: 1 });
  t.after(() => proxy.stop());
  const a = client(proxy.port);
  await new Promise((r) => a.sock.once('connect', r));
  a.sock.write('hello');
  await Promise.race([a.closed, delay(3000)]);
  assert.equal(a.sock.destroyed, true, '第一块就按概率 1 断开');
  assert.equal(a.got(), '');
  assert.ok(await waitFor(() => proxy.count('conn.cut', (e) => e.by === 'close-prob') === 1));
  const summary = await proxy.stop();
  assert.equal(summary.randomCloses, 1);

  const p2 = await startProxy({ listen: '127.0.0.1:0', target: `127.0.0.1:${target}`, stallProb: 1, stallMs: '50' });
  t.after(() => p2.stop());
  assert.equal(p2.listen.stallProb, 1);
  assert.deepEqual(p2.listen.stallMs, [50, 50]);
  assert.equal(p2.listen.loss, 1, '旧字段名照写');
  const c = client(p2.port);
  await new Promise((r) => c.sock.once('connect', r));
  for (const ch of 'abcdef') c.sock.write(ch);
  assert.ok(await waitFor(() => c.got() === 'abcdef'), `每块都受扰，但全部按序到齐：${c.got()}`);
  c.sock.destroy();
  const s2 = await p2.stop();
  assert.ok(s2.held >= 2, `受扰的块数 ${s2.held}`);
});

test('M8K-19 子进程环境：去掉会连错地方或带凭证的变量，目录指到给定处', async (t) => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-m8k-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const saved = { ...process.env };
  t.after(() => { for (const k of ['PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_TEST_ENV_FINGERPRINT']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  process.env.PROMPTCUT_CLUSTER_TOKEN = 'secret';
  process.env.PROMPTCUT_TEST_ENV_FINGERPRINT = '0000000000000000';
  const env = childEnv(dir, { PROMPTCUT_QUEUE_NODE: '1' });
  assert.equal(env.PROMPTCUT_CLUSTER_TOKEN, undefined);
  assert.equal(env.PROMPTCUT_TEST_ENV_FINGERPRINT, undefined);
  assert.equal(env.PROMPTCUT_QUEUE_NODE, '1');
  assert.equal(env.PROMPTCUT_DATA_DIR, path.join(dir, 'data'));
  assert.equal(env.TEMP, path.join(dir, 'tmp'));
  assert.ok(fs.existsSync(path.join(dir, 'tmp')));
});

test('M8K-20 E3 页面：重启后以新会话重读、追到最后一次提交的版本且摘要相同；没重连、摘要不符、没追到都判红', () => {
  const last = { rev: 3, digest: 'd3', path: '/page/lastCommit', value: 'm1' };
  // 正常：重启后一个新会话，重读见到 rev 3、摘要相同
  const ok = judgeLastCommit(last, { sessionsAfter: 1, rev: 3, seenAfter: [{ rev: 3, digest: 'd3' }], valueAt: 'm1' });
  assert.equal(ok.resync.ok, true);
  assert.equal(ok.readable.ok, true);
  assert.equal(ok.readable.via, 'digest');
  // 没重连（副本还拿着重启前内存里的内容）：两条都红
  const stale = judgeLastCommit(last, { sessionsAfter: 0, rev: 3, seenAfter: [], valueAt: 'm1' });
  assert.equal(stale.resync.ok, false);
  assert.equal(stale.readable.ok, false);
  // 重读了但摘要不符
  const bad = judgeLastCommit(last, { sessionsAfter: 1, rev: 3, seenAfter: [{ rev: 3, digest: 'xx' }], valueAt: 'm1' });
  assert.equal(bad.resync.ok, true);
  assert.equal(bad.readable.ok, false);
  assert.equal(bad.readable.digestMatch, false);
  // 文档服务丢了这次提交（重启后只到 rev 2）
  const lost = judgeLastCommit(last, { sessionsAfter: 1, rev: 2, seenAfter: [{ rev: 2, digest: 'd2' }], valueAt: null });
  assert.equal(lost.resync.ok, false);
  assert.equal(lost.readable.ok, false);
  // 重启后又有写入、没见到 rev 3 那一版：退回核对写下的值
  const later = judgeLastCommit(last, { sessionsAfter: 1, rev: 5, seenAfter: [{ rev: 5, digest: 'd5' }], valueAt: 'm1' });
  assert.equal(later.readable.ok, true);
  assert.equal(later.readable.via, 'value');
  assert.equal(judgeLastCommit(last, { sessionsAfter: 1, rev: 5, seenAfter: [{ rev: 5, digest: 'd5' }], valueAt: 'other' }).readable.ok, false);
  // 缺信号
  assert.equal(judgeLastCommit(null, { sessionsAfter: 1, rev: 3, seenAfter: [] }).resync.ok, false);
  assert.equal(judgeLastCommit(last, null).readable.ok, false);
});
