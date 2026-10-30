/**
 * 共享项目的成员与创建者操作模块（契约 `docs/plan/auth-contract.md` 第 7、8 节），类型前缀 `shared.`，外加 `auth.ticket`。
 *
 * | 消息 | 回包 | 说明 |
 * |---|---|---|
 * | `shared.members` | `shared.members.list { devices }` | 本空间在线的设备，按「用户名 + 设备」聚合成一行 |
 * | `shared.watch` | `shared.members.list` | 订阅本空间的成员变化；之后每次有连接进出、创建者操作都再收一条 |
 * | `shared.challenge` | `shared.challenge.ok { nonce, salt, kdf }` | 为一次创建者操作取挑战（绑定这条连接与项目） |
 * | `shared.admin` | `shared.admin.ok { op }` 或 `error` | `{ op, proof: { nonce, m }, … }`，op 见下 |
 * | `auth.ticket` | `auth.ticket.ok { ticket, exp }` | 签发素材票据、连接票据，或云端 Agent 的委托（`kind: 'delegate'`，见 `delegateTicket`） |
 *
 * 托管方的服务（契约 `docs/plan/hosted-render-contract.md` 第 1.6、1.7、3 节；只在托管端、组装方给了 `hostedServices` 时有）：
 * - `shared.members.list` 顶层多一个 `hosted: { render: { available, enabled }, agent: { available, enabled } }`
 *   （`available`：这台文档服务的登记表里有这个服务；`enabled`：本项目对它的开关，记录里没有这一项算开）。放本机的项目没有这个字段；
 * - 以服务自己的身份进来的连接（渲染服务）单独一行，行上多一个 `service: '<服务名>'`（`username` 是保留的 `service:<服务名>`、
 *   `creator: false`），界面按 `service` 字段显示，不看用户名；代成员进来的服务连接（云端 Agent）归在那位成员的行里，
 *   `conns` 里那一项带 `service: '<服务名>'`；
 * - 创建者操作 `set-hosted-service { service: 'render' | 'agent', enabled: boolean }`：改开关（项目记录 `hosted.<服务名>.enabled`），
 *   不加代数、不断成员自己的连接。关掉时这个项目里这个服务的连接先放回手里的认领、再以 4003 `service-disabled` 关闭；
 *   并给本空间其余成员连接发 `shared.notice { event: 'hosted-service-changed', service, enabled }`。
 *   登记表里没有这个服务时回 `bad-message`；改的时候只动 `enabled`，同一个服务下的子选项（`render.streams`）保留；
 * - 创建者操作 `set-hosted-option { service: 'render', option: 'streams', enabled: boolean }`：改服务下面的子选项（项目记录
 *   `hosted.<服务名>.<选项名>`，没有算关）。只记下并通知，不断连接、不动认领；成员列表顶层 `hosted.render` 多带 `streams`；
 *   给本空间其余成员连接（不含服务连接）发 `shared.notice { event: 'hosted-option-changed', service, option, enabled }`。
 *   `service` 不认识、登记表里没有它、`option` 不认识、`enabled` 不是布尔值，都回 `bad-message`；
 * - 服务连接（`scope: 'service'`）的 `auth.ticket` 只签素材票据，负载多带 `sv`（服务名）与 `sk`（公钥编号）；
 * - `service:` 开头的用户名留给服务身份：`set-list` 的名单项、`kick` / `unban` 的目标是这种用户名回 `bad-message`。
 *
 * 创建者操作：`set-password`、`set-list`、`kick`、`unban`、`delete`。每次都要一份新的创建者证明
 * `m = HMAC-SHA256(K_创建者, "promptcut.admin.v1\n" + projectId + "\n" + 创建者用户名 + "\n" + op + "\n" + nonce)`，
 * `nonce` 须由同一连接刚取的 `shared.challenge` 给出。不带证明、证明不对一律回 `forbidden`；证明不对计入限速
 * （第 9 节），冷却期内回 `rate-limited`。除这五种操作外，创建者和普通成员的一切行为完全相同。
 *
 * 管理身份不在任何空间里（组装层的放行判断已挡住它发 `shared.*`）；`local` 身份没有项目，这里的请求一律 `forbidden`，
 * 只有 `shared.members` / `shared.watch` 照样回本空间（`local`）的连接。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ROLES, adminPurpose, b64urlDecode, isUsername as isUsernameShape, isDeviceId, isRole, isConversation, normalizeOwner, isReservedUsername,
} from '../../auth/protocol.mjs';
import { serviceAdmission, hostedStateOf, HOSTED_SERVICES, HOSTED_OPTIONS } from '../../auth/service-identity.mjs';
import { signTicket, userGeneration } from '../../auth/tickets.mjs';
import { signDelegation, memberAccess } from '../../auth/delegation.mjs';
import { DELEGATION_AUDIENCES, isConversationId } from '../../auth/protocol.mjs';
import { admissionOf, isLoopbackAddress } from '../../auth/handshake.mjs';
import { parseList, isCred } from '../../auth/http.mjs';
import { parseInviteOptions, issueInvite, inviteStatus } from '../../auth/invite.mjs';

export const SHARED_MODULE = 'shared';
export const ADMIN_OPS = Object.freeze([
  'set-password', 'set-list', 'kick', 'unban', 'delete', 'set-creator-password', 'list-bans',
  'invite-create', 'invite-revoke', 'invite-status',
  'set-hosted-service', 'set-hosted-option',
]);

/** 成员能用的用户名：形状对，且不是留给服务身份的 `service:` 开头 */
const isUsername = (v) => isUsernameShape(v) && !isReservedUsername(v);

