// 探针:局域网素材服务端到端(W2)。契约见 docs/plan/asset-store-contract.md 第 6 节末段。
//
//   PROMPTCUT_SHARED_CONFIG=<配置文件> node scripts/probes/asset-lan-probe.mjs [--docservice <ws://…>] [--asset <http://…/api/asset>] [--mb 20] [--timeout-ms 60000]
//
// 在另一台机器(笔记本)上跑,只用 Node 内置模块(要 Node 22 起的全局 WebSocket、fetch),不需要 node_modules。
//
// 凭证(M6a,docs/plan/auth-contract.md 第 8、11 节;集群令牌已退出素材服务,本探针不再读它):
//   环境变量 PROMPTCUT_SHARED_CONFIG 指向共享项目配置(第一项)。探针凭项目证明连文档服务(没给 --docservice 时用配置里的 url),
//   经这条连接的 auth.ticket 取一张 rw 素材票据和一张只读票据,读写都带票据。配置里的口令、K、证明、票据都不打印。
//
// 素材服务地址:
//   - 没给 --asset:先按局域网发现(server/lan/discovery.mjs,限时 3 s)找这个项目。放本机的项目,素材服务地址经发现带回、
//     不进控制面的 service.endpoints;找到就按发现的先后取第一个带票据 GET <url>/media/<一个不存在的哈希>/chunks
//     能通的地址(source: 'lan')。没给 --docservice 时,票据也从发现到的那台文档服务取(同 server/auth/route.mjs 的选路)。
//     找不到(放云端的项目,或不在同一网段)再在控制面连接上发 service.watch { kinds: ['asset'] },按登记顺序取第一个
//     能通的地址(source: 'docservice')。地址都不手填。找地址那一段在 asset-lan-discover.mjs,单测 server/test/asset-lan-discover.test.mjs;
//   - 给了 --asset:直接用它(source: 'arg');
//   - --no-lan:不做局域网发现,只等 service.endpoints(老写法)。
//
// 断言(按顺序):
//   1. 随机生成 --mb MB 数据,算出 sha256;
//   2. 不带票据 PUT 第 0 片 → 401;不带票据读 chunks → 401;只读票据 PUT → 403;
//   3. 带票据只传第 0、1 片,chunks 报 received: [0, 1];
//   4. 补传其余分片,complete → 200;
//   5. 带 Origin: http://192.168.50.247:9999 的 GET 回 Access-Control-Allow-Origin: *;
//   6. Range: bytes=100-199 → 206,字节正确;查询串只读票据 ?t= 的 Range 也 206,带 no-store / no-referrer;
//   7. 全件下载后 sha256 相符。
//
// 输出一行 JSON:{ ok, assetUrl, source, lan: { found, ms, candidates, errors } | null, bytes, steps: [{ name, ok, ms }], fails: [{ step, detail }] }
// 退出码:0 全过;1 有断言失败(含超时);2 用法不对、没有共享项目配置、连不上控制面或素材服务。
import crypto from 'node:crypto';
import { discoverLanAsset, firstReachableAsset } from './asset-lan-discover.mjs';

const USAGE = `Usage: PROMPTCUT_SHARED_CONFIG=<config> node scripts/probes/asset-lan-probe.mjs [--docservice <ws://…>] [--asset <http://…/api/asset>] [--no-lan] [--mb 20] [--timeout-ms 60000]
  --docservice  control plane (document service) address, ws:// or wss://; defaults to the one found via LAN discovery, or the url in the shared project config if none was found
  --asset       set the asset service base address (…/api/asset) directly, skipping discovery
  --no-lan      skip LAN discovery, only take the asset service address from the control plane's service.endpoints
  --mb          test data size in MB (default 20)
  --timeout-ms  timeout for the whole run (default 60000)
  Credentials are read from the shared project config pointed to by the environment variable PROMPTCUT_SHARED_CONFIG (asset tickets are fetched via the document service).
  Exit codes: 0 all passed, 1 assertion failed, 2 unreachable (or bad usage).`;

const CHUNK_DEFAULT = 8 * 1024 * 1024;
const LAN_ORIGIN = 'http://192.168.50.247:9999';

/** 不带值的开关 */
const FLAGS = new Set(['no-lan', 'help']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) return { error: `Unexpected argument ${a}` };
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (FLAGS.has(key) && eq < 0) { out[key] = true; continue; }
    const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (val === undefined) return { error: `--${key} is missing a value` };
    out[key] = val;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.error || args.help || (!process.env.PROMPTCUT_SHARED_CONFIG && process.argv.length <= 2)) {
  if (args.error) console.error(args.error);
  console.error(USAGE);
  process.exit(2);
}
const MB = Number(args.mb ?? 20);
const TIMEOUT_MS = Number(args['timeout-ms'] ?? 60000);
if (!(MB > 0) || !(TIMEOUT_MS > 0)) {
  console.error(USAGE);
  process.exit(2);
}
/** 用过的票据:输出前一律擦掉 */
const SECRETS = new Set();
let TICKET = '';
let READ_TICKET = '';

