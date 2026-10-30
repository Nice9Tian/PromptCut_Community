/**
 * 共享项目的客户端（契约 `docs/plan/auth-contract.md` 第 2、4、5、7、8、11 节）。
 *
 * 浏览器与 Node 通用：只用全局的 WebCrypto（`crypto.subtle`、`crypto.getRandomValues`）、`fetch`、`TextEncoder`；
 * 没有 `crypto.subtle` 的页面（明文 http 打开的远端页面不是安全上下文）用 `pure.mjs` 兜底。
 * Node 22 起全局 `crypto.subtle` 就是 `node:crypto` 的 WebCrypto，结果与 `crypto.pbkdf2` 相同。
 *
 * 口令从不离开客户端：建项目、改口令时交上去的是派生密钥 `K`；进入时交的是 `HMAC(K, 用途串)`。
 *
 * 提供：
 * - `deriveKey(password, salt, kdf)`：`K`（base64url）；
 * - `makeCredential(password, kdf?)`：新盐加 `K`，建项目、改口令、改名单用；
 * - `authProof` / `adminProof`：进入证明与创建者操作证明的 `m`；
 * - `requestChallenge`、`lookupProject`、`createSharedProject`：HTTP 端点（第 4 节）；
 * - `buildAuthProtocols`：取挑战、算证明、拼好子协议（第 5 节），每次连之前调一次（nonce 只能用一次）；
 * - `ticketProtocols`：凭连接票据进入的子协议；
 * - `ticketExpiry`：票据的有效期（只解析，不验签名）。
 */
import {
  PROTOCOL, AUTH_PREFIX, TICKET_PREFIX, KDF_DEFAULT, SALT_BYTES, KEY_BYTES,
  b64urlEncode, b64urlDecode, utf8, utf8Text, authPurpose, adminPurpose, isKdf,
} from './protocol.mjs';
import { pbkdf2Sha256, hmacSha256 } from './pure.mjs';

export { PROTOCOL, KDF_DEFAULT } from './protocol.mjs';

const subtleOf = () => {
  const s = globalThis.crypto?.subtle;
  return s && typeof s.importKey === 'function' ? s : null;
};

function randomBytes(n) {
  const out = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('没有可用的随机数源（crypto.getRandomValues）');
  globalThis.crypto.getRandomValues(out);
  return out;
}

function bytesOfKey(key) {
  const k = typeof key === 'string' ? b64urlDecode(key) : key;
  if (!(k instanceof Uint8Array) || k.length !== KEY_BYTES) throw new TypeError('K 必须是 32 字节（base64url）');
  return k;
}

/**
 * 口令 → 派生密钥 `K`（base64url）。
 * @param {string} password
 * @param {string} salt base64url，16 字节
 * @param {{ alg: 'pbkdf2-sha256', iter: number }} [kdf]
 * @param {{ pure?: boolean }} [options] `pure: true` 强制走纯 JS（测试用）
 */
export async function deriveKey(password, salt, kdf = KDF_DEFAULT, { pure = false } = {}) {
  if (typeof password !== 'string' || password === '') throw new TypeError('口令不能为空');
  const saltBytes = b64urlDecode(salt);
  if (!saltBytes || saltBytes.length !== SALT_BYTES) throw new TypeError('盐必须是 16 字节（base64url）');
  if (!isKdf(kdf)) throw new TypeError('不认识的 kdf 参数');
  const pw = utf8(password);
  const subtle = pure ? null : subtleOf();
  if (subtle) {
    const base = await subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: kdf.iter }, base, KEY_BYTES * 8);
    return b64urlEncode(new Uint8Array(bits));
  }
  return b64urlEncode(pbkdf2Sha256(pw, saltBytes, kdf.iter, KEY_BYTES));
}

/** 新盐（16 字节随机数，base64url） */
export const newSalt = () => b64urlEncode(randomBytes(SALT_BYTES));

/** 新的一份口令凭证 `{ salt, key }`：建项目、改项目口令、名单每条都各用一份 */
export async function makeCredential(password, kdf = KDF_DEFAULT, options) {
  const salt = newSalt();
  return { salt, key: await deriveKey(password, salt, kdf, options) };
}