/**
 * C10a 补的三种创建者操作(`docs/plan/c10a-contract.md` 第 5 节;规则与存储在 `../../auth/invite.mjs`):
 * - `invite-create { expiresInSec?, maxUses? }`:作废旧的、签发新的(缺省 7 天、次数不限),回
 *   `shared.admin.ok { op, code, expiresAt, maxUses }`,原文只在这一次回包里出现。另带 `linkOrigin`:托管端的公网源
 *   (取 `PROMPTCUT_DOCSERVICE_PUBLIC_URL` 的源,组装层传进来;没设为 null),界面拼邀请链接 `<源>/editor#invite=<码>` 用;
 * - `invite-revoke`:作废当前的,之后凭它加入一律失败;没有邀请码时照样回 ok;
 * - `invite-status`:回 `{ op, active, expiresAt, maxUses, used, revokedAt }`,不含原文。
 * 三种都不加代数、不断任何连接(作废邀请码不影响已经进来的人)。证明、限速与其余 op 相同。
 */

/**
 * C6.5 补的两种创建者操作(`docs/plan/c65-design.md` 第 9 节裁定、2026-09-26 主会话裁定):
 * - `set-creator-password { creator: { salt, key } }`:改创建者自己的口令(特权第 1 项「改项目密码」的一部分)。
 *   用户名不变;改完旧口令不能再以创建者身份进入,新口令可以,之后的创建者操作按新口令算证明。
 *   **不加代数**、不作废已发的票据、在线连接不断(只有改项目口令或名单才加代数)。两种进入方式都能用。
 * - `list-bans`:回 `shared.admin.ok { op, bans: [{ username, deviceId }], list?: [用户名] }`,只读(限定进入另带名单里的
 *   用户名,不带盐与 K)。界面「已禁入的设备」「改名单」要它;每次创建者操作前的「验证创建者身份」也用它当一次无副作用的证明核对。
 * - `set-list` 的条目可以写成 `{ username, keep: true }`:沿用这个人现有的口令(创建者拿不到别人的 K,
 *   只增删、只改某几个人时其余的照旧)。名单里没有这个人时整批 bad-message。
 * 另外,`set-password` 成功后给本空间其余在线连接各发一条 `shared.notice { event: 'password-changed' }`,
 * 界面据此出「项目密码已被修改」的气泡(交互稿第 5 节);在线连接照旧不断。
 */

/** 关闭码（第 7 节） */
export const CLOSE_REMOVED = 4003;
export const CLOSE_DELETED = 4004;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
// 管理身份、托管方服务的控制身份（没有 tenantId 的 service）不在任何空间里
const spaceOf = (p) => {
  if (typeof p?.tenantId === 'string' && p.tenantId !== '') return p.scope === 'admin' ? null : p.tenantId;
  return p?.scope === 'admin' || p?.scope === 'service' ? null : 'local';
};

class Refused extends Error {
  constructor(reason, detail) {
    super(detail ?? reason);
    this.reason = reason;
  }
}

