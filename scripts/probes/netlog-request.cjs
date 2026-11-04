/**
 * Read Chrome netlog (`--log-net-log=<file>`), listing the progress at the network layer of requests
 * whose URL contains certain text. Can be read while the browser is still open and file is not
 * finalized.
 * Used for forensics such as probe page "never gets DOMContentLoaded"
 * (`docs/archive/agent-reports/AGENT-nav-hang.md`): check whether request was not sent, not fully
 * received, or already received at network layer but never accepted by the page.
 *
 *   node scripts/probes/netlog-request.cjs <netlog> <url-fragment> [--all] [--events]
 *
 * Defaults to listing the last matching request: body bytes read at network layer, timestamp of last
 * body read, request lifetime (REQUEST_ALIVE start and end), bound connection.
 * `--all` outputs one line per matching request; `--events` prints each event of the request (body
 * read events omitted). Timestamps are all in milliseconds relative to the start of that request.
 */
const fs = require('fs');

const [file, pattern, ...flags] = process.argv.slice(2);
if (!file || !pattern) { console.error('Usage: node scripts/probes/netlog-request.cjs <netlog> <URL substring> [--all] [--events]'); process.exit(2); }
const lines = fs.readFileSync(file, 'utf8').split('\n');
let consts = null;
const evs = [];
for (const l of lines) {
  let t = l.trim();
  if (!t) continue;
  if (!consts && t.startsWith('{"constants"')) { consts = JSON.parse(t.replace(/,$/, '') + '}').constants; continue; }
  t = t.replace(/,$/, '');
  if (!t.startsWith('{')) continue;
  try { evs.push(JSON.parse(t)); } catch { /* Finalizing half-line */ }
}
if (!consts) { console.error('Not a Chrome netlog (the first line has no constants)'); process.exit(2); }
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
  return { id, url, start: es[0].time, status, len, bytes, lastReadMs: lastRead, aliveMs: end ? Number(end.time) - t0 : `>${lastT - t0} (still alive when the log ended)` };
}
console.log(`Matching requests: ${reqs.length}; log events: ${evs.length}`);
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
