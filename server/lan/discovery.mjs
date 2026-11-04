/**
 * LAN discovery (Section 4 of contract `docs/plan/shared-project-contract.md`; sole source of plan
 * is item 4 of "Design key points" in `docs/plan/direct-connect-plan.md`). Finds addresses only,
 * no forgery protection: joining a shared project still requires project credentials (M6a).
 *
 * Uses only Node built-ins `node:dgram` and `node:os` (plus in-repo field validation). Browsers
 * cannot send UDP, so they do not use this module: browser side only uses manually entered
 * addresses and the hosted side (`../auth/route.mjs`).
 *
 * | Item | Value (`LAN_DISCOVERY`) |
 * |---|---|
 * | Multicast | `239.255.42.99:54887/udp`, TTL 1 |
 * | Fallback | Queries are also sent to the subnet-directed broadcast address of each selected interface |
 * | Interface selection | Enabled, non-loopback, non-link-local (169.254/16), has IPv4 (`selectInterfaces`) |
 * | Receive | Per-interface `addMembership(group, interfaceAddress)` |
 * | Send | Sent after per-interface `setMulticastInterface(interfaceAddress)` |
 * | Query | `{ magic, v: 1, type: 'query', nonce, name? }`, sent every 500 ms, 3 times total |
 * | Response | Unicast back to querier `{ magic, v: 1, type: 'announce', nonce, projectId, name, mode, hostDeviceName, docservice, asset, ttlMs }`, address taken from interface that received query |
 * | Periodic announcement | Sent to multicast address every 15 s ± 3 s; removed by client if not seen for 45 s |
 * | Packet size | Single-packet UTF-8 JSON ≤ 1 KiB; not sent if exceeded |
 * | Interface change | Checked every 10 s; rebuilds memberships if changed |
 *
 * "Interface that received the query": Node dgram cannot obtain the receiving interface (no
 * IP_PKTINFO), so it matches the querier address against the subnet of each interface
 * (`interfaceFor`). TTL 1 queries only come from directly connected subnets, so the subnet
 * will always match; when querying itself on the same machine, the querier address is the address
 * of one of this machine's interfaces.
 *
 * Exports:
 * - Constant `LAN_DISCOVERY`;
 * - Pure functions: `selectInterfaces`, `broadcastOf`, `interfaceFor`, `interfaceSignature`,
 *   `queryTargets`, `encodePacket`, `parsePacket`, `buildQuery`, `buildAnnounce`, `nameKey`,
 *   `nextAnnounceDelay`;
 * - Host side `createLanHost`: broadcast and response;
 * - Client side `createLanClient` (can persist to receive periodic announcements, with expiration)
 *   and one-shot `discoverLan` (queries and collects, for `route.mjs`);
 *   expiration table `createLanTable` (does not touch sockets, used by `createLanClient`,
 *   verified directly by unit tests).
 */
import dgram from 'node:dgram';
import os from 'node:os';
import { isProjectId, isProjectName, isDeviceName } from '../auth/protocol.mjs';

export const LAN_DISCOVERY = Object.freeze({
  MAGIC: 'promptcut-lan',
  VERSION: 1,
  GROUP: '239.255.42.99',
  PORT: 54887,
  TTL: 1,
  QUERY_INTERVAL_MS: 500,
  QUERY_COUNT: 3,
  ANNOUNCE_PERIOD_MS: 15_000,
  ANNOUNCE_JITTER_MS: 3_000,
  EXPIRE_MS: 45_000,
  MAX_PACKET_BYTES: 1024,
  RESCAN_MS: 10_000,
  /** Total time limit for one-shot discovery (contract Section 3 "3 s limit") */
  DISCOVER_TIMEOUT_MS: 3_000,
  /** How long to wait for responses after the last query */
  DISCOVER_GRACE_MS: 500,
});

const noop = () => {};

// ---------------------------------------------------------------- Addresses and interfaces (pure functions)

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Dotted IPv4 → 32-bit unsigned integer; returns null if invalid */
export function ipv4ToInt(address) {
  const m = IPV4_RE.exec(String(address ?? ''));
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const part = Number(m[i]);
    if (part > 255) return null;
    n = n * 256 + part;
  }
  return n;
}

export const intToIpv4 = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

