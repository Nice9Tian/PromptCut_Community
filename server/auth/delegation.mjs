/**
 * 云端 Agent 的两种成员身份证明（契约 `docs/plan/cloud-agent-contract.md` 第 4.2、4.6、7.2 节；`docs/plan/auth-contract.md` 第 17 节）。
 *
 * | | 委托票据 | 对话委托 |
 * |---|---|---|
 * | 用途 | 页面打 Agent 服务的每个请求时出示：「我是谁」 | 一轮开始时交给 Agent 服务：「在这个对话里代我行事，我离线了也算数」 |
 * | 负载 | `{ kid, k: 'dlg', p, u, dn, cr?, aud, acc, g, ug, exp, iat }` | 同左，另加 `cid: <对话 id>`、`run: true` |
 * | 有效期 | 2 分钟 | 60 分钟 |
 *
 * 形状、签名密钥、核对顺序与连接票据相同（`tickets.mjs`）：`v1.<base64url(JSON)>.<base64url(HMAC-SHA256(ticketKey, "v1." + 负载段))>`，
 * 由项目的文档服务签，也只有它验；先验签名再采信字段；允许 30 s 时钟偏差。`k: 'dlg'` 与连接票据、素材票据的类别不同，
 * 所以它当不了握手票据，也当不了素材票据（`verifyTicket` 只认 `asset` / `conn`）。
 *
 * 委托本身是无状态的票据，撤销不靠查「已发委托」的表，靠文档服务手里的四样：项目代数与成员代数（改口令、改名单、踢人）、
 * 名单与禁入表、项目对这个服务的开关、服务登记表。`checkDelegation` 每次都把这四样重新看一遍，**不看成员在不在线**。
 *
 * 只用 Node 内置模块。委托的原文不进任何日志与错误信息（要记就记 `delegationDigest`）。
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

/** 日志里代替原文的摘要：SHA-256 的前 8 个十六进制字符 */
export const delegationDigest = (ticket) => createHash('sha256').update(String(ticket), 'utf8').digest('hex').slice(0, 8);

/**
 * 这位成员在这个项目里的权限（契约第 4.6 节）：项目记录的可选字段 `readonly: [用户名]` 里有他就是只读，否则读写；
 * 以创建者身份进入的恒为读写。这一版没有设置 `readonly` 的界面与创建者操作，没有这个字段时人人读写。
 * @returns {'r' | 'rw'}
 */
export function memberAccess(record, username, creator = false) {
  if (creator === true) return 'rw';
  const list = Array.isArray(record?.readonly) ? record.readonly : [];
  return list.includes(username) ? 'r' : 'rw';
}

/** 两个权限里取小的 */
export const narrowAccess = (a, b) => (a === 'rw' && b === 'rw' ? 'rw' : 'r');

/**
 * 云端对话的归属键（契约第 7.2 节，待用户审的裁定 U1）。由文档服务算好交给 Agent 服务，Agent 服务不自己推断：
 * - 以创建者身份进入的 → `creator`（换设备能找回）；
 * - 限定进入的名单成员（各有自己的口令）→ `user:<用户名>`（换设备能找回）；
 * - 自由进入的成员（用户名是自报的）→ `device:<userId>`（只能在原设备找回）。
 * 键里不含项目：Agent 服务按「项目 / 归属键」分目录。
 */
export function ownerKeyOf(record, { username, userId, creator }) {
  if (creator === true) return 'creator';
  return record?.mode === 'restricted' ? `user:${username}` : `device:${userId}`;
}

/**
 * 签一张委托票据或对话委托。
 * @param {object} rec 项目记录
 * @param {object} fields `{ u, dn?, cr?, aud, acc, cid? }`；给了 `cid` 就是对话委托（带 `run: true`、60 分钟）
 * @param {number} at 签发时刻
 * @returns {{ ticket: string, exp: number, grant: boolean }}
 */
export function signDelegation(rec, fields, at) {
  const unavailable = roomUnavailableReason(rec);
  if (unavailable) throw Object.assign(new Error('Room unavailable'), { reason: unavailable });
  if (!DELEGATION_AUDIENCES.includes(fields.aud)) throw new TypeError('signDelegation: 不认识的受众');
  if (!isAccess(fields.acc)) throw new TypeError("signDelegation: acc 只能是 'r' 或 'rw'");
  const grant = fields.cid !== undefined && fields.cid !== null;
  if (grant && !isConversationId(fields.cid)) throw new TypeError('signDelegation: 对话 id 不合格');
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
 * 核对一张委托（只看票据自己：形状、签名、有效期、代数、受众）。
 * @param {string} ticket
 * @param {object} options
 * @param {(projectId: string) => object | null} options.lookup 取项目记录（只读）
 * @param {number} options.now
 * @param {string} [options.audience] 必须是给这个服务的
 * @returns {{ ok: true, payload: object, record: object, grant: boolean } | { ok: false, reason: string }}
 *   `reason`：`format`、`no-project`、`relocating` / `relocated`、`signature`、`expired`、`generation`、`audience`
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
  // 只为找密钥解析一次；采信字段要等签名验过
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

/** 这个身份现在还能不能在这个项目里（与 `handshake.mjs` 的 `admissionOf` 同一条规则；这里重写一份免得两个模块互相引用） */
function memberAdmission(rec, { username, deviceId, creator }) {
  if ((rec.bans ?? []).some((b) => b.username === username && b.deviceId === deviceId)) return 'banned';
  if (rec.mode === 'restricted' && !creator && rec.creator.username !== username && !(rec.list ?? []).some((e) => e.username === username)) {
    return 'not-listed';
  }
  return null;
}

/**
 * 完整核对一张委托：票据自己（`verifyDelegation`），再加登记表、项目的开关、名单与禁入表。**不看成员在不在线。**
 * 目录模块的 `hosted.delegate.verify` 与 `hosted.ticket` 的委托分支都问它。
 * @param {object} options
 * @param {string} options.ticket
 * @param {(projectId: string) => object | null} options.lookup
 * @param {object | null} options.registry 服务登记表
 * @param {string} options.service 来核对的那个服务（委托的 `aud` 必须是它）
 * @param {string} [options.kid] 服务此刻所用的公钥编号（给了就核对它还在登记表里）
 * @param {number} options.now
 * @returns {{ ok: true, payload, record, grant, username, deviceId, creator, access, ownerKey } | { ok: false, reason: string }}
 *   `reason` 另有 `service-revoked`、`service-disabled`、`banned`、`not-listed`
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
    // 权限取「签发时的」与「此刻的」里小的那个：签发后被改成只读，下一次核对就按只读
    access: narrowAccess(v.payload.acc, memberAccess(v.record, who.username, creator)),
    ownerKey: ownerKeyOf(v.record, { username: who.username, userId: v.payload.u, creator }),
  };
}
