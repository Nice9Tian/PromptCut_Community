/**
 * Facade for verifying tickets in the asset service (contract `docs/plan/auth-contract.md`
 * Section 8 "Asset service reads and writes").
 *
 * The asset service and document service run in the same process, directly reading the in-memory
 * state of the credential store (signing key, project generation, user generation): after changing
 * the project passphrase, changing the list, or kicking members, previously issued tickets become
 * invalid on the next request. Sharing across different processes is not supported.
 *
 * - `createAssetTicketVerifier({ store, now })`: `store` is the credential store or a getter for it;
 * - `assetTicketVerifierFor(authDir)`: gets the in-process singleton by `auth/` directory
 *   (`credentialStoreFor` in `store.mjs`), opening it only on first verification; if it cannot be
 *   opened, always invalid (close on failure).
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
 * @param {object | (() => object | null)} [options.services] Host service registry
 *   (`service-identity.mjs`). Tickets with `sv` (service identity asset tickets,
 *   `docs/plan/hosted-render-contract.md` Section 1.6) also check the registry and project toggles
 *   on each verification; if unsatisfied, invalidated immediately without waiting for ticket
 *   expiration; if no registry is provided, such tickets are always invalid. The returned result
 *   includes an extra `service`, which the asset service uses to restrict its writable namespaces
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
        // Services acting for members entering projects (Cloud Agent, `docs/plan/cloud-agent-contract.md`
        // Section 4.4): based on the member's own permissions: the list and ban list are checked against
        // the member (invalidated immediately upon being removed or kicked); if the ticket requests
        // read-write while the member is currently read-only, it is invalid (read-only members cannot write).
        // The returned result has `actsFor: 'member'`, by which the asset service only allows it to write
        // original media (`media`), forbidding writes to prerender outputs
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

/** Gets in-process credential store by `auth/` to verify; retries each time if unopened, invalid if still failing */
export function assetTicketVerifierFor(authDir, { now = Date.now } = {}) {
  return createAssetTicketVerifier({ store: () => credentialStoreFor(authDir), now });
}
