/**
 * 仅供测试，生产代码不得引用。
 *
 * SP 共享项目接入测试（契约 `docs/plan/shared-project-contract.md` 第 7 节 SP1～SP7）共用的工具。
 * 只照契约写，不看实现（实现在 `claude/sp-hosting`、`claude/sp-routing`）。
 * M6a 已有的接口（`auth-kit.mjs` 里集成对账过的那些）直接复用。
 *
 * # 假设的接口（契约没写死的函数名、参数与模块路径全部集中在这里；集成对账时只改本文件）
 *
 * ## 托管组合 `cloud/server/hosted/main.mjs`（契约第 1 节写死了路径与环境变量；起子进程的那三个函数在
 *    `cloud/server/test/sp-hosted-kit.mjs`，本文件只留端口与环境这些两边都用的）
 *   环境变量：PROMPTCUT_DOCSERVICE_PORT、PROMPTCUT_ASSET_PORT、PROMPTCUT_DATA_DIR、PROMPTCUT_CLUSTER_TOKEN、
 *            PROMPTCUT_ASSET_PUBLIC_URL、PROMPTCUT_DOCSERVICE_PUBLIC_URL（契约写死）。
 *   〔假设 H1〕文档服务是独立模式：WebSocket 在 `/`，HTTP 端点在 `/shared/…`（与 `server/docservice/main.mjs` 相同）。
 *   〔假设 H2〕素材服务的路径是 `/api/asset/<ns>/<hash>[/<n>|/complete|/chunks]`（与现有中间件相同；契约给的公网地址形如
 *             `http://…:8788/api/asset`）。
 *   〔假设 H3〕就绪判据：子进程自己打出 `listen` 事件行（两个端口都已监听），且文档服务 `GET /shared/lookup?name=…` 回 404 JSON、
 *             素材服务 `GET /api/asset/media/<64 个 0>` 有 HTTP 回应。端口不固定：每次起子进程前由系统分配空端口（`hostedPorts()`：
 *             listen(0) 拿到再放掉、传给子进程），同一台机器上并行跑几份 `npm test` 也不会连到别人的实例。认 `listen` 行是为了
 *             排除「自己的子进程没占到端口、别人的进程恰好在答」。放掉到子进程占上之间被别人抢走时（子进程报 `config.error`
 *             `listen`），`hostedFor` 换一对端口重起。
 *   〔假设 H4〕`.layout` 对不上时「拒绝启动」＝ 进程以非 0 退出码结束（契约只说拒绝启动，没写退出码与日志原因）。
 *   〔假设 H5〕`secrets/cluster-token` 文件内容是令牌本身，允许末尾换行。
 *   〔假设 H6〕素材服务登记用的 `kind` 是 `'asset'`（M5 的 `server/asset-announce.mjs` 就是这样登记的）。
 *
 * ## 数据目录布局（契约第 1 节写死）
 *   `$DATA/docservice/`（auth/、tenants/<projectId>/）、`$DATA/assets/{media,snap,px}/<哈希前两位>/<哈希>[.ext]`、`$DATA/secrets/`。
 *
 * ## `fs-store` 的 `shard: true`（契约第 1 节）
 *   `createFsStore({ dir, shard: true })`；〔假设 S1〕全件放在 `<dir>/<哈希前两位>/<哈希>[.<ext>]`（契约说「按哈希前两位分子目录」，
 *   没写全件在子目录里的文件名，这里按原布局的文件名）。
 *
 * ## 迁移核对 `scripts/probes/shared-project-probe.mjs --role migrate-check --from <url> --to <url>`（契约第 6 节）
 *   〔假设 M1〕`--from` / `--to` 是托管组合**文档服务**的 http 地址（形如 `http://127.0.0.1:5490`），素材服务地址由探针自己经
 *             `service.endpoints` 取；集群令牌从环境变量 `PROMPTCUT_CLUSTER_TOKEN` 读（项目数要经管理接口才数得全）。
 *   〔假设 M2〕结果是 stdout 最后一行 JSON，带 `ok` 布尔字段。
 *
 * ## 缺省托管地址 `server/auth/hosted-default.mjs`（契约第 3 节写死了文件与常量名）
 *   〔假设 D1〕另导出 `resolveHostedUrl({ ui, env })`：`ui` 是界面上改过的值（没改过是 undefined），`env` 缺省 `process.env`。
 *
 * ## 路由 `server/auth/route.mjs`（契约第 3 节写死了文件与两个函数名）
 *   `findSharedProject({ name, hostedUrl, lan: { discover, manual } })` → `{ candidates, errors }`（契约写死）。
 *   〔假设 R1〕`lan.discover` 是 `(opts) => Promise<announce[]>`，announce 为第 4 节应答包的字段
 *             （projectId、name、mode、hostDeviceName、docservice、asset）；测试的假 discover 不看参数，只回本项目名的包。
 *   〔假设 R2〕`hostedUrl` 形如 `http://host:port`（不带尾斜杠）；托管端查询打到 `<hostedUrl>/shared/lookup?name=`。
 *   〔假设 R3〕`createSharedProject({ where: 'hosted', hostedUrl, name, mode, creator: { username, password }, password, list })`，
 *             口令在客户端派生（服务端从不派生，M6a 第 2 节）；回 `{ projectId, name, mode }`（可以再多字段）。
 *
 * ## 局域网发现（契约第 4 节只定参数，没定模块；集成时实现在 `server/lan/discovery.mjs`，对法见下面 `loadLan` 的注释）
 *   〔假设 L0〕模块 `server/auth/lan-discovery.mjs`（Node 专用，浏览器侧不做发现）。导出：
 *     LAN_DISCOVERY  参数常量 { group, port, ttl, queryIntervalMs, queryRepeats, announceIntervalMs, announceJitterMs,
 *                     expireMs, maxPacketBytes, discoverTimeoutMs, interfaceCheckMs }
 *     encodeQuery({ nonce, name? }) → Buffer
 *     encodeAnnounce(fields) → Buffer | null          超过 1 KiB 回 null（「超出不发」）
 *     decodePacket(buf) → object | null               magic / v / type 不对、不是 JSON、超过 1 KiB 都回 null
 *     selectInterfaces(os.networkInterfaces() 的形状) → [{ name, address, netmask, broadcast }]
 *     createLanTable({ now }) → { see(announce), list() }   按包里的 ttlMs（缺省 45 s）过期
 *     createLanHost({ port, interfaces, projects, deviceName, docservicePort, assetPort }) → { start(), stop() }
 *        projects: () => [{ projectId, name, mode }]；收到查询后单播回应答，地址取收到查询的那块网卡（interfaces 里的 address）
 *     discoverLan({ name, port, interfaces, targets, timeoutMs }) → Promise<announce[]>
 *        targets 给了就只向这些地址单播查询（本机单测用，代替组播与定向广播）
 *
 * 只引 Node 内置模块、同目录的测试工具与 `server/safe-port.mjs`（挑空端口时避开坏端口）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { wsClient, rawHandshake, sleep, waitFor } from './fake-ws-kit.mjs';
import { ask, PROTOCOL } from './auth-kit.mjs';
import { isUnsafePort } from '../safe-port.mjs';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const PROBE = path.join(ROOT, 'scripts', 'probes', 'shared-project-probe.mjs');
// 托管端换下来的两个 IP：2026-10-06 阿里云换到新云节点，2026-10-22 缺省地址又从新云节点的 IP 换成自有域名；

// ------------------------------------------------------------------ 空端口
// 不用固定端口：同一台机器上常有几份 `npm test` 并行（不同 worktree 的子 Agent），固定端口会连到别人的实例。

/** 用户常驻的编辑器（5190）与它的舞台端口：动态端口段从 1024 起的机器上 listen(0) 也可能给到，不拿 */
const RESERVED_PORTS = new Set([5190, 5191, 5192]);

