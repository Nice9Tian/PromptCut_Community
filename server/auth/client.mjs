/**
 * Shared project client (contract `docs/plan/auth-contract.md` Sections 2, 4, 5, 7, 8, 11).
 *
 * Universal across browsers and Node: only uses global WebCrypto (`crypto.subtle`,
 * `crypto.getRandomValues`), `fetch`, `TextEncoder`; pages without `crypto.subtle` (remote pages
 * opened over plaintext http are not secure contexts) fall back to `pure.mjs`. Starting from
 * Node 22, global `crypto.subtle` is `node:crypto`'s WebCrypto, producing results identical to
 * `crypto.pbkdf2`.
 *
 * Passphrases never leave the client: when creating projects or changing passphrases, the derived
 * key `K` is submitted; on entry, `HMAC(K, purposeString)` is submitted.
 *
 * Provides:
 * - `deriveKey(password, salt, kdf)`: `K` (base64url);
 * - `makeCredential(password, kdf?)`: new salt plus `K`, used for creating projects, changing
 *   passphrases, and modifying lists;
 * - `authProof` / `adminProof`: `m` for entry proof and creator operation proof;
 * - `requestChallenge`, `lookupProject`, `createSharedProject`: HTTP endpoints (Section 4);
 * - `buildAuthProtocols`: fetches challenge, calculates proof, and builds subprotocols (Section 5),
 *   called once before each connection (nonces are single-use);
 * - `ticketProtocols`: subprotocols for entry via connection ticket;
 * - `ticketExpiry`: ticket validity period (parses only, does not verify signature).
 */
import {
  PROTOCOL, AUTH_PREFIX, TICKET_PREFIX, KDF_DEFAULT, SALT_BYTES, KEY_BYTES,
  b64urlEncode, b64urlDecode, utf8, utf8Text, authPurpose, adminPurpose, isKdf,
} from './protocol.mjs';
import { pbkdf2Sha256, hmacSha256 } from './pure.mjs';
import { tr } from '../i18n.mjs';

export { PROTOCOL, KDF_DEFAULT } from './protocol.mjs';

const subtleOf = () => {
  const s = globalThis.crypto?.subtle;
  return s && typeof s.importKey === 'function' ? s : null;
};

function randomBytes(n) {
  const out = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('No random number source available (crypto.getRandomValues)');
  globalThis.crypto.getRandomValues(out);
  return out;
}

function bytesOfKey(key) {
  const k = typeof key === 'string' ? b64urlDecode(key) : key;
  if (!(k instanceof Uint8Array) || k.length !== KEY_BYTES) throw new TypeError('K must be 32 bytes (base64url)');
  return k;
}

/**
 * Passphrase → derived key `K` (base64url).
 * @param {string} password
 * @param {string} salt base64url, 16 bytes
 * @param {{ alg: 'pbkdf2-sha256', iter: number }} [kdf]
 * @param {{ pure?: boolean }} [options] `pure: true` forces pure JS (for testing)
 */
export async function deriveKey(password, salt, kdf = KDF_DEFAULT, { pure = false } = {}) {
  if (typeof password !== 'string' || password === '') throw new TypeError(tr("Password cannot be empty"));
  const saltBytes = b64urlDecode(salt);
  if (!saltBytes || saltBytes.length !== SALT_BYTES) throw new TypeError('Salt must be 16 bytes (base64url)');
  if (!isKdf(kdf)) throw new TypeError('Unknown kdf parameters');
  const pw = utf8(password);
  const subtle = pure ? null : subtleOf();
  if (subtle) {
    const base = await subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: kdf.iter }, base, KEY_BYTES * 8);
    return b64urlEncode(new Uint8Array(bits));
  }
  return b64urlEncode(pbkdf2Sha256(pw, saltBytes, kdf.iter, KEY_BYTES));
}

/** New salt (16-byte random number, base64url) */
export const newSalt = () => b64urlEncode(randomBytes(SALT_BYTES));

/** A new passphrase credential `{ salt, key }`: used separately for project creation, changing project passphrase, and each list entry */
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

/** Entry proof `m` (Section 5) */
export async function authProof({ key, projectId, username, deviceId, as, nonce }, options) {
  return b64urlEncode(await hmac(key, authPurpose({ projectId, username, deviceId, as, nonce }), options));
}

/** Creator operation proof `m` (Section 7) */
export async function adminProof({ key, projectId, username, op, nonce }, options) {
  return b64urlEncode(await hmac(key, adminPurpose({ projectId, username, op, nonce }), options));
}

/**
 * Document service address → HTTP base URL of shared endpoints: replace `ws:` with `http:`,
 * `wss:` with `https:`, preserve path, and strip trailing slash. Standalone mode `ws://host:8787` →
 * `http://host:8787`; attached mode `ws://host:5190/docservice` → `http://host:5190/docservice`.
 */
