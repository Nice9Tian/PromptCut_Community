/**
 * Two kinds of member credentials for Cloud Agent (contract `docs/plan/cloud-agent-contract.md`
 * Sections 4.2, 4.6, 7.2; `docs/plan/auth-contract.md` Section 17).
 *
 * | | Delegation ticket | Chat delegation |
 * |---|---|---|
 * | Purpose | Presented on every request from page to Agent service: "who I am" | Given to Agent service at start of round: "act for me in this chat, counts even if I go offline" |
 * | Payload | `{ kid, k: 'dlg', p, u, dn, cr?, aud, acc, g, ug, exp, iat }` | Same as left, with additional `cid: <chat id>`, `run: true` |
 * | Validity | 2 minutes | 60 minutes |
 *
 * Shape, signing key, and verification order are identical to connection tickets (`tickets.mjs`):
 * `v1.<base64url(JSON)>.<base64url(HMAC-SHA256(ticketKey, "v1." + payloadSegment))>`, signed by
 * the project's document service, and only verified by it; verifies signature before trusting fields;
 * allows 30 s clock skew. `k: 'dlg'` differs from the categories of connection tickets and asset
 * tickets, so it cannot serve as a handshake ticket or asset ticket (`verifyTicket` only recognizes
 * `asset` / `conn`).
 *
 * Delegations themselves are stateless tickets; revocation does not rely on checking an "issued
 * delegations" table, but on four items held by the document service: project generation and member
 * generation (changing passphrases, changing lists, kicking members), list and ban list, project
 * toggle for this service, and the service registry. `checkDelegation` re-examines all four every
 * time, **without checking whether the member is online**.
 *
 * Uses only Node built-in modules. Raw delegation strings never enter any logs or error messages
 * (record `delegationDigest` if logging is needed).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { roomUnavailableReason } from '../recovery/relocation.mjs';
import {
  DELEGATION_TTL, DELEGATION_AUDIENCES, MAX_TICKET_LENGTH, b64urlDecode, utf8Text, isProjectId, isDeviceName, isConversationId, isAccess,
  splitUserId, isReservedUsername,
} from './protocol.mjs';
import { kidOf } from './store.mjs';
import { CLOCK_SKEW_MS, userGeneration } from './tickets.mjs';
import { serviceEnabled } from './service-identity.mjs';

export const DELEGATION_KIND = 'dlg';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sign = (key, data) => createHmac('sha256', Buffer.from(key, 'base64url')).update(data, 'utf8').digest();

/** Digest replacing raw text in logs: first 8 hexadecimal characters of SHA-256 */
export const delegationDigest = (ticket) => createHash('sha256').update(String(ticket), 'utf8').digest('hex').slice(0, 8);

/**
 * Permissions of this member in this project (contract Section 4.6): read-only if present in the
 * project record's optional field `readonly: [username]`, otherwise read-write; entering with
 * creator identity is always read-write. This version lacks a UI and creator operations to set
 * `readonly`; when this field is absent, everyone has read-write access.
 * @returns {'r' | 'rw'}
 */
export function memberAccess(record, username, creator = false) {
  if (creator === true) return 'rw';
  const list = Array.isArray(record?.readonly) ? record.readonly : [];
  if (list.includes(username)) return 'r';
  if (Array.isArray(record?.list) && record.list.some((e) => e.username === username && e.access === 'r')) return 'r';
  return 'rw';
}

/** Takes the lesser of the two permissions */
export const narrowAccess = (a, b) => (a === 'rw' && b === 'rw' ? 'rw' : 'r');

/**
 * Ownership key for cloud chats (contract Section 7.2, ruling U1 pending user review). Computed by
 * the document service and provided to the Agent service; the Agent service does not infer it:
 * - Entering with creator identity → `creator` (recoverable when switching devices);
 * - List members in restricted entry (each has their own passphrase) → `user:<username>`
 *   (recoverable when switching devices);
 * - Members in open entry (self-reported usernames) → `device:<userId>` (only recoverable on the
 *   original device).
 * The key excludes the project: the Agent service splits directories by "project / ownership key".
 */
export function ownerKeyOf(record, { username, userId, creator }) {
  if (creator === true) return 'creator';
  return record?.mode === 'restricted' ? `user:${username}` : `device:${userId}`;
}

/**
 * Signs a delegation ticket or chat delegation.
 * @param {object} rec Project record
 * @param {object} fields `{ u, dn?, cr?, aud, acc, cid? }`; providing `cid` makes it a chat
 *   delegation (with `run: true`, 60 minutes)
 * @param {number} at Issuance timestamp
 * @returns {{ ticket: string, exp: number, grant: boolean }}
 */
export function signDelegation(rec, fields, at) {
  const unavailable = roomUnavailableReason(rec);
  if (unavailable) throw Object.assign(new Error('Room unavailable'), { reason: unavailable });
  if (!DELEGATION_AUDIENCES.includes(fields.aud)) throw new TypeError('signDelegation: unknown audience');
  if (!isAccess(fields.acc)) throw new TypeError("signDelegation: acc must be 'r' or 'rw'");
  const grant = fields.cid !== undefined && fields.cid !== null;
  if (grant && !isConversationId(fields.cid)) throw new TypeError('signDelegation: invalid chat id');
  const payload = {
    kid: kidOf(rec.ticketKey),
    k: DELEGATION_KIND,
    p: rec.projectId,
    u: fields.u,
    aud: fields.aud,
    acc: fields.acc,
    g: rec.generation,
    ug: userGeneration(rec, fields.u),
    exp: at + (grant ? DELEGATION_TTL.grant : DELEGATION_TTL.ticket),
    iat: at,
  };
  if (fields.dn !== undefined && fields.dn !== null) payload.dn = fields.dn;
  if (fields.cr === true) payload.cr = true;
  if (grant) {
    payload.cid = fields.cid;
    payload.run = true;
  }
  const seg = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = sign(rec.ticketKey, `v1.${seg}`).toString('base64url');
  return { ticket: `v1.${seg}.${sig}`, exp: payload.exp, grant };
}