/** Subnet-directed broadcast address; returns null for /31 and /32 without broadcast addresses */
export function broadcastOf(address, netmask) {
  const a = ipv4ToInt(address);
  const m = ipv4ToInt(netmask);
  if (a === null || m === null) return null;
  const inv = 0xffffffff - m;
  if (inv <= 1) return null;
  // (a & m) | ~m, written arithmetically to avoid pitfalls of 32-bit signed bitwise operations
  return intToIpv4((a - (a % (inv + 1))) + inv);
}

const isLinkLocal = (address) => /^169\.254\./.test(address);
const isLoopback4 = (address) => /^127\./.test(address);

/**
 * Select interfaces: enabled, non-loopback, non-link-local, has IPv4.
 * `os.networkInterfaces()` only lists enabled interfaces (with addresses).
 * @param {ReturnType<typeof os.networkInterfaces>} [nics]
 * @returns {Array<{ name: string, address: string, netmask: string, broadcast: string | null }>} Sorted by name and address
 */
export function selectInterfaces(nics = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(nics ?? {})) {
    for (const nic of list ?? []) {
      if (!nic || nic.internal) continue;
      if (nic.family !== 'IPv4' && nic.family !== 4) continue;
      const address = String(nic.address ?? '');
      if (ipv4ToInt(address) === null || isLinkLocal(address) || isLoopback4(address) || address === '0.0.0.0') continue;
      const netmask = ipv4ToInt(nic.netmask) === null ? '255.255.255.255' : nic.netmask;
      out.push({ name, address, netmask, broadcast: broadcastOf(address, netmask) });
    }
  }
  out.sort((x, y) => (x.name === y.name ? (x.address < y.address ? -1 : x.address > y.address ? 1 : 0) : x.name < y.name ? -1 : 1));
  return out;
}

/** Fingerprint of interface list: rebuilds memberships if changed */
export const interfaceSignature = (list) => list.map((i) => `${i.name}=${i.address}/${i.netmask}`).join(';');

/**
 * Querier address → interface that received the query: first check for identical address
 * (same machine querying itself), then check for same subnet; returns null if neither matches.
 * @param {string} remote
 * @param {ReturnType<typeof selectInterfaces>} list
 */
export function interfaceFor(remote, list) {
  const r = ipv4ToInt(String(remote ?? '').replace(/^::ffff:/i, ''));
  if (r === null) return null;
  for (const i of list) if (ipv4ToInt(i.address) === r) return i;
  for (const i of list) {
    const a = ipv4ToInt(i.address);
    const m = ipv4ToInt(i.netmask);
    const size = 0xffffffff - m + 1;
    if (Math.floor(a / size) === Math.floor(r / size)) return i;
  }
  return null;
}

/**
 * Targets to send a query to: one multicast per interface (call `setMulticastInterface`
 * before sending) and one subnet-directed broadcast.
 * @returns {Array<{ iface, address: string, port: number, multicast: boolean }>}
 */
export function queryTargets(list, { group = LAN_DISCOVERY.GROUP, port = LAN_DISCOVERY.PORT } = {}) {
  const out = [];
  for (const iface of list) {
    out.push({ iface, address: group, port, multicast: true });
    if (iface.broadcast) out.push({ iface, address: iface.broadcast, port, multicast: false });
  }
  return out;
}

/** Interval for next periodic announcement: 15 s ± 3 s (`random` in [0, 1)) */
export const nextAnnounceDelay = (random = Math.random, periodMs = LAN_DISCOVERY.ANNOUNCE_PERIOD_MS, jitterMs = LAN_DISCOVERY.ANNOUNCE_JITTER_MS) =>
  Math.round(periodMs + (random() * 2 - 1) * jitterMs);

// ---------------------------------------------------------------- Packets (pure functions)

/** Project name comparison key: identical to credential store (NFC, lowercase) */
export const nameKey = (name) => String(name).normalize('NFC').toLowerCase();

/** Object → UTF-8 JSON; returns null if over 1 KiB (do not send) */
export function encodePacket(obj, max = LAN_DISCOVERY.MAX_PACKET_BYTES) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  return buf.length > max ? null : buf;
}

/** Contract Section 4 only specifies `nonce` without length limit: accepts 1 to 64 URL-safe characters (own outgoing is a 22-character random string) */
const NONCE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function urlOf(value, protocols) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const u = new URL(value);
    return protocols.includes(u.protocol) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Received packet → validated object; returns null if unrecognized, over length, or invalid fields
 * (drop, do not reply with anything).
 * @param {Buffer | Uint8Array | string} buf
 */