/**
 * @param {object} options
 * @param {() => object | null} options.store 取凭证存储（`../../auth/store.mjs`）
 * @param {ReturnType<import('../../auth/challenges.mjs').createChallenges>} options.challenges 创建者操作的挑战（和 HTTP 端点的进入挑战分开放）
 * @param {ReturnType<import('../../auth/rate-limit.mjs').createRateLimiter>} options.limiter
 * @param {(tenantId: string) => void} [options.dropSpace] 删项目时丢掉这个空间的全部数据
 * @param {(connId: string) => number} [options.claimsOf] 这条连接持有的认领数（「渲染中」标签）
 * @param {(remote: string | null) => boolean} [options.isLoopbackRemote] 回环来源不计限速
 * @param {() => number} [options.now]
 * @param {{ registry: () => object | null, releaseClaims?: (connId: string) => number, urls?: Record<string, string> } | null} [options.hostedServices]
 *   托管端才给：服务登记表的取法，以及「立即放回这条连接手里的认领」（关掉渲染节点的开关时用）；`urls` 是各服务对页面的公网地址
 *   （现在只有 `agent`），成员列表顶层的 `hosted.<服务名>` 里多带一个 `url`
 */
export function sharedModule({
  store,
  challenges,
  limiter,
  dropSpace = () => {},
  claimsOf = () => 0,
  isLoopbackRemote = isLoopbackAddress,
  now,
  linkOrigin = null,
  hostedServices = null,
  accountRuntime = null,
} = {}) {
  const storeOf = typeof store === 'function' ? store : () => store;
  const registryOf = () => {
    try { return hostedServices?.registry?.() ?? null; } catch { return null; }
  };

  /** 成员列表顶层的 `hosted`：只有托管端的共享项目有 */
  function hostedOf(space) {
    if (!hostedServices || space === null) return undefined;
    const rec = storeOf()?.peek(space);
    if (!rec) return undefined;
    const state = hostedStateOf(registryOf(), rec);
    // 页面怎么找到这种服务（云端 Agent 的公网地址，`cloud-agent-contract.md` 第 10.4 节）：组装方配了、且登记表里有这个服务才带
    for (const [name, url] of Object.entries(hostedServices.urls ?? {})) {
      if (typeof url === 'string' && url !== '' && state[name]?.available) state[name].url = url;
    }
    return state;
  }

  function listMessage(space, devices = devicesOf(space)) {
    const message = { type: 'shared.members.list', devices };
    const hosted = hostedOf(space);
    if (hosted) message.hosted = hosted;
    return message;
  }

  /** 这条连接是不是托管方服务的（以自己的身份，或代成员） */
  const serviceOf = (p) => (typeof p?.service === 'string' ? p.service : null);
  /** connId → { principal, space, watching } */
  const conns = new Map();
  const clock = (ctx) => (typeof now === 'function' ? now() : ctx.now());

  function reply(ctx, connId, message, reqId) {
    if (reqId !== undefined) message.reqId = reqId;
    ctx.send(connId, message);
  }

  function connsIn(space) {
    return [...conns.entries()].filter(([, c]) => c.space === space);
  }

  /** 本空间的成员列表（第 7 节） */
  function devicesOf(space) {
    const rows = new Map();
    for (const [connId, c] of connsIn(space)) {
      const p = c.principal;
      // 云端 Agent 服务只用来发布预渲染重试计划的连接（`cloud-agent-contract.md` 第 16 节）不是谁的设备，也不代表任何成员，不列出来
      if (p.purpose === 'publish') continue;
      const key = p.userId;
      let row = rows.get(key);
      if (!row) {
        row = {
          deviceId: p.deviceId ?? null,
          deviceName: p.deviceName ?? null,
          username: p.username ?? p.userId,
          displayName: p.username ?? p.userId,
          creator: p.creator === true,
          tags: { editing: false, rendering: false, agents: 0 },
          conns: [],
        };
        // 托管方服务的连接：不是成员，界面按这个字段显示（「托管方的渲染节点」），不看用户名
        if (p.scope === 'service' && typeof p.service === 'string') row.service = p.service;
        rows.set(key, row);
      }
      const role = p.role ?? 'page';
      const item = { role };
      if (p.conversation !== undefined && p.conversation !== null) item.conversation = p.conversation;
      if (p.owner !== undefined && p.owner !== null) item.owner = { ...p.owner };
      // 代成员进来的服务连接（云端 Agent）归在成员这一行里，连接项上标明是哪个服务
      if (serviceOf(p) !== null && p.scope !== 'service') item.service = p.service;
      row.conns.push(item);
      if (role === 'page') row.tags.editing = true;
      if (role === 'agent') row.tags.agents += 1;
      if (role === 'render' && !row.tags.rendering) {
        let n = 0;
        try { n = Number(claimsOf(connId)) || 0; } catch { n = 0; }
        if (n > 0) row.tags.rendering = true;
      }
    }
    const list = [...rows.values()];
    // 同一用户名出现在不同设备上：这几台都显示为「用户名 (设备名)」
    for (const row of list) {
      const clash = list.some((o) => o !== row && o.username === row.username && o.deviceId !== row.deviceId);
      if (clash) row.displayName = `${row.username} (${row.deviceName ?? row.deviceId})`;
    }
    list.sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : String(a.deviceId) < String(b.deviceId) ? -1 : String(a.deviceId) > String(b.deviceId) ? 1 : 0));
    return list;
  }

  function notify(ctx, space) {
    if (space === null) return;
    let devices = null;
    for (const [connId, c] of connsIn(space)) {
      if (!c.watching) continue;
      devices ??= devicesOf(space);
      ctx.send(connId, listMessage(space, structuredClone(devices)));
    }
  }

  /** 这条连接是共享项目的成员（含本机声明），且项目还在 */
  function memberRecord(c) {
    if (!c || c.principal.scope !== 'member') throw new Refused('forbidden', '只有共享项目的成员能做这件事');
    const rec = storeOf()?.peek(c.space);
    if (!rec) throw new Refused('forbidden', '项目不存在');
    return rec;
  }

  function checkBlocked(ctx, connId) {
    const remote = ctx.remote?.(connId) ?? null;
    const loop = isLoopbackRemote(remote);
    if (!loop && limiter.blocked(remote)) throw new Refused('rate-limited', '口令错误太多，稍后再试');
    return { remote, loop };
  }

  // ---------- 消息 ----------

  function members(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    if (!c || c.space === null) throw new Refused('forbidden');
    reply(ctx, connId, listMessage(c.space), reqId);
  }

  function watch(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    if (!c || c.space === null) throw new Refused('forbidden');
    c.watching = true;
    reply(ctx, connId, listMessage(c.space), reqId);
  }

  function challenge(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    const rec = memberRecord(c);
    checkBlocked(ctx, connId);
    const nonce = challenges.issue(['admin', connId, c.space]);
    reply(ctx, connId, { type: 'shared.challenge.ok', nonce, salt: rec.creator.salt, kdf: { ...rec.kdf } }, reqId);
  }

  /** 托管方服务的连接要票据：只签素材票据，带 `sv` / `sk`；连接票据一律不签（那等于给自己换角色） */
  function serviceTicket(ctx, connId, c, msg, reqId) {
    const p = c.principal;
    if (c.space === null) throw new Refused('forbidden', '控制连接要不到票据');
    const rec = storeOf()?.peek(c.space) ?? null;
    if (!rec) {
      const runtime = typeof accountRuntime === 'function' ? accountRuntime() : accountRuntime;
      if (runtime && typeof runtime.issueServiceAssetTicket === 'function') {
        if (msg.kind !== 'asset') throw new Refused('forbidden', '服务身份只能要素材票据');
        const access = msg.access ?? 'r';
        if (access !== 'r' && access !== 'rw') throw new Refused('bad-message', "access 只能是 'r' 或 'rw'");
        const out = runtime.issueServiceAssetTicket({ projectId: c.space, service: p.service, serviceKid: p.serviceKid, access });
        return reply(ctx, connId, { type: 'auth.ticket.ok', ticket: out.assetTicket ?? out.ticket, exp: out.expiresAt ?? out.exp }, reqId);
      }
    }
    const refused = serviceAdmission({ registry: registryOf(), record: rec, service: p.service, kid: p.serviceKid, role: p.role });
    if (refused) throw new Refused('forbidden', refused);
    if (msg.kind !== 'asset') throw new Refused('forbidden', '服务身份只能要素材票据');
    const access = msg.access ?? 'r';
    if (access !== 'r' && access !== 'rw') throw new Refused('bad-message', "access 只能是 'r' 或 'rw'");
    const out = signTicket(rec, { k: 'asset', u: p.userId, r: access, dn: p.deviceName, sv: p.service, sk: p.serviceKid }, clock(ctx));
    reply(ctx, connId, { type: 'auth.ticket.ok', ticket: out.ticket, exp: out.exp }, reqId);
  }

  /**
   * 代成员进项目的服务连接（云端 Agent，`docs/plan/cloud-agent-contract.md` 第 4.4 节）要素材票据：导入素材、配音等产物入库用。
   * 票据的 `u`、`ug` 是成员的，带 `sv` / `sk`；`r` 不超过成员此刻的权限（只读成员要不到读写票据）。登记表、开关、名单、禁入表
   * 这里核一次，素材服务每次核对票据时再核一次（`auth/asset-tickets.mjs`），所以撤销后当场失效，不等票据过期。
   */
  function memberServiceAssetTicket(ctx, connId, c, msg, reqId) {
    const p = c.principal;
    if (p.scope !== 'member' || c.space === null) throw new Refused('forbidden', '服务连接要不到这种票据');
    if (msg.kind !== 'asset') throw new Refused('forbidden', '服务连接只能要素材票据');
    const rec = storeOf()?.peek(c.space) ?? null;
    const refused = serviceAdmission({ registry: registryOf(), record: rec, service: p.service, kid: p.serviceKid });
    if (refused) throw new Refused('forbidden', refused);
    if (registryOf()?.get(p.service)?.actsFor !== 'member') throw new Refused('forbidden', '服务连接要不到这种票据');
    if (admissionOf(rec, { username: p.username, deviceId: p.deviceId, creator: p.creator === true })) throw new Refused('forbidden');
    const access = msg.access ?? 'r';
    if (access !== 'r' && access !== 'rw') throw new Refused('bad-message', "access 只能是 'r' 或 'rw'");
    const mine = p.access === 'rw' && memberAccess(rec, p.username, p.creator === true) === 'rw' ? 'rw' : 'r';
    if (access === 'rw' && mine !== 'rw') throw new Refused('forbidden', '只读成员的云端 Agent 要不到读写的素材票据');
    const out = signTicket(rec, { k: 'asset', u: p.userId, r: access, dn: p.deviceName, cr: p.creator === true, sv: p.service, sk: p.serviceKid }, clock(ctx));
    ctx.log('shared.agent-asset-ticket', { connId, projectId: c.space, access });
    reply(ctx, connId, { type: 'auth.ticket.ok', ticket: out.ticket, exp: out.exp }, reqId);
  }

  function ticket(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    if (c?.principal?.scope === 'service') return serviceTicket(ctx, connId, c, msg, reqId);
    // 代成员进来的服务连接（云端 Agent）：只签素材票据，权限不超过这位成员此刻的；连接票据、委托一律不签（不能给自己换角色、续命）
    if (serviceOf(c?.principal) !== null) return memberServiceAssetTicket(ctx, connId, c, msg, reqId);
    const rec = memberRecord(c);
    const p = c.principal;
    if (admissionOf(rec, { username: p.username, deviceId: p.deviceId, creator: p.creator === true })) throw new Refused('forbidden');
    if (msg.kind === 'delegate') return delegateTicket(ctx, connId, c, rec, msg, reqId);
    const fields = { u: p.userId, dn: p.deviceName, cr: p.creator === true };
    if (msg.kind === 'asset') {
      const access = msg.access ?? 'r';
      if (access !== 'r' && access !== 'rw') throw new Refused('bad-message', "access 只能是 'r' 或 'rw'");
      Object.assign(fields, { k: 'asset', r: access });
    } else if (msg.kind === 'conn') {
      if (!isRole(msg.role)) throw new Refused('bad-message', `role 只能是 ${ROLES.join(' / ')}`);
      fields.k = 'conn';
      fields.r = msg.role;
      if (msg.role === 'agent') {
        if (!isConversation(msg.conversation)) throw new Refused('bad-message', 'agent 连接要给对话号（正整数）');
        fields.c = msg.conversation;
      } else if (msg.conversation !== undefined && msg.conversation !== null) {
        throw new Refused('bad-message', '只有 agent 连接带对话号');
      }
      if (msg.owner !== undefined && msg.owner !== null) {
        const owner = msg.role === 'render' ? normalizeOwner(msg.owner) : null;
        if (!owner) throw new Refused('bad-message', "owner 只能给 render 连接，取 { kind: 'user' }、{ kind: 'agent', c } 或 { kind: 'browser' }");
        fields.o = owner;
      }
    } else {
      throw new Refused('bad-message', "kind 只能是 'asset'、'conn' 或 'delegate'");
    }
    const out = signTicket(rec, fields, clock(ctx));
    reply(ctx, connId, { type: 'auth.ticket.ok', ticket: out.ticket, exp: out.exp }, reqId);
  }

  /**
   * 云端 Agent 的委托（`docs/plan/cloud-agent-contract.md` 第 4.2 节）：`auth.ticket { kind: 'delegate', audience: 'agent', conversation? }`。
   * 不带 `conversation` 是委托票据（2 分钟，页面每个请求出示）；带 `conversation: <对话 id>` 是对话委托（60 分钟，绑这个对话）。
   * 只有成员自己的页面连接（`page` 角色）能要：`agent`、`render` 角色的连接要不到（Agent 不能给自己续命），服务连接在上面已经挡掉。
   * 权限 `acc` 由这里按成员此刻的权限填，页面指定不了。这台文档服务没有这个服务、或项目关了它的开关，回 `service-disabled`。
   */
  function delegateTicket(ctx, connId, c, rec, msg, reqId) {
    const p = c.principal;
    if (p.role !== 'page') throw new Refused('forbidden', '只有成员的页面连接能要委托');
    if (!DELEGATION_AUDIENCES.includes(msg.audience)) throw new Refused('bad-message', `audience 只能是 ${DELEGATION_AUDIENCES.join(' / ')}`);
    const grant = msg.conversation !== undefined && msg.conversation !== null;
    if (grant && !isConversationId(msg.conversation)) throw new Refused('bad-message', 'conversation 要是对话 id（1～64 个 [A-Za-z0-9_-]）');
    if (!hostedServices || !registryOf()?.get(msg.audience) || rec.hosted?.[msg.audience]?.enabled === false) {
      throw new Refused('service-disabled', '这个项目没有开云端 Agent');
    }
    const out = signDelegation(rec, {
      u: p.userId, dn: p.deviceName, cr: p.creator === true, aud: msg.audience,
      acc: memberAccess(rec, p.username, p.creator === true), ...(grant ? { cid: msg.conversation } : {}),
    }, clock(ctx));
    ctx.log('shared.delegate', { connId, projectId: c.space, audience: msg.audience, grant });
    reply(ctx, connId, { type: 'auth.ticket.ok', ticket: out.ticket, exp: out.exp }, reqId);
  }

  /** 关掉本空间里满足条件的连接 */
  function closeWhere(ctx, space, predicate, code, reason) {
    for (const [connId, c] of connsIn(space)) {
      if (predicate(c.principal)) ctx.close?.(connId, code, reason);
    }
  }

  function admin(ctx, connId, msg, reqId) {
    const c = conns.get(connId);
    const rec = memberRecord(c);
    const { remote, loop } = checkBlocked(ctx, connId);
    const proof = msg.proof;
    if (!isObj(proof) || typeof proof.nonce !== 'string' || typeof proof.m !== 'string') throw new Refused('forbidden', '要创建者证明');
    const op = msg.op;
    if (!ADMIN_OPS.includes(op)) throw new Refused('bad-message', `op 只能是 ${ADMIN_OPS.join(' / ')}`);
    const nonceOk = challenges.consume(proof.nonce, ['admin', connId, c.space]);
    const given = b64urlDecode(proof.m);
    let ok = false;
    if (nonceOk && given && given.length === 32) {
      const expected = createHmac('sha256', Buffer.from(rec.creator.key, 'base64url'))
        .update(adminPurpose({ projectId: rec.projectId, username: rec.creator.username, op, nonce: proof.nonce }))
        .digest();
      ok = timingSafeEqual(expected, Buffer.from(given));
    }
    if (!ok) {
      if (!loop) limiter.fail(remote);
      ctx.log('shared.admin.reject', { connId, remote, op, reason: nonceOk ? 'bad-proof' : 'nonce' });
      throw new Refused('forbidden', '创建者证明不对');
    }
    const st = storeOf();
    const space = c.space;
    switch (op) {
      case 'set-password': {
        if (rec.mode !== 'free') throw new Refused('bad-message', '限定进入没有项目口令，改名单用 set-list');
        if (!isCred(msg.project)) throw new Refused('bad-message', 'project 要 { salt, key }');
        st.update(space, (d) => {
          d.project = { salt: msg.project.salt, key: msg.project.key };
          d.generation += 1;
        });
        for (const [other] of connsIn(space)) {
          if (other !== connId) ctx.send(other, { type: 'shared.notice', event: 'password-changed' });
        }
        break;
      }
      case 'set-creator-password': {
        if (!isCred(msg.creator)) throw new Refused('bad-message', 'creator 要 { salt, key }');
        st.update(space, (d) => {
          d.creator = { ...d.creator, salt: msg.creator.salt, key: msg.creator.key };
        });
        break;
      }
      case 'list-bans': {
        const bans = (rec.bans ?? []).map((b) => ({ username: b.username, deviceId: b.deviceId }));
        const out = { type: 'shared.admin.ok', op, bans };
        // 限定进入另带名单里的用户名(不带盐与 K):界面「改名单」要列出现有名单
        if (rec.mode === 'restricted') out.list = (rec.list ?? []).map((e) => e.username);
        ctx.log('shared.admin', { connId, projectId: space, op });
        reply(ctx, connId, out, reqId);
        return;
      }
      case 'set-list': {
        if (rec.mode !== 'restricted') throw new Refused('bad-message', '自由进入没有名单，改口令用 set-password');
        // `{ username, keep: true }`:沿用名单里这个人现有的口令(界面「改名单」只增删、只改某几个人的密码时用;
        // 创建者拿不到别人的 K,也不该拿到)。名单里没有这个人时整批 bad-message
        const current = new Map((rec.list ?? []).map((e) => [e.username, e]));
        const given = Array.isArray(msg.list)
          ? msg.list.map((e) => (isObj(e) && e.keep === true && typeof e.username === 'string' && current.has(e.username)
            ? { username: e.username, salt: current.get(e.username).salt, key: current.get(e.username).key }
            : e))
          : msg.list;
        const list = parseList(given, rec.creator.username);
        if (!list) throw new Refused('bad-message', 'list 要 [{ username, salt, key }]，用户名不重复、不含创建者');
        const keep = new Set(list.map((e) => e.username));
        st.update(space, (d) => {
          d.list = list;
          d.generation += 1;
        });
        // 以服务自己的身份进来的连接（渲染服务、云端 Agent 的发布连接）不是成员，名单管不着它们：不关
        closeWhere(ctx, space, (p) => p.scope !== 'service' && p.creator !== true && p.username !== rec.creator.username && !keep.has(p.username), CLOSE_REMOVED, 'removed');
        break;
      }
      case 'kick': {
        const { username, deviceId } = msg;
        if (!isUsername(username) || !isDeviceId(deviceId)) throw new Refused('bad-message', '要 username 与 deviceId');
        const userId = `${username}@${deviceId}`;
        st.update(space, (d) => {
          d.userGenerations = { ...(d.userGenerations ?? {}), [userId]: userGeneration(d, userId) + 1 };
          d.bans = (d.bans ?? []).filter((b) => !(b.username === username && b.deviceId === deviceId));
          d.bans.push({ username, deviceId });
        });
        closeWhere(ctx, space, (p) => p.username === username && p.deviceId === deviceId, CLOSE_REMOVED, 'kicked');
        break;
      }
      case 'set-hosted-service': {
        const name = msg.service;
        if (!HOSTED_SERVICES.includes(name)) throw new Refused('bad-message', `service 只能是 ${HOSTED_SERVICES.join(' / ')}`);
        if (!hostedServices || !registryOf()?.get(name)) throw new Refused('bad-message', '这台文档服务没有这个托管方服务');
        if (typeof msg.enabled !== 'boolean') throw new Refused('bad-message', 'enabled 要是布尔值');
        // 只改 enabled，同一个服务下别的字段（子选项，如 render.streams）保留，不整条换掉
        st.update(space, (d) => { d.hosted = { ...(d.hosted ?? {}), [name]: { ...(d.hosted?.[name] ?? {}), enabled: msg.enabled } }; });
        if (!msg.enabled) {
          // 关掉：这个服务在这个项目里的连接先放回手里的认领（不等断线宽限期），再关
          for (const [other, oc] of connsIn(space)) {
            if (serviceOf(oc.principal) !== name) continue;
            try { hostedServices.releaseClaims?.(other); } catch (err) {
              ctx.log('module.error', { module: SHARED_MODULE, hook: 'releaseClaims', message: String(err?.message ?? err) });
            }
            ctx.close?.(other, CLOSE_REMOVED, 'service-disabled');
          }
        }
        for (const [other, oc] of connsIn(space)) {
          if (other !== connId && serviceOf(oc.principal) === null) ctx.send(other, { type: 'shared.notice', event: 'hosted-service-changed', service: name, enabled: msg.enabled });
        }
        break;
      }
      case 'set-hosted-option': {
        // 服务下面的子选项（现在只有 render 的 streams，缺省关）：只记下并通知，不断任何连接、不动认领
        const name = msg.service;
        if (!HOSTED_SERVICES.includes(name)) throw new Refused('bad-message', `service 只能是 ${HOSTED_SERVICES.join(' / ')}`);
        if (!hostedServices || !registryOf()?.get(name)) throw new Refused('bad-message', '这台文档服务没有这个托管方服务');
        if (typeof msg.option !== 'string' || !HOSTED_OPTIONS[name].includes(msg.option)) {
          throw new Refused('bad-message', `${name} 的 option 只能是 ${HOSTED_OPTIONS[name].join(' / ') || '（没有）'}`);
        }
        if (typeof msg.enabled !== 'boolean') throw new Refused('bad-message', 'enabled 要是布尔值');
        const option = msg.option;
        st.update(space, (d) => { d.hosted = { ...(d.hosted ?? {}), [name]: { ...(d.hosted?.[name] ?? {}), [option]: msg.enabled } }; });
        for (const [other, oc] of connsIn(space)) {
          if (other !== connId && serviceOf(oc.principal) === null) {
            ctx.send(other, { type: 'shared.notice', event: 'hosted-option-changed', service: name, option, enabled: msg.enabled });
          }
        }
        break;
      }
      case 'invite-create': {
        const opts = parseInviteOptions(msg);
        if (!opts) throw new Refused('bad-message', 'expiresInSec 要正整数秒，maxUses 要正整数或 null');
        const { code, invite } = issueInvite(st.serverSecret, opts, clock(ctx));
        // 整条换掉：旧摘要随之从索引里拿掉，旧链接立刻失效（store.mjs 的邀请码索引）
        st.update(space, (d) => { d.invite = invite; delete d.inviteDigestSecret; });
        ctx.log('shared.admin', { connId, projectId: space, op });
        reply(ctx, connId, { type: 'shared.admin.ok', op, code, expiresAt: invite.expiresAt, maxUses: invite.maxUses, linkOrigin }, reqId);
        return;
      }
      case 'invite-revoke': {
        const at = clock(ctx);
        if (rec.invite && (rec.invite.revokedAt === null || rec.invite.revokedAt === undefined)) {
          st.update(space, (d) => { d.invite = { ...d.invite, revokedAt: at }; });
        }
        break;
      }
      case 'invite-status': {
        ctx.log('shared.admin', { connId, projectId: space, op });
        reply(ctx, connId, { type: 'shared.admin.ok', op, ...inviteStatus(rec.invite ?? null, clock(ctx)) }, reqId);
        return;
      }
      case 'unban': {
        const { username, deviceId } = msg;
        if (!isUsername(username) || !isDeviceId(deviceId)) throw new Refused('bad-message', '要 username 与 deviceId');
        st.update(space, (d) => {
          d.bans = (d.bans ?? []).filter((b) => !(b.username === username && b.deviceId === deviceId));
        });
        break;
      }
      case 'delete': {
        reply(ctx, connId, { type: 'shared.admin.ok', op }, reqId);
        ctx.log('shared.delete', { projectId: space });
        st.remove(space);
        challenges.dropWhere((b) => b[2] === space);
        closeWhere(ctx, space, () => true, CLOSE_DELETED, 'deleted');
        try {
          dropSpace(space);
        } catch (err) {
          ctx.log('module.error', { module: SHARED_MODULE, hook: 'dropSpace', message: String(err?.message ?? err) });
        }
        return;
      }
      default:
        break;
    }
    ctx.log('shared.admin', { connId, projectId: space, op });
    reply(ctx, connId, { type: 'shared.admin.ok', op }, reqId);
    notify(ctx, space);
  }

  const HANDLERS = {
    'shared.members': members,
    'shared.watch': watch,
    'shared.challenge': challenge,
    'shared.admin': admin,
    'auth.ticket': ticket,
  };

  return {
    name: SHARED_MODULE,
    types: ['shared.', 'auth.ticket'],

    connect(ctx, connId, principal) {
      const space = spaceOf(principal);
      conns.set(connId, { principal: { ...principal }, space, watching: false });
      notify(ctx, space);
    },

    disconnect(ctx, connId) {
      const c = conns.get(connId);
      conns.delete(connId);
      challenges.dropWhere((b) => b[0] === 'admin' && b[1] === connId);
      if (c) notify(ctx, c.space);
    },

    handle(ctx, connId, msg) {
      const reqId = isReqId(msg.reqId) ? msg.reqId : undefined;
      const fn = HANDLERS[msg.type];
      if (!fn) return reply(ctx, connId, { type: 'error', reason: 'unsupported', detail: '共享项目模块不支持这种消息' }, reqId);
      try {
        fn(ctx, connId, msg, reqId);
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        reply(ctx, connId, { type: 'error', reason: err.reason, detail: err.message }, reqId);
      }
    },

    describe() {
      const spaces = {};
      for (const c of conns.values()) {
        if (c.space === null) continue;
        spaces[c.space] = (spaces[c.space] ?? 0) + 1;
      }
      return { spaces };
    },
  };
}

export default sharedModule;
