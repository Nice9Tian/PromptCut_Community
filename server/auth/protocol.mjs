/**
 * Shared project authentication common utilities (contract `docs/plan/auth-contract.md`):
 * constants, base64url, purpose strings, field validation.
 *
 * Universal across browser and Node: imports no modules, uses only global `TextEncoder` / `TextDecoder`.
 * Server (`handshake.mjs`, `tickets.mjs`, `../docservice/modules/shared.mjs`) and client (`client.mjs`)
 * use the same purpose strings and validation, ensuring neither side constructs different bytes.
 */

/** Subprotocol: provided by client during handshake, server only echoes this item (contract section 5) */
export const PROTOCOL = 'promptcut.v1';
export const AUTH_PREFIX = 'promptcut.auth.';
export const TICKET_PREFIX = 'promptcut.ticket.';
export const TENANT_PREFIX = 'promptcut.tenant.';
export const ROLE_PREFIX = 'promptcut.role.';
export const TOKEN_PREFIX = 'promptcut.token.';
/** Handshake item for host service identity (contract `docs/plan/hosted-render-contract.md` section 1.2) */
export const SERVICE_PREFIX = 'promptcut.service.';
/** Usernames starting with this are reserved for host service identity; members cannot use them (same as above, section 1.4) */
export const RESERVED_USERNAME_PREFIX = 'service:';

/** Connection role (contract section 1) */
export const ROLES = Object.freeze(['page', 'agent', 'render']);

/** Passphrase derivation parameters (contract section 2) */
export const KDF_DEFAULT = Object.freeze({ alg: 'pbkdf2-sha256', iter: 600000 });
export const KDF_MIN_ITER = 100000;
export const KDF_MAX_ITER = 5000000;

export const SALT_BYTES = 16;
export const KEY_BYTES = 32;
export const NONCE_BYTES = 32;

/**
 * For testing only: `PROMPTCUT_TEST_ASSET_TICKET_TTL_MS` shortens asset ticket TTL (only accepted
 * between 5 seconds and 15 minutes), used by C10 contract section 12 acceptance check
 * "Frame-by-frame export crossing ticket expiration completes normally" (C10-A10). Not set in
 * production, following the 15 minutes in contract section 8.
 */
const TEST_ASSET_TTL = Number(globalThis.process?.env?.PROMPTCUT_TEST_ASSET_TICKET_TTL_MS);
const ASSET_TTL = Number.isInteger(TEST_ASSET_TTL) && TEST_ASSET_TTL >= 5_000 && TEST_ASSET_TTL <= 15 * 60_000 ? TEST_ASSET_TTL : 15 * 60_000;

/** Ticket TTL (contract section 8 [ruling]) */
export const TICKET_TTL = Object.freeze({ asset: ASSET_TTL, conn: 2 * 60_000 });

/** JSON size limit in subprotocol (contract section 5) */
export const MAX_PROTOCOL_JSON = 1024;
/** Maximum total ticket length (contract section 8) */
export const MAX_TICKET_LENGTH = 2048;

const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/** Bytes → base64url (without `=`) */
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
 * base64url → bytes. Strict: accepts only `[A-Za-z0-9_-]`, no `=`, length cannot be 4n+1,
 * trailing padding bits must be 0 (only one canonical encoding per byte sequence). Returns null if invalid.
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

/** UTF-8 bytes → text; returns null if not valid UTF-8 */
export function utf8Text(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Purpose string for entry proof (contract section 5): `promptcut.auth.v1\n<projectId>\n<username>\n<deviceId>\n<as>\n<nonce>` */
export function authPurpose({ projectId, username, deviceId, as, nonce }) {
  return utf8(`promptcut.auth.v1\n${projectId}\n${username}\n${deviceId}\n${as}\n${nonce}`);
}

/** Purpose string for creator operations (contract section 7): `promptcut.admin.v1\n<projectId>\n<creatorUsername>\n<op>\n<nonce>` */
export function adminPurpose({ projectId, username, op, nonce }) {
  return utf8(`promptcut.admin.v1\n${projectId}\n${username}\n${op}\n${nonce}`);
}

/** Purpose string for service handshake (`hosted-render-contract.md` section 1.2): `promptcut.service.v1\n<serviceName>\n<instanceId>\n<nonce>` */
export function servicePurpose({ service, deviceId, nonce }) {
  return utf8(`promptcut.service.v1\n${service}\n${deviceId}\n${nonce}`);
}

// ---------------------------------------------------------------- Validation

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PROJECT_ID_RE = /^sp_[a-z2-7]{26}$/;

const charCount = (s) => [...s].length;

/** Shared project id: `sp_<26 lowercase base32 chars>` */
export const isProjectId = (v) => typeof v === 'string' && PROJECT_ID_RE.test(v);

/** Project name: 1-64 characters, excluding control characters and `/` */
export const isProjectName = (v) => typeof v === 'string' && v.length > 0 && charCount(v) <= 64 && !CONTROL_RE.test(v) && !v.includes('/');

/** Project name uniqueness key: NFC then lowercase */
export const nameKey = (name) => String(name).normalize('NFC').toLowerCase();

/**
 * Username: 1-64 characters, no control characters, no leading or trailing whitespace.
 * The contract only specified rules for project names; usernames are spliced into purpose strings
 * (newline-delimited fields), so control characters must at least be forbidden.
 */
export const isUsername = (v) => typeof v === 'string' && v.length > 0 && charCount(v) <= 64 && !CONTROL_RE.test(v) && v.trim() === v;

/** Service name: 1-32 `[a-z0-9-]` characters */
export const isServiceName = (v) => typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v);

