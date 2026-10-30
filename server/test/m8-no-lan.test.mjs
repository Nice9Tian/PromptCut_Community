// M8「异地接入」探针公共件 scripts/probes/m8/no-lan.mjs 的纯逻辑：netstat 行解析与按对端地址计数（Windows、Linux 两种格式）。
// 基线排除（REPORT-render-queue-m8.md 第 13.5 节的弱点之一）：开始时已有的、对端是这个地址的连接（上一项留下的 TIME_WAIT 等）不算；
// 之后新出现的不论状态都算——两次采样之间建立又关掉的短连接，下一次采样时只剩 TIME_WAIT，也要抓到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNetstatLine, foreignIs, countTcpTo, countNewTcpTo, pairKey, judgeNoLanTcp, startNoLanWatch } from '../../scripts/probes/m8/no-lan.mjs';

const WINDOWS = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING',
  '  TCP    192.168.50.79:52001    203.0.113.16:443        ESTABLISHED',
  '  TCP    192.168.50.79:52002    192.168.50.96:5780     ESTABLISHED',
  '  TCP    192.168.50.79:52003    192.168.50.96:5789     TIME_WAIT',
  '  TCP    [::1]:5580             [::]:0                 LISTENING',
  '  UDP    0.0.0.0:5353           *:*',
].join('\r\n');

const LINUX = [
  'Active Internet connections (servers and established)',
  'Proto Recv-Q Send-Q Local Address           Foreign Address         State',
  'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN',
  'tcp        0      0 10.0.0.5:40000          192.168.50.96:8787      ESTABLISHED',
  'tcp6       0      0 :::22                   :::*                    LISTEN',
  'udp        0      0 0.0.0.0:68              0.0.0.0:*',
].join('\n');

test('Windows 的 netstat 行：取本端、对端与状态，UDP 与表头不算', () => {
  assert.deepEqual(parseNetstatLine('  TCP    192.168.50.79:52002    192.168.50.96:5780     ESTABLISHED'),
    { proto: 'TCP', local: '192.168.50.79:52002', foreign: '192.168.50.96:5780', state: 'ESTABLISHED' });
  assert.equal(parseNetstatLine('  TCP    192.168.50.79:52003    192.168.50.96:5789     TIME_WAIT').state, 'TIME_WAIT');
  assert.equal(parseNetstatLine('  UDP    0.0.0.0:5353           *:*'), null);
  assert.equal(parseNetstatLine('  Proto  Local Address          Foreign Address        State'), null);
});

test('Linux 的 netstat 行：跳过 Recv-Q / Send-Q 两列', () => {
  assert.deepEqual(parseNetstatLine('tcp        0      0 10.0.0.5:40000          192.168.50.96:8787      ESTABLISHED'),
    { proto: 'tcp', local: '10.0.0.5:40000', foreign: '192.168.50.96:8787', state: 'ESTABLISHED' });
  assert.equal(parseNetstatLine('tcp        0      0 10.0.0.5:40000          192.168.50.96:8787').state, null, '没有状态列就是 null');
});

test('按对端地址计数：任何状态都算，本端是这个地址的不算', () => {
  assert.equal(countTcpTo(WINDOWS, '192.168.50.96').count, 2);
  assert.equal(countTcpTo(WINDOWS, '203.0.113.16').count, 1);
  assert.equal(countTcpTo(WINDOWS, '192.168.50.79').count, 0);
  assert.equal(countTcpTo(LINUX, '192.168.50.96').count, 1);
  assert.equal(countTcpTo(LINUX, '192.168.50.9').count, 0, '前缀相同的地址不算');
});

test('IPv4 映射的 IPv6 对端也认', () => {
  assert.equal(foreignIs('[::ffff:192.168.50.96]:5780', '192.168.50.96'), true);
  assert.equal(foreignIs('192.168.50.960:1', '192.168.50.96'), false);
});

test('地址不是 IPv4 就拒绝开始', () => {
  assert.throws(() => startNoLanWatch('pc.local'), /IPv4/);
});

const PC = '192.168.50.96';
const HEAD = '  Proto  Local Address          Foreign Address        State';
const row = (local, foreign, state) => `  TCP    ${local.padEnd(22)} ${foreign.padEnd(22)} ${state}`;
/** 上一项刚跑完：到 PC 的连接全在 TIME_WAIT / CLOSE_WAIT / FIN_WAIT_2；另有一条到阿里云的 */
const LEFTOVER = [
  HEAD,
  row('192.168.50.79:52010', `${PC}:5780`, 'TIME_WAIT'),
  row('192.168.50.79:52011', `${PC}:5781`, 'TIME_WAIT'),
  row('192.168.50.79:52012', `${PC}:5789`, 'CLOSE_WAIT'),
  row('192.168.50.79:52013', `${PC}:5789`, 'FIN_WAIT_2'),
  row('192.168.50.79:52014', '203.0.113.16:443', 'ESTABLISHED'),
];