export function httpBaseOf(url) {
  const u = new URL(url);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError(tr("The document service address must be ws(s):// or http(s)://"));
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

async function callJson(fetchImpl, url, init) {
  const f = fetchImpl ?? globalThis.fetch;
  if (typeof f !== 'function') throw new Error('No fetch available');
  const res = await f(url, { ...init, cache: 'no-store', redirect: 'error' });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body || body.ok !== true) {
    const err = new Error(tr("Shared endpoint {0} returned {1}{2}", new URL(url).pathname, res.status, body?.error ? `: ${body.error}` : ''));
    err.status = res.status;
    err.reason = body?.error ?? null;
    // Cooldown seconds for 429 (C10a: response `retryAfter`, falling back to `Retry-After` header;
    // UI writes "Please try again after {seconds} seconds" per Table A)
    const after = Number(body?.retryAfter ?? res.headers?.get?.('retry-after'));
    err.retryAfter = Number.isFinite(after) && after > 0 ? after : null;
    throw err;
  }
  return body;
}

const postJson = (fetchImpl, url, body) => callJson(fetchImpl, url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/** `POST shared/challenge`: returns `{ nonce, salt, kdf, mode }` */
export async function requestChallenge({ base, projectId, username, deviceId, as = 'member', fetch }) {
  const r = await postJson(fetch, `${httpBaseOf(base)}/shared/challenge`, { projectId, username, deviceId, as });
  return { nonce: r.nonce, salt: r.salt, kdf: r.kdf, mode: r.mode };
}

/** `GET shared/lookup?name=`: returns `{ projectId, name, mode }` */
export async function lookupProject({ base, name, fetch }) {
  const r = await callJson(fetch, `${httpBaseOf(base)}/shared/lookup?name=${encodeURIComponent(name)}`, { method: 'GET' });
  return { projectId: r.projectId, name: r.name, mode: r.mode };
}

/**
 * `POST shared/invite/resolve` (C10a contract Section 5): looks up projects by invite code without
 * consuming attempts. Returns `{ projectId, name, mode }`; on failure throws `callJson` errors (404
 * `invite-invalid`, 429 `rate-limited`, with `status`, `reason`, `retryAfter`). Invite codes are
 * only in the request body, never in the URL.
 */
export async function resolveInvite({ base, code, fetch }) {
  const r = await postJson(fetch, `${httpBaseOf(base)}/shared/invite/resolve`, { code });
  return { projectId: r.projectId, name: r.name, mode: r.mode };
}

/**
 * `POST shared/invite/redeem` (C10a contract Section 5): redeems by invite code. Open entry returns
 * `{ projectId, name, mode, kdf, key }`, where `key` is `K` of the project passphrase, passed to
 * `buildAuthProtocols({ key })` for handshake as usual; restricted entry returns
 * `{ projectId, name, mode }`, filling in username and password from the list as usual. Failure:
 * 404 `invite-invalid`, 401 `banned`, 429 `rate-limited`.
 */
export async function redeemInvite({ base, code, username, deviceId, fetch }) {
  const r = await postJson(fetch, `${httpBaseOf(base)}/shared/invite/redeem`, { code, username, deviceId });
  const out = { projectId: r.projectId, name: r.name, mode: r.mode };
  if (r.project && typeof r.project.key === 'string') Object.assign(out, { kdf: r.kdf, key: r.project.key });
  return out;
}

/**
 * `POST shared/create`: submits after deriving each `K` on the client.
 * @param {object} options
 * @param {string} options.base Document service address
 * @param {string} options.name
 * @param {'free' | 'restricted'} options.mode
 * @param {{ username: string, password: string }} options.creator
 * @param {string} [options.password] Project passphrase for open entry
 * @param {Array<{ username: string, password: string }>} [options.list] List for restricted entry
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
 * Fetches challenge, computes proof, and constructs subprotocols:
 * `['promptcut.v1', 'promptcut.auth.<base64url(JSON)>']` (Section 5).
 * Must be called once before each connection: nonces are single-use and expire in 60 s.
 *
 * Provide either `password` or `key`: providing `key` (already derived `K`) skips re-derivation;
 * providing `password` derives `K` using the salt and parameters returned by the challenge.
 * `onKey(key)`: called once after deriving `K`, allowing caller to cache it and pass `key` directly
 * next time (caches K, does not cache passphrases).
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
 * `POST shared/verify` [ruling] (`claude/join-error`): takes a fresh proof (result of
 * `buildAuthProtocols`) to ask if the server recognizes it. Returns true if recognized, false for
 * 401; others (404 when legacy service lacks this endpoint, 429, unreachable) throw `callJson`
 * errors (with `status`, absent when unreachable). Used after WebSocket fails to establish:
 * browsers cannot distinguish handshake rejection from connection failure, relying on this to
 * distinguish them.
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

/** Subprotocols for entry via connection ticket (Section 5) */
export const ticketProtocols = (ticket) => [PROTOCOL, TICKET_PREFIX + ticket];

/** Ticket payload (signature unverified, for client inspection of expiry etc.); returns null if unparseable */
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

/** Ticket expiration time (millisecond timestamp); returns null if unparseable */
export function ticketExpiry(ticket) {
  const p = ticketPayload(ticket);
  return p && Number.isFinite(p.exp) ? p.exp : null;
}