/**
 * 向系统要 n 个互不相同的空闲 TCP 端口：逐个 listen(0) 且全部占着，记下端口后一起放掉。
 * 有的机器把 TCP 动态端口段改到了从 1024 起，listen(0) 可能给到 fetch 拒连的坏端口（`safe-port.mjs`）或 5190～5192，
 * 这些号占着不放、另要一个，直到凑够 n 个（最多多试 50 次）。
 * `host` 与子进程绑的地址一致（托管组合缺省绑 0.0.0.0）。
 */
export async function freePorts(n, host = '0.0.0.0') {
  const servers = [];
  const good = [];
  try {
    for (let tries = 0; good.length < n; tries++) {
      if (tries >= n + 50) throw new Error(`freePorts：试了 ${tries} 次仍凑不够 ${n} 个可用端口（${servers.map((s) => s.address()?.port).join(', ')}）`);
      const srv = net.createServer();
      servers.push(srv);
      await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, host, resolve); });
      const port = srv.address().port;
      if (!isUnsafePort(port) && !RESERVED_PORTS.has(port)) good.push(port);
    }
    return good;
  } finally {
    await Promise.all(servers.map((s) => new Promise((resolve) => { if (s.listening) s.close(() => resolve()); else resolve(); })));
  }
}

/** 托管组合要的一对端口 { docPort, assetPort } */
export async function hostedPorts() {
  const [docPort, assetPort] = await freePorts(2);
  return { docPort, assetPort };
}

