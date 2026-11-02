/**
 * For testing only; must not be referenced by production code.
 *
 * Shared utilities for M6a shared project authentication tests (contract
 * `docs/plan/auth-contract.md` section 12, AU1-AU14).
 * Written strictly against the contract, without looking at the implementation.
 *
 * # Assumed server interfaces (not frozen by contract, reconciled during lead session
 * integration; if mismatched, only modify `assemble` / `assetMiddleware` in this file)
 *
 *   server/auth/index.mjs
 *     createSharedHost(options) → host
 *       options.dataDir       Document service data directory; credentials stored in
 *                             <dataDir>/auth/, shared project spaces in <dataDir>/tenants/<projectId>/
 *       options.server        If provided, indicates attached mode (LAN host, vite): mounts to this
 *                             http server, WS path options.path
 *       options.path          WS path for attached mode, default '/docservice'; HTTP endpoints at
 *                             `<path>/shared/…`
 *       options.now           Injected clock (nonce expiration, ticket expiration, rate limit
 *                             cooldown, hourly project creation limit all computed from it)
 *       options.log           (event, fields) => void, all document service and auth logs go through it
 *       options.device        Local device info { deviceId, deviceName } (for local declaration)
 *       options.clusterToken  Cluster token for standalone mode; omitted in attached mode
 *     host.service            Return value of createDocService (describe(), close() as usual)
 *     host.auth               Credential store; passed to asset service to verify tickets
 *     host.handleHttp(req, res) → boolean   Handles `shared/…` endpoints (including OPTIONS);
 *                             returns false if not handled. In standalone mode host is already
 *                             connected to self-created server, not called by tests; in attached
 *                             mode called by host (test here)
 *     host.listen(port, hostname) → Promise<address>   Only in standalone mode
 *     host.close() → Promise
 *
 *   server/asset-service.ts
 *     assetServiceMiddleware(root, { stores: { media }, auth: host.auth })   Asset service verifies
 *                                                                            tickets against host.auth
 *
 *   server/auth/client.mjs (contract section 11)
 *     deriveKey(password, salt, kdf) → Promise<string | Uint8Array>
 *     buildAuthProtocols({ base, projectId, username, deviceId, deviceName, as, password | key, role, conversation, owner }) → Promise<string[]>
 *     ticketExpiry(ticket) → number (timestamp in milliseconds)
 *
 * # Simulate non-loopback sources
 *
 * All services bind to 127.0.0.1, port 0. When simulating LAN / public network sources, append
 * `__remote=<address>` to the URL query string: the test hooks a listener in advance on the server's
 * `request` / `upgrade` events, modifies `req.socket.remoteAddress` to this address, and removes
 * this entry from `req.url` so the implementation cannot see it. Requests without this entry
 * restore the socket to the original loopback address (preventing crosstalk across sockets
 * reused by keep-alive).
 *
 * # Self-implemented protocol
 *
 * Derivation, challenge, proof, and creator operation proofs are all computed on the fly here using
 * `node:crypto` according to contract sections 2, 4, 5, 7, bypassing `client.mjs`, so that tests
 * verify the wire format itself; `client.mjs` has separate test cases for cross-checking. The
 * derived salt is fed to PBKDF2 as "16 bytes after base64url decoding" (the contract writes
 * "KDF(passphrase, salt)", where salt is a 16-byte random number stored as base64url; the server
 * never derives, so server test cases are unaffected by this). Tests use `iter: 100000` (the lower
 * bound permitted by the contract) to save time.
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

// ------------------------------------------------------------------ Clock

/** Injected clock: follows real time, advanced forward with `advance(ms)` */
export function testClock() {
  let offset = 0;
  const now = () => Date.now() + offset;
  return { now, advance(ms) { offset += ms; } };
}

// ------------------------------------------------------------------ Derivation and proof (contract sections 2, 5, 7)

