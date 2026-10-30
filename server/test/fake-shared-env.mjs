/**
 * 共享项目测试的公共件（M6a，契约 `docs/plan/auth-contract.md`）：起带凭证存储的文档服务、建项目、拼子协议。
 *
 *   startSharedService({ mode, now, isLoopback, clusterToken, limits, dataDir })
 *       → { service, store, port, url, base, logs, dir, close() }
 *       独立模式（hosted）自建服务器监听 127.0.0.1:0；挂载模式（lan）自起一个 http 服务器挂上去，WS 路径 /docservice。
 *       `isLoopback` 缺省一律 false：测试都从 127.0.0.1 连，要测「局域网来源」就得把回环当远端。
 *   createProject(base, { name, mode, creator, password, list, kdf })  → { projectId, name, mode }
 *   join(base, { projectId, username, deviceId, deviceName, password, as, role, conversation, owner })
 *       → 已打开的 wsClient（fake-ws-kit）
 *
 * kdf 缺省用最低的 10 万次，测试跑得快；派生本身另有对拍用例。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { openCredentialStore } from '../auth/store.mjs';
import { buildAuthProtocols, createSharedProject } from '../auth/client.mjs';
import { wsClient } from './fake-ws-kit.mjs';

export const FAST_KDF = Object.freeze({ alg: 'pbkdf2-sha256', iter: 100000 });
export const LOCAL_DEVICE = Object.freeze({ deviceId: 'pc-local-device-0001', deviceName: 'host-pc' });

let devSeq = 0;
/** 一个合法的 deviceId */
export const deviceId = (tag = 'dev') => `${tag}-${String(++devSeq).padStart(4, '0')}-abcdefghij`.replace(/[^A-Za-z0-9_-]/g, '-');

export function tempDir(prefix = 'pc-shared-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function startSharedService({
  mode = 'hosted', now = Date.now, isLoopback = () => false, clusterToken, limits, dataDir = tempDir(), service: serviceOptions,
} = {}) {
  const logs = [];
  const log = (event, fields) => logs.push({ event, ...fields });
  const store = openCredentialStore({ dir: path.join(dataDir, 'auth'), now });
  let host = null;
  const built = createSharedDocService({
    mode,
    dataDir,
    store,
    ...(mode === 'lan' ? { server: (host = http.createServer()), path: '/docservice' } : {}),
    clusterToken,
    isLoopback,
    localDevice: LOCAL_DEVICE,
    now,
    log,
    limits,
    service: { autoTick: false, ...serviceOptions },
  });
  let port;
  if (mode === 'lan') {
    host.on('request', (req, res) => {
      if (!built.handleHttp(req, res)) { res.statusCode = 404; res.end(); }
    });
    await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
    port = host.address().port;
  } else {
    port = (await built.service.listen(0, '127.0.0.1')).port;
  }
  const url = mode === 'lan' ? `ws://127.0.0.1:${port}/docservice` : `ws://127.0.0.1:${port}`;
  return {
    ...built,
    store,
    port,
    url,
    base: url,
    logs,
    dir: dataDir,
    async close() {
      await built.service.close();
      if (host) await new Promise((resolve) => { host.close(() => resolve()); host.closeAllConnections?.(); });
    },
  };
}

export function createProject(base, { name = `p-${Math.random().toString(36).slice(2, 8)}`, mode = 'free', creator = { username: 'alice', password: 'creator-pw' }, password = 'project-pw', list = [], kdf = FAST_KDF } = {}) {
  return createSharedProject({ base, name, mode, creator, password, list, kdf });
}

/** 凭证明进入；回已打开的连接。握手失败时 `opened` 会 reject */
export async function join(base, opts) {
  const protocols = await buildAuthProtocols({ base, deviceName: 'Test PC', role: 'page', as: 'member', ...opts });
  return wsClient(base, protocols);
}

/**
 * 素材票据的测试件：在临时目录（或给定的 `auth/` 目录）开一份凭证存储，建一个项目，按需签票据。
 *   issue(r = 'rw', at = Date.now(), userId?)  → 票据字符串
 *   tickets                                    → 交给 `assetServiceMiddleware(root, { tickets })` 的核对器
 *   bump(fn)                                   → 改项目记录（代数、禁入表）后照常签新的
 */
export async function assetTicketKit({ dir = path.join(tempDir('pc-ticket-'), 'auth'), store: given } = {}) {
  const { signTicket } = await import('../auth/tickets.mjs');
  const { createAssetTicketVerifier } = await import('../auth/asset-tickets.mjs');
  const store = given ?? openCredentialStore({ dir });
  const cred = { salt: 'AAAAAAAAAAAAAAAAAAAAAA', key: 'A'.repeat(43) };
  const rec = store.create({ name: `t-${Math.random().toString(36).slice(2, 10)}`, mode: 'free', kdf: FAST_KDF, creator: { username: 'alice', ...cred }, project: cred });
  const projectId = rec.projectId;
  const USER = 'bob@dev-0001-abcdefghij';
  return {
    store,
    projectId,
    userId: USER,
    issue: (r = 'rw', at = Date.now(), u = USER) => signTicket(store.peek(projectId), { k: 'asset', u, r }, at).ticket,
    tickets: createAssetTicketVerifier({ store }),
    bump: (fn) => store.update(projectId, fn),
  };
}
