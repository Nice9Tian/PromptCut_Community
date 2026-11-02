/**
 * For testing only; must not be imported in production code.
 *
 * Shared utilities for SP shared project connection tests (contract
 * `docs/plan/shared-project-contract.md` Section 7 SP1-SP7).
 * Written solely according to contract, ignoring implementation (implementations are in
 * `claude/sp-hosting`, `claude/sp-routing`).
 * Interfaces already in M6a (those reconciled during integration in `auth-kit.mjs`) are reused
 * directly.
 *
 * # Assumed interfaces (function names, parameters, and module paths not fixed in the contract
 *   are all centralized here; modify only this file during integration reconciliation)
 *
 * ## Hosted bundle `cloud/server/hosted/main.mjs` (contract Section 1 fixes paths and
 *    environment variables; the three functions starting child processes are in
 *    `cloud/server/test/sp-hosted-kit.mjs`, this file keeps only ports and environment used by both
 *    sides)
 *   Environment variables: PROMPTCUT_DOCSERVICE_PORT, PROMPTCUT_ASSET_PORT, PROMPTCUT_DATA_DIR,
 *                          PROMPTCUT_CLUSTER_TOKEN, PROMPTCUT_ASSET_PUBLIC_URL,
 *                          PROMPTCUT_DOCSERVICE_PUBLIC_URL (fixed in contract).
 *   [Assumption H1] Document service is in standalone mode: WebSocket at `/`, HTTP endpoints at
 *                   `/shared/…` (same as `server/docservice/main.mjs`).
 *   [Assumption H2] Asset service path is `/api/asset/<ns>/<hash>[/<n>|/complete|/chunks]` (same as
 *                   existing middleware; public URL given in contract is formatted like
 *                   `http://…:8788/api/asset`).
 *   [Assumption H3] Readiness criterion: child process prints a `listen` event line itself (both
 *                   ports are listening), and document service `GET /shared/lookup?name=…` returns
 *                   404 JSON, asset service `GET /api/asset/media/<64 zeros>` has an HTTP response.
 *                   Ports are not fixed: system allocates free ports before starting each child
 *                   process (`hostedPorts()`: acquired via listen(0) then released, passed to child
 *                   process); running multiple `npm test` in parallel on the same machine will not
 *                   connect to someone else's instance. Recognizing the `listen` line is to rule out
 *                   "own child process failed to acquire port and another process happens to be
 *                   responding". When preempted by another process between release and child
 *                   process acquisition (child process reports `config.error` `listen`), `hostedFor`
 *                   restarts with another pair of ports.
 *   [Assumption H4] When `.layout` does not match, "refuse to start" = process exits with a non-zero
 *                   exit code (contract only mentions refusing to start, without specifying exit
 *                   code or log reason).
 *   [Assumption H5] File contents of `secrets/cluster-token` is the token itself, trailing newline
 *                   allowed.
 *   [Assumption H6] The `kind` used for registering asset service is `'asset'` (registered this way
 *                   in M5's `server/asset-announce.mjs`).
 *
 * ## Data directory layout (fixed in contract Section 1)
 *   `$DATA/docservice/` (auth/, tenants/<projectId>/),
 *   `$DATA/assets/{media,snap,px}/<first 2 hex digits of hash>/<hash>[.ext]`, `$DATA/secrets/`.
 *
 * ## `shard: true` in `fs-store` (contract Section 1)
 *   `createFsStore({ dir, shard: true })`; [Assumption S1] whole file placed in
 *   `<dir>/<first 2 hex digits of hash>/<hash>[.<ext>]` (contract states "split into subdirectories
 *   by first two digits of hash", without specifying filename of whole file in subdirectory;
 *   filename from original layout used here).
 *
 * ## Migration check `scripts/probes/shared-project-probe.mjs --role migrate-check --from <url> --to <url>`
 *    (contract Section 6)
 *   [Assumption M1] `--from` / `--to` are HTTP URLs of the hosted bundle **document service**
 *                   (formatted like `http://127.0.0.1:5490`), while asset service URLs are fetched
 *                   by probe itself via `service.endpoints`; cluster token is read from environment
 *                   variable `PROMPTCUT_CLUSTER_TOKEN` (project count can only be fully counted via
 *                   management interface).
 *   [Assumption M2] Result is the last line of JSON on stdout, with an `ok` boolean field.
 *
 * ## Default hosted URL `server/auth/hosted-default.mjs` (file and constant names fixed in contract Section 3)
 *   [Assumption D1] Also exports `resolveHostedUrl({ ui, env })`: `ui` is the modified value in
 *                   the UI (undefined if unmodified), `env` defaults to `process.env`.
 *
 * ## Routing `server/auth/route.mjs` (file and two function names fixed in contract Section 3)
 *   `findSharedProject({ name, hostedUrl, lan: { discover, manual } })` → `{ candidates, errors }`
 *   (fixed in contract).
 *   [Assumption R1] `lan.discover` is `(opts) => Promise<announce[]>`, where announce represents
 *                   fields of response packet in Section 4 (projectId, name, mode, hostDeviceName,
 *                   docservice, asset); mock discover in tests ignores parameters and only returns
 *                   packets matching this project name.
 *   [Assumption R2] `hostedUrl` is formatted like `http://host:port` (no trailing slash);
 *                   hosted-side queries hit `<hostedUrl>/shared/lookup?name=`.
 *   [Assumption R3] `createSharedProject({ where: 'hosted', hostedUrl, name, mode, creator: { username, password }, password, list })`,
 *                   passphrase derived on client side (server never derives, M6a Section 2);
 *                   returns `{ projectId, name, mode }` (may include more fields).
 *
 * ## LAN discovery (contract Section 4 only specifies parameters, not modules; implemented in
 *    `server/lan/discovery.mjs` during integration; reconciliation approach see `loadLan` comment below)
 *   [Assumption L0] Module `server/auth/lan-discovery.mjs` (Node-only; browser side does not
 *                   perform discovery). Exports:
 *     LAN_DISCOVERY  parameter constants { group, port, ttl, queryIntervalMs, queryRepeats,
 *                     announceIntervalMs, announceJitterMs, expireMs, maxPacketBytes,
 *                     discoverTimeoutMs, interfaceCheckMs }
 *     encodeQuery({ nonce, name? }) → Buffer
 *     encodeAnnounce(fields) → Buffer | null          returns null when exceeding 1 KiB ("do not send if oversized")
 *     decodePacket(buf) → object | null               returns null if magic / v / type is incorrect, not JSON, or exceeding 1 KiB
 *     selectInterfaces(shape of os.networkInterfaces()) → [{ name, address, netmask, broadcast }]
 *     createLanTable({ now }) → { see(announce), list() }   expires according to ttlMs in packet (default 45 s)
 *     createLanHost({ port, interfaces, projects, deviceName, docservicePort, assetPort }) → { start(), stop() }
 *        projects: () => [{ projectId, name, mode }]; responds with unicast reply upon receiving
 *        query, using address of the network interface that received query (address in interfaces)
 *     discoverLan({ name, port, interfaces, targets, timeoutMs }) → Promise<announce[]>
 *        if targets is provided, unicasts queries only to these addresses (used by local unit tests
 *        to replace multicast and directed broadcast)
 *
 * Imports only Node built-in modules, test utilities in the same directory, and `server/safe-port.mjs`
 * (avoids bad ports when picking free ports).
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
// Two IPs retired from the hosted side: 2026-10-06 Alibaba Cloud migrated to a new cloud node;
// 2026-10-22 default URL switched from the new cloud node's IP to a custom domain;

// ------------------------------------------------------------------ Free ports
// Do not use fixed ports: multiple `npm test` often run in parallel on the same machine (subagents
// in different worktrees); fixed ports would connect to someone else's instance.

/** The user's resident editor (5190) and its stage port: on machines where ephemeral port range starts from 1024, listen(0) might also allocate them; do not take them */
const RESERVED_PORTS = new Set([5190, 5191, 5192]);