const keyCache = new Map();
/** K = PBKDF2-HMAC-SHA256(passphrase, 16 bytes of salt, iter, 32), base64url */
export function derive(password, salt, kdf = KDF) {
  const id = `${kdf.iter}\n${salt}\n${password}`;
  let k = keyCache.get(id);
  if (!k) {
    k = pbkdf2Sync(Buffer.from(password, 'utf8'), unb64u(salt), kdf.iter, 32, 'sha256').toString('base64url');
    keyCache.set(id, k);
  }
  return k;
}

/** Create a fresh credential record { username?, salt, key } */
export function credential(password, username) {
  const salt = b64u(randomBytes(16));
  const rec = { salt, key: derive(password, salt) };
  return username === undefined ? rec : { username, ...rec };
}

const hmac = (key, text) => createHmac('sha256', unb64u(key)).update(Buffer.from(text, 'utf8')).digest();

/** Handshake proof m (section 5) */
export function proofMac(key, { projectId, username, deviceId, as, nonce }) {
  return b64u(hmac(key, `promptcut.auth.v1\n${projectId}\n${username}\n${deviceId}\n${as}\n${nonce}`));
}

/** Creator operation proof m (section 7) */
export function adminMac(key, { projectId, username, op, nonce }) {
  return b64u(hmac(key, `promptcut.admin.v1\n${projectId}\n${username}\n${op}\n${nonce}`));
}

/** Proof subprotocol: `promptcut.auth.<base64url(JSON)>`; extra can override/delete any field (deleted if undefined) */
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

// ------------------------------------------------------------------ Tickets (section 8)

export function parseTicket(ticket) {
  const [v, payload, sig] = ticket.split('.');
  return { v, payload, sig, body: JSON.parse(unb64u(payload).toString('utf8')) };
}

/** Modify fields in payload, keep original signature: signature is bound to be invalid */
export function tamperTicket(ticket, patch) {
  const t = parseTicket(ticket);
  const body = { ...t.body, ...patch };
  return `${t.v}.${b64u(Buffer.from(JSON.stringify(body), 'utf8'))}.${t.sig}`;
}

/** Replace the last character of the signature segment */
export function flipSignature(ticket) {
  const last = ticket.at(-1);
  return ticket.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

// ------------------------------------------------------------------ Assembly (assumed interfaces are centralized here)

export async function loadClient() {
  const mod = await import('../auth/client.mjs');
  for (const name of ['deriveKey', 'buildAuthProtocols', 'ticketExpiry']) {
    assert.equal(typeof mod[name], 'function', `server/auth/client.mjs must export ${name} (contract section 11); actual exports: ${Object.keys(mod).join(', ')}`);
  }
  return mod;
}

/**
 * Assembly entry point (wired to actual implementation after integration reconciliation):
 * `createSharedDocService` in `server/docservice/shared-service.mjs`, credential store
 * `openCredentialStore({ dir: <dataDir>/auth })` in `server/auth/store.mjs`, and asset ticket
 * verifier `createAssetTicketVerifier` in `server/auth/asset-tickets.mjs`. The returned host
 * shape matches the assumptions at the top of the file.
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

// ------------------------------------------------------------------ Asset service (TS transpilation, same approach as asset-store-http.test.mjs)

let assetModPromise = null;
export function loadAsset() {
  assetModPromise ??= (async () => {
    const require_ = createRequire(import.meta.url);
    const ts = require_('typescript');
    const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-auth-asset-'));
    process.on('exit', () => { try { fs.rmSync(OUT, { recursive: true, force: true }); } catch { /* Ignore */ } });
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

/** Asset service verifies tickets via host.auth (ticket verifier); actual option name is `tickets` */
async function assetMiddleware(root, auth) {
  const { asset, store } = await loadAsset();
  const media = store.createBlobStore({ kind: 'memory', chunkSize: 8 * 1024 * 1024 });
  return asset.assetServiceMiddleware(root, { stores: { media }, tickets: auth });
}

// ------------------------------------------------------------------ Source address rewriting

const REMOTE_PARAM = '__remote';