test('countNewTcpTo：基线里的不算（进 baselineLines），基线外的不论状态都算', () => {
  const baseline = new Set(countTcpTo(LEFTOVER.join('\r\n'), PC).lines.map(pairKey));
  assert.equal(baseline.size, 4);
  const same = countNewTcpTo(LEFTOVER.join('\r\n'), PC, baseline);
  assert.equal(same.count, 0, '基线里的 TIME_WAIT 等不算');
  assert.equal(same.baselineLines.length, 4);
  const later = countNewTcpTo([
    ...LEFTOVER,
    row('192.168.50.79:52020', `${PC}:5780`, 'TIME_WAIT'),
    row('192.168.50.79:52021', `${PC}:5780`, 'SYN_SENT'),
    row('192.168.50.79:52022', `${PC}:8787`, 'CLOSE_WAIT'),
  ].join('\r\n'), PC, baseline);
  assert.equal(later.count, 3, '运行中新出现的 TIME_WAIT、SYN_SENT、CLOSE_WAIT 都算');
  assert.deepEqual(later.lines.map((l) => l.state), ['TIME_WAIT', 'SYN_SENT', 'CLOSE_WAIT']);
});

test('judgeNoLanTcp：没取到基线、基线之后没采样过都不算过；有基线外的连接不过', () => {
  assert.equal(judgeNoLanTcp({ baselineOk: true, samples: 3, maxTcp: 0 }), true);
  assert.equal(judgeNoLanTcp({ baselineOk: true, samples: 3, maxTcp: 1 }), false);
  assert.equal(judgeNoLanTcp({ baselineOk: true, samples: 0, maxTcp: 0 }), false, '基线之后一次都没采样到');
  assert.equal(judgeNoLanTcp({ baselineOk: false, samples: 0, maxTcp: 0 }), false, 'netstat 一次都没跑成');
});

/** 按顺序回给 startNoLanWatch 的假 netstat（单测不跑真的 netstat、不做局域网发现） */
function fakeNetstat(outputs) {
  let i = 0;
  return () => {
    const o = outputs[Math.min(i, outputs.length - 1)];
    i += 1;
    return o === null ? { ok: false, text: '' } : { ok: true, text: o.join('\r\n') };
  };
}

test('startNoLanWatch：基线里的 TIME_WAIT 不算，只记进 baseline', async () => {
  const w = startNoLanWatch(PC, { everyMs: 3_600_000, netstat: fakeNetstat([LEFTOVER, LEFTOVER, LEFTOVER]), discover: false });
  w.sample();
  const r = await w.stop();
  assert.equal(r.baselineOk, true);
  assert.equal(r.baseline.length, 4);
  assert.match(r.baseline[0], /TIME_WAIT$/);
  assert.equal(r.samples, 2);
  assert.equal(r.maxTcp, 0);
  assert.deepEqual(r.seen, []);
  assert.equal(r.tcpOk, true);
});

test('startNoLanWatch：运行中建立又关掉的短连接（下一次采样只剩 TIME_WAIT）算', async () => {
  const shortLived = [...LEFTOVER, row('192.168.50.79:52030', `${PC}:5780`, 'TIME_WAIT')];
  const w = startNoLanWatch(PC, { everyMs: 3_600_000, netstat: fakeNetstat([LEFTOVER, shortLived, LEFTOVER]), discover: false });
  w.sample();
  const r = await w.stop();
  assert.equal(r.maxTcp, 1);
  assert.deepEqual(r.seen, [`192.168.50.79:52030>${PC}:5780 TIME_WAIT`]);
  assert.equal(r.tcpOk, false);
});

test('startNoLanWatch：SYN_SENT（连局域网没连上）也算；第一次 netstat 失败时下一次取到的当基线', async () => {
  const syn = [HEAD, row('192.168.50.79:52040', `${PC}:5780`, 'SYN_SENT')];
  const w = startNoLanWatch(PC, { everyMs: 3_600_000, netstat: fakeNetstat([null, [HEAD], syn]), discover: false });
  w.sample();
  const r = await w.stop();
  assert.equal(r.failedSamples, 1);
  assert.equal(r.baselineOk, true);
  assert.equal(r.samples, 1);
  assert.equal(r.maxTcp, 1);
  assert.equal(r.tcpOk, false);
});
