/**
 * HT7 探针：从外面敲一个托管端，核对三项匿名拒绝（契约 `docs/plan/http-transport-contract.md` 第 11 节 HT7、第 10 节）。
 *
 *   node scripts/probes/ht7-probe.mjs --base https://<host>/hosted [--asset <素材服务 API 基址>] [--admin <管理接口基址>] [--timeout-ms 15000]
 *
 * 缺省不连任何地址：**必须显式给 `--base`**（文档服务的 http(s) 基址，经 nginx 时带 `/hosted`；给 ws(s):// 也收）。
 * 另两项不给时按阿里云的同形路由推：
 *   --asset  缺省 `<base 的 origin>/media/api/asset`
 *   --admin  缺省 `--asset` 去掉结尾的 `/api/asset`（管理接口在素材服务那个端口上：`<admin>/admin/inventory`）
 *
 * 核对（全部要过）：
 *   ws-anonymous       不带任何凭证的 WebSocket 升级（子协议只有 promptcut.v1）→ 401
 *   ws-bad-token       带一个随机的集群令牌项 → 401
 *   asset-anonymous    不带票据读一个随机哈希的素材 → 401
 *   admin-no-token     不带令牌 GET <admin>/admin/inventory → 被拒（401 或 403）
 *   admin-bad-token    带随机令牌 → 被拒（401 或 403）
 *
 * 输出：最后一行一行 JSON `{ ok, base, asset, admin, checks: [{ name, ok, status, expect }], fails }`。
 * 退出码：全过 0；有一项不过 1；参数不对或一项都连不上 2。
 * 在只能出网、要经代理的机器上跑：Node 22.22 起加 `NODE_USE_ENV_PROXY=1`（本脚本的升级请求走 `node:http(s)`，
 * 该开关对它是否生效以所用 Node 版本为准；不生效时在能直连的机器上跑）。
 * 只用 Node 内置模块；不带、不打印任何真实凭证（令牌项是现生成的随机串）。
 */
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);

function usage(msg) {
  process.stderr.write(`${msg}\n用法：node scripts/probes/ht7-probe.mjs --base https://<host>/hosted [--asset <url>] [--admin <url>] [--timeout-ms 15000]\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'usage', message: msg })}\n`);
  process.exit(2);
}

const rawBase = arg('--base', null);
if (!rawBase) usage('缺 --base（本探针缺省不连任何地址）');
let base;
try {
  base = new URL(rawBase);
} catch {
  usage(`--base 不是合法地址：${rawBase}`);
}
if (base.protocol === 'ws:') base.protocol = 'http:';
if (base.protocol === 'wss:') base.protocol = 'https:';
if (base.protocol !== 'http:' && base.protocol !== 'https:') usage('--base 要是 http(s):// 或 ws(s)://');
const basePath = base.pathname.replace(/\/+$/, '');
const asset = (arg('--asset', null) ?? `${base.origin}/media/api/asset`).replace(/\/+$/, '');
const admin = (arg('--admin', null) ?? asset.replace(/\/api\/asset$/, '')).replace(/\/+$/, '');
const timeoutMs = Number(arg('--timeout-ms', '15000')) || 15_000;

/** 发一个 WebSocket 升级请求，只看状态码：101 → 101；别的 → 那个状态码；连不上 → null */
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

const fails = checks.filter((c) => !c.ok).map((c) => `${c.name}：期望 ${c.expect.join(' / ')}，实际 ${c.status ?? '连不上'}`);
const ok = fails.length === 0;
process.stdout.write(`${JSON.stringify({ ok, base: `${base.origin}${basePath}`, asset, admin, checks, fails })}\n`);
// 不用 process.exit：Windows 上在套接字还没关完时强退会让 Node 以 0xC0000409 崩掉，退出码就不是我们给的了
process.exitCode = ok ? 0 : checks.every((c) => c.status === null) ? 2 : 1;
