/**
 * 仅供测试，生产代码不得引用。
 *
 * M6a 共享项目鉴权测试（契约 `docs/plan/auth-contract.md` 第 12 节 AU1～AU14）共用的工具。
 * 只照契约写，不看实现。
 *
 * # 假设的服务端接口（契约没写死，主会话集成时对账；对不上只改本文件的 `assemble` / `assetMiddleware` 两处）
 *
 *   server/auth/index.mjs
 *     createSharedHost(options) → host
 *       options.dataDir       文档服务的数据目录；凭证存储在 <dataDir>/auth/，共享项目的空间在 <dataDir>/tenants/<projectId>/
 *       options.server        给了就是挂载模式（局域网主机，vite）：挂到这个 http 服务器上，WS 路径 options.path
 *       options.path          挂载模式的 WS 路径，缺省 '/docservice'；HTTP 端点在 `<path>/shared/…`
 *       options.now           注入时钟（nonce 过期、票据过期、限速冷却、每小时建项目上限都按它算）
 *       options.log           (event, fields) => void，文档服务与鉴权的日志都走它
 *       options.device        本机设备信息 { deviceId, deviceName }（本机声明用）
 *       options.clusterToken  独立模式的集群令牌；挂载模式下不传
 *     host.service            createDocService 的返回值（describe()、close() 照旧）
 *     host.auth               凭证存储；交给素材服务核对票据
 *     host.handleHttp(req, res) → boolean   答 `shared/…` 端点（含 OPTIONS）；不归它管的回 false。
 *                             独立模式下 host 自己已接到自建服务器上，测试不再调；挂载模式由宿主（这里是测试）调
 *     host.listen(port, hostname) → Promise<address>   只在独立模式
 *     host.close() → Promise
 *
 *   server/asset-service.ts
 *     assetServiceMiddleware(root, { stores: { media }, auth: host.auth })   素材服务凭 host.auth 核对票据
 *
 *   server/auth/client.mjs（契约第 11 节）
 *     deriveKey(password, salt, kdf) → Promise<string | Uint8Array>
 *     buildAuthProtocols({ base, projectId, username, deviceId, deviceName, as, password | key, role, conversation, owner }) → Promise<string[]>
 *     ticketExpiry(ticket) → number（毫秒时间戳）
 *
 * # 模拟非回环来源
 *
 * 服务都绑 127.0.0.1、端口 0。要模拟局域网 / 公网来源时，URL 查询串加 `__remote=<地址>`：测试在服务器的
 * `request` / `upgrade` 事件上抢先挂一个监听，把 `req.socket.remoteAddress` 改成这个地址并从 `req.url` 删掉这一项，
 * 实现看不到它。没带这一项的请求把 socket 恢复成原来的回环地址（keep-alive 复用的 socket 不串）。
 *
 * # 协议自己实现
 *
 * 派生、挑战、证明、创建者操作的证明都按契约第 2、4、5、7 节用 `node:crypto` 在这里现算，不经 `client.mjs`，
 * 这样测试核对的是线上的格式本身；`client.mjs` 另有用例对拍。派生的盐按「base64url 解码后的 16 字节」喂给 PBKDF2
 * （契约写「KDF(口令, 盐)」，盐是 16 字节随机数、以 base64url 存；服务端从不派生，所以服务端用例不受这一点影响）。
 * 测试用 `iter: 100000`（契约允许的下限），省时间。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createHmac, pbkdf2Sync, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wsClient, rawHandshake, sleep, waitFor } from './fake-ws-kit.mjs';

export { wsClient, rawHandshake, sleep, waitFor };

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const KDF = Object.freeze({ alg: 'pbkdf2-sha256', iter: 100_000 });
export const PROTOCOL = 'promptcut.v1';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(s, 'base64url');

// ------------------------------------------------------------------ 时钟

/** 注入时钟：跟着真实时间走，`advance(ms)` 往前拨 */
export function testClock() {
  let offset = 0;
  const now = () => Date.now() + offset;
  return { now, advance(ms) { offset += ms; } };
}

// ------------------------------------------------------------------ 派生与证明（契约第 2、5、7 节）