/** Usernames reserved for service identity (disallowed for member entry, project creation, list, or kicking) */
export const isReservedUsername = (v) => typeof v === 'string' && v.startsWith(RESERVED_USERNAME_PREFIX);

/** Service username and `userId` in project: `service:<serviceName>`, `service:<serviceName>@<instanceId>` */
export const serviceUsername = (service) => `${RESERVED_USERNAME_PREFIX}${service}`;
export const serviceUserId = (service, deviceId) => `${serviceUsername(service)}@${deviceId}`;

export const isDeviceId = (v) => typeof v === 'string' && DEVICE_ID_RE.test(v);

/** Device name: 1-64 characters, excluding control characters */
export const isDeviceName = (v) => typeof v === 'string' && v.length > 0 && charCount(v) <= 64 && !CONTROL_RE.test(v);

export const isRole = (v) => typeof v === 'string' && ROLES.includes(v);

/** Chat number: positive integer */
export const isConversation = (v) => Number.isSafeInteger(v) && v > 0;

/**
 * Ownership: `{ kind: 'user' }`, `{ kind: 'agent', c: <chatNumber> }`, or `{ kind: 'browser' }`
 * (M7 D9: render ticket signed when online page itself acts as pure browser node; queue module
 * pins profile to browser accordingly); returns normalized object if valid, otherwise null.
 */
export function normalizeOwner(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (v.kind === 'user' && keys.length === 1) return { kind: 'user' };
  if (v.kind === 'browser' && keys.length === 1) return { kind: 'browser' };
  if (v.kind === 'agent' && isConversation(v.c) && keys.length === 2) return { kind: 'agent', c: v.c };
  return null;
}

/** base64url-encoded fixed-length byte string (16-byte salt, 32-byte K) */
export function isB64Bytes(v, length) {
  const b = b64urlDecode(v);
  return b !== null && b.length === length;
}

/** `kdf` parameters: `{ alg: 'pbkdf2-sha256', iter }`, iter between 100,000 and 5,000,000 */
export function isKdf(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && v.alg === 'pbkdf2-sha256' && Number.isSafeInteger(v.iter) && v.iter >= KDF_MIN_ITER && v.iter <= KDF_MAX_ITER
    && Object.keys(v).length === 2;
}

/** `userId = <username>@<deviceId>`; deviceId contains no `@`, split by the last `@` */
export function splitUserId(userId) {
  if (typeof userId !== 'string') return null;
  const i = userId.lastIndexOf('@');
  if (i <= 0) return null;
  const username = userId.slice(0, i);
  const deviceId = userId.slice(i + 1);
  return isDeviceId(deviceId) ? { username, deviceId } : null;
}

// ---------------------------------------------------------------- Cloud Agent delegation (`docs/plan/cloud-agent-contract.md` section 4.2)

/** TTL for delegation tickets (presented by page on each request) and chat delegations (bound to one chat, valid after member goes offline) */
export const DELEGATION_TTL = Object.freeze({ ticket: 2 * 60_000, grant: 60 * 60_000 });
/** Delegation audience: service name of the host service requesting it; currently only Cloud Agent service */
export const DELEGATION_AUDIENCES = Object.freeze(['agent']);
/** Chat id (generated by page): 1-64 `[A-Za-z0-9_-]` characters */
export const isConversationId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
/** Member permissions in project: read-write or read-only */
export const isAccess = (v) => v === 'r' || v === 'rw';
