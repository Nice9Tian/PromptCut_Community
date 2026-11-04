// Probe: LAN asset service end-to-end (W2). See end of section 6 of docs/plan/asset-store-contract.md for contract.
//
//   PROMPTCUT_SHARED_CONFIG=<config file> node scripts/probes/asset-lan-probe.mjs [--docservice <ws://…>] [--asset <http://…/api/asset>] [--mb 20] [--timeout-ms 60000]
//
// Runs on another machine (laptop), using only Node built-in modules (requires global WebSocket
// and fetch from Node 22+), no node_modules needed.
//
// Credentials (M6a, docs/plan/auth-contract.md sections 8 and 11; cluster token is retired from
// asset service, this probe no longer reads it):
//   Environment variable PROMPTCUT_SHARED_CONFIG points to shared project config (first item).
//   Probe connects to document service using project proof (uses url in config when --docservice
//   is omitted), fetches one rw asset ticket and one read-only ticket via auth.ticket on this
//   connection; both reads and writes carry tickets. Passphrase, K, proof, and tickets in config
//   are never printed.
//
// Asset service address:
//   - When --asset is omitted: first search for this project via LAN discovery
//     (server/lan/discovery.mjs, 3 s timeout). For local projects, asset service address is
//     returned via discovery and does not enter the control plane's service.endpoints; if found,
//     takes the first working address (source: 'lan') in discovery order that responds to
//     GET <url>/media/<nonexistent hash>/chunks with ticket. When --docservice is omitted, ticket is
//     also fetched from discovered document service (same as routing in server/auth/route.mjs).
//     If not found (cloud projects, or not on same subnet), sends service.watch { kinds: ['asset'] }
//     over control plane connection, taking the first working address in registration order
//     (source: 'docservice'). Neither address is filled manually. The address lookup logic is in
//     asset-lan-discover.mjs, unit test server/test/asset-lan-discover.test.mjs;
//   - When --asset is given: use it directly (source: 'arg');
//   - --no-lan: do not perform LAN discovery, only wait for service.endpoints (legacy behavior).
//
// Assertions (in order):
//   1. Randomly generate --mb MB data, compute sha256;
//   2. PUT chunk 0 without ticket → 401; read chunks without ticket → 401; read-only ticket PUT → 403;
//   3. Upload only chunks 0 and 1 with ticket, chunks reports received: [0, 1];
//   4. Upload remaining chunks, complete → 200;
//   5. GET with Origin: http://192.168.50.247:9999 returns Access-Control-Allow-Origin: *;
//   6. Range: bytes=100-199 → 206, correct bytes; query string read-only ticket ?t= Range also 206,
//      with no-store / no-referrer;
//   7. Download whole file and verify sha256 matches.
//
// Outputs one JSON line: { ok, assetUrl, source, lan: { found, ms, candidates, errors } | null,
// bytes, steps: [{ name, ok, ms }], fails: [{ step, detail }] }
// Exit code: 0 all pass; 1 assertion failure (including timeout); 2 invalid usage, missing shared
// project config, cannot connect to control plane or asset service.
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

/** Flag without a value */
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
/** Used tickets: always scrubbed before output */
const SECRETS = new Set();
let TICKET = '';
let READ_TICKET = '';

const result = { ok: false, assetUrl: null, source: args.asset ? 'arg' : 'docservice', lan: null, bytes: 0, steps: [], fails: [] };
let finished = false;
/** Prints one JSON line and exits. Token is not in result, scrubbed again for safety */
function finish(code) {
  if (finished) return;
  finished = true;
  result.ok = code === 0 && result.fails.length === 0;
  let line = JSON.stringify(result);
  for (const secret of SECRETS) line = line.split(secret).join('<ticket>');
  process.exitCode = code;
  // Exit after writing: stdout on a pipe may be asynchronous
  process.stdout.write(`${line}\n`, () => process.exit(code));
}
/** Connection failures: exit code 2 */
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

/**
 * Single step: times and records results; assertion failures are recorded in fails but subsequent
 * steps continue running; connection failure stops the whole pass
 */
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
 * Connects to control plane via shared project, fetches asset ticket; when --asset is omitted,
 * finds the first working asset service address: if lanAssets is non-empty (LAN discovery found
 * this project), searches within it; otherwise subscribes to asset registrations and searches in order
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
        // Empty table: wait for subsequent push
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
 * Closes connection and waits for close event, up to CLOSE_WAIT_MS. If process.exit is called
 * before close handshake completes, libuv on Windows crashes on assertion UV_HANDLE_CLOSING
 * (exiting immediately after discover when failing to connect to asset service)
 */
function closeAndWait(ws) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, CLOSE_WAIT_MS);
    ws.addEventListener('close', () => { clearTimeout(t); resolve(); }, { once: true });
    if (ws.readyState !== WebSocket.CLOSING) {
      try { ws.close(); } catch { /* Closed */ }
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