const keyCache = new Map();
/** K = PBKDF2-HMAC-SHA256(口令, 盐的 16 字节, iter, 32)，base64url */
export function derive(password, salt, kdf = KDF) {
  const id = `${kdf.iter}\n${salt}\n${password}`;
  let k = keyCache.get(id);
  if (!k) {
    k = pbkdf2Sync(Buffer.from(password, 'utf8'), unb64u(salt), kdf.iter, 32, 'sha256').toString('base64url');
    keyCache.set(id, k);
  }
  return k;
}

/** 新造一份凭证记录 { username?, salt, key } */
export function credential(password, username) {
  const salt = b64u(randomBytes(16));
  const rec = { salt, key: derive(password, salt) };
  return username === undefined ? rec : { username, ...rec };
}

const hmac = (key, text) => createHmac('sha256', unb64u(key)).update(Buffer.from(text, 'utf8')).digest();

/** 握手证明 m（第 5 节） */
export function proofMac(key, { projectId, username, deviceId, as, nonce }) {
  return b64u(hmac(key, `promptcut.auth.v1\n${projectId}\n${username}\n${deviceId}\n${as}\n${nonce}`));
}

/** 创建者操作证明 m（第 7 节） */
export function adminMac(key, { projectId, username, op, nonce }) {
  return b64u(hmac(key, `promptcut.admin.v1\n${projectId}\n${username}\n${op}\n${nonce}`));
}

/** 证明子协议：`promptcut.auth.<base64url(JSON)>`；extra 可以覆盖/删除任何字段（值为 undefined 即删） */
export function authItem(fields) {
  const json = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) json[k] = v;
  return `promptcut.auth.${b64u(Buffer.from(JSON.stringify(json), 'utf8'))}`;
}

export function proofFields({ projectId, username, deviceId, deviceName, as = 'member', nonce, key, role = 'page', c, o, m }) {
  return {
    v: 1, p: projectId, u: username, d: deviceId, dn: deviceName, as, nonce,
    m: m ?? proofMac(key, { projectId, username, deviceId, as, nonce }),
    r: role, c, o,
  };
}

// ------------------------------------------------------------------ 票据（第 8 节）

export function parseTicket(ticket) {
  const [v, payload, sig] = ticket.split('.');
  return { v, payload, sig, body: JSON.parse(unb64u(payload).toString('utf8')) };
}

/** 改负载里的字段、保留原签名：签名必然不对 */
export function tamperTicket(ticket, patch) {
  const t = parseTicket(ticket);
  const body = { ...t.body, ...patch };
  return `${t.v}.${b64u(Buffer.from(JSON.stringify(body), 'utf8'))}.${t.sig}`;
}