export function parsePacket(buf, max = LAN_DISCOVERY.MAX_PACKET_BYTES) {
  const size = typeof buf === 'string' ? Buffer.byteLength(buf, 'utf8') : buf?.length ?? 0;
  if (!size || size > max) return null;
  let m;
  try {
    m = JSON.parse(typeof buf === 'string' ? buf : Buffer.from(buf).toString('utf8'));
  } catch {
    return null;
  }
  if (!isObj(m) || m.magic !== LAN_DISCOVERY.MAGIC || m.v !== LAN_DISCOVERY.VERSION) return null;
  if (m.type === 'query') {
    if (!NONCE_RE.test(String(m.nonce ?? ''))) return null;
    if (m.name !== undefined && m.name !== null && !isProjectName(m.name)) return null;
    return { type: 'query', nonce: m.nonce, ...(isProjectName(m.name) ? { name: m.name } : {}) };
  }
  if (m.type === 'announce') {
    if (m.nonce !== undefined && m.nonce !== null && !NONCE_RE.test(String(m.nonce))) return null;
    if (!isProjectId(m.projectId) || !isProjectName(m.name) || (m.mode !== 'free' && m.mode !== 'restricted')) return null;
    if (!isDeviceName(m.hostDeviceName)) return null;
    const docservice = urlOf(m.docservice, ['ws:', 'wss:']);
    const asset = urlOf(m.asset, ['http:', 'https:']);
    if (!docservice || !asset) return null;
    const ttlMs = Number.isFinite(m.ttlMs) && m.ttlMs >= 1000 && m.ttlMs <= 600_000 ? m.ttlMs : LAN_DISCOVERY.EXPIRE_MS;
    return {
      type: 'announce', nonce: typeof m.nonce === 'string' ? m.nonce : null,
      projectId: m.projectId, name: m.name, mode: m.mode, hostDeviceName: m.hostDeviceName, docservice, asset, ttlMs,
    };
  }
  return null;
}

export function buildQuery({ nonce, name } = {}) {
  return { magic: LAN_DISCOVERY.MAGIC, v: LAN_DISCOVERY.VERSION, type: 'query', nonce, ...(name ? { name } : {}) };
}

/**
 * Announcement (response and periodic announcement share the same shape; periodic announcement
 * has no nonce). Address is taken from `iface.address`.
 * @param {object} o
 * @param {{ projectId: string, name: string, mode: string }} o.project
 * @param {{ address: string }} o.iface
 * @param {string} o.hostDeviceName
 * @param {number} o.servicePort Port of the editor (housing both document service and asset service)
 */
export function buildAnnounce({ project, iface, hostDeviceName, servicePort, docPath = '/docservice', assetPath = '/api/asset', nonce = null, ttlMs = LAN_DISCOVERY.EXPIRE_MS }) {
  const hostPort = `${iface.address}:${servicePort}`;
  return {
    magic: LAN_DISCOVERY.MAGIC, v: LAN_DISCOVERY.VERSION, type: 'announce', ...(nonce ? { nonce } : {}),
    projectId: project.projectId, name: project.name, mode: project.mode, hostDeviceName,
    docservice: `ws://${hostPort}${docPath}`, asset: `http://${hostPort}${assetPath}`, ttlMs,
  };
}

export function newNonce() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

// ---------------------------------------------------------------- Shared socket parts

const sendTo = (socket, buf, port, address) => new Promise((resolve) => {
  try {
    socket.send(buf, port, address, (err) => resolve(err ?? null));
  } catch (err) {
    resolve(err);
  }
});

/** Add or remove multicast memberships based on old and new interface lists; returns new list */
function syncMemberships(socket, group, prev, next, log) {
  const had = new Set(prev.map((i) => i.address));
  const want = new Set(next.map((i) => i.address));
  for (const address of had) {
    if (want.has(address)) continue;
    try { socket.dropMembership(group, address); } catch { /* Interface is already gone */ }
  }
  for (const address of want) {
    if (had.has(address)) continue;
    try {
      socket.addMembership(group, address);
    } catch (err) {
      log('lan.error', { stage: 'membership', address, message: String(err?.message ?? err) });
    }
  }
  return next;
}

