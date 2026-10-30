/**
 * 托管方服务身份（契约 `docs/plan/hosted-render-contract.md` 第 1 节）。
 *
 * 托管方在云节点上跑的服务（渲染服务；以后的 Agent 服务）各有一对 Ed25519 密钥：
 * - **登记表**（文档服务读）：`<托管数据目录>/secrets/services.json`，只有公钥，服务能拿到的连接角色也写在这里；
 *   `{ v: 1, services: { <服务名>: { role, actsFor?, keys: [{ kid, alg: 'ed25519', pub, addedAt }] } } }`；
 *   `actsFor`：`'self'`（缺省；服务以自己的身份进项目，不是成员，如渲染服务）或 `'member'`（服务代某个成员进项目，票据的
 *   `u`、`ug` 是成员的，握手照成员查名单、禁入表，如云端 Agent 服务）。握手按这个属性分支，不写死服务名；
 * - **私钥文件**（服务自己读）：`<私钥目录>/service-key.json`，
 *   `{ v: 1, service, kid, alg: 'ed25519', priv: <PKCS#8 DER base64url>, instanceId, instanceName }`。
 *
 * 本模块提供：密钥的生成与签名核对、登记表的读（带按修改时刻重读）与改（加公钥、撤公钥，原子写）、私钥文件的读写、
 * 服务端判断「这个服务此刻能不能在这个项目里」的 `serviceAdmission`，以及服务一侧拼握手子协议的 `buildServiceProtocols`。
 *
 * 私钥、签名、`nonce` 不进任何日志与错误信息。只用 Node 内置模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import {
  PROTOCOL, SERVICE_PREFIX, ROLES, b64urlDecode, isServiceName, isDeviceId, isDeviceName, servicePurpose,
} from './protocol.mjs';
import { roomUnavailableReason } from '../recovery/relocation.mjs';

export const SERVICES_FILE = 'services.json';
export const SERVICE_KEY_FILE = 'service-key.json';
export const SERVICE_ALG = 'ed25519';
/** Ed25519 签名的字节数 */
export const SERVICE_SIG_BYTES = 64;
/** 服务进项目时用谁的身份 */
export const ACTS_FOR = Object.freeze(['self', 'member']);
/** 有项目级开关的服务（项目记录 `hosted: { <服务名>: { enabled } }`，没有这一项算开）。登记表里可以有别的服务，它们没有开关 */
export const HOSTED_SERVICES = Object.freeze(['render', 'agent']);
/**
 * 服务下面的子选项（项目记录 `hosted.<服务名>.<选项名>`，布尔，没有这一项算关，只有显式为 `true` 才算开；契约 `docs/plan/hosted-render-contract.md` 第 3.1 节）。
 * 现在只有渲染节点的 `streams`（为这个项目生成轨道流）。这里只管记下并通知，渲染服务认领任务时看不看它不在这里管。
 */
export const HOSTED_OPTIONS = Object.freeze({ render: Object.freeze(['streams']), agent: Object.freeze([]) });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const KID_RE = /^[A-Za-z0-9_-]{8}$/;

function bad(code, detail) {
  const err = new Error(detail ?? code);
  err.code = code;
  return err;
}

/** 公钥的编号：原始 32 字节 sha256 的前 8 个 base64url 字符 */
export const kidOfPublic = (pub) => createHash('sha256').update(Buffer.from(pub, 'base64url')).digest('base64url').slice(0, 8);

/** 原始 32 字节公钥（base64url）→ KeyObject */
export function publicKeyOf(pub) {
  const raw = b64urlDecode(pub);
  if (!raw || raw.length !== 32) throw bad('bad-service-key', '公钥要是 32 字节 base64url');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
}

/** 新生成一对：`{ kid, pub, priv }`，`pub` 是原始 32 字节、`priv` 是 PKCS#8 DER，都是 base64url */
export function generateServiceKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x;
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  return { kid: kidOfPublic(pub), pub, priv };
}

