/**
 * Issuance and verification of tickets (contract `docs/plan/auth-contract.md` Section 8).
 *
 * Shape: `v1.<base64url(JSON)>.<base64url(HMAC-SHA256(signingKey, "v1." + payloadSegment))>`,
 * base64url without `=`.
 * JSON: `{ kid, k: 'asset' | 'conn', p: projectId, u: userId, r, g, ug, exp, iat }`;
 * connection tickets may additionally carry `c` (chat number), `o` (ownership), as well as this
 * implementation's `dn` (device name) and `cr` (issuer is creator, UI badge only).
 * Tickets with host service identity (`docs/plan/hosted-render-contract.md` Sections 1.3 and 1.6)
 * of both kinds additionally carry `sv` (service name) and `sk` (`kid` of the public key used by
 * the service when issued). When a service enters a project with its own identity, `u` is
 * `service:<serviceName>@<instanceId>` (in this case without `c`, `o`, `cr`); for a service entering
 * on behalf of a member (registry `actsFor: 'member'`), `u` and `ug` are that member's. Which service
 * uses which kind is checked during handshake against the registry; here only the shape is enforced.
 * For tickets without `sv`, `u` must not be a reserved username.
 *
 * Signing key is `ticketKey` in project record, `kid` is its ID (`store.kidOf`); records may also
 * store `oldTicketKeys: [{ kid, key, until }]`; during rotation, old tickets remain accepted until
 * `until`.
 *
 * Verification order: total length ≤ 2048 → payload segment decoded via base64url / JSON for `p`
 * and `kid`, used only to locate key → verify signature on the **raw received payload segment** with
 * the located key (constant-time comparison) → only after verification accept fields in payload:
 * kind, role, expiration, generation.
 * Allows 30 s clock skew; `exp - iat` must not exceed validity duration for this ticket kind.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { roomUnavailableReason } from '../recovery/relocation.mjs';
import {
  TICKET_TTL, MAX_TICKET_LENGTH, b64urlDecode, utf8Text, isProjectId, isRole, isConversation, normalizeOwner,
  isDeviceName, splitUserId, isServiceName, isReservedUsername, serviceUsername,
} from './protocol.mjs';
import { kidOf } from './store.mjs';

export const CLOCK_SKEW_MS = 30_000;

const sign = (key, data) => createHmac('sha256', Buffer.from(key, 'base64url')).update(data, 'utf8').digest();

/** Current generation of a user: defaults to 1 if unrecorded */
export const userGeneration = (rec, userId) => {
  const g = rec?.userGenerations?.[userId];
  return Number.isSafeInteger(g) ? g : 1;
};

/**
 * Signs a ticket.
 * @param {object} rec Project record (requires `ticketKey`, `generation`, `userGenerations`)
 * @param {object} fields `{ k, u, r, c?, o?, dn?, cr?, sv?, sk?, acc?, pu? }`
 * @param {number} at Issuance timestamp
 * @returns {{ ticket: string, exp: number }}
 */