function openSocket(dgramImpl, { port, bindAddress, onMessage, log }) {
  return new Promise((resolve, reject) => {
    const socket = dgramImpl.createSocket({ type: 'udp4', reuseAddr: true });
    let bound = false;
    socket.on('error', (err) => {
      if (!bound) {
        try { socket.close(); } catch { /* Closed */ }
        reject(err);
        return;
      }
      log('lan.error', { stage: 'socket', message: String(err?.message ?? err) });
    });
    socket.on('message', onMessage);
    socket.bind(port, bindAddress, () => {
      bound = true;
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(LAN_DISCOVERY.TTL);
        socket.setMulticastLoopback(true);
      } catch (err) {
        log('lan.error', { stage: 'socket-options', message: String(err?.message ?? err) });
      }
      resolve(socket);
    });
  });
}

// ---------------------------------------------------------------- Host side

/**
 * Broadcast and response for LAN host. Started by editor (`vite-plugin-docservice.ts`) when
 * there are LAN-mode shared projects and a non-loopback address is bound; stopped when all
 * projects are deleted or editor exits.
 *
 * @param {object} options
 * @param {() => Array<{ projectId: string, name: string, mode: string }>} options.projects Current projects to announce
 * @param {string} options.hostDeviceName
 * @param {number} options.servicePort Editor port (houses both document service `/docservice` and asset service `/api/asset`)
 * @param {string} [options.docPath]
 * @param {string} [options.assetPath]
 * @param {string} [options.group]
 * @param {number} [options.port] Port to bind, default 54887; pass 0 in tests (see `port()` to retrieve actual port)
 * @param {number} [options.announcePort] Port to send periodic announcements to, defaults to `port` (uses actual bound port when `port` is 0)
 * @param {string} [options.bindAddress] Default `0.0.0.0`
 * @param {() => ReturnType<typeof selectInterfaces>} [options.interfaces]
 * @param {number} [options.periodMs]
 * @param {number} [options.jitterMs]
 * @param {number} [options.rescanMs]
 * @param {() => number} [options.random]
 * @param {typeof dgram} [options.dgram]
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function createLanHost({
  projects,
  hostDeviceName,
  servicePort,
  docPath = '/docservice',
  assetPath = '/api/asset',
  group = LAN_DISCOVERY.GROUP,
  port = LAN_DISCOVERY.PORT,
  announcePort,
  bindAddress = '0.0.0.0',
  interfaces = () => selectInterfaces(),
  periodMs = LAN_DISCOVERY.ANNOUNCE_PERIOD_MS,
  jitterMs = LAN_DISCOVERY.ANNOUNCE_JITTER_MS,
  rescanMs = LAN_DISCOVERY.RESCAN_MS,
  random = Math.random,
  dgram: dgramImpl = dgram,
  log = noop,
} = {}) {
  if (typeof projects !== 'function') throw new TypeError('createLanHost: projects must be a function');
  if (!isDeviceName(hostDeviceName)) throw new TypeError('createLanHost: hostDeviceName is invalid');
  if (!Number.isInteger(servicePort) || servicePort <= 0) throw new TypeError('createLanHost: servicePort must be a port number');

  let socket = null;
  let starting = null;
  let ifaces = [];
  let periodTimer = null;
  let rescanTimer = null;
  let stopped = false;
  /** Same query round arrives once via multicast and once via broadcast: replies only once per (nonce, querier) within 250 ms */
  const recent = new Map();
  const stats = { queries: 0, replies: 0, announces: 0, oversize: 0, sendErrors: 0 };

  const currentProjects = () => {
    try {
      return (projects() ?? []).filter((p) => p && isProjectId(p.projectId) && isProjectName(p.name));
    } catch (err) {
      log('lan.error', { stage: 'projects', message: String(err?.message ?? err) });
      return [];
    }
  };

  async function send(obj, toPort, toAddress, multicastIface) {
    const buf = encodePacket(obj);
    if (!buf) {
      stats.oversize += 1;
      log('lan.oversize', { projectId: obj.projectId });
      return;
    }
    if (!socket) return;
    if (multicastIface) {
      try { socket.setMulticastInterface(multicastIface.address); } catch (err) {
        stats.sendErrors += 1;
        log('lan.error', { stage: 'multicast-interface', address: multicastIface.address, message: String(err?.message ?? err) });
        return;
      }
    }
    const err = await sendTo(socket, buf, toPort, toAddress);
    if (err) {
      stats.sendErrors += 1;
      log('lan.error', { stage: 'send', to: toAddress, message: String(err?.message ?? err) });
    }
  }

  /** Periodic announcement: sent to multicast address per interface and per project */
  let chain = Promise.resolve();
  function announceNow() {
    chain = chain.then(async () => {
      const list = currentProjects();
      for (const iface of ifaces) {
        for (const project of list) {
          await send(buildAnnounce({ project, iface, hostDeviceName, servicePort, docPath, assetPath }), announcePort ?? (port === 0 ? socket?.address().port : port), group, iface);
          stats.announces += 1;
        }
      }
    }).catch(noop);
    return chain;
  }

  function onMessage(buf, rinfo) {
    const msg = parsePacket(buf);
    if (!msg || msg.type !== 'query') return;
    stats.queries += 1;
    const key = `${msg.nonce}|${rinfo.address}|${rinfo.port}`;
    const at = Date.now();
    for (const [k, t] of recent) if (at - t > 250) recent.delete(k);
    if (recent.has(key)) return;
    recent.set(key, at);
    const iface = interfaceFor(rinfo.address, ifaces) ?? ifaces[0];
    if (!iface) return;
    const wanted = msg.name ? nameKey(msg.name) : null;
    const list = currentProjects().filter((p) => wanted === null || nameKey(p.name) === wanted);
    chain = chain.then(async () => {
      for (const project of list) {
        await send(buildAnnounce({ project, iface, hostDeviceName, servicePort, docPath, assetPath, nonce: msg.nonce }), rinfo.port, rinfo.address, null);
        stats.replies += 1;
      }
    }).catch(noop);
  }

  function schedulePeriod() {
    periodTimer = setTimeout(() => {
      if (stopped) return;
      announceNow();
      schedulePeriod();
    }, nextAnnounceDelay(random, periodMs, jitterMs));
    periodTimer.unref?.();
  }

  function rescan() {
    let next;
    try { next = interfaces(); } catch { next = []; }
    if (interfaceSignature(next) === interfaceSignature(ifaces)) return false;
    log('lan.interfaces', { from: ifaces.map((i) => i.address), to: next.map((i) => i.address) });
    ifaces = syncMemberships(socket, group, ifaces, next, log);
    announceNow();
    return true;
  }

  async function start() {
    if (socket) return;
    if (starting) return starting;
    stopped = false;
    starting = (async () => {
      const s = await openSocket(dgramImpl, { port, bindAddress, onMessage, log });
      if (stopped) { try { s.close(); } catch { /* Closed */ } return; }
      socket = s;
      socket.unref?.();
      let list;
      try { list = interfaces(); } catch { list = []; }
      ifaces = syncMemberships(socket, group, [], list, log);
      log('lan.start', { port: socket.address().port, interfaces: ifaces.map((i) => i.address), projects: currentProjects().length });
      announceNow();
      schedulePeriod();
      rescanTimer = setInterval(() => { if (!stopped) rescan(); }, rescanMs);
      rescanTimer.unref?.();
    })().finally(() => { starting = null; });
    return starting;
  }

  async function stop() {
    stopped = true;
    if (starting) await starting.catch(noop);
    clearTimeout(periodTimer);
    clearInterval(rescanTimer);
    periodTimer = rescanTimer = null;
    const s = socket;
    socket = null;
    ifaces = [];
    if (s) {
      await chain.catch(noop);
      await new Promise((resolve) => { try { s.close(resolve); } catch { resolve(); } });
      log('lan.stop', {});
    }
  }

  return {
    start,
    stop,
    /** Project added or removed: announce immediately once (deleted projects will no longer appear starting next round, expires on client after 45 s) */
    refresh: () => (socket ? announceNow() : Promise.resolve()),
    rescan: () => (socket ? rescan() : false),
    running: () => socket !== null,
    port: () => socket?.address().port ?? null,
    interfaces: () => ifaces.slice(),
    stats: () => ({ ...stats }),
  };
}