const result = { ok: false, assetUrl: null, source: args.asset ? 'arg' : 'docservice', lan: null, bytes: 0, steps: [], fails: [] };
let finished = false;
/** 打一行 JSON 退出。令牌不在 result 里,保险起见再擦一遍 */
function finish(code) {
  if (finished) return;
  finished = true;
  result.ok = code === 0 && result.fails.length === 0;
  let line = JSON.stringify(result);
  for (const secret of SECRETS) line = line.split(secret).join('<ticket>');
  process.exitCode = code;
  // 写完再退出:管道上的 stdout 可能是异步的
  process.stdout.write(`${line}\n`, () => process.exit(code));
}
/** 连不上一类:退出码 2 */
class Unreachable extends Error {}

const deadline = Date.now() + TIMEOUT_MS;
const left = () => Math.max(1, deadline - Date.now());
const watchdog = setTimeout(() => {
  result.fails.push({ step: 'timeout', detail: `Whole run exceeded ${TIMEOUT_MS} ms` });
  finish(1);
}, TIMEOUT_MS);
watchdog.unref?.();

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const safe = (text) => { let out = String(text); for (const secret of SECRETS) out = out.split(secret).join('<ticket>'); return out; };

async function request(url, init = {}, ms = left()) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(ms, left())) });
  } catch (err) {
    throw new Unreachable(`${init.method || 'GET'} ${url}:${safe(err?.cause?.message || err?.message || err)}`);
  }
}

/** 一步:计时、记结果;断言失败记进 fails 但继续跑后面的步骤,连不上就整趟停 */
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    result.steps.push({ name, ok: true, ms: Date.now() - t0 });
    return true;
  } catch (err) {
    result.steps.push({ name, ok: false, ms: Date.now() - t0 });
    if (err instanceof Unreachable) throw err;
    result.fails.push({ step: name, detail: safe(err?.message || err) });
    return false;
  }
}
function check(cond, detail) {
  if (!cond) throw new Error(detail);
}

/**
 * 凭共享项目连控制面,取素材票据;没给 --asset 时找第一个能通的素材服务地址:
 * lanAssets 非空(局域网发现到了这个项目)就在它里面找,否则订阅 asset 登记按顺序找
 */
async function connectAndDiscover(docservice, wantDiscovery, lanAssets = []) {
  let parsed;
  try { parsed = new URL(docservice); } catch { throw new Unreachable(`--docservice is not a valid address: ${docservice}`); }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Unreachable('--docservice must be ws:// or wss://');
  if (typeof WebSocket !== 'function') throw new Unreachable('This Node has no global WebSocket (requires Node 22 or later)');
  let protocols;
  try {
    const { sharedProtocols } = await import(new URL('../../server/auth/shared-config.mjs', import.meta.url));
    protocols = await sharedProtocols({ ...SHARED, url: docservice }, { role: 'page' })();
  } catch (err) {
    throw new Unreachable(`Failed to get the entry challenge: ${safe(err?.message || err)}`);
  }
  const ws = new WebSocket(docservice, protocols);
  try {
    const ask = (message) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Unreachable(`Timed out waiting for the reply to ${message.type}`)), Math.min(left(), 15000));
      const onMessage = (e) => {
        let m;
        try { m = JSON.parse(String(e.data)); } catch { return; }
        if (m?.reqId !== message.reqId) return;
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        if (m.type === 'error') reject(new Unreachable(`Control plane replied with error: ${m.reason ?? ''}`));
        else resolve(m);
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify(message));
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Unreachable(`Cannot reach the control plane (also happens with bad credentials) ${parsed.protocol}//${parsed.host}${parsed.pathname}`)), { once: true });
    });
    TICKET = (await ask({ type: 'auth.ticket', reqId: 'rw', kind: 'asset', access: 'rw' })).ticket;
    READ_TICKET = (await ask({ type: 'auth.ticket', reqId: 'r', kind: 'asset', access: 'r' })).ticket;
    SECRETS.add(TICKET);
    SECRETS.add(READ_TICKET);
    if (!wantDiscovery) return null;
    const missing = sha256(crypto.randomBytes(32));
    const reach = (urls) => firstReachableAsset(urls, { ticket: TICKET, missingHash: missing, timeoutMs: Math.min(3000, left()) });
    if (lanAssets.length) {
      const hit = await reach(lanAssets);
      if (hit) return hit;
      throw new Unreachable(`None of the asset service addresses found via LAN discovery are reachable: ${lanAssets.join(', ')}`);
    }
    const registrations = await new Promise((resolve, reject) => {
      const why = args['no-lan'] ? '' : '(LAN discovery did not find this project either)';
      const timer = setTimeout(() => reject(new Unreachable(`Timed out waiting for the control plane's service.endpoints${why}`)), Math.min(left(), 15000));
      ws.send(JSON.stringify({ type: 'service.watch', kinds: ['asset'] }));
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Unreachable(`Cannot reach the control plane ${parsed.protocol}//${parsed.host}${parsed.pathname}`)); });
      ws.addEventListener('close', (e) => { clearTimeout(timer); reject(new Unreachable(`Control plane closed the connection (${e.code}${e.reason ? ` ${e.reason}` : ''})`)); });
      ws.addEventListener('message', (e) => {
        let m;
        try { m = JSON.parse(String(e.data)); } catch { return; }
        if (m?.type === 'error') { clearTimeout(timer); reject(new Unreachable(`Control plane replied with error: ${m.reason ?? ''}`)); return; }
        if (m?.type !== 'service.endpoints' || !Array.isArray(m.endpoints)) return;
        const list = m.endpoints.filter((x) => x?.kind === 'asset' && Array.isArray(x.urls) && x.urls.length);
        if (list.length) { clearTimeout(timer); resolve(list); }
        // 空表:等后续推送
      });
    });
    const hit = await reach(registrations.flatMap((r) => r.urls));
    if (hit) return hit;
    throw new Unreachable(`None of the asset service addresses registered with the control plane are reachable: ${registrations.flatMap((r) => r.urls).join(', ')}`);
  } finally {
    await closeAndWait(ws);
  }
}