async function hmac(key, data, { pure = false } = {}) {
  const k = bytesOfKey(key);
  const subtle = pure ? null : subtleOf();
  if (subtle) {
    const h = await subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', h, data));
  }
  return hmacSha256(k, data);
}

/** 进入证明 `m`（第 5 节） */
export async function authProof({ key, projectId, username, deviceId, as, nonce }, options) {
  return b64urlEncode(await hmac(key, authPurpose({ projectId, username, deviceId, as, nonce }), options));
}

/** 创建者操作证明 `m`（第 7 节） */
export async function adminProof({ key, projectId, username, op, nonce }, options) {
  return b64urlEncode(await hmac(key, adminPurpose({ projectId, username, op, nonce }), options));
}

/**
 * 文档服务地址 → 共享端点的 HTTP 基址：`ws:` 换 `http:`、`wss:` 换 `https:`，路径保留、去掉末尾斜杠。
 * 独立模式 `ws://host:8787` → `http://host:8787`；挂载模式 `ws://host:5190/docservice` → `http://host:5190/docservice`。
 */
export function httpBaseOf(url) {
  const u = new URL(url);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError('文档服务地址必须是 ws(s):// 或 http(s)://');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

async function callJson(fetchImpl, url, init) {
  const f = fetchImpl ?? globalThis.fetch;
  if (typeof f !== 'function') throw new Error('没有可用的 fetch');
  const res = await f(url, { ...init, cache: 'no-store', redirect: 'error' });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body || body.ok !== true) {
    const err = new Error(`共享端点 ${new URL(url).pathname} 回 ${res.status}${body?.error ? `：${body.error}` : ''}`);
    err.status = res.status;
    err.reason = body?.error ?? null;
    // 429 的冷却秒数（C10a：回包的 `retryAfter`，没有再看 `Retry-After` 头；界面照表 A 写「请 {秒数} 秒后再试」）
    const after = Number(body?.retryAfter ?? res.headers?.get?.('retry-after'));
    err.retryAfter = Number.isFinite(after) && after > 0 ? after : null;
    throw err;
  }
  return body;
}