// ---------------------------------------------------------------- Client side

/**
 * Seen hosts table (does not touch sockets): keyed by "project + document service address",
 * expires if not seen again using the smaller of `expireMs` (45 s) and `ttlMs` from packet.
 * Used by `createLanClient`; local unit tests use it directly to verify expiration and renewal.
 *
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.expireMs]
 * @param {number} [options.startedAt] `firstSeenMs` counted from this moment, defaults to table creation time
 * @param {(hosts: object[]) => void} [options.onChange] Called when a new host is seen or several hosts are removed by `sweep`
 */
export function createLanTable({ now = Date.now, expireMs = LAN_DISCOVERY.EXPIRE_MS, startedAt, onChange = noop } = {}) {
  /** `${projectId}|${docservice}` → entry */
  const hosts = new Map();
  const t0 = Number.isFinite(startedAt) ? startedAt : now();
  const expired = (h, at) => at - h.lastSeenAt > Math.min(expireMs, h.ttlMs ?? expireMs);

  function list({ name } = {}) {
    const wanted = name ? nameKey(name) : null;
    const at = now();
    return [...hosts.values()]
      .filter((h) => !expired(h, at) && (wanted === null || nameKey(h.name) === wanted))
      .map((h) => ({ ...h }))
      .sort((a, b) => a.firstSeenMs - b.firstSeenMs);
  }

  /** Remove expired entries; returns true if any were removed */
  function sweep() {
    const at = now();
    let changed = false;
    for (const [k, h] of hosts) {
      if (expired(h, at)) { hosts.delete(k); changed = true; }
    }
    if (changed) onChange(list());
    return changed;
  }

  /**
   * Observed an announcement (processed by `parsePacket`, or object with identical fields);
   * returns whether it was newly observed.
   * @param {{ projectId: string, name: string, mode: string, hostDeviceName: string, docservice: string, asset: string, ttlMs?: number }} msg
   * @param {string | null} [from] Sender packet address
   */
  function see(msg, from = null) {
    const key = `${msg.projectId}|${msg.docservice}`;
    const at = now();
    const had = hosts.get(key);
    const fresh = !had || expired(had, at);
    hosts.set(key, {
      projectId: msg.projectId, name: msg.name, mode: msg.mode, hostDeviceName: msg.hostDeviceName,
      docservice: msg.docservice, asset: msg.asset, ttlMs: Number.isFinite(msg.ttlMs) ? msg.ttlMs : expireMs, from,
      firstSeenMs: fresh ? at - t0 : had.firstSeenMs, lastSeenAt: at,
    });
    if (fresh) onChange(list());
    return fresh;
  }

  return { see, list, sweep };
}