export const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
export const ZERO_HASH = '0'.repeat(64);

export function tmpDir(t, prefix = 'pc-sp-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t?.after?.(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 子进程可能还占着 */ } });
  return dir;
}

// ------------------------------------------------------------------ 本机的非回环 IPv4

/** 本机一块已启用、非回环、非链路本地的 IPv4 地址；没有就回 null（用它连 0.0.0.0 上的服务，对端地址就不是回环） */
export function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

// ------------------------------------------------------------------ 托管组合子进程

const SCRUB = [
  'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_DOCSERVICE_HOST', 'PROMPTCUT_DOCSERVICE_PORT', 'PROMPTCUT_DOCSERVICE_URL',
  'PROMPTCUT_DOCSERVICE_DATA', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_ASSET_PORT', 'PROMPTCUT_DATA_DIR',
  'PROMPTCUT_ASSET_PUBLIC_URL', 'PROMPTCUT_DOCSERVICE_PUBLIC_URL', 'PROMPTCUT_HOSTED_URL', 'PROMPTCUT_LAN_HOST',
];

export function cleanEnv(extra = {}) {
  const base = { ...process.env };
  for (const k of SCRUB) delete base[k];
  return { ...base, ...extra };
}

/**
 * 给 auth-kit 的 createProject / proofFor / join 用的「env」：对着一个 host（127.0.0.1 或本机局域网地址）上的
 * 独立模式文档服务。`remote` 参数忽略（子进程里改不了对端地址，要非回环就用 lanIPv4() 做 host）。
 */
export function docEnv(port, host = '127.0.0.1') {
  const clients = [];
  return {
    port, host,
    async http(rel, { method = 'GET', body, headers = {} } = {}) {
      const init = { method, headers: { ...headers } };
      if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
      const r = await fetch(`http://${host}:${port}/${rel}`, init);
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: r.status, headers: r.headers, json, text };
    },
    async handshake(protocols) {
      const r = await rawHandshake(port, { protocols, host });
      r.sock.destroy();
      return { status: r.status, protocol: r.headers['sec-websocket-protocol'] };
    },
    async open(protocols) {
      const c = wsClient(`ws://${host}:${port}/`, protocols);
      clients.push(c);
      await c.opened;
      return c;
    },
    closeAll() { for (const c of clients.splice(0)) c.close(); },
  };
}

/** 素材服务请求（`base` 形如 `http://host:port/api/asset`） */
export async function assetReq(base, rel, { method = 'GET', headers = {}, body } = {}) {
  const r = await fetch(`${base}/${rel}`, { method, headers, body });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* 字节 */ }
  return { status: r.status, headers: r.headers, json, buf };
}