const CLOSE_WAIT_MS = 3000;
/**
 * 关连接并等 close 事件,最多 CLOSE_WAIT_MS。关闭握手没完成就 process.exit,
 * Windows 上 libuv 会断言 UV_HANDLE_CLOSING 崩掉(连不上素材服务时 discover 之后紧接着就退出)
 */
function closeAndWait(ws) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, CLOSE_WAIT_MS);
    ws.addEventListener('close', () => { clearTimeout(t); resolve(); }, { once: true });
    if (ws.readyState !== WebSocket.CLOSING) {
      try { ws.close(); } catch { /* 已关 */ }
    }
  });
}

let SHARED = null;

async function main() {
  try {
    const { loadSharedConfig } = await import(new URL('../../server/auth/shared-config.mjs', import.meta.url));
    SHARED = loadSharedConfig()?.[0] ?? null;
  } catch (err) {
    throw new Unreachable(safe(err?.message || err));
  }
  if (!SHARED) throw new Unreachable('No shared project config: set the environment variable PROMPTCUT_SHARED_CONFIG');
  let lanAssets = [];
  let lanDocservice = null;
  if (!args.asset && !args['no-lan']) {
    const lan = await discoverLanAsset({ projectId: SHARED.projectId, name: SHARED.name });
    result.lan = {
      found: lan.candidates.length > 0,
      ms: lan.ms,
      candidates: lan.candidates.map((c) => ({ asset: c.asset, docservice: c.docservice, hostDeviceName: c.hostDeviceName })),
      errors: lan.errors,
    };
    lanAssets = lan.candidates.map((c) => c.asset);
    lanDocservice = lan.candidates.find((c) => c.docservice)?.docservice ?? null;
    if (lanAssets.length) result.source = 'lan';
  }
  const found = await connectAndDiscover(args.docservice ?? lanDocservice ?? SHARED.url, !args.asset, lanAssets);
  const base = args.asset ? String(args.asset).replace(/\/+$/, '') : found;
  result.assetUrl = base;
  const auth = { Authorization: `Bearer ${TICKET}` };

  let buf;
  let hash;
  let chunkSize = CHUNK_DEFAULT;
  await step('generate', async () => {
    buf = crypto.randomBytes(Math.round(MB * 1024 * 1024));
    hash = sha256(buf);
    result.bytes = buf.length;
    const r = await request(`${base}/media/${hash}/chunks`, { headers: auth });
    check(r.status === 200, `chunks returned ${r.status}`);
    const st = await r.json();
    check(st.complete === false && Array.isArray(st.received) && st.received.length === 0, `Wrong reconciliation for a new hash: ${JSON.stringify(st)}`);
    if (Number.isSafeInteger(st.chunkSize) && st.chunkSize > 0) chunkSize = st.chunkSize;
  });
  if (!buf) return;
  const count = Math.max(1, Math.ceil(buf.length / chunkSize));
  const slice = (n) => buf.subarray(n * chunkSize, Math.min(buf.length, (n + 1) * chunkSize));
  const headers = { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(buf.length), 'X-Media-Ext': 'bin' };
  const putChunk = async (n, withToken, other) => {
    const extra = other ? { Authorization: `Bearer ${other}` } : withToken ? auth : {};
    const r = await request(`${base}/media/${hash}/${n}`, { method: 'PUT', body: slice(n), headers: { ...headers, ...extra } });
    const text = await r.text().catch(() => '');
    return { status: r.status, text };
  };

  await step('put-without-ticket-401', async () => {
    const r = await putChunk(0, false);
    check(r.status === 401, `PUT of chunk 0 without a ticket returned ${r.status}: ${r.text.slice(0, 200)}`);
  });

  await step('read-without-ticket-401', async () => {
    const r = await request(`${base}/media/${hash}/chunks`);
    await r.arrayBuffer().catch(() => {});
    check(r.status === 401, `Reading chunks without a ticket returned ${r.status}`);
  });

  await step('put-read-only-403', async () => {
    const r = await putChunk(0, false, READ_TICKET);
    check(r.status === 403, `PUT with a read-only ticket returned ${r.status}: ${r.text.slice(0, 200)}`);
  });

  const first = Math.min(2, count);
  await step('put-0-1-received', async () => {
    for (let n = 0; n < first; n++) {
      const r = await putChunk(n, true);
      check(r.status === 200, `PUT of chunk ${n} returned ${r.status}: ${r.text.slice(0, 200)}`);
    }
    const st = await (await request(`${base}/media/${hash}/chunks`, { headers: auth })).json();
    const want = Array.from({ length: first }, (_, i) => i);
    check(JSON.stringify(st.received) === JSON.stringify(want), `chunks reported received ${JSON.stringify(st.received)}, expected ${JSON.stringify(want)}`);
  });

  await step('put-rest-complete', async () => {
    for (let n = first; n < count; n++) {
      const r = await putChunk(n, true);
      check(r.status === 200, `PUT of chunk ${n} returned ${r.status}: ${r.text.slice(0, 200)}`);
    }
    const r = await request(`${base}/media/${hash}/complete`, { method: 'POST', headers: auth });
    const text = await r.text().catch(() => '');
    check(r.status === 200, `complete returned ${r.status}: ${text.slice(0, 200)}`);
  });

  await step('cors-get', async () => {
    const r = await request(`${base}/media/${hash}`, { headers: { Origin: LAN_ORIGIN, Range: 'bytes=0-0', ...auth } });
    await r.arrayBuffer().catch(() => {});
    check(r.status === 200 || r.status === 206, `GET returned ${r.status}`);
    check(r.headers.get('access-control-allow-origin') === '*', `Access-Control-Allow-Origin is ${r.headers.get('access-control-allow-origin')}`);
  });

  await step('range-206', async () => {
    const r = await request(`${base}/media/${hash}`, { headers: { Range: 'bytes=100-199', ...auth } });
    const got = Buffer.from(await r.arrayBuffer());
    check(r.status === 206, `Range returned ${r.status}`);
    check(got.equals(buf.subarray(100, 200)), `Range bytes are wrong (received ${got.length} bytes)`);
  });

  await step('query-ticket-range-206', async () => {
    const r = await request(`${base}/media/${hash}?t=${encodeURIComponent(READ_TICKET)}`, { headers: { Range: 'bytes=100-199' } });
    const got = Buffer.from(await r.arrayBuffer());
    check(r.status === 206, `Range with a query-string ticket returned ${r.status}`);
    check(got.equals(buf.subarray(100, 200)), 'Range bytes with a query-string ticket are wrong');
    check(r.headers.get('cache-control') === 'no-store', `Cache-Control is ${r.headers.get('cache-control')}`);
    check(r.headers.get('referrer-policy') === 'no-referrer', `Referrer-Policy is ${r.headers.get('referrer-policy')}`);
  });

  await step('download-sha256', async () => {
    const r = await request(`${base}/media/${hash}`, { headers: auth });
    const got = Buffer.from(await r.arrayBuffer());
    check(r.status === 200, `Full GET returned ${r.status}`);
    check(got.length === buf.length, `Length ${got.length}, expected ${buf.length}`);
    check(sha256(got) === hash, 'sha256 mismatch');
  });
}

main().then(
  () => finish(result.fails.length ? 1 : 0),
  (err) => {
    result.fails.push({ step: 'connect', detail: safe(err?.message || err) });
    finish(err instanceof Unreachable ? 2 : 1);
  },
);
