/**
 * 共享项目鉴权的公共部分（契约 `docs/plan/auth-contract.md`）：常量、base64url、用途串、字段校验。
 *
 * 浏览器与 Node 通用：不引任何模块，只用全局的 `TextEncoder` / `TextDecoder`。
 * 服务端（`handshake.mjs`、`tickets.mjs`、`../docservice/modules/shared.mjs`）和客户端（`client.mjs`）
 * 用同一份用途串与校验，两边不会拼出不同的字节。
 */

/** 子协议：握手时客户端给、服务端只回显这一项（契约第 5 节） */
export const PROTOCOL = 'promptcut.v1';
export const AUTH_PREFIX = 'promptcut.auth.';
export const TICKET_PREFIX = 'promptcut.ticket.';
export const TENANT_PREFIX = 'promptcut.tenant.';
export const ROLE_PREFIX = 'promptcut.role.';
export const TOKEN_PREFIX = 'promptcut.token.';
/** 托管方服务身份的握手项（契约 `docs/plan/hosted-render-contract.md` 第 1.2 节） */
export const SERVICE_PREFIX = 'promptcut.service.';
/** 以它开头的用户名留给托管方服务身份，成员不能用（同上第 1.4 节） */
export const RESERVED_USERNAME_PREFIX = 'service:';

/** 连接角色（契约第 1 节） */
export const ROLES = Object.freeze(['page', 'agent', 'render']);

/** 口令派生参数（契约第 2 节） */
export const KDF_DEFAULT = Object.freeze({ alg: 'pbkdf2-sha256', iter: 600000 });
export const KDF_MIN_ITER = 100000;
export const KDF_MAX_ITER = 5000000;

export const SALT_BYTES = 16;
export const KEY_BYTES = 32;
export const NONCE_BYTES = 32;

/**
 * 仅供测试：`PROMPTCUT_TEST_ASSET_TICKET_TTL_MS` 把素材票据的有效期缩短（5 秒～15 分钟之间才认），C10 契约第 12 节的验收
 * 「逐帧导出跨过票据时限照常完成」用（C10-A10）。生产环境不设，照契约第 8 节的 15 分钟。
 */
const TEST_ASSET_TTL = Number(globalThis.process?.env?.PROMPTCUT_TEST_ASSET_TICKET_TTL_MS);
const ASSET_TTL = Number.isInteger(TEST_ASSET_TTL) && TEST_ASSET_TTL >= 5_000 && TEST_ASSET_TTL <= 15 * 60_000 ? TEST_ASSET_TTL : 15 * 60_000;

/** 票据有效期（契约第 8 节〔裁〕） */
export const TICKET_TTL = Object.freeze({ asset: ASSET_TTL, conn: 2 * 60_000 });

/** 子协议里 JSON 的上限（契约第 5 节） */
export const MAX_PROTOCOL_JSON = 1024;
/** 票据总长上限（契约第 8 节） */
export const MAX_TICKET_LENGTH = 2048;

const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/** 字节 → base64url（不带 `=`） */
export function b64urlEncode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/**
 * base64url → 字节。严格：只认 `[A-Za-z0-9_-]`、不带 `=`、长度不能是 4n+1，
 * 末尾多余的位必须是 0（同一段字节只有一种写法）。不合格回 null。
 */