/** Preemptively attach listener on server: rewrite socket remote address per `__remote` and remove it from URL */
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
    } catch { /* As is */ }
    if (Object.hasOwn(sock, 'remoteAddress')) delete sock.remoteAddress;
    if (remote !== null) Object.defineProperty(sock, 'remoteAddress', { value: remote, configurable: true, enumerable: true });
  };
  server.prependListener('request', fix);
  server.prependListener('upgrade', fix);
}

/** Add `__remote` to the path */
export function withRemote(p, remote) {
  if (!remote) return p;
  return `${p}${p.includes('?') ? '&' : '?'}${REMOTE_PARAM}=${encodeURIComponent(remote)}`;
}

// ------------------------------------------------------------------ Start service

export const HOST_DEVICE = Object.freeze({ deviceId: 'host-device-0001', deviceName: 'LanHost' });

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pc-auth-'));
}

/**
 * Start a document service with shared project authentication (port 0).
 * @param {object} [o]
 * @param {boolean} [o.attached] Attached mode (LAN host); defaults to standalone mode (hosted side)
 * @param {string} [o.clusterToken] Cluster token for standalone mode
 * @param {ReturnType<typeof testClock>} [o.clock]
 * @param {boolean} [o.assets] Also start asset service in the same process (sharing host.auth)
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

    /** The `shared/…` endpoint of the document service */
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

    /** Handshake, inspecting only status code and echoed subprotocol */
    async handshake(protocols, remote) {
      const r = await rawHandshake(port, { protocols, path: withRemote(wsPath, remote) });
      r.sock.destroy();
      return { status: r.status, protocol: r.headers['sec-websocket-protocol'] };
    },

    /** Connect (wait for open); throw if connection fails */
    async open(protocols, remote) {
      const c = wsClient(`ws://127.0.0.1:${port}${withRemote(wsPath, remote)}`, protocols);
      clients.push(c);
      await c.opened;
      return c;
    },

    /** Asset service */
    async asset(rel, { method = 'GET', headers = {}, body, remote } = {}) {
      assert.ok(assetPort, 'startHost needs assets: true');
      const r = await fetch(`http://127.0.0.1:${assetPort}${withRemote(`/api/asset/${rel}`, remote)}`, { method, headers, body });
      const buf = Buffer.from(await r.arrayBuffer());
      let json = null;
      try { json = JSON.parse(buf.toString('utf8')); } catch { /* Bytes */ }
      return { status: r.status, headers: r.headers, json, buf };
    },

    /** Principal of all current connections (`describe().conns[].principal`) */
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

/** Start service and shut it down when test finishes */
export async function hostFor(t, options) {
  const env = await startHost(options);
  t.after(() => env.close());
  return env;
}

// ------------------------------------------------------------------ Shared project

let nameSeq = 0;
export const uniqueName = (prefix = 'proj') => `${prefix}-${process.pid}-${++nameSeq}`;

/**
 * Create project. `creator`, `password`, and `list` take plaintext passphrases, derived on the fly here.
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
  assert.equal(r.status, 201, `shared/create should be 201: ${r.status} ${r.text}`);
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
 * Retrieve challenge and construct proof subprotocol. password defaults to being retrieved
 * from proj per `as` and mode (creator passphrase / project passphrase / passphrase in list).
 * @returns {Promise<{ protocols: string[], nonce, salt, key, fields }>}
 */