export function signTicket(rec, fields, at) {
  const unavailable = roomUnavailableReason(rec);
  if (unavailable) throw Object.assign(new Error('Room unavailable'), { reason: unavailable });
  const ttl = TICKET_TTL[fields.k];
  if (!ttl) throw new TypeError(`Unknown ticket type ${fields.k}`);
  const payload = {
    kid: kidOf(rec.ticketKey),
    k: fields.k,
    p: rec.projectId,
    u: fields.u,
    r: fields.r,
    g: rec.generation,
    ug: userGeneration(rec, fields.u),
    exp: at + ttl,
    iat: at,
  };
  if (fields.c !== undefined && fields.c !== null) payload.c = fields.c;
  if (fields.o !== undefined && fields.o !== null) payload.o = fields.o;
  if (fields.dn !== undefined && fields.dn !== null) payload.dn = fields.dn;
  if (fields.cr === true) payload.cr = true;
  if (fields.sv !== undefined && fields.sv !== null) {
    payload.sv = fields.sv;
    payload.sk = fields.sk;
    // Two connection ticket types for Cloud Agent service (`docs/plan/cloud-agent-contract.md`
    // Sections 4.3, 16): acting for members carries `acc`, publishing prerender retry plans only carries `pu`
    if (fields.acc !== undefined && fields.acc !== null) payload.acc = fields.acc;
    if (fields.pu !== undefined && fields.pu !== null) payload.pu = fields.pu;
  }
  const seg = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = sign(rec.ticketKey, `v1.${seg}`).toString('base64url');
  return { ticket: `v1.${seg}.${sig}`, exp: payload.exp };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Verifies a ticket.
 * @param {string} ticket
 * @param {object} options
 * @param {(projectId: string) => object | null} options.lookup Look up project record (read-only)
 * @param {number} options.now
 * @param {'asset' | 'conn'} [options.kind] Accept only this kind
 * @returns {{ ok: true, payload: object, record: object } | { ok: false, reason: string }}
 *   `reason`: `format`, `no-project`, `signature`, `kind`, `expired`, `generation`
 */
export function verifyTicket(ticket, { lookup, now, kind } = {}) {
  const bad = (reason) => ({ ok: false, reason });
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > MAX_TICKET_LENGTH) return bad('format');
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return bad('format');
  const [, seg, sigText] = parts;
  const raw = b64urlDecode(seg);
  const sig = b64urlDecode(sigText);
  if (!raw || !sig || sig.length !== 32) return bad('format');
  // Parsed once only to locate the key; trusting fields must wait until signature is verified
  const text = utf8Text(raw);
  let hint;
  try {
    hint = text === null ? null : JSON.parse(text);
  } catch {
    hint = null;
  }
  if (!isObj(hint) || !isProjectId(hint.p) || typeof hint.kid !== 'string') return bad('format');
  const rec = lookup(hint.p);
  if (!rec) return bad('no-project');
  const unavailable = roomUnavailableReason(rec);
  if (unavailable) return bad(unavailable);
  const at = now;
  let key = null;
  if (kidOf(rec.ticketKey) === hint.kid) key = rec.ticketKey;
  else {
    for (const old of rec.oldTicketKeys ?? []) {
      if (old && old.kid === hint.kid && typeof old.key === 'string' && !(Number.isFinite(old.until) && old.until < at)) key = old.key;
    }
  }
  if (!key) return bad('signature');
  const expected = sign(key, `v1.${seg}`);
  if (!timingSafeEqual(expected, Buffer.from(sig))) return bad('signature');

  const p = hint;
  if (p.k !== 'asset' && p.k !== 'conn') return bad('format');
  if (kind && p.k !== kind) return bad('kind');
  const who = splitUserId(p.u);
  if (!who) return bad('format');
  // Tickets with service identity: service name and public key ID must both be present; when `u` is
  // a reserved username, it must belong to this service and have no member-only fields. Other tickets
  // must not use reserved usernames
  if (p.sv !== undefined) {
    if (!isServiceName(p.sv) || typeof p.sk !== 'string' || p.sk === '' || p.sk.length > 16) return bad('format');
    if (isReservedUsername(who.username) && (who.username !== serviceUsername(p.sv) || p.cr !== undefined || p.c !== undefined || p.o !== undefined)) return bad('format');
  } else if (p.sk !== undefined || isReservedUsername(who.username)) {
    return bad('format');
  }
  // `acc` (permissions for service connections acting for a member) only appears on a member's `sv`
  // connection ticket; `pu` (publish only) only appears on the service's own `sv` connection ticket
  if (p.acc !== undefined && (p.sv === undefined || p.k !== 'conn' || isReservedUsername(who.username) || (p.acc !== 'r' && p.acc !== 'rw'))) return bad('format');
  if (p.pu !== undefined && (p.sv === undefined || p.k !== 'conn' || !isReservedUsername(who.username) || p.pu !== 'publish')) return bad('format');
  if (p.k === 'asset' && p.r !== 'r' && p.r !== 'rw') return bad('format');
  if (p.k === 'conn') {
    if (!isRole(p.r)) return bad('format');
    if (p.r === 'agent' && !isConversation(p.c) && p.pu !== 'publish') return bad('format');
    if (p.c !== undefined && !isConversation(p.c)) return bad('format');
    if (p.o !== undefined && (p.r !== 'render' || !normalizeOwner(p.o))) return bad('format');
    if (p.dn !== undefined && !isDeviceName(p.dn)) return bad('format');
  }
  if (!Number.isSafeInteger(p.exp) || !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.g) || !Number.isSafeInteger(p.ug)) return bad('format');
  if (p.exp - p.iat > TICKET_TTL[p.k] || p.exp < p.iat) return bad('format');
  if (at > p.exp + CLOCK_SKEW_MS || p.iat > at + CLOCK_SKEW_MS) return bad('expired');
  if (p.g !== rec.generation || p.ug !== userGeneration(rec, p.u)) return bad('generation');
  return { ok: true, payload: p, record: rec };
}
