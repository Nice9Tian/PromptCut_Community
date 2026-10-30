/**
 * 仅供测试，生产代码不得引用。
 *
 * 托管方服务身份的测试（契约 `docs/plan/hosted-render-contract.md` 第 10.1 节 HR1～HR15）共用的工具：起一台带服务登记表的
 * 托管端文档服务（`mode: 'hosted'`、端口 0、本机信任关掉——与云节点同样的配置），以及服务一侧的握手、目录、票据。
 * 成员一侧的建项目、进入、创建者操作沿用 `auth-kit.mjs`（`env` 的形状与它的 `startHost` 相同）。
 * 服务握手的签名在这里照契约第 1.2 节现算（`node:crypto`），不经 `service-identity.mjs` 的客户端函数。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import {
  wsClient, rawHandshake, testClock, installRemoteOverride, withRemote, loadAsset, ask, HOST_DEVICE, PROTOCOL, b64u,
} from './auth-kit.mjs';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { openCredentialStore } from '../auth/store.mjs';
import { createAssetTicketVerifier } from '../auth/asset-tickets.mjs';
import {
  createServiceRegistry, generateServiceKeyPair, addServiceKey, retireServiceKey, newInstanceId, SERVICES_FILE,
} from '../auth/service-identity.mjs';

export const SERVICE_PREFIX = 'promptcut.service.';
export const TICKET_PREFIX = 'promptcut.ticket.';

/** 新造一把服务密钥并登记进 `file`；回服务一侧要的那份 `{ service, role, kid, pub, priv, instanceId, instanceName }` */
export function enrollService(file, { service = 'render', role = service, actsFor = service === 'agent' ? 'member' : 'self', instanceId = newInstanceId(), instanceName = `${service}-test` } = {}) {
  const pair = generateServiceKeyPair();
  addServiceKey(file, { service, role, actsFor, kid: pair.kid, pub: pair.pub });
  return { service, role, actsFor, ...pair, instanceId, instanceName };
}

/** 契约第 1.2 节的签名：Ed25519 签 `promptcut.service.v1\n<服务名>\n<instanceId>\n<nonce>` */
export function serviceSignature(priv, { service, deviceId, nonce }) {
  const key = createPrivateKey({ key: Buffer.from(priv, 'base64url'), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(`promptcut.service.v1\n${service}\n${deviceId}\n${nonce}`, 'utf8'), key).toString('base64url');
}

export const serviceItem = (fields) => {
  const json = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) json[k] = v;
  return SERVICE_PREFIX + b64u(Buffer.from(JSON.stringify(json), 'utf8'));
};

/**
 * 起一台托管端文档服务。
 * @param {object} [o]
 * @param {string[]} [o.services] 预先登记哪些服务（各一把密钥），缺省 `['render']`；`[]` 表示登记表文件不存在
 * @param {boolean} [o.registry] false：不给登记表（等同没有托管方服务的旧托管端）
 * @param {boolean} [o.attached] 挂载模式（局域网主机）
 * @param {boolean} [o.trustLoopback] 缺省 false（云节点在 nginx 之后）
 * @param {boolean} [o.assets] 同进程再起素材服务（三个命名空间，票据核对共用登记表）
 * @param {number} [o.lingerMs] 目录里 `active` 的保持时长
 * @param {Record<string, string>} [o.serviceUrls] 托管方服务对页面的公网地址（成员列表顶层 `hosted.<服务名>.url`）
 */