/**
 * Verifies a delegation (inspects only the ticket itself: shape, signature, validity, generation,
 * audience).
 * @param {string} ticket
 * @param {object} options
 * @param {(projectId: string) => object | null} options.lookup Gets project record (read-only)
 * @param {number} options.now
 * @param {string} [options.audience] Must be intended for this service
 * @returns {{ ok: true, payload: object, record: object, grant: boolean } | { ok: false, reason: string }}
 *   `reason`: `format`, `no-project`, `relocating` / `relocated`, `signature`, `expired`,
 *   `generation`, `audience`
 */
export function verifyDelegation(ticket, { lookup, now, audience } = {}) {
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
  let key = null;
  if (kidOf(rec.ticketKey) === hint.kid) key = rec.ticketKey;
  else {
    for (const old of rec.oldTicketKeys ?? []) {
      if (old && old.kid === hint.kid && typeof old.key === 'string' && !(Number.isFinite(old.until) && old.until < now)) key = old.key;
    }
  }
  if (!key) return bad('signature');
  if (!timingSafeEqual(sign(key, `v1.${seg}`), Buffer.from(sig))) return bad('signature');

  const p = hint;
  if (p.k !== DELEGATION_KIND) return bad('format');
  const who = splitUserId(p.u);
  if (!who || isReservedUsername(who.username)) return bad('format');
  if (!isAccess(p.acc) || typeof p.aud !== 'string') return bad('format');
  if (p.dn !== undefined && !isDeviceName(p.dn)) return bad('format');
  if (p.cr !== undefined && p.cr !== true) return bad('format');
  const grant = p.run !== undefined || p.cid !== undefined;
  if (grant && (p.run !== true || !isConversationId(p.cid))) return bad('format');
  if (!Number.isSafeInteger(p.exp) || !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.g) || !Number.isSafeInteger(p.ug)) return bad('format');
  if (p.exp - p.iat > (grant ? DELEGATION_TTL.grant : DELEGATION_TTL.ticket) || p.exp < p.iat) return bad('format');
  if (now > p.exp + CLOCK_SKEW_MS || p.iat > now + CLOCK_SKEW_MS) return bad('expired');
  if (p.g !== rec.generation || p.ug !== userGeneration(rec, p.u)) return bad('generation');
  if (audience !== undefined && p.aud !== audience) return bad('audience');
  return { ok: true, payload: p, record: rec, grant };
}

/** Whether this identity can still remain in this project (same rule as `admissionOf` in `handshake.mjs`; duplicated here to avoid circular imports between the two modules) */
function memberAdmission(rec, { username, deviceId, creator }) {
  if ((rec.bans ?? []).some((b) => b.username === username && b.deviceId === deviceId)) return 'banned';
  if (rec.mode === 'restricted' && !creator && rec.creator.username !== username && !(rec.list ?? []).some((e) => e.username === username)) {
    return 'not-listed';
  }
  return null;
}

/**
 * Fully verifies a delegation: the ticket itself (`verifyDelegation`), plus registry, project
 * switches, list, and ban table. **Does not check whether members are online.**
 * Both `hosted.delegate.verify` in the directory module and the delegation branch of
 * `hosted.ticket` consult it.
 * @param {object} options
 * @param {string} options.ticket
 * @param {(projectId: string) => object | null} options.lookup
 * @param {object | null} options.registry Service registry
 * @param {string} options.service The service to verify (must match the delegation's `aud`)
 * @param {string} [options.kid] Key ID currently used by the service (if provided, verifies it is
 *   still in the registry)
 * @param {number} options.now
 * @returns {{ ok: true, payload, record, grant, username, deviceId, creator, access, ownerKey } | { ok: false, reason: string }}
 *   `reason` also includes `service-revoked`, `service-disabled`, `banned`, `not-listed`
 */
export function checkDelegation({ ticket, lookup, registry, service, kid, now }) {
  const entry = registry ? registry.get(service) : null;
  if (!entry || (kid !== undefined && !entry.keys.some((k) => k.kid === kid))) return { ok: false, reason: 'service-revoked' };
  const v = verifyDelegation(ticket, { lookup, now, audience: service });
  if (!v.ok) return v;
  if (!serviceEnabled(v.record, service)) return { ok: false, reason: 'service-disabled' };
  const who = splitUserId(v.payload.u);
  const creator = v.payload.cr === true;
  const denied = memberAdmission(v.record, { username: who.username, deviceId: who.deviceId, creator });
  if (denied) return { ok: false, reason: denied };
  return {
    ok: true, payload: v.payload, record: v.record, grant: v.grant,
    username: who.username, deviceId: who.deviceId, creator,
    // Permissions take the lesser of "at issuance" and "current": if changed to read-only after
    // issuance, the next verification treats it as read-only
    access: narrowAccess(v.payload.acc, memberAccess(v.record, who.username, creator)),
    ownerKey: ownerKeyOf(v.record, { username: who.username, userId: v.payload.u, creator }),
  };
}