export function b64urlDecode(text) {
  if (typeof text !== 'string' || !B64URL_RE.test(text) || text.length % 4 === 1) return null;
  const full = Math.floor(text.length / 4);
  const rest = text.length % 4;
  const out = new Uint8Array(full * 3 + (rest === 0 ? 0 : rest - 1));
  let o = 0;
  let i = 0;
  for (; i < full * 4; i += 4) {
    const n = (LOOKUP[text.charCodeAt(i)] << 18) | (LOOKUP[text.charCodeAt(i + 1)] << 12)
      | (LOOKUP[text.charCodeAt(i + 2)] << 6) | LOOKUP[text.charCodeAt(i + 3)];
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  if (rest === 2) {
    const a = LOOKUP[text.charCodeAt(i)];
    const b = LOOKUP[text.charCodeAt(i + 1)];
    if (b & 15) return null;
    out[o++] = ((a << 2) | (b >> 4)) & 255;
  } else if (rest === 3) {
    const a = LOOKUP[text.charCodeAt(i)];
    const b = LOOKUP[text.charCodeAt(i + 1)];
    const c = LOOKUP[text.charCodeAt(i + 2)];
    if (c & 3) return null;
    out[o++] = ((a << 2) | (b >> 4)) & 255;
    out[o++] = ((b << 4) | (c >> 2)) & 255;
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (text) => encoder.encode(String(text));

/** UTF-8 字节 → 文本；不是合法 UTF-8 回 null */
export function utf8Text(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** 进入证明的用途串（契约第 5 节）：`promptcut.auth.v1\n<projectId>\n<username>\n<deviceId>\n<as>\n<nonce>` */
export function authPurpose({ projectId, username, deviceId, as, nonce }) {
  return utf8(`promptcut.auth.v1\n${projectId}\n${username}\n${deviceId}\n${as}\n${nonce}`);
}

/** 创建者操作的用途串（契约第 7 节）：`promptcut.admin.v1\n<projectId>\n<创建者用户名>\n<op>\n<nonce>` */
export function adminPurpose({ projectId, username, op, nonce }) {
  return utf8(`promptcut.admin.v1\n${projectId}\n${username}\n${op}\n${nonce}`);
}

/** 服务握手的用途串（`hosted-render-contract.md` 第 1.2 节）：`promptcut.service.v1\n<服务名>\n<instanceId>\n<nonce>` */
export function servicePurpose({ service, deviceId, nonce }) {
  return utf8(`promptcut.service.v1\n${service}\n${deviceId}\n${nonce}`);
}

// ---------------------------------------------------------------- 校验

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PROJECT_ID_RE = /^sp_[a-z2-7]{26}$/;

const charCount = (s) => [...s].length;

/** 共享项目 id：`sp_<26 位小写 base32>` */
export const isProjectId = (v) => typeof v === 'string' && PROJECT_ID_RE.test(v);

/** 项目名：1～64 个字符，不含控制字符与 `/` */
export const isProjectName = (v) => typeof v === 'string' && v.length > 0 && charCount(v) <= 64 && !CONTROL_RE.test(v) && !v.includes('/');

/** 项目名的唯一性键：NFC 再转小写 */
export const nameKey = (name) => String(name).normalize('NFC').toLowerCase();

/**
 * 用户名：1～64 个字符，不含控制字符，首尾不是空白。
 * 契约只给了项目名的规则；用户名要拼进用途串（以换行分隔字段），所以至少不许有控制字符。
 */
export const isUsername = (v) => typeof v === 'string' && v.length > 0 && charCount(v) <= 64 && !CONTROL_RE.test(v) && v.trim() === v;

/** 服务名：1～32 个 `[a-z0-9-]` */
export const isServiceName = (v) => typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v);

/** 留给服务身份的用户名（成员进入、建项目、名单、踢人都不许用） */
export const isReservedUsername = (v) => typeof v === 'string' && v.startsWith(RESERVED_USERNAME_PREFIX);

/** 服务在项目里的用户名与 `userId`：`service:<服务名>`、`service:<服务名>@<instanceId>` */
export const serviceUsername = (service) => `${RESERVED_USERNAME_PREFIX}${service}`;
export const serviceUserId = (service, deviceId) => `${serviceUsername(service)}@${deviceId}`;

export const isDeviceId = (v) => typeof v === 'string' && DEVICE_ID_RE.test(v);

/** 设备名：1～64 个字符，不含控制字符 */
export const isDeviceName = (v) => typeof v === 'string' && v.length > 0 && charCount(v) <= 64 && !CONTROL_RE.test(v);

export const isRole = (v) => typeof v === 'string' && ROLES.includes(v);

/** 对话号：正整数 */
export const isConversation = (v) => Number.isSafeInteger(v) && v > 0;

/**
 * 归属：`{ kind: 'user' }`、`{ kind: 'agent', c: <对话号> }`，或 `{ kind: 'browser' }`（M7 D9：在线页面自己当纯浏览器节点时签的
 * render 票据；队列模块据此把 profile 固定为 browser）；合格回规整后的对象，否则 null
 */
export function normalizeOwner(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (v.kind === 'user' && keys.length === 1) return { kind: 'user' };
  if (v.kind === 'browser' && keys.length === 1) return { kind: 'browser' };
  if (v.kind === 'agent' && isConversation(v.c) && keys.length === 2) return { kind: 'agent', c: v.c };
  return null;
}

/** base64url 编码的定长字节串（盐 16 字节、K 32 字节） */
export function isB64Bytes(v, length) {
  const b = b64urlDecode(v);
  return b !== null && b.length === length;
}

/** `kdf` 参数：`{ alg: 'pbkdf2-sha256', iter }`，iter 在 10 万～500 万之间 */
export function isKdf(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && v.alg === 'pbkdf2-sha256' && Number.isSafeInteger(v.iter) && v.iter >= KDF_MIN_ITER && v.iter <= KDF_MAX_ITER
    && Object.keys(v).length === 2;
}

/** `userId = <用户名>@<deviceId>`；deviceId 里没有 `@`，按最后一个 `@` 拆 */
export function splitUserId(userId) {
  if (typeof userId !== 'string') return null;
  const i = userId.lastIndexOf('@');
  if (i <= 0) return null;
  const username = userId.slice(0, i);
  const deviceId = userId.slice(i + 1);
  return isDeviceId(deviceId) ? { username, deviceId } : null;
}

// ---------------------------------------------------------------- 云端 Agent 的委托（`docs/plan/cloud-agent-contract.md` 第 4.2 节）

/** 委托票据（页面每个请求出示）与对话委托（绑一个对话，成员离线后仍有效）的有效期 */
export const DELEGATION_TTL = Object.freeze({ ticket: 2 * 60_000, grant: 60 * 60_000 });
/** 委托的受众：要它的那种托管方服务的服务名。现在只有云端 Agent 服务 */
export const DELEGATION_AUDIENCES = Object.freeze(['agent']);
/** 对话 id（页面起的）：1～64 个 `[A-Za-z0-9_-]` */
export const isConversationId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
/** 成员在项目里的权限：读写或只读 */
export const isAccess = (v) => v === 'r' || v === 'rw';
