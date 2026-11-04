/**
 * WebSocket handshake authentication (contract `docs/plan/auth-contract.md` sections 5, 6, 9, 10).
 *
 * The client provides `promptcut.v1` in `Sec-WebSocket-Protocol`, plus at most one of the following
 * (multiple items always result in 401):
 * - Proof `promptcut.auth.<base64url(JSON)>` → Member identity for that project;
 * - Connection ticket `promptcut.ticket.<ticket>` → The identity that issued the ticket, with role
 *   from the ticket;
 * - Local claim `promptcut.tenant.<projectId>` (may also add `promptcut.role.<role>`), accepted only
 *   from loopback sources → Local-trusted identity for that project;
 * - Cluster token `promptcut.token.<token>` → Admin identity, restricted to admin interfaces
 *   (accepted only when caller permits; never accepted in attached mode);
 * - Service identity `promptcut.service.<base64url(JSON)>` (`docs/plan/hosted-render-contract.md`
 *   section 1.2) → Control identity for host services, not entering any project, only allowed to
 *   view the directory and request tickets. Accepted only when caller provides a registry (hosted
 *   side) and the request genuinely originates from this machine.
 * Connection tickets with `sv` (issued to services by the directory module, section 1.4 as above)
 * are divided into two types based on `actsFor` of the service in the registry; both check the
 * registry and project switches:
 * - `'self'` (render service) → Service identity in that project `scope: 'service'`: not a member,
 *   does not check list or ban table;
 * - `'member'` (Cloud Agent service) → Identity of the member from the ticket (`scope: 'member'`)
 *   plus `service`: checks list, ban table, and kicks like a regular member.
 * Connections with a `service` field always go through the message whitelist
 * (`../docservice/service-gate.mjs`).
 * Loopback source providing nothing → Local identity
 * `{ userId: 'local', tenantId: 'local', scope: 'local', role: 'page' }`.
 * Legacy clients from loopback sources that do not even provide `promptcut.v1` are also admitted
 * as local identity (M5 behavior).
 *
 * On failure, always returns null (assembly layer returns 401 with no reason in the response body),
 * logs `auth.reject { remote, reason }`, `reason` ∈ `no-credential`, `bad-proof`, `nonce`, `banned`,
 * `not-listed`, `no-project`, `rate-limited`, `bad-format`, `multiple`; service identity also includes
 * `bad-service`, `service-origin`, `service-revoked`, `service-disabled`. Never logs the raw plaintext
 * of any passphrase, `K`, proof, ticket, or token.
 *
 * The role entry in a local claim can be written as `promptcut.role.agent.<chatNumber>` to include
 * the chat number (the contract only specifies `promptcut.role.<role>`, but `agent` connections
 * require a chat number, which is an extension of this implementation).
 * Loopback source providing only `promptcut.role.agent.<chatNumber>` (without a local claim): Agent
 * connection in the local `local` space, yielding
 * `{ ...localIdentity, role: 'agent', conversation: chatNumber }` (C6.5 section 5; added in
 * `c65-agent`).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  PROTOCOL, AUTH_PREFIX, TICKET_PREFIX, TENANT_PREFIX, ROLE_PREFIX, TOKEN_PREFIX, SERVICE_PREFIX, MAX_PROTOCOL_JSON,
  b64urlDecode, utf8Text, authPurpose, isProjectId, isUsername, isDeviceId, isDeviceName, isRole, isConversation,
  normalizeOwner, splitUserId, isServiceName, isReservedUsername, serviceUsername, serviceUserId,
} from './protocol.mjs';
import { verifyServiceProof, serviceAdmission, SERVICE_SIG_BYTES } from './service-identity.mjs';
import { isLocalOrigin } from './origin.mjs';
import { verifyTicket } from './tickets.mjs';
import { memberAccess, narrowAccess } from './delegation.mjs';
import { roomUnavailableReason } from '../recovery/relocation.mjs';

const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

export const LOCAL_PRINCIPAL = Object.freeze({ userId: 'local', tenantId: 'local', scope: 'local', role: 'page' });
export const ADMIN_PRINCIPAL = Object.freeze({ userId: 'admin', tenantId: null, scope: 'admin' });

/** Host service control identity (not entering any project space); `serviceRole` is the service's connection role in the registry */
export function serviceControlPrincipal({ service, kid, role, deviceId, deviceName }) {
  return { userId: serviceUsername(service), tenantId: null, scope: 'service', service, serviceKid: kid, serviceRole: role, deviceId, deviceName };
}