/** 整件（单片）上传：PUT 0 再 complete。回 { hash, bytes, put, done } */
export async function uploadWhole(base, { ns = 'media', bytes = randomBytes(1500), ext, headers = {} } = {}) {
  const hash = sha256hex(bytes);
  const h = { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length), ...(ext ? { 'X-Media-Ext': ext } : {}), ...headers };
  const put = await assetReq(base, `${ns}/${hash}/0`, { method: 'PUT', headers: h, body: bytes });
  const done = put.status === 200 ? await assetReq(base, `${ns}/${hash}/complete`, { method: 'POST', headers }) : null;
  return { hash, bytes, put, done };
}

// ------------------------------------------------------------------ 消息小工具（在 auth-kit 的 ask 之上）

/** 订阅服务地址，回 service.endpoints 的 endpoints */
export async function endpointsOf(c) {
  const r = await ask(c, { type: 'service.watch', kinds: 'all' }, 'service.endpoints');
  assert.equal(r.type, 'service.endpoints', JSON.stringify(r));
  return r.endpoints;
}

/** endpoints 里全部 asset 地址 */
export const assetUrls = (endpoints) => endpoints.filter((e) => e.kind === 'asset').flatMap((e) => e.urls ?? []);

/** 登记一版项目并上传快照（单片） */
export async function putSnapshot(c, projectId, text) {
  const digest = sha256hex(Buffer.from(text, 'utf8'));
  const a = await ask(c, { type: 'project.announce', projectId, digest }, 'project.announced');
  assert.equal(a.type, 'project.announced', JSON.stringify(a));
  const s = await ask(c, { type: 'project.snapshot.put', projectId, projectRev: a.projectRev, digest, index: 0, count: 1, data: text }, 'project.snapshot.stored');
  assert.equal(s.type, 'project.snapshot.stored', JSON.stringify(s));
  assert.equal(s.complete, true);
  return { projectRev: a.projectRev, digest };
}

/** 取回快照全文；没有回 null */
export async function getSnapshot(c, projectId, projectRev) {
  const reqId = `sp-snap-${randomBytes(4).toString('hex')}`;
  c.send({ type: 'project.snapshot.get', projectId, projectRev, reqId });
  let text = '';
  for (;;) {
    const m = await c.next((x) => x?.reqId === reqId, 5000);
    if (m.type === 'project.snapshot.part') {
      if (m.missing) return null;
      text += m.data;
    } else if (m.type === 'project.snapshot.end') {
      return text;
    } else {
      throw new Error(`取快照：${JSON.stringify(m)}`);
    }
  }
}

// ------------------------------------------------------------------ 迁移核对探针

export function runProbe(args, env = {}, ms = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE, ...args], { cwd: ROOT, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      const last = out.trim().split('\n').filter(Boolean).at(-1) ?? '';
      let json = null;
      try { json = JSON.parse(last); } catch { /* 不是 JSON */ }
      resolve({ code, out, err, json });
    });
  });
}

// ------------------------------------------------------------------ 客户端模块（假设 D1、R1～R3、L0）

async function importOrExplain(rel, names) {
  let mod;
  try {
    mod = await import(rel);
  } catch (err) {
    throw new Error(`加载 ${rel} 失败（SP 实现还没合入？）：${err?.message ?? err}`);
  }
  for (const n of names) {
    assert.ok(n in mod, `${rel} 要导出 ${n}；实际导出：${Object.keys(mod).join(', ')}`);
  }
  return mod;
}

