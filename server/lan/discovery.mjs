/**
 * 局域网发现（契约 `docs/plan/shared-project-contract.md` 第 4 节；方案的唯一出处 `docs/plan/direct-connect-plan.md`
 * 「设计要点」第 4 条）。只找地址，不做防伪：进入共享项目仍要项目凭证（M6a）。
 *
 * 只用 Node 内置的 `node:dgram`、`node:os`（另引仓库内的字段校验）。浏览器不能发 UDP，不用本模块：
 * 浏览器侧只走手填地址与托管端（`../auth/route.mjs`）。
 *
 * | 项 | 值（`LAN_DISCOVERY`） |
 * |---|---|
 * | 组播 | `239.255.42.99:54887/udp`，TTL 1 |
 * | 兜底 | 查询同时发往每个选中网卡的子网定向广播地址 |
 * | 选网卡 | 已启用、非回环、非链路本地（169.254/16）、有 IPv4（`selectInterfaces`） |
 * | 接收 | 逐网卡 `addMembership(组, 网卡地址)` |
 * | 发送 | 逐网卡 `setMulticastInterface(网卡地址)` 后发送 |
 * | 查询 | `{ magic, v: 1, type: 'query', nonce, name? }`，每 500 ms 发一次，共 3 次 |
 * | 应答 | 单播回查询方 `{ magic, v: 1, type: 'announce', nonce, projectId, name, mode, hostDeviceName, docservice, asset, ttlMs }`，地址取收到查询的那块网卡的 |
 * | 周期通告 | 每 15 s ± 3 s 向组播地址发一次；客户端 45 s 没见到就移除 |
 * | 包大小 | 单包 UTF-8 JSON ≤ 1 KiB，超出不发 |
 * | 网卡变化 | 每 10 s 查一次，变了就重建成员资格 |
 *
 * 「收到查询的那块网卡」：Node 的 dgram 拿不到收包网卡（没有 IP_PKTINFO），按查询方地址与各网卡的子网对上号
 * （`interfaceFor`）。TTL 1 的查询只会来自直连网段，所以子网一定对得上；同一台机器上自己查自己时，查询方地址就是本机某块网卡的地址。
 *
 * 导出：
 * - 常量 `LAN_DISCOVERY`；
 * - 纯函数：`selectInterfaces`、`broadcastOf`、`interfaceFor`、`interfaceSignature`、`queryTargets`、`encodePacket`、`parsePacket`、
 *   `buildQuery`、`buildAnnounce`、`nameKey`、`nextAnnounceDelay`；
 * - 主机端 `createLanHost`：广播与应答；
 * - 客户端 `createLanClient`（可常驻收周期通告、带过期）与一次性的 `discoverLan`（查询并收集，给 `route.mjs` 用）；
 *   过期表 `createLanTable`（不碰套接字，`createLanClient` 用它，单测直接验）。
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
  /** 一次性发现的总时限（契约第 3 节「限时 3 s」） */
  DISCOVER_TIMEOUT_MS: 3_000,
  /** 最后一次查询之后再等多久收应答 */
  DISCOVER_GRACE_MS: 500,
});

const noop = () => {};

// ---------------------------------------------------------------- 地址与网卡（纯函数）

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 点分 IPv4 → 32 位无符号整数；不合法回 null */
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

/** 子网定向广播地址；/31、/32 没有广播地址，回 null */
export function broadcastOf(address, netmask) {
  const a = ipv4ToInt(address);
  const m = ipv4ToInt(netmask);
  if (a === null || m === null) return null;
  const inv = 0xffffffff - m;
  if (inv <= 1) return null;
  // (a & m) | ~m，用算术写，避免 32 位有符号位运算的坑
  return intToIpv4((a - (a % (inv + 1))) + inv);
}

const isLinkLocal = (address) => /^169\.254\./.test(address);
const isLoopback4 = (address) => /^127\./.test(address);