/**
 * Requests n mutually distinct free TCP ports from the system: listen(0) on each one while keeping
 * all held, records ports, and releases them all together.
 * Some machines have TCP ephemeral port ranges modified to start from 1024, so listen(0) may
 * return bad ports that fetch refuses to connect to (`safe-port.mjs`) or 5190-5192; hold these
 * numbers without releasing and request another until n ports are gathered (retry at most 50 times).
 * `host` matches the address bound by the child process (hosted bundle binds to 0.0.0.0 by default).
 */
export async function freePorts(n, host = '0.0.0.0') {
  const servers = [];
  const good = [];
  try {
    for (let tries = 0; good.length < n; tries++) {
      if (tries >= n + 50) throw new Error(`freePorts: tried ${tries} times and still could not gather ${n} free ports (${servers.map((s) => s.address()?.port).join(', ')})`);
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

/** Pair of ports required by the hosted bundle { docPort, assetPort } */
export async function hostedPorts() {
  const [docPort, assetPort] = await freePorts(2);
  return { docPort, assetPort };
}

export const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
export const ZERO_HASH = '0'.repeat(64);

export function tmpDir(t, prefix = 'pc-sp-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t?.after?.(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Child process may still be holding it */ } });
  return dir;
}

// ------------------------------------------------------------------ Non-loopback IPv4 on this machine

/** An enabled, non-loopback, non-link-local IPv4 address on this machine; returns null if none (used to connect to services on 0.0.0.0 so peer address is not loopback) */
export function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return null;
}

// ------------------------------------------------------------------ Hosted bundle child process

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
 * The "env" used for auth-kit's createProject / proofFor / join: points to a standalone mode
 * document service on a host (127.0.0.1 or local LAN address). `remote` parameter is ignored
 * (peer address cannot be changed in child processes; use lanIPv4() as host for non-loopback).
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
      try { json = JSON.parse(text); } catch { /* Not JSON */ }
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

/** Asset service request (`base` formatted like `http://host:port/api/asset`) */
export async function assetReq(base, rel, { method = 'GET', headers = {}, body } = {}) {
  const r = await fetch(`${base}/${rel}`, { method, headers, body });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* Bytes */ }
  return { status: r.status, headers: r.headers, json, buf };
}

/** Whole file (single chunk) upload: PUT 0 then complete. Returns { hash, bytes, put, done } */
export async function uploadWhole(base, { ns = 'media', bytes = randomBytes(1500), ext, headers = {} } = {}) {
  const hash = sha256hex(bytes);
  const h = { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length), ...(ext ? { 'X-Media-Ext': ext } : {}), ...headers };
  const put = await assetReq(base, `${ns}/${hash}/0`, { method: 'PUT', headers: h, body: bytes });
  const done = put.status === 200 ? await assetReq(base, `${ns}/${hash}/complete`, { method: 'POST', headers }) : null;
  return { hash, bytes, put, done };
}

