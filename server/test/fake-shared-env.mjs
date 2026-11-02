/**
 * Shared test fixture for shared project tests (M6a, contract `docs/plan/auth-contract.md`):
 * starts document service with credential store, creates projects, and builds subprotocols.
 *
 *   startSharedService({ mode, now, isLoopback, clusterToken, limits, dataDir })
 *       → { service, store, port, url, base, logs, dir, close() }
 *       Standalone mode (hosted) starts its own server listening on 127.0.0.1:0; attached mode
 *       (lan) starts an http server and mounts onto it, WS path /docservice.
 *       `isLoopback` defaults to false: all tests connect from 127.0.0.1; to test "LAN origin",
 *       loopback must be treated as remote.
 *   createProject(base, { name, mode, creator, password, list, kdf })  → { projectId, name, mode }
 *   join(base, { projectId, username, deviceId, deviceName, password, as, role, conversation, owner })
 *       → an open wsClient (fake-ws-kit)
 *
 * kdf defaults to the lowest 100,000 iterations for fast test runs; key derivation itself has
 * separate cross-check test cases.
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
/** A valid deviceId */
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

/** Enters with credentials; returns an open connection. On handshake failure, `opened` rejects */
export async function join(base, opts) {
  const protocols = await buildAuthProtocols({ base, deviceName: 'Test PC', role: 'page', as: 'member', ...opts });
  return wsClient(base, protocols);
}

/**
 * Test fixture for asset tickets: opens a credential store in a temporary directory (or the
 * given `auth/` directory), creates a project, and issues tickets on demand.
 *   issue(r = 'rw', at = Date.now(), userId?)  → ticket string
 *   tickets                                    → verifier passed to
 *                                                `assetServiceMiddleware(root, { tickets })`
 *   bump(fn)                                   → updates project record (generation, ban list)
 *                                                and issues new ones as usual
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