/** 服务握手的签名（base64url） */
export function signServiceProof(priv, { service, deviceId, nonce }) {
  const key = createPrivateKey({ key: Buffer.from(priv, 'base64url'), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(servicePurpose({ service, deviceId, nonce })), key).toString('base64url');
}

/** 核对服务握手的签名；任何格式问题都回 false */
export function verifyServiceProof(pub, { service, deviceId, nonce }, m) {
  try {
    const sig = b64urlDecode(m);
    if (!sig || sig.length !== SERVICE_SIG_BYTES) return false;
    return verify(null, Buffer.from(servicePurpose({ service, deviceId, nonce })), publicKeyOf(pub), Buffer.from(sig));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 登记表

/** 校验并规整登记表的内容；不合格抛 `code: 'bad-services-file'` */
export function parseRegistry(json) {
  if (!isObj(json) || json.v !== 1 || !isObj(json.services)) throw bad('bad-services-file', '登记表要是 { v: 1, services: {…} }');
  const services = {};
  for (const [name, entry] of Object.entries(json.services)) {
    if (!isServiceName(name)) throw bad('bad-services-file', `服务名不合格：${name}`);
    if (!isObj(entry) || !ROLES.includes(entry.role) || !Array.isArray(entry.keys)) throw bad('bad-services-file', `服务 ${name} 要 { role, keys: […] }`);
    const actsFor = entry.actsFor ?? 'self';
    if (!ACTS_FOR.includes(actsFor)) throw bad('bad-services-file', `服务 ${name} 的 actsFor 只能是 ${ACTS_FOR.join(' / ')}`);
    const keys = [];
    for (const k of entry.keys) {
      if (!isObj(k) || k.alg !== SERVICE_ALG || typeof k.pub !== 'string' || typeof k.kid !== 'string' || !KID_RE.test(k.kid)) {
        throw bad('bad-services-file', `服务 ${name} 的公钥条目不合格`);
      }
      const raw = b64urlDecode(k.pub);
      if (!raw || raw.length !== 32 || kidOfPublic(k.pub) !== k.kid) throw bad('bad-services-file', `服务 ${name} 的公钥与 kid 对不上`);
      if (keys.some((x) => x.kid === k.kid)) throw bad('bad-services-file', `服务 ${name} 的 kid 重复`);
      keys.push({ kid: k.kid, alg: SERVICE_ALG, pub: k.pub, addedAt: Number.isFinite(k.addedAt) ? k.addedAt : 0 });
    }
    services[name] = { role: entry.role, actsFor, keys };
  }
  return { v: 1, services };
}

/** 严格读登记表文件：不存在回空表；读不了或不合格抛错 */
export function readRegistryFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { v: 1, services: {} };
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw bad('bad-services-file', '登记表不是合法的 JSON');
  }
  return parseRegistry(json);
}

let tmpSeq = 0;
function writeAtomic(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${(tmpSeq += 1)}`;
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 没建成 */ }
    throw err;
  }
}

/** 往登记表里加一把公钥（没有这个服务就建）；角色或 `actsFor` 与已有的不同抛 `code: 'role-conflict'`。回是否新加了 */
export function addServiceKey(file, { service, role, actsFor = 'self', kid, pub, at = Date.now() }) {
  if (!isServiceName(service)) throw bad('bad-service-name', '服务名要是 1～32 个 [a-z0-9-]');
  if (!ROLES.includes(role)) throw bad('bad-role', `role 只能是 ${ROLES.join(' / ')}`);
  if (kidOfPublic(pub) !== kid) throw bad('bad-service-key', '公钥与 kid 对不上');
  const reg = readRegistryFile(file);
  if (!ACTS_FOR.includes(actsFor)) throw bad('bad-acts-for', `actsFor 只能是 ${ACTS_FOR.join(' / ')}`);
  const entry = reg.services[service] ?? { role, actsFor, keys: [] };
  if (entry.role !== role || entry.actsFor !== actsFor) throw bad('role-conflict', `服务 ${service} 已登记为 ${entry.role} / ${entry.actsFor}`);
  if (entry.keys.some((k) => k.kid === kid)) return false;
  entry.keys.push({ kid, alg: SERVICE_ALG, pub, addedAt: at });
  reg.services[service] = entry;
  writeAtomic(file, `${JSON.stringify(reg, null, 2)}\n`);
  return true;
}

/** 撤一把公钥；这个服务一把都不剩时把它整项拿掉。回是否撤了 */
export function retireServiceKey(file, { service, kid }) {
  const reg = readRegistryFile(file);
  const entry = reg.services[service];
  if (!entry || !entry.keys.some((k) => k.kid === kid)) return false;
  entry.keys = entry.keys.filter((k) => k.kid !== kid);
  if (entry.keys.length === 0) delete reg.services[service];
  writeAtomic(file, `${JSON.stringify(reg, null, 2)}\n`);
  return true;
}

/**
 * 文档服务一侧的登记表：读内存，按文件的修改时刻重读（换钥、撤钥不用重启文档服务）。
 * 文件不存在是空表；读不了或不合格也按空表（失败即关：谁也进不来），打一条 `services.registry-error`。
 * @param {object} options
 * @param {string} options.file
 * @param {() => number} [options.now]
 * @param {number} [options.minCheckMs] 两次看文件修改时刻至少隔多久，缺省 1 s
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function createServiceRegistry({ file, now = Date.now, minCheckMs = 1000, log = () => {} } = {}) {
  if (typeof file !== 'string' || file === '') throw new TypeError('createServiceRegistry: file 必须是非空字符串');
  let services = {};
  let stamp = null;
  let checkedAt = -Infinity;
  let version = 0;

  const stampOf = () => {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return 'absent';
    }
  };

  function load() {
    const next = stampOf();
    if (next === stamp) return false;
    stamp = next;
    let parsed = { services: {} };
    try {
      parsed = readRegistryFile(file);
    } catch (err) {
      log('services.registry-error', { reason: String(err?.code ?? 'read') });
    }
    services = parsed.services;
    version += 1;
    log('services.registry', { services: Object.fromEntries(Object.entries(services).map(([n, e]) => [n, { role: e.role, actsFor: e.actsFor, kids: e.keys.map((k) => k.kid) }])) });
    return true;
  }
  load();

  /** 到了该看的时候就看一眼文件；变了回 true */
  function refresh({ force = false } = {}) {
    const at = now();
    if (!force && at - checkedAt < minCheckMs) return false;
    checkedAt = at;
    return load();
  }

  return {
    file,
    refresh,
    /** 这个服务的登记项 `{ role, keys }`；没有回 null */
    get(name) {
      refresh();
      return Object.hasOwn(services, name) ? services[name] : null;
    },
    /** 这个服务的这把公钥还在不在 */
    has(name, kid) {
      const entry = this.get(name);
      return !!entry && entry.keys.some((k) => k.kid === kid);
    },
    /** 这把公钥的条目；没有回 null */
    keyOf(name, kid) {
      const entry = this.get(name);
      return entry?.keys.find((k) => k.kid === kid) ?? null;
    },
    names: () => Object.keys(services),
    get version() { return version; },
  };
}

// ---------------------------------------------------------------- 项目里的准入

/** 这个项目对这个服务的开关：项目记录的 `hosted.<服务名>.enabled`，没有这一项算开 */
export function serviceEnabled(record, service) {
  return record?.hosted?.[service]?.enabled !== false;
}

/**
 * 这个项目的某个子选项：项目记录的 `hosted.<服务名>.<选项名>`，**没有这一项算关**，只有显式为 `true` 才算开
 * （与服务本身的开关相反：服务开关没有算开。2026-10-12 用户定：轨道流缺省不产，省云端资源，要的创建者自己打开）。
 */
export function hostedOptionEnabled(record, service, option) {
  return record?.hosted?.[service]?.[option] === true;
}

/**
 * 成员列表顶层与目录条目里的 `hosted`：有开关的服务各一项 `{ available, enabled }`。
 * `available`：登记表里有这个服务；`enabled`：这个项目的开关。渲染节点另带 `streams`（子选项「生成轨道流」，缺省关）。
 */
export function hostedStateOf(registry, record) {
  const out = {};
  for (const name of HOSTED_SERVICES) {
    out[name] = { available: !!registry?.get(name), enabled: serviceEnabled(record, name) };
    for (const option of HOSTED_OPTIONS[name]) out[name][option] = hostedOptionEnabled(record, name, option);
  }
  return out;
}

/**
 * 这个服务此刻能不能在这个项目里（握手、接续、逐消息、取票据、素材票据核对都问它）。能回 null，不能回原因：
 * `service-revoked`（登记表里没有这把公钥了，或角色变了）、`no-project`、`relocating` / `relocated`、`service-disabled`。
 */
export function serviceAdmission({ registry, record, service, kid, role }) {
  const entry = registry ? registry.get(service) : null;
  if (!entry || !entry.keys.some((k) => k.kid === kid)) return 'service-revoked';
  if (role !== undefined && role !== null && entry.role !== role) return 'service-revoked';
  if (!record) return 'no-project';
  const unavailable = roomUnavailableReason(record);
  if (unavailable) return unavailable;
  if (!serviceEnabled(record, service)) return 'service-disabled';
  return null;
}

// ---------------------------------------------------------------- 私钥文件（服务一侧）

/** 新的 instanceId：22 个 base64url 字符 */
export const newInstanceId = () => randomBytes(16).toString('base64url');

/** 写私钥文件 `<dir>/service-key.json`（目录 0700、文件 0600）。回文件路径 */
export function writeServiceKeyFile(dir, { service, kid, priv, instanceId, instanceName }) {
  if (!isServiceName(service) || !isDeviceId(instanceId) || !isDeviceName(instanceName)) throw bad('bad-service-key', '私钥文件的字段不合格');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  const file = path.join(dir, SERVICE_KEY_FILE);
  writeAtomic(file, `${JSON.stringify({ v: 1, service, kid, alg: SERVICE_ALG, priv, instanceId, instanceName }, null, 2)}\n`);
  return file;
}

/**
 * 读私钥文件（给文件或它所在的目录都行）。不存在、格式不对、权限比 0600 宽（只在 POSIX 上判）抛 `code: 'service-key'`，
 * 错误信息里没有私钥。
 */
export function readServiceKeyFile(fileOrDir) {
  let file = fileOrDir;
  try {
    if (fs.statSync(fileOrDir).isDirectory()) file = path.join(fileOrDir, SERVICE_KEY_FILE);
  } catch { /* 下面读的时候报 */ }
  let json;
  try {
    if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) throw bad('service-key', '私钥文件的权限比 0600 宽');
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'service-key') throw err;
    throw bad('service-key', `读不了私钥文件（${err?.code ?? 'bad-json'}）`);
  }
  if (!isObj(json) || json.v !== 1 || json.alg !== SERVICE_ALG || !isServiceName(json.service) || typeof json.kid !== 'string'
    || typeof json.priv !== 'string' || !isDeviceId(json.instanceId) || !isDeviceName(json.instanceName)) {
    throw bad('service-key', '私钥文件格式不对');
  }
  return { service: json.service, kid: json.kid, priv: json.priv, instanceId: json.instanceId, instanceName: json.instanceName };
}

/** `ws(s)://…` / `http(s)://…` → 共享端点的 http 基址（去掉末尾的 `/`） */
function httpBaseOf(url) {
  const u = new URL(url);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * 服务一侧：取一次挑战、拼好握手子协议 `[promptcut.v1, promptcut.service.<…>]`。每次建新会话调一次（`nonce` 只能用一次）。
 * @param {object} options
 * @param {string} options.base 文档服务地址（`ws://127.0.0.1:8787`）
 * @param {{ service, kid, priv, instanceId, instanceName }} options.key `readServiceKeyFile` 的结果
 * @param {typeof globalThis.fetch} [options.fetch]
 */
export async function buildServiceProtocols({ base, key, fetch: fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${httpBaseOf(base)}/shared/service-challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: key.service, deviceId: key.instanceId }),
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || typeof body?.nonce !== 'string') throw bad('service-challenge', `取服务挑战失败（${res.status}）`);
  const m = signServiceProof(key.priv, { service: key.service, deviceId: key.instanceId, nonce: body.nonce });
  const json = { v: 1, s: key.service, kid: key.kid, d: key.instanceId, dn: key.instanceName, nonce: body.nonce, m };
  return [PROTOCOL, SERVICE_PREFIX + Buffer.from(JSON.stringify(json), 'utf8').toString('base64url')];
}