/** 签名段最后一个字符换掉 */
export function flipSignature(ticket) {
  const last = ticket.at(-1);
  return ticket.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

// ------------------------------------------------------------------ 组装（假设的接口集中在这里）

export async function loadClient() {
  const mod = await import('../auth/client.mjs');
  for (const name of ['deriveKey', 'buildAuthProtocols', 'ticketExpiry']) {
    assert.equal(typeof mod[name], 'function', `server/auth/client.mjs 要导出 ${name}（契约第 11 节）；实际导出：${Object.keys(mod).join(', ')}`);
  }
  return mod;
}

/**
 * 组装入口（集成对账后接到实际实现）：`server/docservice/shared-service.mjs` 的 `createSharedDocService`，
 * 凭证存储 `server/auth/store.mjs` 的 `openCredentialStore({ dir: <dataDir>/auth })`，素材票据核对器
 * `server/auth/asset-tickets.mjs` 的 `createAssetTicketVerifier`。回的 host 形状与文件头的假设一致。
 */
async function assemble({ dataDir, server, path: wsPath, now, log, device, clusterToken }) {
  const [{ createSharedDocService }, { openCredentialStore }, { createAssetTicketVerifier }] = await Promise.all([
    import('../docservice/shared-service.mjs'),
    import('../auth/store.mjs'),
    import('../auth/asset-tickets.mjs'),
  ]);
  const store = openCredentialStore({ dir: path.join(dataDir, 'auth'), now, log });
  const attached = !!server;
  const built = createSharedDocService({
    mode: attached ? 'lan' : 'hosted',
    dataDir,
    store,
    ...(attached ? { server, path: wsPath ?? '/docservice' } : {}),
    ...(clusterToken ? { clusterToken } : {}),
    localDevice: device,
    now,
    log,
  });
  return {
    service: built.service,
    auth: createAssetTicketVerifier({ store, now }),
    store,
    handleHttp: (req, res) => built.handleHttp(req, res),
    listen: (port, hostname) => built.service.listen(port, hostname),
    close: () => built.service.close(),
  };
}

// ------------------------------------------------------------------ 素材服务（TS 转译，同 asset-store-http.test.mjs 的办法）

let assetModPromise = null;
export function loadAsset() {
  assetModPromise ??= (async () => {
    const require_ = createRequire(import.meta.url);
    const ts = require_('typescript');
    const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-auth-asset-'));
    process.on('exit', () => { try { fs.rmSync(OUT, { recursive: true, force: true }); } catch { /* 忽略 */ } });
    const compiled = new Map();
    const resolveRel = (fromFile, spec) => {
      const base = path.resolve(path.dirname(fromFile), spec);
      for (const c of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.mjs')]) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      }
      return null;
    };
    const compileTs = (absFile) => {
      if (compiled.has(absFile)) return compiled.get(absFile);
      const rel = path.relative(ROOT, absFile).replace(/[\\/]/g, '__').replace(/\.ts$/, '');
      const outFile = path.join(OUT, `${rel}.mjs`);
      const url = pathToFileURL(outFile).href;
      compiled.set(absFile, url);
      let src = fs.readFileSync(absFile, 'utf8');
      const rewrite = (spec) => {
        const hit = resolveRel(absFile, spec);
        if (!hit) return spec;
        return hit.endsWith('.ts') ? compileTs(hit) : pathToFileURL(hit).href;
      };
      src = src.replace(/(\bfrom\s*)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
      src = src.replace(/(\bimport\s*\(\s*)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
      src = src.replace(/(\bimport\s+)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
      const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
      fs.writeFileSync(outFile, js);
      return url;
    };
    const media = await import(compileTs(path.join(ROOT, 'server', 'vite-plugin-media.ts')));
    const asset = await import(compileTs(path.join(ROOT, 'server', 'asset-service.ts')));
    const store = await import('../asset-store/index.mjs');
    return { media, asset, store };
  })();
  return assetModPromise;
}

/** 素材服务凭 host.auth（票据核对器）核对票据；实际选项名是 `tickets` */
async function assetMiddleware(root, auth) {
  const { asset, store } = await loadAsset();
  const media = store.createBlobStore({ kind: 'memory', chunkSize: 8 * 1024 * 1024 });
  return asset.assetServiceMiddleware(root, { stores: { media }, tickets: auth });
}

// ------------------------------------------------------------------ 来源地址改写

const REMOTE_PARAM = '__remote';

/** 在服务器上抢先挂监听：按 `__remote` 改 socket 的对端地址并从 URL 删掉这一项 */
export function installRemoteOverride(server) {
  const fix = (req) => {
    const sock = req.socket;
    let remote = null;
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      remote = u.searchParams.get(REMOTE_PARAM);
      if (remote !== null) {
        u.searchParams.delete(REMOTE_PARAM);
        req.url = u.pathname + (u.search === '?' ? '' : u.search);
      }
    } catch { /* 原样 */ }
    if (Object.hasOwn(sock, 'remoteAddress')) delete sock.remoteAddress;
    if (remote !== null) Object.defineProperty(sock, 'remoteAddress', { value: remote, configurable: true, enumerable: true });
  };
  server.prependListener('request', fix);
  server.prependListener('upgrade', fix);
}

/** 路径加上 `__remote` */
export function withRemote(p, remote) {
  if (!remote) return p;
  return `${p}${p.includes('?') ? '&' : '?'}${REMOTE_PARAM}=${encodeURIComponent(remote)}`;
}

// ------------------------------------------------------------------ 起服务

export const HOST_DEVICE = Object.freeze({ deviceId: 'host-device-0001', deviceName: 'LanHost' });

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pc-auth-'));
}

/**
 * 起一台带共享项目鉴权的文档服务（端口 0）。
 * @param {object} [o]
 * @param {boolean} [o.attached] 挂载模式（局域网主机）；缺省独立模式（托管端）
 * @param {string} [o.clusterToken] 独立模式的集群令牌
 * @param {ReturnType<typeof testClock>} [o.clock]
 * @param {boolean} [o.assets] 同一进程里再起素材服务（共用 host.auth）
 */
export async function startHost({ attached = false, clusterToken, clock = testClock(), assets = false } = {}) {
  const dataDir = tempDataDir();
  const logs = [];
  const log = (event, fields) => logs.push({ event, ...fields });
  const wsPath = attached ? '/docservice' : '/';
  const httpPrefix = attached ? '/docservice/' : '/';
  let host;
  let hostServer = null;
  let port;
  if (attached) {
    let handle = null;
    hostServer = http.createServer((req, res) => {
      if (handle && handle(req, res)) return;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    installRemoteOverride(hostServer);
    host = await assemble({ dataDir, server: hostServer, path: wsPath, now: clock.now, log, device: HOST_DEVICE });
    handle = (req, res) => host.handleHttp(req, res);
    await new Promise((resolve) => hostServer.listen(0, '127.0.0.1', resolve));
    port = hostServer.address().port;
  } else {
    host = await assemble({ dataDir, now: clock.now, log, device: HOST_DEVICE, ...(clusterToken ? { clusterToken } : {}) });
    installRemoteOverride(host.service.server);
    port = (await host.listen(0, '127.0.0.1')).port;
  }

  let assetServer = null;
  let assetPort = null;
  let assetRoot = null;
  if (assets) {
    assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-auth-assetroot-'));
    const { media } = await loadAsset();
    fs.mkdirSync(media.mediaDir(assetRoot), { recursive: true });
    const mw = await assetMiddleware(assetRoot, host.auth);
    assetServer = http.createServer((req, res) => {
      void mw(req, res, () => { res.statusCode = 404; res.end('no route'); });
    });
    installRemoteOverride(assetServer);
    await new Promise((resolve) => assetServer.listen(0, '127.0.0.1', resolve));
    assetPort = assetServer.address().port;
  }

  const clients = [];
  const env = {
    attached, host, dataDir, logs, clock, port, wsPath, clusterToken,
    get service() { return host.service; },
    httpBase: `http://127.0.0.1:${port}${httpPrefix}`,

    /** 文档服务的 `shared/…` 端点 */
    async http(rel, { method = 'GET', body, remote, headers = {}, raw } = {}) {
      const init = { method, headers: { ...headers } };
      if (raw !== undefined) init.body = raw;
      else if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
      const r = await fetch(`http://127.0.0.1:${port}${withRemote(httpPrefix + rel, remote)}`, init);
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: r.status, headers: r.headers, json, text };
    },

    /** 握手，只看状态码与回显的子协议 */
    async handshake(protocols, remote) {
      const r = await rawHandshake(port, { protocols, path: withRemote(wsPath, remote) });
      r.sock.destroy();
      return { status: r.status, protocol: r.headers['sec-websocket-protocol'] };
    },

    /** 连上（等 open）；连不上抛错 */
    async open(protocols, remote) {
      const c = wsClient(`ws://127.0.0.1:${port}${withRemote(wsPath, remote)}`, protocols);
      clients.push(c);
      await c.opened;
      return c;
    },

    /** 素材服务 */
    async asset(rel, { method = 'GET', headers = {}, body, remote } = {}) {
      assert.ok(assetPort, 'startHost 要带 assets: true');
      const r = await fetch(`http://127.0.0.1:${assetPort}${withRemote(`/api/asset/${rel}`, remote)}`, { method, headers, body });
      const buf = Buffer.from(await r.arrayBuffer());
      let json = null;
      try { json = JSON.parse(buf.toString('utf8')); } catch { /* 字节 */ }
      return { status: r.status, headers: r.headers, json, buf };
    },

    /** 当前全部连接的 principal（`describe().conns[].principal`） */
    principals() {
      return host.service.describe().conns.map((c) => c.principal);
    },

    async close() {
      for (const c of clients) c.close();
      await host.close();
      if (hostServer) {
        hostServer.closeAllConnections?.();
        await new Promise((resolve) => hostServer.close(() => resolve()));
      }
      if (assetServer) {
        assetServer.closeAllConnections?.();
        await new Promise((resolve) => assetServer.close(() => resolve()));
      }
      for (const d of [dataDir, assetRoot]) if (d) fs.rmSync(d, { recursive: true, force: true });
    },
  };
  return env;
}

/** 起服务并在用例结束时关掉 */
export async function hostFor(t, options) {
  const env = await startHost(options);
  t.after(() => env.close());
  return env;
}

// ------------------------------------------------------------------ 共享项目

let nameSeq = 0;
export const uniqueName = (prefix = 'proj') => `${prefix}-${process.pid}-${++nameSeq}`;

/**
 * 建项目。`creator`、`password`、`list` 给明文口令，这里现派生。
 * @returns {Promise<{ projectId, name, mode, creator, password?, list? }>}
 */
export async function createProject(env, {
  name = uniqueName(), mode = 'free', creator = { username: 'alice', password: 'creator-pw' },
  password = 'project-pw', list = [{ username: 'bob', password: 'bob-pw' }], remote,
} = {}) {
  const body = { name, mode, kdf: KDF, creator: credential(creator.password, creator.username) };
  if (mode === 'free') body.project = credential(password);
  else body.list = list.map((e) => credential(e.password, e.username));
  const r = await env.http('shared/create', { method: 'POST', body, remote });
  assert.equal(r.status, 201, `shared/create 应 201：${r.status} ${r.text}`);
  assert.equal(r.json.ok, true);
  return { projectId: r.json.projectId, name, mode, creator, password, list };
}

/** `POST shared/challenge` */
export async function challenge(env, { projectId, username, deviceId, as = 'member', remote }) {
  return env.http('shared/challenge', { method: 'POST', body: { projectId, username, deviceId, as }, remote });
}

let devSeq = 0;
export const newDevice = (name = 'Dev') => ({ deviceId: `dev-${process.pid}-${++devSeq}-abcdefgh`, deviceName: `${name}${devSeq}` });

/**
 * 取挑战、拼证明子协议。password 缺省按 as 与模式从 proj 里取（创建者口令 / 项目口令 / 名单里的口令）。
 * @returns {Promise<{ protocols: string[], nonce, salt, key, fields }>}
 */
export async function proofFor(env, proj, {
  username, password, key, device = newDevice(), as = 'member', role = 'page', c, o, remote, mutate,
}) {
  const ch = await challenge(env, { projectId: proj.projectId, username, deviceId: device.deviceId, as, remote });
  assert.equal(ch.status, 200, `挑战应 200：${ch.status} ${ch.text}`);
  const { nonce, salt } = ch.json;
  let pw = password;
  if (pw === undefined && key === undefined) {
    if (as === 'creator') pw = proj.creator.password;
    else if (proj.mode === 'free') pw = proj.password;
    else pw = proj.list.find((e) => e.username === username)?.password ?? 'not-listed-pw';
  }
  const k = key ?? derive(pw, salt, ch.json.kdf ?? KDF);
  let fields = proofFields({ projectId: proj.projectId, username, deviceId: device.deviceId, deviceName: device.deviceName, as, nonce, key: k, role, c, o });
  if (mutate) fields = mutate(fields) ?? fields;
  return { protocols: [PROTOCOL, authItem(fields)], nonce, salt, key: k, fields, device };
}

/** 以成员（或创建者）身份连上 */
export async function join(env, proj, opts) {
  const p = await proofFor(env, proj, opts);
  const c = await env.open(p.protocols, opts.remote);
  c.device = p.device;
  c.username = opts.username;
  return c;
}

/** 以成员身份握手，只回状态码 */
export async function joinStatus(env, proj, opts) {
  const p = await proofFor(env, proj, opts);
  return (await env.handshake(p.protocols, opts.remote)).status;
}

// ------------------------------------------------------------------ 消息

let reqSeq = 0;

/**
 * 集成对账补的调用格式：服务地址登记模块（M5 起就有，`server/docservice/modules/endpoints.mjs`）的
 * `service.watch` 要求带 `kinds`（字符串数组或 `'all'`），契约没写这个字段。用例没带时补 `'all'`。
 */
function adaptMessage(message) {
  if (message?.type === 'service.watch' && message.kinds === undefined) return { ...message, kinds: 'all' };
  return message;
}
/**
 * 发一条带 reqId 的消息，等同 reqId 的回包。
 * 契约没写 `shared.*`、`auth.ticket` 的回包带不带 reqId（已有模块都带）：给了 `types` 时，
 * 不带 reqId 且类型在 `types` 里（或是 `error`）的消息也算回包。
 */
export async function ask(c, message, types = null, ms = 3000) {
  const reqId = `au-${++reqSeq}`;
  c.send({ ...adaptMessage(message), reqId });
  const list = types ? [].concat(types, 'error') : null;
  return c.next((m) => m?.reqId === reqId || (list !== null && m?.reqId === undefined && list.includes(m?.type)), ms);
}

/** 发出后在 ms 内等同 reqId 的回包，没有就回 null */
export async function askOrNull(c, message, ms = 400) {
  try { return await ask(c, message, null, ms); } catch { return null; }
}

/** 成员列表 */
export async function members(c) {
  const r = await ask(c, { type: 'shared.members' }, 'shared.members.list');
  assert.equal(r.type, 'shared.members.list', `shared.members 回包：${JSON.stringify(r)}`);
  return r.devices;
}

/** 创建者操作：同一连接取挑战、按创建者口令算证明、发 shared.admin */
export async function adminOp(c, proj, op, fields = {}, { password = proj.creator.password, username = proj.creator.username, badProof = false, noProof = false } = {}) {
  const ch = await ask(c, { type: 'shared.challenge' }, 'shared.challenge.ok');
  // 取挑战被拒（冷却中、不是成员等）时把拒绝原样交回，由用例断言
  if (ch.type !== 'shared.challenge.ok') return ch;
  const key = derive(password, ch.salt, ch.kdf ?? KDF);
  let m = adminMac(key, { projectId: proj.projectId, username, op, nonce: ch.nonce });
  if (badProof) m = b64u(randomBytes(32));
  const msg = { type: 'shared.admin', op, ...fields };
  if (!noProof) msg.proof = { nonce: ch.nonce, m };
  return ask(c, msg, 'shared.admin.ok');
}

/** 要一张票据 */
export async function ticketOf(c, body) {
  const r = await ask(c, { type: 'auth.ticket', ...body }, 'auth.ticket.ok');
  assert.equal(r.type, 'auth.ticket.ok', `auth.ticket 回包：${JSON.stringify(r)}`);
  assert.equal(typeof r.ticket, 'string');
  return r;
}

// ------------------------------------------------------------------ 素材

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** 从回环上传一件小素材（不带票据），回哈希 */
export async function uploadLocal(env, bytes = randomBytes(1000)) {
  const hash = sha256hex(bytes);
  const put = await env.asset(`media/${hash}/0`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length) } });
  assert.equal(put.status, 200, `回环上传分片：${put.status} ${put.buf.toString()}`);
  const done = await env.asset(`media/${hash}/complete`, { method: 'POST' });
  assert.equal(done.status, 200, `回环 complete：${done.status} ${done.buf.toString()}`);
  return { hash, bytes };
}

/** 从远端写一片（用来测写入鉴权），回状态 */
export async function remotePut(env, remote, headers = {}, query = '') {
  const bytes = randomBytes(64);
  const hash = sha256hex(bytes);
  const r = await env.asset(`media/${hash}/0${query}`, { method: 'PUT', body: bytes, remote, headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length), ...headers } });
  return r;
}

export const bearer = (t) => ({ Authorization: `Bearer ${t}` });

/** 所有日志行序列化后的全文 */
export const logText = (env) => env.logs.map((l) => JSON.stringify(l)).join('\n');
