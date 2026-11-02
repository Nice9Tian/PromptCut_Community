/**
 * Invite codes (C10a contract `docs/plan/c10a-contract.md` section 5): generation, digest, status, redemption.
 *
 * - Invite code: `crypto.randomBytes(32)` encoded as unpadded base64url, 43 characters. Raw code
 *   appears only in the issuance response, never written to disk or logged.
 * - Stored in project records (`store.mjs`, co-located with credentials):
 *   `invite: { id, digest, createdAt, expiresAt, maxUses, used, redeemed: [userId…], revokedAt }`,
 *   `digest = base64url(HMAC-SHA256(serverSecret, code))`.
 * - A project has only one valid invite code: issuing a new one invalidates the old one (entire
 *   old record replaced, old digest invalidated accordingly).
 * - Default validity is 7 days, unlimited uses (`maxUses: null`); creator can change this at issuance.
 * - "Valid" = exists, not invalidated, not expired, uses not exhausted. On redemption, re-redemption
 *   by same `userId` (username + device id) does not deduct uses again.
 *
 * This module contains only pure functions and Node built-in `node:crypto`; HTTP endpoints reside in
 * `http.mjs`, and creator operations reside in `../docservice/modules/shared.mjs`. When HT-a modifies
 * `http.mjs` / `shared.mjs` later, invite code rules remain here and do not need to change.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { b64urlEncode } from './protocol.mjs';

/** Invite code byte length and encoded length (contract section 5) */
export const INVITE_BYTES = 32;
export const INVITE_LENGTH = 43;

export const INVITE_DEFAULTS = Object.freeze({
  /** Default validity: 7 days (seconds) */
  EXPIRES_IN_SEC: 604_800,
  /** Maximum validity: one year (seconds). Contract specifies no upper bound; only blocks obvious errors here */
  MAX_EXPIRES_IN_SEC: 365 * 86_400,
  /** Maximum uses: contract specifies no upper bound; blocks obvious errors */
  MAX_USES: 1_000_000,
  /**
   * Number of redeemed userId entries to record: prevents unbounded growth when uses are unlimited;
   * once exceeded, earliest entries are no longer considered "redeemed" (re-redemption will deduct again)
   */
  MAX_REDEEMED: 10_000,
});

const INVITE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Invite code shape: 43 base64url characters (without `=`) */
export const isInviteCode = (v) => typeof v === 'string' && INVITE_RE.test(v);

/** New raw invite code */
export const newInviteCode = () => b64urlEncode(randomBytes(INVITE_BYTES));

/** Invite code digest: `base64url(HMAC-SHA256(serverSecret, code))` */
export function inviteDigest(serverSecret, code) {
  return b64urlEncode(createHmac('sha256', serverSecret).update(String(code), 'utf8').digest());
}

/**
 * Validate and normalize `invite-create` fields: `expiresInSec?` (positive integer seconds, default 604800),
 * `maxUses?` (positive integer or null, default null). Returns null if invalid.
 */
export function parseInviteOptions(msg) {
  const expiresInSec = msg?.expiresInSec ?? INVITE_DEFAULTS.EXPIRES_IN_SEC;
  const maxUses = msg?.maxUses ?? null;
  if (!Number.isSafeInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > INVITE_DEFAULTS.MAX_EXPIRES_IN_SEC) return null;
  if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > INVITE_DEFAULTS.MAX_USES)) return null;
  return { expiresInSec, maxUses };
}

/**
 * Issue: returns `{ code, invite }`, where `invite` is the entry to write into project records (without raw code).
 * @param {Buffer | Uint8Array} serverSecret
 * @param {{ expiresInSec: number, maxUses: number | null }} options Already processed by `parseInviteOptions`
 * @param {number} now Milliseconds
 */
export function issueInvite(serverSecret, { expiresInSec, maxUses }, now) {
  const code = newInviteCode();
  const invite = {
    id: b64urlEncode(randomBytes(9)),
    digest: inviteDigest(serverSecret, code),
    createdAt: now,
    expiresAt: now + expiresInSec * 1000,
    maxUses,
    used: 0,
    redeemed: [],
    revokedAt: null,
  };
  return { code, invite };
}

/** Whether this invite code record is currently valid (exists, not invalidated, not expired, uses not exhausted) */
export function inviteActive(invite, now) {
  if (!invite || typeof invite !== 'object') return false;
  if (invite.revokedAt !== null && invite.revokedAt !== undefined) return false;
  if (!(Number(invite.expiresAt) > now)) return false;
  if (invite.maxUses !== null && invite.maxUses !== undefined && Number(invite.used) >= invite.maxUses) return false;
  return true;
}

/** Response fields for `invite-status`: `{ active, expiresAt, maxUses, used, revokedAt }`, excluding raw code and digest */
export function inviteStatus(invite, now) {
  if (!invite) return { active: false, expiresAt: null, maxUses: null, used: 0, revokedAt: null };
  return {
    active: inviteActive(invite, now),
    expiresAt: invite.expiresAt ?? null,
    maxUses: invite.maxUses ?? null,
    used: Number(invite.used) || 0,
    revokedAt: invite.revokedAt ?? null,
  };
}

/**
 * Deduct uses during redemption (contract section 5 "Deduct uses"): verify validity first, then
 * increment `used` by one; re-redemptions by same `userId` do not deduct again. Modifies on draft
 * (called inside `store.update` mutate); returns `'ok'` (deducted), `'again'` (already redeemed by
 * same userId, not deducted), or `'invalid'`. Document service is single-process and synchronous,
 * so no other requests can intervene between verification and increment.
 */
export function redeemOn(invite, userId, now) {
  if (!invite) return 'invalid';
  const redeemed = Array.isArray(invite.redeemed) ? invite.redeemed : [];
  const seen = redeemed.includes(userId);
  // Already redeemed users: allow entry if invite code is still within validity period and not
  // invalidated, without checking uses (their redemption was counted already)
  if (seen) {
    if (invite.revokedAt !== null && invite.revokedAt !== undefined) return 'invalid';
    if (!(Number(invite.expiresAt) > now)) return 'invalid';
    return 'again';
  }
  if (!inviteActive(invite, now)) return 'invalid';
  invite.used = (Number(invite.used) || 0) + 1;
  invite.redeemed = [...redeemed, userId].slice(-INVITE_DEFAULTS.MAX_REDEEMED);
  return 'ok';
}