export async function proofFor(env, proj, {
  username, password, key, device = newDevice(), as = 'member', role = 'page', c, o, remote, mutate,
}) {
  const ch = await challenge(env, { projectId: proj.projectId, username, deviceId: device.deviceId, as, remote });
  assert.equal(ch.status, 200, `challenge should be 200: ${ch.status} ${ch.text}`);
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

/** Connect as a member (or creator) */
export async function join(env, proj, opts) {
  const p = await proofFor(env, proj, opts);
  const c = await env.open(p.protocols, opts.remote);
  c.device = p.device;
  c.username = opts.username;
  return c;
}

/** Handshake as a member, returning only status code */
export async function joinStatus(env, proj, opts) {
  const p = await proofFor(env, proj, opts);
  return (await env.handshake(p.protocols, opts.remote)).status;
}

// ------------------------------------------------------------------ Messages

let reqSeq = 0;

/**
 * Call format patched during integration reconciliation: `service.watch` in service address
 * registry module (present since M5, `server/docservice/modules/endpoints.mjs`) requires `kinds`
 * (string array or `'all'`), omitted in contract. Defaults to `'all'` when omitted in test cases.
 */
function adaptMessage(message) {
  if (message?.type === 'service.watch' && message.kinds === undefined) return { ...message, kinds: 'all' };
  return message;
}
/**
 * Send a message with reqId and wait for a response with the same reqId.
 * Contract does not specify whether responses for `shared.*` and `auth.ticket` carry reqId
 * (all existing modules carry it): when `types` is provided, messages without reqId whose type
 * is in `types` (or is `error`) also count as responses.
 */
export async function ask(c, message, types = null, ms = 3000) {
  const reqId = `au-${++reqSeq}`;
  c.send({ ...adaptMessage(message), reqId });
  const list = types ? [].concat(types, 'error') : null;
  return c.next((m) => m?.reqId === reqId || (list !== null && m?.reqId === undefined && list.includes(m?.type)), ms);
}

/** Wait up to ms after sending for response with same reqId, returning null if none */
export async function askOrNull(c, message, ms = 400) {
  try { return await ask(c, message, null, ms); } catch { return null; }
}

/** Member list */
export async function members(c) {
  const r = await ask(c, { type: 'shared.members' }, 'shared.members.list');
  assert.equal(r.type, 'shared.members.list', `shared.members reply: ${JSON.stringify(r)}`);
  return r.devices;
}

/** Creator operation: fetch challenge on same connection, compute proof with creator passphrase, send shared.admin */
export async function adminOp(c, proj, op, fields = {}, { password = proj.creator.password, username = proj.creator.username, badProof = false, noProof = false } = {}) {
  const ch = await ask(c, { type: 'shared.challenge' }, 'shared.challenge.ok');
  // When challenge request is rejected (in cooldown, not a member, etc.), return rejection as is
  // for test assertions
  if (ch.type !== 'shared.challenge.ok') return ch;
  const key = derive(password, ch.salt, ch.kdf ?? KDF);
  let m = adminMac(key, { projectId: proj.projectId, username, op, nonce: ch.nonce });
  if (badProof) m = b64u(randomBytes(32));
  const msg = { type: 'shared.admin', op, ...fields };
  if (!noProof) msg.proof = { nonce: ch.nonce, m };
  return ask(c, msg, 'shared.admin.ok');
}

/** Request a ticket */
export async function ticketOf(c, body) {
  const r = await ask(c, { type: 'auth.ticket', ...body }, 'auth.ticket.ok');
  assert.equal(r.type, 'auth.ticket.ok', `auth.ticket reply: ${JSON.stringify(r)}`);
  assert.equal(typeof r.ticket, 'string');
  return r;
}

// ------------------------------------------------------------------ Assets

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** Upload a small asset from loopback (without a ticket), returning the hash */
export async function uploadLocal(env, bytes = randomBytes(1000)) {
  const hash = sha256hex(bytes);
  const put = await env.asset(`media/${hash}/0`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length) } });
  assert.equal(put.status, 200, `loopback chunk upload: ${put.status} ${put.buf.toString()}`);
  const done = await env.asset(`media/${hash}/complete`, { method: 'POST' });
  assert.equal(done.status, 200, `loopback complete: ${done.status} ${done.buf.toString()}`);
  return { hash, bytes };
}

/** Write a chunk remotely (to test write authentication), returning status */
export async function remotePut(env, remote, headers = {}, query = '') {
  const bytes = randomBytes(64);
  const hash = sha256hex(bytes);
  const r = await env.asset(`media/${hash}/0${query}`, { method: 'PUT', body: bytes, remote, headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length), ...headers } });
  return r;
}

export const bearer = (t) => ({ Authorization: `Bearer ${t}` });

/** Full text of all serialized log lines */
export const logText = (env) => env.logs.map((l) => JSON.stringify(l)).join('\n');
