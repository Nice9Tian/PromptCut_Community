/**
 * 素材服务核对票据用的外观（契约 `docs/plan/auth-contract.md` 第 8 节「素材服务的读写」）。
 *
 * 素材服务与文档服务跑在同一个进程里，直接读凭证存储的内存状态（签名密钥、项目代数、用户代数）：
 * 改项目口令、改名单、踢人之后，已发的票据下一次请求就失效。不同进程之间不支持共用。
 *
 * - `createAssetTicketVerifier({ store, now })`：`store` 是凭证存储或取它的函数；
 * - `assetTicketVerifierFor(authDir)`：按 `auth/` 目录取进程内单例（`store.mjs` 的 `credentialStoreFor`），
 *   第一次核对时才打开；打不开就一律无效（失败即关）。
 */
import { verifyTicket } from './tickets.mjs';
import { credentialStoreFor } from './store.mjs';
import { serviceAdmission } from './service-identity.mjs';
import { admissionOf } from './handshake.mjs';
import { splitUserId, isReservedUsername } from './protocol.mjs';
import { memberAccess } from './delegation.mjs';

/**
 * @param {object} options
 * @param {object | (() => object | null)} options.store
 * @param {() => number} [options.now]
 * @param {object | (() => object | null)} [options.services] 托管方服务的登记表（`service-identity.mjs`）。带 `sv` 的票据
 *   （服务身份的素材票据，`docs/plan/hosted-render-contract.md` 第 1.6 节）每次核对都另看登记表与项目的开关，不满足当场无效，
 *   不等票据过期；没给登记表时这种票据一律无效。回的结果多一个 `service`，素材服务据此限制它能写的命名空间
 * @returns {{ verify(ticket: string): { ok: true, access: 'r' | 'rw', projectId: string, userId: string, service?: string, actsFor?: 'member' } | { ok: false, reason: string } }}
 */
export function createAssetTicketVerifier({ store, now = Date.now, services = null } = {}) {
  const storeOf = typeof store === 'function' ? store : () => store;
  const registryOf = typeof services === 'function' ? services : () => services;
  return {
    verify(ticket) {
      let st = null;
      try {
        st = storeOf();
      } catch {
        st = null;
      }
      if (!st) return { ok: false, reason: 'no-store' };
      const v = verifyTicket(ticket, { lookup: (id) => st.peek(id), now: now(), kind: 'asset' });
      if (!v.ok) return { ok: false, reason: v.reason };
      if (v.payload.sv !== undefined) {
        let registry = null;
        try { registry = registryOf(); } catch { registry = null; }
        const refused = serviceAdmission({ registry, record: v.record, service: v.payload.sv, kid: v.payload.sk });
        if (refused) return { ok: false, reason: refused };
        // 代成员进项目的服务（云端 Agent，`docs/plan/cloud-agent-contract.md` 第 4.4 节）：按成员本人的权限——
        // 名单与禁入表照成员查（被移出、被踢后当场失效）；票据要的是读写而成员此刻只读的，无效（只读成员写不进）。
        // 回的结果带 `actsFor: 'member'`，素材服务据此只许它写素材原件（`media`），不许写预渲染产物
        if (registry.get(v.payload.sv)?.actsFor === 'member') {
          const who = splitUserId(v.payload.u);
          if (!who || isReservedUsername(who.username)) return { ok: false, reason: 'format' };
          const creator = v.payload.cr === true;
          const denied = admissionOf(v.record, { username: who.username, deviceId: who.deviceId, creator });
          if (denied) return { ok: false, reason: denied };
          if (v.payload.r === 'rw' && memberAccess(v.record, who.username, creator) !== 'rw') return { ok: false, reason: 'forbidden' };
          return { ok: true, access: v.payload.r, projectId: v.payload.p, userId: v.payload.u, service: v.payload.sv, actsFor: 'member' };
        }
        return { ok: true, access: v.payload.r, projectId: v.payload.p, userId: v.payload.u, service: v.payload.sv };
      }
      return { ok: true, access: v.payload.r, projectId: v.payload.p, userId: v.payload.u };
    },
  };
}

/** 按 `auth/` 目录取进程内的凭证存储来核对；打不开时每次都再试一次，仍打不开就回无效 */
export function assetTicketVerifierFor(authDir, { now = Date.now } = {}) {
  return createAssetTicketVerifier({ store: () => credentialStoreFor(authDir), now });
}