/**
 * Client: sends queries, receives responses; when `listen: true`, binds multicast port, joins group,
 * and persists to receive periodic announcements. Seen hosts are keyed by "project + document service
 * address", and removed if not seen again within `expireMs` (45 s).
 *
 * @param {object} [options]
 * @param {boolean} [options.listen] Default false: binds ephemeral port only, receives unicast query responses
 * @param {string} [options.group]
 * @param {number} [options.port] Port to send queries to (also bound port when `listen` is true), default 54887
 * @param {string} [options.bindAddress] Default `0.0.0.0`
 * @param {() => ReturnType<typeof selectInterfaces>} [options.interfaces]
 * @param {number} [options.expireMs]
 * @param {number} [options.rescanMs]
 * @param {() => number} [options.now]
 * @param {typeof dgram} [options.dgram]
 * @param {(hosts: object[]) => void} [options.onChange]
 * @param {(event: string, fields: object) => void} [options.log]
 */
export async function createLanClient({
  listen = false,
  group = LAN_DISCOVERY.GROUP,
  port = LAN_DISCOVERY.PORT,
  bindAddress = '0.0.0.0',
  interfaces = () => selectInterfaces(),
  expireMs = LAN_DISCOVERY.EXPIRE_MS,
  rescanMs = LAN_DISCOVERY.RESCAN_MS,
  now = Date.now,
  dgram: dgramImpl = dgram,
  onChange = noop,
  log = noop,
} = {}) {
  const table = createLanTable({ now, expireMs, onChange });
  const sweep = table.sweep;
  let ifaces = [];
  let closed = false;

  function onMessage(buf, rinfo) {
    const msg = parsePacket(buf);
    if (!msg || msg.type !== 'announce') return;
    table.see(msg, rinfo.address);
  }

  const socket = await openSocket(dgramImpl, { port: listen ? port : 0, bindAddress, onMessage, log });
  try { ifaces = interfaces(); } catch { ifaces = []; }
  if (listen) ifaces = syncMemberships(socket, group, [], ifaces, log);
  const sweepTimer = setInterval(sweep, 1000);
  sweepTimer.unref?.();
  const rescanTimer = setInterval(() => {
    let next;
    try { next = interfaces(); } catch { next = []; }
    if (interfaceSignature(next) === interfaceSignature(ifaces)) return;
    ifaces = listen ? syncMemberships(socket, group, ifaces, next, log) : next;
  }, rescanMs);
  rescanTimer.unref?.();

  const list = table.list;

  /** Send a round of queries (multicast once and subnet broadcast once per interface); returns sent packet count and errors */
  async function queryOnce({ nonce, name } = {}) {
    const buf = encodePacket(buildQuery({ nonce, name }));
    const out = { sent: 0, errors: [] };
    if (!buf || closed) return out;
    for (const t of queryTargets(ifaces, { group, port })) {
      if (t.multicast) {
        try { socket.setMulticastInterface(t.iface.address); } catch (err) {
          out.errors.push({ to: t.address, message: String(err?.message ?? err) });
          continue;
        }
      }
      const err = await sendTo(socket, buf, t.port, t.address);
      if (err) out.errors.push({ to: t.address, message: String(err?.message ?? err) });
      else out.sent += 1;
    }
    return out;
  }

  /**
   * Query: sends `count` times, spaced by `intervalMs`, with the same nonce.
   * Returns `{ sent, errors, interfaces }`.
   */
  async function query({ name, count = LAN_DISCOVERY.QUERY_COUNT, intervalMs = LAN_DISCOVERY.QUERY_INTERVAL_MS, nonce = newNonce() } = {}) {
    const total = { sent: 0, errors: [], interfaces: ifaces.map((i) => i.address) };
    for (let i = 0; i < count && !closed; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
      const r = await queryOnce({ nonce, name });
      total.sent += r.sent;
      total.errors.push(...r.errors);
    }
    return total;
  }

  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(sweepTimer);
    clearInterval(rescanTimer);
    await new Promise((resolve) => { try { socket.close(resolve); } catch { resolve(); } });
  }

  return {
    query,
    list,
    sweep,
    close,
    port: () => socket.address().port,
    interfaces: () => ifaces.slice(),
  };
}