/** Identity of a host service in a project: not a member (`scope: 'service'`), role is taken from the ticket */
export function serviceDataPrincipal({ service, kid, projectId, deviceId, deviceName, role }) {
  return {
    userId: serviceUserId(service, deviceId), tenantId: projectId, scope: 'service', service, serviceKid: kid,
    username: serviceUsername(service), deviceId, deviceName, creator: false, role, conversation: null, owner: null,
  };
}

/** Cluster token format: 32-256 base64url characters */
export const checkTokenFormat = (token) => typeof token === 'string' && TOKEN_RE.test(token);

/** Subprotocol list provided by the client in the handshake request (split across multiple headers and commas) */
export function offeredProtocols(req) {
  const raw = req?.headers?.['sec-websocket-protocol'];
  if (raw === undefined) return [];
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  return text.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** Loopback address (including IPv4-mapped IPv6) */
export function isLoopbackAddress(address) {
  const a = String(address ?? '').toLowerCase();
  return a === '::1' || /^127\./.test(a) || /^::ffff:127\./.test(a);
}

const digest = (text) => createHash('sha256').update(text, 'utf8').digest();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Principal of a member (or creator) identity */
function memberPrincipal({ projectId, username, deviceId, deviceName, creator, role, conversation, owner }) {
  return {
    userId: `${username}@${deviceId}`,
    tenantId: projectId,
    scope: 'member',
    username,
    deviceId,
    deviceName,
    creator: creator === true,
    role,
    conversation: conversation ?? null,
    owner: owner ?? null,
  };
}

/**
 * Finds the `K` (base64url) for this entry based on mode and username; returns null if not found
 * (not on the list, not the creator).
 * Under restricted entry, the creator is automatically considered a member of the list: if
 * `as: 'member'` and the username is the creator's, uses the creator's `K`.
 */
export function credentialFor(rec, username, as) {
  if (as === 'creator') return rec.creator.username === username ? rec.creator : null;
  if (rec.mode === 'free') return rec.project ?? null;
  if (rec.creator.username === username) return rec.creator;
  return (rec.list ?? []).find((e) => e.username === username) ?? null;
}

/** Whether this identity may currently access the project (ban table, restricted entry list); returns null if allowed, reason if not */
export function admissionOf(rec, { username, deviceId, creator }) {
  if ((rec.bans ?? []).some((b) => b.username === username && b.deviceId === deviceId)) return 'banned';
  if (rec.mode === 'restricted' && !creator && rec.creator.username !== username && !(rec.list ?? []).some((e) => e.username === username)) {
    return 'not-listed';
  }
  return null;
}

/**
 * @param {object} options
 * @param {() => object | null} options.store Fetches credential store (can be null: accepts only
 *   local identity and token when store is not loaded)
 * @param {ReturnType<import('./challenges.mjs').createChallenges>} options.challenges
 * @param {ReturnType<import('./rate-limit.mjs').createRateLimiter>} options.limiter
 * @param {string} [options.clusterToken] Cluster token; token entries always return 401 if omitted
 *   or `acceptToken` is false
 * @param {boolean} [options.acceptToken] Whether to accept cluster tokens (false in attached mode)
 * @param {(req) => boolean} options.isLoopback Whether this request comes from local loopback
 * @param {(req) => string | null} [options.remoteOf] Source address for logging and rate limiting
 * @param {() => object | null} [options.services] Fetches service registry (`createServiceRegistry`
 *   from `service-identity.mjs`); service handshake entries and tickets with `sv` always return
 *   401 if omitted or null (LAN host)
 * @param {(req) => boolean} [options.isDirectLocal] Whether the request genuinely originates from
 *   this machine (service handshakes accept only this, ignoring local trust switch); defaults to
 *   `isLocalOrigin` from `origin.mjs`
 * @param {{ deviceId: string, deviceName: string }} [options.localDevice] Local device information
 *   used for local claims
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function createHandshakeAuth({
  store,
  challenges,
  limiter,
  clusterToken,
  acceptToken = true,
  isLoopback,
  remoteOf = (req) => req?.socket?.remoteAddress ?? null,
  localDevice,
  services = null,
  isDirectLocal = (req) => isLocalOrigin(req),
  now = Date.now,
  log = () => {},
}) {
  const registryOf = typeof services === 'function' ? services : () => services;
  if (clusterToken !== undefined && clusterToken !== null && !checkTokenFormat(clusterToken)) {
    throw new TypeError('createHandshakeAuth: invalid cluster token format (must be 32-256 base64url characters)');
  }
  const tokenDigest = acceptToken && clusterToken ? digest(clusterToken) : null;
  const storeOf = typeof store === 'function' ? store : () => store;

  function authenticate(req) {
    const remote = remoteOf(req);
    const reject = (reason) => {
      log('auth.reject', { remote, reason });
      return null;
    };
    let loopback = false;
    try {
      loopback = !!isLoopback(req);
    } catch {
      loopback = false;
    }
    const offered = offeredProtocols(req);
    const items = offered.filter((p) => p !== PROTOCOL);
    const kinds = items.filter((p) => p.startsWith(AUTH_PREFIX) || p.startsWith(TICKET_PREFIX) || p.startsWith(TENANT_PREFIX) || p.startsWith(TOKEN_PREFIX) || p.startsWith(SERVICE_PREFIX));
    const roleItems = items.filter((p) => p.startsWith(ROLE_PREFIX));

    if (kinds.length > 1) return reject('multiple');
    if (kinds.length === 0) {
      if (roleItems.length > 0) {
        // Agent connection in local `local` space (C6.5 section 5): loopback source provides only
        // `promptcut.role.agent.<chatNumber>`, yielding local identity plus agent role and chat number;
        // write identity records this as "which chat of which Agent". Other role entries are not
        // accepted on their own
        if (!loopback) return reject('bad-format');
        if (roleItems.length > 1) return reject('multiple');
        if (!offered.includes(PROTOCOL)) return reject('bad-format');
        const m = /^agent\.([1-9][0-9]{0,14})$/.exec(roleItems[0].slice(ROLE_PREFIX.length));
        if (!m) return reject('bad-format');
        return { ...LOCAL_PRINCIPAL, role: 'agent', conversation: Number(m[1]) };
      }
      return loopback ? { ...LOCAL_PRINCIPAL } : reject('no-credential');
    }
    if (!offered.includes(PROTOCOL)) return reject('bad-format');
    const item = kinds[0];

    // ---------- Cluster token ----------
    if (item.startsWith(TOKEN_PREFIX)) {
      if (roleItems.length > 0) return reject('bad-format');
      if (!tokenDigest) return reject('no-credential');
      const ok = timingSafeEqual(digest(item.slice(TOKEN_PREFIX.length)), tokenDigest);
      return ok ? { ...ADMIN_PRINCIPAL } : reject('bad-proof');
    }

    // ---------- Local claim ----------
    if (item.startsWith(TENANT_PREFIX)) {
      if (!loopback) return reject('no-credential');
      if (roleItems.length > 1) return reject('multiple');
      const projectId = item.slice(TENANT_PREFIX.length);
      let role = 'page';
      let conversation = null;
      if (roleItems.length === 1) {
        const m = /^(page|agent|render)(?:\.([1-9][0-9]{0,14}))?$/.exec(roleItems[0].slice(ROLE_PREFIX.length));
        if (!m) return reject('bad-format');
        role = m[1];
        if (m[2] !== undefined) {
          if (role !== 'agent') return reject('bad-format');
          conversation = Number(m[2]);
        }
      }
      if (role === 'agent' && conversation === null) return reject('bad-format');
      if (!isProjectId(projectId)) return reject('bad-format');
      const rec = storeOf()?.peek(projectId);
      if (!rec) return reject('no-project');
      const unavailable = roomUnavailableReason(rec);
      if (unavailable) return reject(unavailable);
      if (!localDevice || !isDeviceId(localDevice.deviceId)) return reject('no-credential');
      return memberPrincipal({
        projectId, username: 'local', deviceId: localDevice.deviceId, deviceName: localDevice.deviceName,
        creator: true, role, conversation,
      });
    }

    if (roleItems.length > 0) return reject('bad-format');
    // During cooldown period: non-loopback sources with proof or ticket are rejected (even with correct passphrase)
    if (!loopback && limiter.blocked(remote)) return reject('rate-limited');

    // ---------- Service identity (control connection) ----------
    if (item.startsWith(SERVICE_PREFIX)) {
      const registry = registryOf();
      if (!registry) return reject('no-credential');
      const failService = (reason) => {
        if (!loopback) limiter.fail(remote);
        return reject(reason);
      };
      const raw = b64urlDecode(item.slice(SERVICE_PREFIX.length));
      if (!raw || raw.length > MAX_PROTOCOL_JSON) return reject('bad-format');
      const text = utf8Text(raw);
      let j;
      try {
        j = text === null ? null : JSON.parse(text);
      } catch {
        j = null;
      }
      if (!isObj(j) || j.v !== 1) return reject('bad-format');
      const { s: service, kid, d: deviceId, dn: deviceName, nonce, m } = j;
      if (!isServiceName(service) || typeof kid !== 'string' || kid === '' || kid.length > 16 || !isDeviceId(deviceId) || !isDeviceName(deviceName)
        || typeof nonce !== 'string' || typeof m !== 'string') return reject('bad-format');
      // Verify nonce first: invalidated regardless of subsequent success or failure; replayed used nonces
      // do not count toward rate limiting (same as proof)
      const nonceState = challenges.check(nonce, ['service', service, deviceId]);
      if (nonceState === 'used') return reject('nonce');
      if (nonceState !== 'ok') return failService('nonce');
      // Only accept connections genuinely initiated from this machine: even if the private key leaks, it
      // can only be used on the node itself (contract section 1.2 [ruling])
      let direct = false;
      try { direct = !!isDirectLocal(req); } catch { direct = false; }
      if (!direct) return reject('service-origin');
      const entry = registry.get(service);
      const key = entry?.keys.find((k) => k.kid === kid) ?? null;
      const sig = b64urlDecode(m);
      if (!key || !sig || sig.length !== SERVICE_SIG_BYTES) return failService('bad-service');
      if (!verifyServiceProof(key.pub, { service, deviceId, nonce }, m)) return failService('bad-service');
      return serviceControlPrincipal({ service, kid, role: entry.role, deviceId, deviceName });
    }

    // ---------- Connection ticket ----------
    if (item.startsWith(TICKET_PREFIX)) {
      const st = storeOf();
      if (!st) return reject('no-project');
      const v = verifyTicket(item.slice(TICKET_PREFIX.length), { lookup: (id) => st.peek(id), now: now(), kind: 'conn' });
      if (!v.ok) return reject(v.reason === 'no-project' ? 'no-project' : 'bad-proof');
      const p = v.payload;
      const who = splitUserId(p.u);
      if (p.sv !== undefined) {
        // Tickets with service identity: check registry and switches for this project first
        const registry = registryOf();
        const refused = serviceAdmission({ registry, record: v.record, service: p.sv, kid: p.sk, role: p.r });
        if (refused) return reject(refused);
        const own = who.username === serviceUsername(p.sv);
        if (registry.get(p.sv).actsFor === 'member') {
          // Enter project on behalf of a member (Cloud Agent service): ticket's `u` and `ug` belong to the
          // member, check list and ban table as a member
          if (own) {
            // This service's own identity has only one use: connections used solely to publish prerender retry
            // plans (`cloud-agent-contract.md` section 16).
            // Not a member: does not check list or ban table, and carries no member permissions; whitelist only
            // allows publishing those few message types
            if (p.pu !== 'publish') return reject('bad-format');
            return {
              ...serviceDataPrincipal({ service: p.sv, kid: p.sk, projectId: p.p, deviceId: who.deviceId, deviceName: p.dn ?? who.deviceId, role: p.r }),
              purpose: 'publish',
            };
          }
          const asCreator = p.cr === true;
          const banned = admissionOf(v.record, { username: who.username, deviceId: who.deviceId, creator: asCreator });
          if (banned) return reject(banned);
          return {
            ...memberPrincipal({
              projectId: p.p, username: who.username, deviceId: who.deviceId, deviceName: p.dn ?? who.deviceId,
              creator: asCreator, role: p.r, conversation: p.c, owner: p.o,
            }),
            service: p.sv, serviceKid: p.sk,
            // Permissions take the lesser of what is in the ticket and current; if not specified in the ticket,
            // defaults to read-only (fail-closed)
            access: narrowAccess(p.acc === 'rw' ? 'rw' : 'r', memberAccess(v.record, who.username, asCreator)),
          };
        }
        // Enter project with the service's own identity (render service): not a member, does not check list
        // or ban table
        if (!own || p.pu !== undefined || p.acc !== undefined) return reject('bad-format');
        return serviceDataPrincipal({ service: p.sv, kid: p.sk, projectId: p.p, deviceId: who.deviceId, deviceName: p.dn ?? who.deviceId, role: p.r });
      }
      const creator = p.cr === true;
      const denied = admissionOf(v.record, { username: who.username, deviceId: who.deviceId, creator });
      if (denied) return reject(denied);
      return memberPrincipal({
        projectId: p.p, username: who.username, deviceId: who.deviceId, deviceName: p.dn ?? who.deviceId,
        creator, role: p.r, conversation: p.c, owner: p.o,
      });
    }

    // ---------- Proof ----------
    const fail = (reason) => {
      if (!loopback) limiter.fail(remote);
      return reject(reason);
    };
    const raw = b64urlDecode(item.slice(AUTH_PREFIX.length));
    if (!raw || raw.length > MAX_PROTOCOL_JSON) return reject('bad-format');
    const text = utf8Text(raw);
    let j;
    try {
      j = text === null ? null : JSON.parse(text);
    } catch {
      j = null;
    }
    if (!isObj(j) || j.v !== 1) return reject('bad-format');
    const { p: projectId, u: username, d: deviceId, dn: deviceName, as, nonce, m, r: role, c, o } = j;
    if (!isProjectId(projectId) || !isUsername(username) || !isDeviceId(deviceId) || !isDeviceName(deviceName)) return reject('bad-format');
    // Usernames starting with `service:` are reserved for service identities; members cannot enter
    // with them (contract hosted-render section 1.4)
    if (isReservedUsername(username)) return reject('bad-format');
    if ((as !== 'member' && as !== 'creator') || typeof nonce !== 'string' || typeof m !== 'string') return reject('bad-format');
    // Verify nonce first: invalidated regardless of subsequent success or failure. Replays of used
    // nonces (Node's WebSocket retries once as-is after 401) do not count toward rate limiting
    const nonceState = challenges.check(nonce, ['join', projectId, username, deviceId, as]);
    if (nonceState === 'used') return reject('nonce');
    if (nonceState !== 'ok') return fail('nonce');
    if (!isRole(role)) return reject('bad-format');
    if (role === 'agent' ? !isConversation(c) : (c !== undefined && c !== null)) return reject('bad-format');
    let owner = null;
    if (o !== undefined && o !== null) {
      if (role !== 'render') return reject('bad-format');
      owner = normalizeOwner(o);
      if (!owner) return reject('bad-format');
    }
    const st = storeOf();
    const rec = st?.peek(projectId);
    if (!rec) return reject('no-project');
    const unavailable = roomUnavailableReason(rec);
    if (unavailable) return reject(unavailable);
    const cred = credentialFor(rec, username, as);
    if (!cred) return fail('not-listed');
    const given = b64urlDecode(m);
    if (!given || given.length !== 32) return fail('bad-proof');
    const expected = createHmac('sha256', Buffer.from(cred.key, 'base64url'))
      .update(authPurpose({ projectId, username, deviceId, as, nonce }))
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(given))) return fail('bad-proof');
    const creator = as === 'creator' || (rec.mode === 'restricted' && cred === rec.creator);
    const denied = admissionOf(rec, { username, deviceId, creator });
    if (denied) return reject(denied);
    return memberPrincipal({ projectId, username, deviceId, deviceName, creator, role, conversation: role === 'agent' ? c : null, owner });
  }

  return {
    authenticate,
    /** Subprotocol to echo on successful handshake: returns only `promptcut.v1` */
    protocolFor(req) {
      return offeredProtocols(req).includes(PROTOCOL) ? PROTOCOL : null;
    },
  };
}