/**
 * 选网卡：已启用、非回环、非链路本地、有 IPv4。`os.networkInterfaces()` 只列出已启用（有地址）的网卡。
 * @param {ReturnType<typeof os.networkInterfaces>} [nics]
 * @returns {Array<{ name: string, address: string, netmask: string, broadcast: string | null }>} 按名字、地址排序
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

/** 网卡列表的指纹：变了就重建成员资格 */
export const interfaceSignature = (list) => list.map((i) => `${i.name}=${i.address}/${i.netmask}`).join(';');

/**
 * 查询方地址 → 收到查询的那块网卡：先找地址相同的（同一台机器自己查自己），再找同一子网的；都没有回 null。
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
 * 一次查询要发往的目标：每块网卡一条组播（发前 `setMulticastInterface`）、一条子网定向广播。
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

/** 下一次周期通告的间隔：15 s ± 3 s（`random` 取 [0, 1)） */
export const nextAnnounceDelay = (random = Math.random, periodMs = LAN_DISCOVERY.ANNOUNCE_PERIOD_MS, jitterMs = LAN_DISCOVERY.ANNOUNCE_JITTER_MS) =>
  Math.round(periodMs + (random() * 2 - 1) * jitterMs);

// ---------------------------------------------------------------- 包（纯函数）

/** 项目名比较键：与凭证存储相同（NFC、小写） */
export const nameKey = (name) => String(name).normalize('NFC').toLowerCase();

/** 对象 → UTF-8 JSON；超过 1 KiB 回 null（不发） */
export function encodePacket(obj, max = LAN_DISCOVERY.MAX_PACKET_BYTES) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  return buf.length > max ? null : buf;
}

/** 契约第 4 节只写了 `nonce`，没限长度：收 1～64 个 URL 安全字符（自己发的是 22 位随机串） */
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
 * 收到的包 → 校验过的对象；不认识、超长、字段不对都回 null（丢掉，不回任何东西）。
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
 * 通告（应答与周期通告同形；周期通告没有 nonce）。地址取 `iface.address`。
 * @param {object} o
 * @param {{ projectId: string, name: string, mode: string }} o.project
 * @param {{ address: string }} o.iface
 * @param {string} o.hostDeviceName
 * @param {number} o.servicePort 编辑器（文档服务与素材服务同在）的端口
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

// ---------------------------------------------------------------- 套接字的公共部分

const sendTo = (socket, buf, port, address) => new Promise((resolve) => {
  try {
    socket.send(buf, port, address, (err) => resolve(err ?? null));
  } catch (err) {
    resolve(err);
  }
});

/** 按新旧网卡列表增减组播成员资格；回新的列表 */
function syncMemberships(socket, group, prev, next, log) {
  const had = new Set(prev.map((i) => i.address));
  const want = new Set(next.map((i) => i.address));
  for (const address of had) {
    if (want.has(address)) continue;
    try { socket.dropMembership(group, address); } catch { /* 网卡已经没了 */ }
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
        try { socket.close(); } catch { /* 已关 */ }
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

// ---------------------------------------------------------------- 主机端

/**
 * 局域网主机的广播与应答。编辑器（`vite-plugin-docservice.ts`）在有局域网模式的共享项目、且绑了非回环地址时起它，
 * 项目全删掉或编辑器退出时停。
 *
 * @param {object} options
 * @param {() => Array<{ projectId: string, name: string, mode: string }>} options.projects 当前要通告的项目
 * @param {string} options.hostDeviceName
 * @param {number} options.servicePort 编辑器端口（文档服务 `/docservice`、素材服务 `/api/asset` 都在它上面）
 * @param {string} [options.docPath]
 * @param {string} [options.assetPath]
 * @param {string} [options.group]
 * @param {number} [options.port] 绑定的端口，缺省 54887；测试给 0（取回实际端口见 `port()`）
 * @param {number} [options.announcePort] 周期通告发往的端口，缺省同 `port`（`port` 为 0 时取实际绑定的端口）
 * @param {string} [options.bindAddress] 缺省 `0.0.0.0`
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
  if (typeof projects !== 'function') throw new TypeError('createLanHost: projects 必须是函数');
  if (!isDeviceName(hostDeviceName)) throw new TypeError('createLanHost: hostDeviceName 不合法');
  if (!Number.isInteger(servicePort) || servicePort <= 0) throw new TypeError('createLanHost: servicePort 必须是端口号');

  let socket = null;
  let starting = null;
  let ifaces = [];
  let periodTimer = null;
  let rescanTimer = null;
  let stopped = false;
  /** 同一轮查询经组播与广播各到一次：按 (nonce, 查询方) 在 250 ms 内只答一次 */
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

  /** 周期通告：逐网卡、逐项目发到组播地址 */
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
      if (stopped) { try { s.close(); } catch { /* 已关 */ } return; }
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
    /** 项目有增删：立即通告一次（删掉的项目下一轮起不再出现，客户端 45 s 后过期） */
    refresh: () => (socket ? announceNow() : Promise.resolve()),
    rescan: () => (socket ? rescan() : false),
    running: () => socket !== null,
    port: () => socket?.address().port ?? null,
    interfaces: () => ifaces.slice(),
    stats: () => ({ ...stats }),
  };
}