/**
 * One-shot discovery: sends 3 queries (every 500 ms), waiting until `graceMs` after receiving
 * the last query or total time limit `timeoutMs` (default 3 s), whichever comes first.
 * Returns `{ hosts, interfaces, sent, errors, elapsedMs }`; `hosts` is ordered by first seen,
 * with `firstSeenMs` (counted from start of discovery). Does not throw if no interfaces are found
 * or socket cannot be opened: writes reasons to `errors`, `hosts` will be empty.
 *
 * @param {object} [options] Same as `createLanClient`, plus `name`, `timeoutMs`, `graceMs`, `count`, `intervalMs`
 */
export async function discoverLan({
  name,
  timeoutMs = LAN_DISCOVERY.DISCOVER_TIMEOUT_MS,
  graceMs = LAN_DISCOVERY.DISCOVER_GRACE_MS,
  count = LAN_DISCOVERY.QUERY_COUNT,
  intervalMs = LAN_DISCOVERY.QUERY_INTERVAL_MS,
  ...clientOptions
} = {}) {
  const t0 = Date.now();
  let client;
  try {
    client = await createLanClient({ ...clientOptions, listen: false });
  } catch (err) {
    return { hosts: [], interfaces: [], sent: 0, errors: [{ reason: 'socket', message: String(err?.message ?? err) }], elapsedMs: Date.now() - t0 };
  }
  if (client.interfaces().length === 0) {
    await client.close();
    return { hosts: [], interfaces: [], sent: 0, errors: [{ reason: 'no-interface' }], elapsedMs: Date.now() - t0 };
  }
  const deadline = t0 + timeoutMs;
  const sending = client.query({ name, count, intervalMs });
  const r = await Promise.race([sending, new Promise((res) => setTimeout(() => res(null), Math.max(0, deadline - Date.now())))]);
  const end = Math.min(deadline, Date.now() + graceMs);
  await new Promise((res) => setTimeout(res, Math.max(0, end - Date.now())));
  const hosts = client.list({ name });
  await client.close();
  const sent = r ?? { sent: 0, errors: [] };
  return {
    hosts,
    interfaces: client.interfaces().map((i) => i.address),
    sent: sent.sent,
    errors: sent.errors.map((e) => ({ reason: 'send', ...e })),
    elapsedMs: Date.now() - t0,
  };
}