// ------------------------------------------------------------------ Message utilities (built on top of auth-kit's ask)

/** Subscribes to service addresses, returns endpoints from service.endpoints */
export async function endpointsOf(c) {
  const r = await ask(c, { type: 'service.watch', kinds: 'all' }, 'service.endpoints');
  assert.equal(r.type, 'service.endpoints', JSON.stringify(r));
  return r.endpoints;
}

/** All asset URLs in endpoints */
export const assetUrls = (endpoints) => endpoints.filter((e) => e.kind === 'asset').flatMap((e) => e.urls ?? []);

/** Registers a project version and uploads snapshot (single chunk) */
export async function putSnapshot(c, projectId, text) {
  const digest = sha256hex(Buffer.from(text, 'utf8'));
  const a = await ask(c, { type: 'project.announce', projectId, digest }, 'project.announced');
  assert.equal(a.type, 'project.announced', JSON.stringify(a));
  const s = await ask(c, { type: 'project.snapshot.put', projectId, projectRev: a.projectRev, digest, index: 0, count: 1, data: text }, 'project.snapshot.stored');
  assert.equal(s.type, 'project.snapshot.stored', JSON.stringify(s));
  assert.equal(s.complete, true);
  return { projectRev: a.projectRev, digest };
}

/** Retrieves full snapshot text; returns null if none */
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
      throw new Error(`Get snapshot: ${JSON.stringify(m)}`);
    }
  }
}

