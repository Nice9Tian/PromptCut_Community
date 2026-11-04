/**
 * HTTP endpoints for shared projects (contract `docs/plan/auth-contract.md` section 4).
 *
 * | Endpoint | Description |
 * |---|---|
 * | `POST shared/create` | Create project, client provides derived `K`; 201 / 400 / 403 / 409 / 429 |
 * | `GET shared/lookup?name=` | Look up project id by name; 200 / 404 |
 * | `POST shared/challenge` | Fetch entry challenge; 200 / 400 / 404 / 429 |
 * | `POST shared/invite/resolve` | Look up project by invite code (C10a): 200 / 404 `invite-invalid` / 429 |
 * | `POST shared/invite/redeem` | Redeem by invite code (C10a): 200 / 400 / 401 `banned` / 404 `invite-invalid` / 429 |
 * | `POST shared/verify` | [ruling] Verify an entry proof (`claude/join-error`): 200 / 400 / 401 / 429 |
 * | `POST shared/service-challenge` | Host service fetches handshake challenge (`docs/plan/hosted-render-contract.md` section 1.2): 200 / 400 / 429; 404 when assembler provides no registry |
 *
 * `shared/verify` [ruling]: body `{ protocols: [...] }` is the subprotocol list to be provided for the
 * WebSocket handshake, which must contain the proof (`promptcut.auth.…`), submitted for verification
 * to the **same** `authenticate` as the handshake: returns 200 `{ ok: true }` if passed, returns 401
 * `unauthorized` if not (giving no reason, same as the handshake). The nonce in the proof is consumed
 * as usual, and failure counts toward rate limiting as usual. Purpose: in browsers, a WebSocket
 * handshake rejected with 401 and failing to connect at all look identical (both are 1006); when
 * unable to enter the page, query once with a new proof to distinguish "wrong username or password"
 * from "cannot connect to server". When the assembler does not provide `authenticate`, this endpoint
 * returns 404 (same as old services without this endpoint).
 *
 * Standalone mode is mounted on the document service's own HTTP server (path `/shared/…`), and
 * attached mode is mounted on `<WS path>/shared/…` (in vite it is `/docservice/shared/…`). This module
 * only recognizes the prefix given by the caller, and leaves all other paths untouched.
 *
 * All return JSON, `Cache-Control: no-store`, `Access-Control-Allow-Origin: *` (without credentials),
 * answering `OPTIONS` preflight. Request body limit is 64 KiB, returning 413 if exceeded. Errors
 * uniformly return `{ ok: false, error: '<reason>' }`.
 *
 * Who can create [ruling]:
 * - Hosted side (`mode: 'hosted'`, standalone mode): any origin can create; maximum 10 per hour from
 *   the same origin, maximum 1000 across the entire service, returns 429 if exceeded;
 * - LAN host (`mode: 'lan'`, attached mode): only local loopback origins can create, others get 403.
 *
 * Loopback origins (`isLoopback`): LAN host only allows loopback to create projects; loopback
 * challenge and invite code failures do not count toward rate limiting. When local trust is disabled
 * (`PROMPTCUT_TRUST_LOOPBACK=0`, hosted side behind reverse proxy,
 * `docs/plan/http-transport-contract.md` section 10), `isLoopback` passed in by the assembler
 * (`createSharedDocService`) always returns false, and loopback is restricted like any other origin.
 *
 * Usernames not on the list (and `as: 'creator'` when not the creator) return pseudo-salt: first 16
 * bytes of `HMAC-SHA256(serverSecret, projectId + '\n' + username)`, identical every time for the same
 * username, with the same shape as a real salt.
 */
import { createHmac } from 'node:crypto';
import {
  AUTH_PREFIX, SERVICE_PREFIX, KEY_BYTES, SALT_BYTES, isProjectId, isProjectName, isUsername as isUsernameShape, isDeviceId, isB64Bytes, isKdf,
  isReservedUsername, isServiceName,
} from './protocol.mjs';
import { credentialFor } from './handshake.mjs';
import { roomUnavailableReason } from '../recovery/relocation.mjs';
import { isInviteCode, inviteDigest, inviteActive, redeemOn } from './invite.mjs';

export const SHARED_HTTP_DEFAULTS = Object.freeze({
  MAX_BODY: 64 * 1024,
  CREATE_PER_HOUR: 10,
  MAX_PROJECTS: 1000,
  HOUR_MS: 3_600_000,
});