// ---------------------------------------------------------------- 客户端

/**
 * 见到的主机表（不碰套接字）：按「项目 + 文档服务地址」记，`expireMs`（45 s）与包里的 `ttlMs` 取小者，没再见到就过期。
 * `createLanClient` 用它；本机单测直接用它验过期与续期。
 *
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.expireMs]
 * @param {number} [options.startedAt] `firstSeenMs` 从这一刻算起，缺省建表的时刻
 * @param {(hosts: object[]) => void} [options.onChange] 新见到一台、或 `sweep` 移除了几台时调
 */
export function createLanTable({ now = Date.now, expireMs = LAN_DISCOVERY.EXPIRE_MS, startedAt, onChange = noop } = {}) {
  /** `${projectId}|${docservice}` → 条目 */
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

  /** 移除过期的；有移除回 true */
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
   * 见到一条通告（`parsePacket` 过的，或字段相同的对象）；回是不是新见到的。
   * @param {{ projectId: string, name: string, mode: string, hostDeviceName: string, docservice: string, asset: string, ttlMs?: number }} msg
   * @param {string | null} [from] 发包方地址
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
 * 客户端：发查询、收应答；`listen: true` 时绑组播端口、加入组，常驻收周期通告。
 * 见到的主机按「项目 + 文档服务地址」记，`expireMs`（45 s）没再见到就移除。
 *
 * @param {object} [options]
 * @param {boolean} [options.listen] 缺省 false：只绑临时端口，收查询的单播应答
 * @param {string} [options.group]
 * @param {number} [options.port] 查询发往的端口（`listen` 时也是绑定的端口），缺省 54887
 * @param {string} [options.bindAddress] 缺省 `0.0.0.0`
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

  /** 发一轮查询（每块网卡组播一次、子网广播一次）；回发出的包数与错误 */
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
   * 查询：发 `count` 次、每次隔 `intervalMs`，同一个 nonce。回 `{ sent, errors, interfaces }`。
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
 * 一次性发现：发 3 次查询（每 500 ms），收到最后一次查询之后 `graceMs` 或总时限 `timeoutMs`（缺省 3 s）先到为止。
 * 回 `{ hosts, interfaces, sent, errors, elapsedMs }`；`hosts` 按首次见到的先后排，带 `firstSeenMs`（从开始查找算起）。
 * 找不到任何网卡、套接字打不开，都不抛：`errors` 里写原因，`hosts` 为空。
 *
 * @param {object} [options] 同 `createLanClient`，另加 `name`、`timeoutMs`、`graceMs`、`count`、`intervalMs`
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
