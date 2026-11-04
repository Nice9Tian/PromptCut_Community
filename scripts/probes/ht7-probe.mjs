/**
 * HT7 probe: hit a hosted side from the outside to verify three anonymous rejections (contract
 * `docs/plan/http-transport-contract.md` Section 11 HT7, Section 10).
 *
 *   node scripts/probes/ht7-probe.mjs --base https://<host>/hosted
 *        [--asset <asset service API base>] [--admin <admin API base>] [--timeout-ms 15000]
 *
 * Does not connect to any address by default: **must explicitly provide `--base`** (http(s) base
 * address for document service, with `/hosted` when routed through nginx; ws(s):// is also accepted).
 * When the other two are omitted, infer from Alibaba Cloud isomorphic routes:
 *   --asset  defaults to `<origin of base>/media/api/asset`
 *   --admin  defaults to `--asset` with trailing `/api/asset` removed (admin API is on the asset
 *            service port: `<admin>/admin/inventory`)
 *
 * Verification (all must pass):
 *   ws-anonymous       WebSocket upgrade without any credentials (subprotocol only promptcut.v1) → 401
 *   ws-bad-token       with a random cluster token item → 401
 *   asset-anonymous    read an asset with a random hash without a ticket → 401
 *   admin-no-token     GET <admin>/admin/inventory without token → rejected (401 or 403)
 *   admin-bad-token    with random token → rejected (401 or 403)
 *
 * Output: last line is a single JSON line `{ ok, base, asset, admin, checks: [{ name, ok, status, expect }], fails }`.
 * Exit code: all pass 0; any failure 1; invalid arguments or cannot connect to any 2.
 * Running on egress-only machines behind a proxy: add `NODE_USE_ENV_PROXY=1` from Node 22.22
 * (this script's upgrade requests go through `node:http(s)`, and whether this flag takes effect
 * depends on the Node version used; run on directly connectable machines if it does not take effect).
 * Uses only Node built-in modules; carries and prints no real credentials (token items are freshly
 * generated random strings).
 */
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);

function usage(msg) {
  process.stderr.write(`${msg}\nUsage: node scripts/probes/ht7-probe.mjs --base https://<host>/hosted [--asset <url>] [--admin <url>] [--timeout-ms 15000]\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'usage', message: msg })}\n`);
  process.exit(2);
}

const rawBase = arg('--base', null);
if (!rawBase) usage('Missing --base (this probe connects to no address by default)');
let base;
try {
  base = new URL(rawBase);
} catch {
  usage(`--base is not a valid address: ${rawBase}`);
}
if (base.protocol === 'ws:') base.protocol = 'http:';
if (base.protocol === 'wss:') base.protocol = 'https:';
if (base.protocol !== 'http:' && base.protocol !== 'https:') usage('--base must be http(s):// or ws(s)://');
const basePath = base.pathname.replace(/\/+$/, '');
const asset = (arg('--asset', null) ?? `${base.origin}/media/api/asset`).replace(/\/+$/, '');
const admin = (arg('--admin', null) ?? asset.replace(/\/api\/asset$/, '')).replace(/\/+$/, '');
const timeoutMs = Number(arg('--timeout-ms', '15000')) || 15_000;

/** Send WebSocket upgrade request, checking only status code: 101 → 101; other → status code; unreachable → null */
function upgradeStatus(url, protocols) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request({
      method: 'GET',
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}` || '/',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Protocol': protocols.join(', '),
      },
      timeout: timeoutMs,
      agent: false,
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
    req.on('response', (res) => { res.resume(); res.socket?.destroy(); resolve(res.statusCode ?? null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function httpStatus(url, headers = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer().catch(() => {});
    return res.status;
  } catch {
    return null;
  }
}

const wsUrl = `${base.origin}${basePath}/`;
const randomToken = () => randomBytes(32).toString('base64url');
const checks = [];
const check = (name, status, expect) => checks.push({ name, ok: expect.includes(status), status, expect });

check('ws-anonymous', await upgradeStatus(wsUrl, ['promptcut.v1']), [401]);
check('ws-bad-token', await upgradeStatus(wsUrl, ['promptcut.v1', `promptcut.token.${randomToken()}`]), [401]);
check('asset-anonymous', await httpStatus(`${asset}/media/${randomBytes(32).toString('hex')}`), [401]);
check('admin-no-token', await httpStatus(`${admin}/admin/inventory`), [401, 403]);
check('admin-bad-token', await httpStatus(`${admin}/admin/inventory`, { Authorization: `Bearer ${randomToken()}` }), [401, 403]);

const fails = checks.filter((c) => !c.ok).map((c) => `${c.name}: expected ${c.expect.join(' / ')}, got ${c.status ?? 'unreachable'}`);
const ok = fails.length === 0;
process.stdout.write(`${JSON.stringify({ ok, base: `${base.origin}${basePath}`, asset, admin, checks, fails })}\n`);
// Do not use process.exit: force exiting on Windows before sockets finish closing crashes Node
// with 0xC0000409, losing our intended exit code
process.exitCode = ok ? 0 : checks.every((c) => c.status === null) ? 2 : 1;
