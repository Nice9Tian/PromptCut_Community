/**
 * For testing only; production code must not reference this.
 *
 * Shared utilities for host service identity tests (contract
 * `docs/plan/hosted-render-contract.md` Section 10.1 HR1-HR15): start a hosted side document
 * service with a service registry (`mode: 'hosted'`, port 0, local trust disabled: same
 * configuration as cloud nodes), along with service-side handshake, catalog, and tickets.
 * Member-side project creation, entry, and creator operations reuse `auth-kit.mjs` (the shape of
 * `env` is the same as its `startHost`).
 * Service handshake signatures are computed on the fly here per Section 1.2 of contract
 * (`node:crypto`), without using client functions from `service-identity.mjs`.
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

/**
 * Generate a new service key and register it in `file`; return
 * `{ service, role, kid, pub, priv, instanceId, instanceName }` needed by service side
 */
export function enrollService(file, { service = 'render', role = service, actsFor = service === 'agent' ? 'member' : 'self', instanceId = newInstanceId(), instanceName = `${service}-test` } = {}) {
  const pair = generateServiceKeyPair();
  addServiceKey(file, { service, role, actsFor, kid: pair.kid, pub: pair.pub });
  return { service, role, actsFor, ...pair, instanceId, instanceName };
}

/**
 * Signature for contract Section 1.2: Ed25519 signs
 * `promptcut.service.v1\n<service name>\n<instanceId>\n<nonce>`
 */
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
 * Start a hosted side document service.
 * @param {object} [o]
 * @param {string[]} [o.services] Which services to pre-register (one key each), defaults to
 * `['render']`; `[]` means registry file does not exist
 * @param {boolean} [o.registry] false: do not provide registry (equivalent to old hosted side
 * without host services)
 * @param {boolean} [o.attached] Attached mode (LAN host)
 * @param {boolean} [o.trustLoopback] Defaults to false (cloud node is behind nginx)
 * @param {boolean} [o.assets] Also start asset service in same process (three namespaces, ticket
 * verification shares registry)
 * @param {number} [o.lingerMs] Linger duration for `active` in catalog
 * @param {Record<string, string>} [o.serviceUrls] Public address of host services facing page
 * (top-level `hosted.<service name>.url` in member list)
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
      try { json = JSON.parse(text); } catch { /* Not JSON */ }
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
      assert.ok(assetPort, 'startServiceHost must be called with assets: true');
      const r = await fetch(`http://127.0.0.1:${assetPort}/api/asset/${rel}`, { method, headers, body });
      const buf = Buffer.from(await r.arrayBuffer());
      let json = null;
      try { json = JSON.parse(buf.toString('utf8')); } catch { /* Bytes */ }
      return { status: r.status, json, buf };
    },

    principals() {
      return built.service.describe().conns.map((c) => c.principal);
    },

    /**
     * Advance catalog module by one tick immediately (linger expiration and registry reread are
     * both in tick)
     */
    tickHosted() { built.service.tick('hosted'); },

    /** Switch to a new key and register it (old one remains); return the new one */
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

/** Fetch service challenge */
export async function serviceChallenge(env, key, { remote } = {}) {
  return env.http('shared/service-challenge', { method: 'POST', body: { service: key.service, deviceId: key.instanceId }, remote });
}

/**
 * Fetch challenge and assemble subprotocols for service handshake. `mutate(fields)` can modify
 * fields after signing (to forge invalid handshake items).
 * @returns {Promise<{ protocols: string[], nonce: string, fields: object }>}
 */
export async function serviceProtocolsFor(env, key, { mutate, nonce: givenNonce } = {}) {
  let nonce = givenNonce;
  if (nonce === undefined) {
    const ch = await serviceChallenge(env, key);
    assert.equal(ch.status, 200, `service challenge should return 200: ${ch.status} ${ch.text}`);
    nonce = ch.json.nonce;
  }
  let fields = {
    v: 1, s: key.service, kid: key.kid, d: key.instanceId, dn: key.instanceName, nonce,
    m: serviceSignature(key.priv, { service: key.service, deviceId: key.instanceId, nonce }),
  };
  if (mutate) fields = mutate(fields) ?? fields;
  return { protocols: [PROTOCOL, serviceItem(fields)], nonce, fields };
}

/** Open control connection */
export async function openControl(env, key) {
  const p = await serviceProtocolsFor(env, key);
  return env.open(p.protocols);
}

/** Subscribe to catalog on control connection, return full manifest */
export async function watchDirectory(control) {
  const r = await ask(control, { type: 'hosted.watch' }, 'hosted.projects');
  assert.equal(r.type, 'hosted.projects', `hosted.watch reply: ${JSON.stringify(r)}`);
  assert.equal(r.full, true);
  return r.projects;
}

/** Request ticket to enter project on control connection; return entire response (may be error) */
export function requestServiceTicket(control, projectId, extra = {}) {
  return ask(control, { type: 'hosted.ticket', projectId, ...extra }, 'hosted.ticket.ok');
}

/** Request ticket and use it to open data connection */
export async function openData(env, control, projectId) {
  const r = await requestServiceTicket(control, projectId);
  assert.equal(r.type, 'hosted.ticket.ok', `hosted.ticket reply: ${JSON.stringify(r)}`);
  const c = await env.open([PROTOCOL, TICKET_PREFIX + r.ticket]);
  c.ticket = r.ticket;
  return c;
}

/** Send a message, return "type" or "error:reason" */
export async function outcome(c, message, okTypes = null) {
  const r = await ask(c, message, okTypes);
  return r.type === 'error' ? `error:${r.reason}` : r.type;
}

/** Fake handshake request (fed directly to `authenticate`, used to test origin detection) */
export function fakeUpgrade(protocols, { remoteAddress = '127.0.0.1', headers = {} } = {}) {
  return { method: 'GET', url: '/', socket: { remoteAddress }, headers: { 'sec-websocket-protocol': protocols.join(', '), ...headers } };
}

/**
 * All data plane and management plane message types (each claimed by a module; HR4 sends them
 * one by one)
 */
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