const postJson = (fetchImpl, url, body) => callJson(fetchImpl, url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/** `POST shared/challenge`：回 `{ nonce, salt, kdf, mode }` */
export async function requestChallenge({ base, projectId, username, deviceId, as = 'member', fetch }) {
  const r = await postJson(fetch, `${httpBaseOf(base)}/shared/challenge`, { projectId, username, deviceId, as });
  return { nonce: r.nonce, salt: r.salt, kdf: r.kdf, mode: r.mode };
}

/** `GET shared/lookup?name=`：回 `{ projectId, name, mode }` */
export async function lookupProject({ base, name, fetch }) {
  const r = await callJson(fetch, `${httpBaseOf(base)}/shared/lookup?name=${encodeURIComponent(name)}`, { method: 'GET' });
  return { projectId: r.projectId, name: r.name, mode: r.mode };
}

/**
 * `POST shared/invite/resolve`（C10a 契约第 5 节）：凭邀请码查项目，不扣次数。回 `{ projectId, name, mode }`；
 * 失败抛 `callJson` 的错误（404 `invite-invalid`、429 `rate-limited`，带 `status`、`reason`、`retryAfter`）。
 * 邀请码只在请求体里，不进地址。
 */
export async function resolveInvite({ base, code, fetch }) {
  const r = await postJson(fetch, `${httpBaseOf(base)}/shared/invite/resolve`, { code });
  return { projectId: r.projectId, name: r.name, mode: r.mode };
}

/**
 * `POST shared/invite/redeem`（C10a 契约第 5 节）：凭邀请码兑换。自由进入回 `{ projectId, name, mode, kdf, key }`，
 * `key` 就是项目口令的 `K`，交给 `buildAuthProtocols({ key })` 照常握手；限定进入回 `{ projectId, name, mode }`，
 * 名单里的用户名和密码照填。失败：404 `invite-invalid`、401 `banned`、429 `rate-limited`。
 */
export async function redeemInvite({ base, code, username, deviceId, fetch }) {
  const r = await postJson(fetch, `${httpBaseOf(base)}/shared/invite/redeem`, { code, username, deviceId });
  const out = { projectId: r.projectId, name: r.name, mode: r.mode };
  if (r.project && typeof r.project.key === 'string') Object.assign(out, { kdf: r.kdf, key: r.project.key });
  return out;
}

/**
 * `POST shared/create`：在客户端派生各份 `K` 后交上去。
 * @param {object} options
 * @param {string} options.base 文档服务地址
 * @param {string} options.name
 * @param {'free' | 'restricted'} options.mode
 * @param {{ username: string, password: string }} options.creator
 * @param {string} [options.password] 自由进入的项目口令
 * @param {Array<{ username: string, password: string }>} [options.list] 限定进入的名单
 * @param {object} [options.kdf]
 */
export async function createSharedProject({ base, name, mode, creator, password, list, kdf = KDF_DEFAULT, fetch }) {
  const body = { name, mode, kdf, creator: { username: creator.username, ...(await makeCredential(creator.password, kdf)) } };
  if (mode === 'free') body.project = await makeCredential(password, kdf);
  if (mode === 'restricted') {
    body.list = [];
    for (const item of list ?? []) body.list.push({ username: item.username, ...(await makeCredential(item.password, kdf)) });
  }
  const r = await postJson(fetch, `${httpBaseOf(base)}/shared/create`, body);
  return { projectId: r.projectId, name: r.name, mode: r.mode };
}

/**
 * 取挑战、算证明、拼好子协议：`['promptcut.v1', 'promptcut.auth.<base64url(JSON)>']`（第 5 节）。
 * 每次连之前都要调一次：nonce 只能用一次、60 s 过期。
 *
 * `password` 与 `key` 给一个：给 `key`（已派生的 `K`）就不再派生，给 `password` 按挑战回的盐与参数派生。
 * `onKey(key)`：派生出 `K` 后调一次，调用方可以缓存它，下次直接给 `key`（缓存 K，不缓存口令）。
 */
export async function buildAuthProtocols({
  base, projectId, username, deviceId, deviceName, as = 'member', password, key, role = 'page', conversation, owner, fetch, onKey,
}) {
  const ch = await requestChallenge({ base, projectId, username, deviceId, as, fetch });
  let k = key;
  if (!k) {
    k = await deriveKey(password, ch.salt, ch.kdf);
    if (typeof onKey === 'function') onKey(k);
  }
  const m = await authProof({ key: k, projectId, username, deviceId, as, nonce: ch.nonce });
  const payload = { v: 1, p: projectId, u: username, d: deviceId, dn: deviceName, as, nonce: ch.nonce, m, r: role };
  if (conversation !== undefined && conversation !== null) payload.c = conversation;
  if (owner !== undefined && owner !== null) payload.o = owner;
  return [PROTOCOL, AUTH_PREFIX + b64urlEncode(utf8(JSON.stringify(payload)))];
}

/**
 * `POST shared/verify`〔裁〕（`claude/join-error`）：拿一份新证明（`buildAuthProtocols` 的结果）问服务端认不认。
 * 认回 true，401 回 false；别的（404 旧服务没有这个端点、429、连不上）抛 `callJson` 的错误（带 `status`，连不上时没有）。
 * 用在 WebSocket 没建成之后：浏览器里握手被拒与没连上分不出，靠它分清。
 */
export async function verifyProtocols({ base, protocols, fetch }) {
  try {
    await postJson(fetch, `${httpBaseOf(base)}/shared/verify`, { protocols });
    return true;
  } catch (err) {
    if (err?.status === 401) return false;
    throw err;
  }
}

/** 凭连接票据进入的子协议（第 5 节） */
export const ticketProtocols = (ticket) => [PROTOCOL, TICKET_PREFIX + ticket];

/** 票据的负载（不验签名，只给客户端看有效期等）；解析不了回 null */
export function ticketPayload(ticket) {
  if (typeof ticket !== 'string') return null;
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const bytes = b64urlDecode(parts[1]);
  const text = bytes && utf8Text(bytes);
  if (!text) return null;
  try {
    const p = JSON.parse(text);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

/** 票据的过期时刻（毫秒时间戳）；解析不了回 null */
export function ticketExpiry(ticket) {
  const p = ticketPayload(ticket);
  return p && Number.isFinite(p.exp) ? p.exp : null;
}