export const loadHostedDefault = () => importOrExplain('../auth/hosted-default.mjs', ['DEFAULT_HOSTED_URL', 'resolveHostedUrl']);
export const loadRoute = () => importOrExplain('../auth/route.mjs', ['findSharedProject', 'createSharedProject']);
/**
 * 〔集成胶水，L0〕实现的模块是 `server/lan/discovery.mjs`，名字与参数形状和假设不同，这里一一对上（断言用的参数值不动）：
 *   LAN_DISCOVERY      实现是大写键（GROUP、PORT、TTL、QUERY_INTERVAL_MS、QUERY_COUNT、ANNOUNCE_PERIOD_MS、ANNOUNCE_JITTER_MS、
 *                      EXPIRE_MS、MAX_PACKET_BYTES、DISCOVER_TIMEOUT_MS、RESCAN_MS）→ 换成假设的小写键；
 *   encodeQuery        → encodePacket(buildQuery(...))；encodeAnnounce → encodePacket(fields)（超过 1 KiB 回 null）；
 *   decodePacket       → parsePacket（实现回的对象不带 magic、v，这里补回去）；
 *   selectInterfaces   → 同名；createLanTable → 同名（`{ now }`）；
 *   createLanHost      → createLanHost({ projects, hostDeviceName: deviceName, servicePort: docservicePort, port, interfaces: () => [...] })；
 *                        实现里文档服务与素材服务同在编辑器一个端口上（`servicePort`），两个端口不同时这里直接报错；
 *   discoverLan        → discoverLan({ name, port, interfaces: () => [...], timeoutMs }).hosts；
 *                        `targets`（只向这些地址单播查询）落在实现的注入点上：把每个目标当成一块网卡的「定向广播地址」，
 *                        实现对它发的就是单播（组播那一份照发，发往回环，不影响结果）。
 */
export async function loadLan() {
  const m = await importOrExplain('../lan/discovery.mjs', [
    'LAN_DISCOVERY', 'encodePacket', 'parsePacket', 'buildQuery', 'selectInterfaces', 'createLanTable', 'createLanHost', 'discoverLan',
  ]);
  const P = m.LAN_DISCOVERY;
  const withEnvelope = (msg) => (msg ? { magic: P.MAGIC, v: P.VERSION, ...msg } : null);
  return {
    LAN_DISCOVERY: Object.freeze({
      group: P.GROUP, port: P.PORT, ttl: P.TTL, queryIntervalMs: P.QUERY_INTERVAL_MS, queryRepeats: P.QUERY_COUNT,
      announceIntervalMs: P.ANNOUNCE_PERIOD_MS, announceJitterMs: P.ANNOUNCE_JITTER_MS, expireMs: P.EXPIRE_MS,
      maxPacketBytes: P.MAX_PACKET_BYTES, discoverTimeoutMs: P.DISCOVER_TIMEOUT_MS, interfaceCheckMs: P.RESCAN_MS,
    }),
    encodeQuery: ({ nonce, name } = {}) => m.encodePacket(m.buildQuery({ nonce, name })),
    encodeAnnounce: (fields) => m.encodePacket(fields),
    decodePacket: (buf) => {
      const msg = m.parsePacket(buf);
      if (!msg) return null;
      // 实现把没有 nonce 的通告记成 nonce: null；按包里原样还原（没有就不带）
      const { nonce, ...rest } = msg;
      return withEnvelope({ ...rest, ...(nonce === null || nonce === undefined ? {} : { nonce }) });
    },
    selectInterfaces: (nics) => m.selectInterfaces(nics),
    createLanTable: ({ now } = {}) => m.createLanTable({ now }),
    createLanHost: ({ port, interfaces, projects, deviceName, docservicePort, assetPort }) => {
      if (assetPort !== undefined && assetPort !== docservicePort) throw new Error('实现里文档服务与素材服务同端口（servicePort）');
      const list = [...interfaces];
      return m.createLanHost({ projects, hostDeviceName: deviceName, servicePort: docservicePort, port, interfaces: () => list });
    },
    discoverLan: async ({ name, port, interfaces, targets, timeoutMs } = {}) => {
      let list = [...(interfaces ?? m.selectInterfaces())];
      if (Array.isArray(targets) && targets.length) {
        list = targets.flatMap((target) => list.map((i) => ({ ...i, broadcast: target })));
      }
      const r = await m.discoverLan({ name, ...(port !== undefined ? { port } : {}), interfaces: () => list, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      return r.hosts;
    },
  };
}

export async function loadFsStore() {
  const { createFsStore } = await import('../asset-store/fs-store.mjs');
  return createFsStore;
}

/** 本机单测里代替真实网卡的「回环网卡」（只给 createLanHost / discoverLan 的注入参数用） */
export const LOOP_IFACE = Object.freeze({ name: 'sp-test-lo', address: '127.0.0.1', netmask: '255.0.0.0', broadcast: '127.255.255.255' });

export { sleep, waitFor, PROTOCOL };
