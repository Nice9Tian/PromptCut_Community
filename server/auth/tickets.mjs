/**
 * 票据的签发与核对（契约 `docs/plan/auth-contract.md` 第 8 节）。
 *
 * 形状：`v1.<base64url(JSON)>.<base64url(HMAC-SHA256(签名密钥, "v1." + 负载段))>`，base64url 不带 `=`。
 * JSON：`{ kid, k: 'asset' | 'conn', p: projectId, u: userId, r, g, ug, exp, iat }`；
 * 连接票据另可带 `c`（对话号）、`o`（归属），以及本实现加的 `dn`（设备名）、`cr`（签发者是创建者，只作界面标记）。
 * 托管方服务身份的票据（`docs/plan/hosted-render-contract.md` 第 1.3、1.6 节）两类都另带 `sv`（服务名）与 `sk`（签发时
 * 服务所用公钥的 `kid`）。服务以自己的身份进项目时 `u` 是 `service:<服务名>@<instanceId>`（这时不带 `c`、`o`、`cr`）；
 * 代成员进项目的服务（登记表 `actsFor: 'member'`）`u`、`ug` 是那位成员的。哪种服务该用哪种由握手按登记表核对，这里只管形状。
 * 不带 `sv` 的票据 `u` 不许是保留用户名。
 *
 * 签名密钥是项目记录里的 `ticketKey`，`kid` 是它的编号（`store.kidOf`）；记录可以另存
 * `oldTicketKeys: [{ kid, key, until }]`，轮换期间旧票据照认，直到 `until`。
 *
 * 核对顺序：总长 ≤ 2048 → 负载段按 base64url / JSON 解出 `p` 与 `kid`，只用来找密钥 →
 * 用找到的密钥对**收到的原始负载段**验签名（定长比较）→ 验过才采信负载里的字段：类别、角色、有效期、代数。
 * 允许 30 s 时钟偏差；`exp - iat` 不得超过这类票据的有效期。
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

/** 某个用户当前的代数：没记过是 1 */
export const userGeneration = (rec, userId) => {
  const g = rec?.userGenerations?.[userId];
  return Number.isSafeInteger(g) ? g : 1;
};

/**
 * 签一张票据。
 * @param {object} rec 项目记录（要 `ticketKey`、`generation`、`userGenerations`）
 * @param {object} fields `{ k, u, r, c?, o?, dn?, cr?, sv?, sk?, acc?, pu? }`
 * @param {number} at 签发时刻
 * @returns {{ ticket: string, exp: number }}
 */
export function signTicket(rec, fields, at) {
  const unavailable = roomUnavailableReason(rec);
  if (unavailable) throw Object.assign(new Error('Room unavailable'), { reason: unavailable });
  const ttl = TICKET_TTL[fields.k];
  if (!ttl) throw new TypeError(`不认识的票据类别 ${fields.k}`);
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
    // 云端 Agent 服务的两种连接票据（`docs/plan/cloud-agent-contract.md` 第 4.3、16 节）：代成员的带 `acc`，只用来发布预渲染重试计划的带 `pu`
    if (fields.acc !== undefined && fields.acc !== null) payload.acc = fields.acc;
    if (fields.pu !== undefined && fields.pu !== null) payload.pu = fields.pu;
  }
  const seg = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = sign(rec.ticketKey, `v1.${seg}`).toString('base64url');
  return { ticket: `v1.${seg}.${sig}`, exp: payload.exp };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 核对一张票据。
 * @param {string} ticket
 * @param {object} options
 * @param {(projectId: string) => object | null} options.lookup 取项目记录（只读）
 * @param {number} options.now
 * @param {'asset' | 'conn'} [options.kind] 只认这一类
 * @returns {{ ok: true, payload: object, record: object } | { ok: false, reason: string }}
 *   `reason`：`format`、`no-project`、`signature`、`kind`、`expired`、`generation`
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
  // 服务身份的票据：服务名、公钥编号齐全；`u` 是保留用户名时必须正是这个服务的，且不带成员才有的字段。别的票据不许用保留用户名
  if (p.sv !== undefined) {
    if (!isServiceName(p.sv) || typeof p.sk !== 'string' || p.sk === '' || p.sk.length > 16) return bad('format');
    if (isReservedUsername(who.username) && (who.username !== serviceUsername(p.sv) || p.cr !== undefined || p.c !== undefined || p.o !== undefined)) return bad('format');
  } else if (p.sk !== undefined || isReservedUsername(who.username)) {
    return bad('format');
  }
  // `acc`（代成员的服务连接的权限）只出现在成员的 `sv` 连接票据上；`pu`（只用来发布）只出现在服务自己身份的 `sv` 连接票据上
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