const ALLOW_HEADERS = 'Content-Type';
const ALLOW_METHODS = 'GET, POST, OPTIONS';

function send(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
}

const fail = (res, status, error) => send(res, status, { ok: false, error });

class TooLarge extends Error {}

/** Read request body (limit maxBody); throws TooLarge if exceeded */
function readBody(req, maxBody) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBody) {
      reject(new TooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBody) {
        done = true;
        reject(new TooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * Usernames usable by members: correct shape, and not starting with `service:` reserved for service
 * identity (`hosted-render-contract.md` section 1.4)
 */
const isUsername = (v) => isUsernameShape(v) && !isReservedUsername(v);
const isCred = (v) => isObj(v) && isB64Bytes(v.salt, SALT_BYTES) && isB64Bytes(v.key, KEY_BYTES);

/** Validate request body of `shared/create`; returns normalized object if valid, otherwise null */
export function parseCreate(body) {
  if (!isObj(body)) return null;
  const { name, mode, kdf, creator, project, list } = body;
  if (!isProjectName(name) || (mode !== 'free' && mode !== 'restricted') || !isKdf(kdf)) return null;
  if (!isCred(creator) || !isUsername(creator.username)) return null;
  const out = { name, mode, kdf: { alg: kdf.alg, iter: kdf.iter }, creator: { username: creator.username, salt: creator.salt, key: creator.key } };
  if (mode === 'free') {
    if (!isCred(project) || list !== undefined) return null;
    out.project = { salt: project.salt, key: project.key };
  } else {
    if (project !== undefined) return null;
    const entries = list ?? [];
    if (!Array.isArray(entries) || entries.length > 1000) return null;
    const seen = new Set([creator.username]);
    out.list = [];
    for (const e of entries) {
      if (!isCred(e) || !isUsername(e.username) || seen.has(e.username)) return null;
      seen.add(e.username);
      out.list.push({ username: e.username, salt: e.salt, key: e.key });
    }
  }
  return out;
}

/** Validate list (also used by `set-list`): `[{ username, salt, key }]`, no duplicate names, no creator */
export function parseList(list, creatorName) {
  if (!Array.isArray(list) || list.length > 1000) return null;
  const seen = new Set([creatorName]);
  const out = [];
  for (const e of list) {
    if (!isCred(e) || !isUsername(e.username) || seen.has(e.username)) return null;
    seen.add(e.username);
    out.push({ username: e.username, salt: e.salt, key: e.key });
  }
  return out;
}

export { isCred };

/** Pseudo-salt: first 16 bytes of `HMAC-SHA256(serverSecret, projectId + '\n' + username)` */
export function fakeSalt(serverSecret, projectId, username) {
  return createHmac('sha256', serverSecret).update(`${projectId}\n${username}`, 'utf8').digest().subarray(0, SALT_BYTES).toString('base64url');
}

/**
 * @param {object} options
 * @param {() => object | null} options.store Fetches credential store; when unavailable, all endpoints return 503 `auth-store`
 * @param {ReturnType<import('./challenges.mjs').createChallenges>} options.challenges
 * @param {ReturnType<import('./rate-limit.mjs').createRateLimiter>} options.limiter
 * @param {'hosted' | 'lan'} options.mode
 * @param {(req) => boolean} options.isLoopback
 * @param {(req) => string | null} [options.remoteOf]
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number} [options.createPerHour]
 * @param {number} [options.maxProjects]
 * @param {number} [options.maxBody]
 * @param {(projectId: string) => void} [options.onCreate]
 * @param {(req) => object | null} [options.authenticate] Handshake authentication (`createHandshakeAuth().authenticate`); only answers `shared/verify` when provided
 * @param {() => object | null} [options.services] Fetches service registry; only answers `shared/service-challenge` when provided (hosted side)
 */
export function createSharedHttp({
  store,
  challenges,
  limiter,
  mode,
  isLoopback,
  remoteOf = (req) => req?.socket?.remoteAddress ?? null,
  now = Date.now,
  log = () => {},
  createPerHour = SHARED_HTTP_DEFAULTS.CREATE_PER_HOUR,
  maxProjects = SHARED_HTTP_DEFAULTS.MAX_PROJECTS,
  maxBody = SHARED_HTTP_DEFAULTS.MAX_BODY,
  onCreate = () => {},
  authenticate = null,
  services = null,
}) {
  const servicesOf = typeof services === 'function' ? services : () => services;
  if (mode !== 'hosted' && mode !== 'lan') throw new TypeError("createSharedHttp: mode must be 'hosted' or 'lan'");
  const storeOf = typeof store === 'function' ? store : () => store;
  /** Origin → timestamps of project creations in the last hour */
  const creates = new Map();

  const loopbackOf = (req) => {
    try {
      return !!isLoopback(req);
    } catch {
      return false;
    }
  };

  async function jsonBody(req, res) {
    let text;
    try {
      text = await readBody(req, maxBody);
    } catch (err) {
      if (err instanceof TooLarge) {
        res.setHeader('Connection', 'close');
        fail(res, 413, 'too-large');
        req.resume();
        return undefined;
      }
      fail(res, 400, 'bad-request');
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      fail(res, 400, 'bad-request');
      return undefined;
    }
  }

  async function create(req, res, st) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (mode === 'lan' && !loopback) {
      req.resume();
      return fail(res, 403, 'forbidden');
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    const parsed = parseCreate(body);
    if (!parsed) return fail(res, 400, 'bad-request');
    if (mode === 'hosted') {
      const at = now();
      const recent = (creates.get(remote) ?? []).filter((t) => t > at - SHARED_HTTP_DEFAULTS.HOUR_MS);
      if (recent.length >= createPerHour || st.count() >= maxProjects) {
        creates.set(remote, recent);
        return fail(res, 429, 'rate-limited');
      }
      if (st.nameTaken(parsed.name)) return fail(res, 409, 'name-taken');
      recent.push(at);
      creates.set(remote, recent);
    } else if (st.nameTaken(parsed.name)) {
      return fail(res, 409, 'name-taken');
    }
    let rec;
    try {
      rec = st.create(parsed);
    } catch (err) {
      if (err?.code === 'name-taken') return fail(res, 409, 'name-taken');
      throw err;
    }
    log('shared.create', { remote, projectId: rec.projectId, mode: rec.mode });
    try { onCreate(rec.projectId); } catch { /* Notification failure does not affect project creation */ }
    send(res, 201, { ok: true, projectId: rec.projectId, name: rec.name, mode: rec.mode });
  }

  function lookup(req, res, st, url) {
    const name = url.searchParams.get('name');
    const rec = typeof name === 'string' && name !== '' ? st.byName(name) : null;
    if (!rec) return fail(res, 404, 'no-project');
    send(res, 200, { ok: true, projectId: rec.projectId, name: rec.name, mode: rec.mode });
  }

  async function challenge(req, res, st) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (!loopback && limiter.blocked(remote)) {
      req.resume();
      return tooMany(res, remote);
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    if (!isObj(body)) return fail(res, 400, 'bad-request');
    const { projectId, username, deviceId, as } = body;
    // Reserved usernames do not report format errors here: return pseudo-salt like usernames not on the
    // list, and subsequent handshake fails
    if (!isProjectId(projectId) || !isUsernameShape(username) || !isDeviceId(deviceId) || (as !== 'member' && as !== 'creator')) {
      return fail(res, 400, 'bad-request');
    }
    const rec = st.peek(projectId);
    const unavailable = roomUnavailableReason(rec);
    if (unavailable) return fail(res, unavailable === 'relocated' ? 409 : 503, unavailable);
    if (!rec) return fail(res, 404, 'no-project');
    const cred = isReservedUsername(username) ? null : credentialFor(rec, username, as);
    const salt = cred ? cred.salt : fakeSalt(st.serverSecret, projectId, username);
    const nonce = challenges.issue(['join', projectId, username, deviceId, as]);
    send(res, 200, { ok: true, nonce, salt, kdf: { ...rec.kdf }, mode: rec.mode });
  }

  /** `POST shared/verify { protocols }` [ruling]: see file header */
  async function verify(req, res) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (!loopback && limiter.blocked(remote)) {
      req.resume();
      return tooMany(res, remote, { withBody: true });
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    const list = isObj(body) ? body.protocols : undefined;
    if (!Array.isArray(list) || list.length === 0 || list.length > 8
      || !list.every((p) => typeof p === 'string' && p.length > 0 && !p.includes(','))
      || !list.some((p) => p.startsWith(AUTH_PREFIX) || p.startsWith(SERVICE_PREFIX))) {
      return fail(res, 400, 'bad-request');
    }
    // Same origin and request headers as this request, only replacing subprotocols with those given in
    // body: rate limiting and loopback trust match handshake
    const probe = { method: req.method, url: req.url, socket: req.socket, headers: { ...req.headers, 'sec-websocket-protocol': list.join(', ') } };
    let principal = null;
    try {
      principal = authenticate(probe);
    } catch {
      principal = null;
    }
    if (principal && typeof principal.userId === 'string') return send(res, 200, { ok: true });
    if (!loopback && limiter.blocked(remote)) return tooMany(res, remote, { withBody: true });
    return fail(res, 401, 'unauthorized');
  }

  /**
   * `POST shared/service-challenge { service, deviceId }`: one-time nonce for host service handshake,
   * bound to `('service', service, deviceId)`. Returns one even if service name is not in registry
   * (does not expose whether the service exists), and subsequent handshake fails.
   */
  async function serviceChallenge(req, res) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (!loopback && limiter.blocked(remote)) {
      req.resume();
      return tooMany(res, remote);
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    if (!isObj(body) || !isServiceName(body.service) || !isDeviceId(body.deviceId)) return fail(res, 400, 'bad-request');
    // Key rotation and key revocation take effect here: inspect registry file whenever someone fetches a challenge
    try { servicesOf()?.refresh?.({ force: true }); } catch { /* Keep as-is if unreadable */ }
    const nonce = challenges.issue(['service', body.service, body.deviceId]);
    send(res, 200, { ok: true, nonce });
  }

  /**
   * 429 `rate-limited` includes `Retry-After` header (cooldown seconds remaining, exposed in CORS);
   * response additionally includes `retryAfter` when `withBody`.
   * C10a lead session ruling (2026-09-27): when HTTP endpoints return 429 due to rate limiting, include
   * both; UI displays "Please try again in {seconds} seconds" per contract section 14 Table A. Both
   * invite code endpoints include both; `shared/challenge` only includes header, keeping response body
   * as-is per auth contract (AU8 contract test compares it verbatim; changes deferred to contract
   * revision).
   */
  function tooMany(res, remote, { withBody = false } = {}) {
    const sec = Math.max(1, Math.ceil(limiter.retryAfterMs?.(remote) / 1000 || 0));
    if (!res.headersSent) {
      res.setHeader('Retry-After', String(sec));
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    }
    if (withBody) return send(res, 429, { ok: false, error: 'rate-limited', retryAfter: sec });
    return fail(res, 429, 'rate-limited');
  }

  /**
   * Two endpoints for invite codes (C10a contract section 5): `POST shared/invite/resolve { code }`,
   * `POST shared/invite/redeem { code, username, deviceId }`.
   *
   * - Unknown, invalidated, expired, or exhausted all return 404 `invite-invalid` (single standard,
   *   preventing probing of invite code state);
   * - On redemption, returns 401 `banned` if `(username, deviceId)` is in ban list;
   * - Both failures count toward section 9 passphrase error rate limiting (loopback origins excluded,
   *   consistent with challenges); returns 429 during cooldown (`Retry-After` header and response
   *   `retryAfter`);
   * - Malformed invite codes (not 43 base64url characters) likewise return 404 `invite-invalid` and
   *   count toward limits;
   * - Restricted entry: uses deducted only if username is on list (or is creator); returns identical
   *   response without deducting if not on list (lead session ruling);
   * - `resolve` does not deduct uses; `redeem` verifies before deducting once; re-redemptions by same
   *   `userId` do not deduct again (`redeemOn` in `invite.mjs`);
   * - Open entry redemption returns project passphrase `K` (`kdf` and `project: { salt, key }`), and
   *   client performs handshake as usual based on this; restricted entry does not return `K`;
   * - Request body not logged: log contains only origin, project id, and result, without invite code
   *   or username.
   */
  async function invite(req, res, st, which) {
    const remote = remoteOf(req);
    const loopback = loopbackOf(req);
    if (!loopback && limiter.blocked(remote)) {
      req.resume();
      return tooMany(res, remote, { withBody: true });
    }
    const body = await jsonBody(req, res);
    if (body === undefined) return;
    if (!isObj(body)) return fail(res, 400, 'bad-request');
    if (which === 'redeem' && (!isUsername(body.username) || !isDeviceId(body.deviceId))) return fail(res, 400, 'bad-request');
    const at = now();
    const invalid = () => {
      if (!loopback) limiter.fail(remote);
      log('shared.invite.reject', { remote, route: which, reason: 'invite-invalid' });
      return fail(res, 404, 'invite-invalid');
    };
    // Malformed invite codes also return "invalid" and count toward limits: code guessers cannot
    // distinguish format errors from nonexistent codes in the response
    if (!isInviteCode(body.code)) return invalid();
    const rec = typeof st.peekByInviteCode === 'function' ? st.peekByInviteCode(body.code) : st.peekByInviteDigest(inviteDigest(st.serverSecret, body.code));
    if (!rec || !rec.invite) return invalid();
    const unavailable = roomUnavailableReason(rec);
    if (unavailable) return fail(res, unavailable === 'relocated' ? 409 : 503, unavailable);
    const base = { ok: true, projectId: rec.projectId, name: rec.name, mode: rec.mode };
    if (which === 'resolve') {
      if (!inviteActive(rec.invite, at)) return invalid();
      return send(res, 200, base);
    }
    const { username, deviceId } = body;
    const userId = `${username}@${deviceId}`;
    // Try on a replica first: do not write to disk if invalid; do not write if already redeemed by same userId (again)
    const trial = redeemOn(structuredClone(rec.invite), userId, at);
    if (trial === 'invalid') return invalid();
    if ((rec.bans ?? []).some((b) => b.username === username && b.deviceId === deviceId)) {
      if (!loopback) limiter.fail(remote);
      log('shared.invite.reject', { remote, route: which, projectId: rec.projectId, reason: 'banned' });
      return fail(res, 401, 'banned');
    }
    // Restricted entry: uses deducted only if username is on list (or is creator); returns identical
    // response without deducting if not on list (lead session ruling 2026-09-27: do not check passphrase
    // during redemption, otherwise anyone with link could exhaust uses by changing device name;
    // identical response does not leak list)
    const listed = rec.mode !== 'restricted' || rec.creator.username === username || (rec.list ?? []).some((e) => e.username === username);
    const counted = trial === 'ok' && listed;
    if (counted) st.update(rec.projectId, (d) => { redeemOn(d.invite, userId, at); });
    log('shared.invite.redeem', { remote, projectId: rec.projectId, counted });
    if (rec.mode === 'free' && rec.project) {
      return send(res, 200, { ...base, kdf: { ...rec.kdf }, project: { salt: rec.project.salt, key: rec.project.key } });
    }
    return send(res, 200, base);
  }

  /**
   * Handle a request. `prefix` is the prefix where shared endpoints reside (standalone mode `''`,
   * attached mode `/docservice`). Returns false and touches nothing if path is not `<prefix>/shared/…`;
   * returns true if it is (response already or about to be sent).
   */
  function handle(req, res, prefix = '') {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    const base = `${prefix}/shared/`;
    if (!url.pathname.startsWith(base)) return false;
    const route = url.pathname.slice(base.length);
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return true;
    }
    const st = storeOf();
    const run = async () => {
      if (!st) {
        req.resume();
        return fail(res, 503, 'auth-store');
      }
      if (route === 'create') {
        if (method !== 'POST') return fail(res, 405, 'method');
        return create(req, res, st);
      }
      if (route === 'lookup') {
        if (method !== 'GET') return fail(res, 405, 'method');
        return lookup(req, res, st, url);
      }
      if (route === 'challenge') {
        if (method !== 'POST') return fail(res, 405, 'method');
        return challenge(req, res, st);
      }
      if (route === 'verify' && typeof authenticate === 'function') {
        if (method !== 'POST') return fail(res, 405, 'method');
        return verify(req, res);
      }
      if (route === 'service-challenge' && servicesOf()) {
        if (method !== 'POST') return fail(res, 405, 'method');
        return serviceChallenge(req, res);
      }
      if (route === 'invite/resolve' || route === 'invite/redeem') {
        if (method !== 'POST') return fail(res, 405, 'method');
        return invite(req, res, st, route.slice('invite/'.length));
      }
      req.resume();
      return fail(res, 404, 'not-found');
    };
    run().catch((err) => {
      log('shared.http-error', { route, message: String(err?.message ?? err) });
      fail(res, 500, 'internal');
    });
    return true;
  }

  return { handle };
}
