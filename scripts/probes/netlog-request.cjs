/**
 * 读 Chrome 网络日志(`--log-net-log=<文件>`),列出 URL 含某段文字的请求在网络层的经过。浏览器还开着、文件没收尾时也能读。
 * 用于探针页面「等不到 DOMContentLoaded」一类的取证(`docs/archive/agent-reports/AGENT-nav-hang.md`):看请求是没发出去、没收完,还是网络层已收完而页面一直没收下。
 *
 *   node scripts/probes/netlog-request.cjs <网络日志> <URL 片段> [--all] [--events]
 *
 * 缺省列最后一个匹配的请求:网络层读到的正文字节数、最后一次读到正文的时刻、请求活了多久(REQUEST_ALIVE 起止)、绑定的连接。
 * `--all` 每个匹配的请求一行;`--events` 再把该请求的事件逐条打出来(正文读取的事件省略)。时刻都是相对该请求开始的毫秒。
 */
const fs = require('fs');

const [file, pattern, ...flags] = process.argv.slice(2);
if (!file || !pattern) { console.error('用法: node scripts/probes/netlog-request.cjs <网络日志> <URL 片段> [--all] [--events]'); process.exit(2); }
const lines = fs.readFileSync(file, 'utf8').split('\n');
let consts = null;
const evs = [];
for (const l of lines) {
  let t = l.trim();
  if (!t) continue;
  if (!consts && t.startsWith('{"constants"')) { consts = JSON.parse(t.replace(/,$/, '') + '}').constants; continue; }
  t = t.replace(/,$/, '');
  if (!t.startsWith('{')) continue;
  try { evs.push(JSON.parse(t)); } catch { /* 收尾的半行 */ }
}
if (!consts) { console.error('不是 Chrome 网络日志(第一行没有 constants)'); process.exit(2); }
const typeName = Object.fromEntries(Object.entries(consts.logEventTypes).map(([k, v]) => [v, k]));
const srcName = Object.fromEntries(Object.entries(consts.logSourceType).map(([k, v]) => [v, k]));
const bySrc = new Map();
for (const e of evs) { if (!bySrc.has(e.source.id)) bySrc.set(e.source.id, []); bySrc.get(e.source.id).push(e); }

const reqs = [...bySrc.entries()].filter(([, es]) => srcName[es[0].source.type] === 'URL_REQUEST' && es.some((e) => e.params?.url?.includes(pattern)));
const lastT = Number(evs.at(-1)?.time ?? 0);
function summary(id, es) {
  const t0 = Number(es[0].time);
  const url = es.find((e) => e.params?.url)?.params.url;
  let bytes = 0, lastRead = null;
  for (const e of es) if (typeName[e.type] === 'URL_REQUEST_JOB_FILTERED_BYTES_READ') { bytes += e.params.byte_count; lastRead = Number(e.time) - t0; }
  const alive = es.filter((e) => typeName[e.type] === 'REQUEST_ALIVE');
  const end = alive.find((e) => e.phase === 2);
  const status = es.find((e) => typeName[e.type] === 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS')?.params?.headers?.[0] ?? null;
  const len = (es.find((e) => typeName[e.type] === 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS')?.params?.headers ?? []).find((h) => /^content-length:/i.test(h)) ?? null;
  return { id, url, start: es[0].time, status, len, bytes, lastReadMs: lastRead, aliveMs: end ? Number(end.time) - t0 : `>${lastT - t0}(日志结束时还活着)` };
}
console.log(`匹配的请求 ${reqs.length} 个;日志 ${evs.length} 条事件`);
const pick = flags.includes('--all') ? reqs : reqs.slice(-1);
for (const [id, es] of pick) {
  console.log(JSON.stringify(summary(id, es)));
  if (!flags.includes('--events')) continue;
  const t0 = Number(es[0].time);
  for (const e of es) {
    const n = typeName[e.type];
    if (n === 'URL_REQUEST_JOB_FILTERED_BYTES_READ' || n === 'HTTP_TRANSACTION_READ_BODY') continue;
    console.log(`${String(Number(e.time) - t0).padStart(8)} ${['  ', 'B ', 'E '][e.phase]}${n} ${e.params ? JSON.stringify(e.params).slice(0, 200) : ''}`);
  }
}