// ------------------------------------------------------------------ Migration check probe

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
      try { json = JSON.parse(last); } catch { /* Not JSON */ }
      resolve({ code, out, err, json });
    });
  });
}

// ------------------------------------------------------------------ Client modules (assumptions D1, R1-R3, L0)

async function importOrExplain(rel, names) {
  let mod;
  try {
    mod = await import(rel);
  } catch (err) {
    throw new Error(`Failed to load ${rel} (has the SP implementation not been merged yet?): ${err?.message ?? err}`);
  }
  for (const n of names) {
    assert.ok(n in mod, `${rel} must export ${n}; actual exports: ${Object.keys(mod).join(', ')}`);
  }
  return mod;
}

export const loadHostedDefault = () => importOrExplain('../auth/hosted-default.mjs', ['DEFAULT_HOSTED_URL', 'resolveHostedUrl']);
export const loadRoute = () => importOrExplain('../auth/route.mjs', ['findSharedProject', 'createSharedProject']);
/**
 * [Integration glue, L0] The implemented module is `server/lan/discovery.mjs`; names and parameter
 * shapes differ from assumptions, mapped one-to-one here (parameter values for assertions untouched):
 *   LAN_DISCOVERY      Implementation uses uppercase keys (GROUP, PORT, TTL, QUERY_INTERVAL_MS,
 *                      QUERY_COUNT, ANNOUNCE_PERIOD_MS, ANNOUNCE_JITTER_MS, EXPIRE_MS,
 *                      MAX_PACKET_BYTES, DISCOVER_TIMEOUT_MS, RESCAN_MS) → converted to the
 *                      assumed lowercase keys;
 *   encodeQuery        → encodePacket(buildQuery(...)); encodeAnnounce → encodePacket(fields)
 *                      (returns null when exceeding 1 KiB);
 *   decodePacket       → parsePacket (the object returned by implementation lacks magic and v,
 *                      restored here);
 *   selectInterfaces   → same name; createLanTable → same name (`{ now }`);
 *   createLanHost      → createLanHost({ projects, hostDeviceName: deviceName,
 *                        servicePort: docservicePort, port, interfaces: () => [...] });
 *                        in implementation, document service and asset service share one port on
 *                        editor (`servicePort`); throws error directly when the two ports differ;
 *   discoverLan        → discoverLan({ name, port, interfaces: () => [...], timeoutMs }).hosts;
 *                        `targets` (unicast query to these addresses only) hits the injection point
 *                        in implementation: treats each target as "directed broadcast address"
 *                        of a network interface, so implementation sends unicast to it (multicast
 *                        copy is still sent to loopback, with no effect on results).
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
      // The implementation records announces without a nonce as nonce: null; restored as in the original packet (omit if absent)
      const { nonce, ...rest } = msg;
      return withEnvelope({ ...rest, ...(nonce === null || nonce === undefined ? {} : { nonce }) });
    },
    selectInterfaces: (nics) => m.selectInterfaces(nics),
    createLanTable: ({ now } = {}) => m.createLanTable({ now }),
    createLanHost: ({ port, interfaces, projects, deviceName, docservicePort, assetPort }) => {
      if (assetPort !== undefined && assetPort !== docservicePort) throw new Error('In the implementation the document service and the asset service share one port (servicePort)');
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

/** "Loopback interface" substituting for real network interfaces in local unit tests (used only for injection parameters of createLanHost / discoverLan) */
export const LOOP_IFACE = Object.freeze({ name: 'sp-test-lo', address: '127.0.0.1', netmask: '255.0.0.0', broadcast: '127.255.255.255' });

export { sleep, waitFor, PROTOCOL };
