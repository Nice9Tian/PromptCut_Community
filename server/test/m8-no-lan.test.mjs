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

test('Windows netstat lines: take the local end, the remote end and the state; UDP and the header do not count', () => {
  assert.deepEqual(parseNetstatLine('  TCP    192.168.50.79:52002    192.168.50.96:5780     ESTABLISHED'),
    { proto: 'TCP', local: '192.168.50.79:52002', foreign: '192.168.50.96:5780', state: 'ESTABLISHED' });
  assert.equal(parseNetstatLine('  TCP    192.168.50.79:52003    192.168.50.96:5789     TIME_WAIT').state, 'TIME_WAIT');
  assert.equal(parseNetstatLine('  UDP    0.0.0.0:5353           *:*'), null);
  assert.equal(parseNetstatLine('  Proto  Local Address          Foreign Address        State'), null);
});

test('Linux netstat lines: skip the Recv-Q / Send-Q columns', () => {
  assert.deepEqual(parseNetstatLine('tcp        0      0 10.0.0.5:40000          192.168.50.96:8787      ESTABLISHED'),
    { proto: 'tcp', local: '10.0.0.5:40000', foreign: '192.168.50.96:8787', state: 'ESTABLISHED' });
  assert.equal(parseNetstatLine('tcp        0      0 10.0.0.5:40000          192.168.50.96:8787').state, null, 'No state column means null');
});

test('Count by remote address: any state counts, those whose local end is this address do not', () => {
  assert.equal(countTcpTo(WINDOWS, '192.168.50.96').count, 2);
  assert.equal(countTcpTo(WINDOWS, '203.0.113.16').count, 1);
  assert.equal(countTcpTo(WINDOWS, '192.168.50.79').count, 0);
  assert.equal(countTcpTo(LINUX, '192.168.50.96').count, 1);
  assert.equal(countTcpTo(LINUX, '192.168.50.9').count, 0, 'Addresses sharing the same prefix do not count');
});

test('IPv4-mapped IPv6 remote ends are recognized too', () => {
  assert.equal(foreignIs('[::ffff:192.168.50.96]:5780', '192.168.50.96'), true);
  assert.equal(foreignIs('192.168.50.960:1', '192.168.50.96'), false);
});

test('Refuse to start if the address is not IPv4', () => {
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

test('countNewTcpTo: connections in the baseline do not count (they go into baselineLines), those outside the baseline count regardless of state', () => {
  const baseline = new Set(countTcpTo(LEFTOVER.join('\r\n'), PC).lines.map(pairKey));
  assert.equal(baseline.size, 4);
  const same = countNewTcpTo(LEFTOVER.join('\r\n'), PC, baseline);
  assert.equal(same.count, 0, 'TIME_WAIT and the like in the baseline do not count');
  assert.equal(same.baselineLines.length, 4);
  const later = countNewTcpTo([
    ...LEFTOVER,
    row('192.168.50.79:52020', `${PC}:5780`, 'TIME_WAIT'),
    row('192.168.50.79:52021', `${PC}:5780`, 'SYN_SENT'),
    row('192.168.50.79:52022', `${PC}:8787`, 'CLOSE_WAIT'),
  ].join('\r\n'), PC, baseline);
  assert.equal(later.count, 3, 'TIME_WAIT, SYN_SENT and CLOSE_WAIT that newly appear during the run all count');
  assert.deepEqual(later.lines.map((l) => l.state), ['TIME_WAIT', 'SYN_SENT', 'CLOSE_WAIT']);
});

test('judgeNoLanTcp: no pass if no baseline was obtained or nothing was sampled after the baseline; no pass if there are connections outside the baseline', () => {
  assert.equal(judgeNoLanTcp({ baselineOk: true, samples: 3, maxTcp: 0 }), true);
  assert.equal(judgeNoLanTcp({ baselineOk: true, samples: 3, maxTcp: 1 }), false);
  assert.equal(judgeNoLanTcp({ baselineOk: true, samples: 0, maxTcp: 0 }), false, 'Nothing was sampled after the baseline');
  assert.equal(judgeNoLanTcp({ baselineOk: false, samples: 0, maxTcp: 0 }), false, 'netstat never ran successfully');
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

test('startNoLanWatch: TIME_WAIT in the baseline does not count and is only recorded in baseline', async () => {
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

test('startNoLanWatch: a short connection opened and closed during the run (only TIME_WAIT is left at the next sample) counts', async () => {
  const shortLived = [...LEFTOVER, row('192.168.50.79:52030', `${PC}:5780`, 'TIME_WAIT')];
  const w = startNoLanWatch(PC, { everyMs: 3_600_000, netstat: fakeNetstat([LEFTOVER, shortLived, LEFTOVER]), discover: false });
  w.sample();
  const r = await w.stop();
  assert.equal(r.maxTcp, 1);
  assert.deepEqual(r.seen, [`192.168.50.79:52030>${PC}:5780 TIME_WAIT`]);
  assert.equal(r.tcpOk, false);
});

test('startNoLanWatch: SYN_SENT (a LAN connection that did not complete) counts too; if the first netstat fails, the one obtained next is used as the baseline', async () => {
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