export async function startServiceHost({
  services = ['render'], registry: withRegistry = true, attached = false, trustLoopback = false, assets = false, lingerMs, clock = testClock(),
  serviceUrls = null,
} = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hr-'));
  const registryFile = path.join(dataDir, 'secrets', SERVICES_FILE);
  const logs = [];
  const log = (event, fields) => logs.push({ event, ...fields });
  const keys = {};
  for (const name of services) keys[name] = enrollService(registryFile, { service: name });
  const store = openCredentialStore({ dir: path.join(dataDir, 'auth'), now: clock.now, log });
  const registry = withRegistry ? createServiceRegistry({ file: registryFile, now: clock.now, minCheckMs: 0, log }) : null;

  const wsPath = attached ? '/docservice' : '/';
  const httpPrefix = attached ? '/docservice/' : '/';
  let hostServer = null;
  let handle = null;
  if (attached) {
    hostServer = http.createServer((req, res) => {
      if (handle && handle(req, res)) return;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    installRemoteOverride(hostServer);
  }
  const built = createSharedDocService({
    mode: attached ? 'lan' : 'hosted',
    dataDir,
    store,
    ...(attached ? { server: hostServer, path: wsPath } : {}),
    trustLoopback,
    localDevice: HOST_DEVICE,
    now: clock.now,
    log,
    serviceRegistry: registry,
    ...(Number.isFinite(lingerMs) ? { hostedLingerMs: lingerMs } : {}),
    ...(serviceUrls ? { hostedServiceUrls: serviceUrls } : {}),
  });
  let port;
  if (attached) {
    handle = (req, res) => built.handleHttp(req, res);
    await new Promise((resolve) => hostServer.listen(0, '127.0.0.1', resolve));
    port = hostServer.address().port;
  } else {
    installRemoteOverride(built.service.server);
    port = (await built.service.listen(0, '127.0.0.1')).port;
  }

  let assetServer = null;
  let assetPort = null;
  if (assets) {
    const { asset, store: blobs } = await loadAsset();
    const stores = Object.fromEntries(['media', 'snap', 'px'].map((ns) => [ns, blobs.createBlobStore({ kind: 'memory', chunkSize: 8 * 1024 * 1024 })]));
    const tickets = createAssetTicketVerifier({ store, now: clock.now, services: () => registry });
    const assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hr-asset-'));
    const mw = asset.assetServiceMiddleware(assetRoot, { stores, tickets, isTrusted: () => false, pxEvict: null });
    assetServer = http.createServer((req, res) => { void mw(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
    await new Promise((resolve) => assetServer.listen(0, '127.0.0.1', resolve));
    assetPort = assetServer.address().port;
    assetServer.root = assetRoot;
  }

  const clients = [];
  const env = {
    attached, dataDir, logs, clock, port, wsPath, store, registry, registryFile, keys,
    host: { service: built.service, store },
    get service() { return built.service; },
    authenticate: built.authenticate,

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

    async handshake(protocols, remote) {
      const r = await rawHandshake(port, { protocols, path: withRemote(wsPath, remote) });
      r.sock.destroy();
      return { status: r.status, protocol: r.headers['sec-websocket-protocol'] };
    },

    async open(protocols, remote) {
      const c = wsClient(`ws://127.0.0.1:${port}${withRemote(wsPath, remote)}`, protocols);
      clients.push(c);
      await c.opened;
      return c;
    },

    async asset(rel, { method = 'GET', headers = {}, body } = {}) {
      assert.ok(assetPort, 'startServiceHost 要带 assets: true');
      const r = await fetch(`http://127.0.0.1:${assetPort}/api/asset/${rel}`, { method, headers, body });
      const buf = Buffer.from(await r.arrayBuffer());
      let json = null;
      try { json = JSON.parse(buf.toString('utf8')); } catch { /* 字节 */ }
      return { status: r.status, json, buf };
    },

    principals() {
      return built.service.describe().conns.map((c) => c.principal);
    },

    /** 让目录模块立刻走一拍（保持期到期、登记表重读都在 tick 里） */
    tickHosted() { built.service.tick('hosted'); },

    /** 换一把新密钥并登记（旧的还在）；回新的那份 */
    enroll(options) { return enrollService(registryFile, options); },
    retire(service, kid) { return retireServiceKey(registryFile, { service, kid }); },

    async close() {
      for (const c of clients) c.close();
      await built.service.close();
      if (hostServer) {
        hostServer.closeAllConnections?.();
        await new Promise((resolve) => hostServer.close(() => resolve()));
      }
      if (assetServer) {
        assetServer.closeAllConnections?.();
        await new Promise((resolve) => assetServer.close(() => resolve()));
        fs.rmSync(assetServer.root, { recursive: true, force: true });
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return env;
}

export async function serviceHostFor(t, options) {
  const env = await startServiceHost(options);
  t.after(() => env.close());
  return env;
}

/** 取服务挑战 */
export async function serviceChallenge(env, key, { remote } = {}) {
  return env.http('shared/service-challenge', { method: 'POST', body: { service: key.service, deviceId: key.instanceId }, remote });
}

/**
 * 取挑战、拼服务握手的子协议。`mutate(fields)` 可以在签名之后改字段（造坏的握手项）。
 * @returns {Promise<{ protocols: string[], nonce: string, fields: object }>}
 */
export async function serviceProtocolsFor(env, key, { mutate, nonce: givenNonce } = {}) {
  let nonce = givenNonce;
  if (nonce === undefined) {
    const ch = await serviceChallenge(env, key);
    assert.equal(ch.status, 200, `服务挑战应 200：${ch.status} ${ch.text}`);
    nonce = ch.json.nonce;
  }
  let fields = {
    v: 1, s: key.service, kid: key.kid, d: key.instanceId, dn: key.instanceName, nonce,
    m: serviceSignature(key.priv, { service: key.service, deviceId: key.instanceId, nonce }),
  };
  if (mutate) fields = mutate(fields) ?? fields;
  return { protocols: [PROTOCOL, serviceItem(fields)], nonce, fields };
}

/** 开控制连接 */
export async function openControl(env, key) {
  const p = await serviceProtocolsFor(env, key);
  return env.open(p.protocols);
}

/** 控制连接上订阅目录，回完整清单 */
export async function watchDirectory(control) {
  const r = await ask(control, { type: 'hosted.watch' }, 'hosted.projects');
  assert.equal(r.type, 'hosted.projects', `hosted.watch 回包：${JSON.stringify(r)}`);
  assert.equal(r.full, true);
  return r.projects;
}

/** 控制连接上要一张进项目的票据；回整条回包（可能是 error） */
export function requestServiceTicket(control, projectId, extra = {}) {
  return ask(control, { type: 'hosted.ticket', projectId, ...extra }, 'hosted.ticket.ok');
}

/** 要票据并凭它开数据连接 */
export async function openData(env, control, projectId) {
  const r = await requestServiceTicket(control, projectId);
  assert.equal(r.type, 'hosted.ticket.ok', `hosted.ticket 回包：${JSON.stringify(r)}`);
  const c = await env.open([PROTOCOL, TICKET_PREFIX + r.ticket]);
  c.ticket = r.ticket;
  return c;
}

/** 发一条消息，回「类型」或「error:原因」 */
export async function outcome(c, message, okTypes = null) {
  const r = await ask(c, message, okTypes);
  return r.type === 'error' ? `error:${r.reason}` : r.type;
}

/** 假的握手请求（直接喂给 `authenticate`，测来源判断用） */
export function fakeUpgrade(protocols, { remoteAddress = '127.0.0.1', headers = {} } = {}) {
  return { method: 'GET', url: '/', socket: { remoteAddress }, headers: { 'sec-websocket-protocol': protocols.join(', '), ...headers } };
}

/** 全部数据面与管理面的消息类型（每个都有模块认领；HR4 逐个发） */
export const ALL_TYPES = [
  'project.open', 'project.announce', 'project.close', 'project.op', 'project.follow', 'project.upload', 'project.snapshot.put', 'project.snapshot.get',
  'content.put', 'content.get', 'content.list', 'content.watch',
  'events.create', 'events.complete', 'events.text', 'events.list',
  'presence.set', 'presence.clear', 'cost.put', 'cost.list',
  'shared.members', 'shared.watch', 'shared.challenge', 'shared.admin', 'auth.ticket',
  'service.announce', 'service.withdraw', 'service.watch',
  'node.hello', 'node.active', 'publisher.hello', 'queue.watch',
  'task.publish', 'task.unsubscribe', 'task.claim', 'task.progress', 'task.complete', 'task.release', 'task.fail', 'card.lock',
];
