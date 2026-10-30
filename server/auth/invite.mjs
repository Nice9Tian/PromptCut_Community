/**
 * 邀请码（C10a 契约 `docs/plan/c10a-contract.md` 第 5 节）：生成、摘要、状态、兑换。
 *
 * - 邀请码：`crypto.randomBytes(32)` 编成不带填充的 base64url，43 个字符。原文只在签发的那一次回包里出现，不落盘、不进日志。
 * - 存在项目记录里（`store.mjs`，与凭证同处）：
 *   `invite: { id, digest, createdAt, expiresAt, maxUses, used, redeemed: [userId…], revokedAt }`，
 *   `digest = base64url(HMAC-SHA256(serverSecret, code))`。
 * - 一个项目只有一个有效邀请码：签发新的同时作废旧的（旧记录整条换掉，旧摘要随之失效）。
 * - 缺省有效期 7 天、次数不限（`maxUses: null`）；创建者签发时可以改。
 * - 「有效」= 存在、未作废、未过期、次数未满。兑换时同一 `userId`（用户名 + 设备 id）再兑换不重复扣次。
 *
 * 本模块只有纯函数与 Node 内置的 `node:crypto`；HTTP 端点在 `http.mjs`，创建者操作在
 * `../docservice/modules/shared.mjs`。以后 HT-a 改 `http.mjs` / `shared.mjs` 时，邀请码的规则都在这里，不用跟着动。
 */
import { createHmac, randomBytes } from 'node:crypto';
import { b64urlEncode } from './protocol.mjs';

/** 邀请码的字节数与编码后的长度（契约第 5 节） */
export const INVITE_BYTES = 32;
export const INVITE_LENGTH = 43;

export const INVITE_DEFAULTS = Object.freeze({
  /** 缺省有效期：7 天（秒） */
  EXPIRES_IN_SEC: 604_800,
  /** 有效期上限：一年（秒）。契约没给上限，这里只挡明显写错的值 */
  MAX_EXPIRES_IN_SEC: 365 * 86_400,
  /** 次数上限：契约没给，挡明显写错的值 */
  MAX_USES: 1_000_000,
  /** 兑换过的 userId 记多少条：次数不限时也不让记录无限长；超过后最早的不再算「已兑换」（再兑换会再扣一次） */
  MAX_REDEEMED: 10_000,
});

const INVITE_RE = /^[A-Za-z0-9_-]{43}$/;

/** 邀请码的形状：43 个 base64url 字符（不带 `=`） */
export const isInviteCode = (v) => typeof v === 'string' && INVITE_RE.test(v);

/** 新的邀请码原文 */
export const newInviteCode = () => b64urlEncode(randomBytes(INVITE_BYTES));

/** 邀请码的摘要：`base64url(HMAC-SHA256(serverSecret, code))` */
export function inviteDigest(serverSecret, code) {
  return b64urlEncode(createHmac('sha256', serverSecret).update(String(code), 'utf8').digest());
}

/**
 * 校验并规整 `invite-create` 的字段：`expiresInSec?`（正整数秒，缺省 604800）、`maxUses?`（正整数或 null，缺省 null）。
 * 不合格回 null。
 */
export function parseInviteOptions(msg) {
  const expiresInSec = msg?.expiresInSec ?? INVITE_DEFAULTS.EXPIRES_IN_SEC;
  const maxUses = msg?.maxUses ?? null;
  if (!Number.isSafeInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > INVITE_DEFAULTS.MAX_EXPIRES_IN_SEC) return null;
  if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > INVITE_DEFAULTS.MAX_USES)) return null;
  return { expiresInSec, maxUses };
}

/**
 * 签发：回 `{ code, invite }`，`invite` 是要写进项目记录的那一条（不含原文）。
 * @param {Buffer | Uint8Array} serverSecret
 * @param {{ expiresInSec: number, maxUses: number | null }} options 已经 `parseInviteOptions` 过
 * @param {number} now 毫秒
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

/** 这条邀请码记录现在有没有效（存在、未作废、未过期、次数未满） */
export function inviteActive(invite, now) {
  if (!invite || typeof invite !== 'object') return false;
  if (invite.revokedAt !== null && invite.revokedAt !== undefined) return false;
  if (!(Number(invite.expiresAt) > now)) return false;
  if (invite.maxUses !== null && invite.maxUses !== undefined && Number(invite.used) >= invite.maxUses) return false;
  return true;
}

/** `invite-status` 的回包字段：`{ active, expiresAt, maxUses, used, revokedAt }`，不含原文与摘要 */
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
 * 兑换时的扣次数（契约第 5 节「扣次数」）：先核对有效，再给 `used` 加一；同一 `userId` 再兑换不重复扣。
 * 在草稿上改（`store.update` 的 mutate 里调）；回 `'ok'`（扣了）、`'again'`（同一 userId 兑换过，不扣）或 `'invalid'`。
 * 文档服务单进程、同步处理，核对与加一之间没有别的请求插进来。
 */
export function redeemOn(invite, userId, now) {
  if (!invite) return 'invalid';
  const redeemed = Array.isArray(invite.redeemed) ? invite.redeemed : [];
  const seen = redeemed.includes(userId);
  // 已兑换过的人：邀请码还在有效期内、没作废就放行，不看次数（他那一次早算过了）
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
