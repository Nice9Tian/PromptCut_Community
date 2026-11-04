/**
 * Document service assembly with shared projects (M6a, contract `docs/plan/auth-contract.md`).
 * Both `main.mjs` in standalone mode and `vite-plugin-docservice.ts` in attached mode are assembled
 * here, differing only by `mode`:
 *
 * | | `hosted` (standalone mode, hosted side) | `lan` (attached mode, LAN host) |
 * |---|---|---|
 * | Shared endpoints | `/shared/…`, mounted on custom HTTP server | `<path>/shared/…`, host calls `handleHttp` |
 * | Who can create projects | Any origin, rate-limited by origin and total count | Local loopback only |
 * | Cluster token | Recognized, grants admin identity | Never recognized |
 *
 * Mounted modules:
 * - Render queue, projects, content store, tool call events, cost records (`modules/costs.mjs`):
 *   **one instance per space** (`spaces.mjs`). Event module borrows project module in the same
 *   space to broadcast (project channel) and borrows content module to write `event-detail`, so
 *   these three are bundled into a group per space (`bundleForSpace`); `local` space storage reuses
 *   `dataDir` itself (local document service is `<root>/out/docservice`, standalone mode is data
 *   directory), while shared project spaces are at `<dataDir>/tenants/<projectId>/`;
 * - Service address registry (`endpoints`): one instance for entire service, admin interface;
 * - Shared projects (`shared`): member list, creator operations, tickets.
 *
 * Host service identity (`docs/plan/hosted-render-contract.md`): when `serviceRegistry` (service
 * registry) is provided in `hosted` mode, handshake recognizes service items and tickets with `sv`,
 * answers `shared/service-challenge`, and mounts directory module `hosted`; connections with a
 * `service` field are whitelisted message by message (`service-gate.mjs`), and re-check registry
 * and project toggle (also checked before resume). `lan` mode rejects all of them.
 *
 * Credential store is at `<dataDir>/auth/` (`../auth/store.mjs`), opened by caller and passed in;
 * passing null indicates not loaded: shared endpoints return 503, credential handshakes all return 401,
 * loopback local identity functions as usual.
 *
 * Loopback trust (`trustLoopback`, environment variable `PROMPTCUT_TRUST_LOOPBACK`,
 * `docs/plan/http-transport-contract.md` Section 10): defaults to treating loopback origin as local.
 * When deployed behind a reverse proxy, requests forwarded by proxy also appear as loopback here
 * (semantics: "local" is determined by true initiator, `docs/semantics/mechanism/asset-service.md`),
 * so hosted side passes false: the three places here: document service handshake (loopback without
 * credentials returns 401, local declaration rejected), shared HTTP endpoints (rate-limited as
 * non-loopback origins), and creator operation rate limits: no longer recognize loopback. Asset
 * service and admin interface in hosted combo (`server/hosted/combo.mjs`) follow the same toggle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDocService } from './service.mjs';
import { spacedModule, LOCAL_SPACE } from './spaces.mjs';
import { endpointsModule } from './modules/endpoints.mjs';
import { projectModule } from './modules/project.mjs';
import { contentModule } from './modules/content.mjs';
import { costsModule } from './modules/costs.mjs';
import { presenceModule } from './modules/presence.mjs';
import { pendingMergeModule } from './modules/pending-merge.mjs';
import { eventsModule } from './modules/events.mjs';
import { sharedModule } from './modules/shared.mjs';
import { createFileStore, createMemoryStore } from './store/index.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createHandshakeAuth, admissionOf } from '../auth/handshake.mjs';
import { memberAccess } from '../auth/delegation.mjs';
import { isLocalOrigin, remoteTagOf } from '../auth/origin.mjs';
import { createSharedHttp } from '../auth/http.mjs';
import { createChallenges } from '../auth/challenges.mjs';
import { createRateLimiter } from '../auth/rate-limit.mjs';
import { isProjectId } from '../auth/protocol.mjs';
import { roomUnavailableReason } from '../recovery/relocation.mjs';
import { docServiceExtensions } from './extensions.mjs';
import { serviceGate, AGENT_WRITE_TYPES } from './service-gate.mjs';
import { serviceAdmission } from '../auth/service-identity.mjs';
import { offeredProtocols } from './auth.mjs';
import { tr } from '../i18n.mjs';

/**
 * @param {object} options
 * @param {'hosted' | 'lan'} options.mode
 * @param {string | null} [options.dataDir] Storage directory for `local` space; when null, all spaces use in-memory storage (for testing)
 * @param {object | null} options.store Opened credential store (`openCredentialStore` / `credentialStoreFor`), null indicates not loaded
 * @param {import('node:http').Server} [options.server] Host server in attached mode
 * @param {string} [options.path] WebSocket path in attached mode (shared endpoints are beneath it), default `/docservice`
 * @param {string} [options.clusterToken] Cluster token (recognized only in `hosted`)
 * @param {(req) => boolean} [options.isLoopback] Whether request is from local loopback; defaults to socket peer address
 * @param {boolean} [options.trustLoopback] Default true; when false, loopback origins are not treated as local (all three places above treated as remote), `isLoopback` is no longer called
 * @param {(req) => string | null} [options.remoteOf] Origin address; defaults to socket peer address
 * @param {{ deviceId: string, deviceName: string }} [options.localDevice] Local device used for local declaration
 * @param {() => number} [options.now] Injected clock: challenge expiration, rate limiting, and ticket validity all follow it
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {object} [options.limits] `{ createPerHour, maxProjects, challengeTtlMs, rateWindowMs, maxFailures, cooldownMs }`
 * @param {object} [options.service] Other options passed through to `createDocService` (`autoTick`, `heartbeatMs`, `sweepMs`…)
 * @param {(projectId: string) => void} [options.onCreate] Called after shared project is created (LAN host starts broadcasting based on this, SP contract Section 4)
 * @param {(projectId: string) => void} [options.onDelete] Called after shared project is deleted (LAN host stops announcing this project based on this)
 * @param {object | null} [options.serviceRegistry] Host service registry (`createServiceRegistry` in `auth/service-identity.mjs`);
 *   used only in `hosted` mode, without it there is no service identity
 * @param {(req) => boolean} [options.isDirectLocal] "Truly initiated locally" criterion for service handshake, default `isLocalOrigin` (ignores loopback trust toggle)
 * @param {number} [options.hostedLingerMs] Duration to retain `active` in directory (for testing)
 * @param {Record<string, string> | null} [options.hostedServiceUrls] Public address of host service to page, e.g. `{ agent: 'https://<main site>/agent/v1' }`
 *   (`docs/plan/cloud-agent-contract.md` Section 10.4); sent to page at top-level `hosted.agent.url` of member list
 */
export function createSharedDocService({
  mode,
  dataDir = null,
  store = null,
  server,
  path: wsPath = '/docservice',
  clusterToken,
  // "Local" is determined by true initiator: peer is loopback and every hop in forwarding headers
  // is loopback (`auth/origin.mjs`, contract Section 10)
  isLoopback: isLoopbackOption = (req) => isLocalOrigin(req),
  trustLoopback = true,
  // Loopback forwarded via reverse proxy is recorded as `proxied:<peer>`: places determining local solely
  // by origin address (rate limit exemptions for creator operations) no longer treat it as local
  remoteOf = (req) => remoteTagOf(req),
  localDevice,
  now = Date.now,
  log,
  limits = {},
  service: serviceOptions = {},
  onCreate,
  onDelete,
  // C10a Section 5: public origin used by invite links (takes origin from `--doc-public-url` /
  // `PROMPTCUT_DOCSERVICE_PUBLIC_URL`, passed in by hosted combo);
  // `invite-create` response includes it. If absent it is null, UI constructs it from the address it
  // connected to
  linkOrigin = null,
  serviceRegistry = null,
  isDirectLocal = (req) => isLocalOrigin(req),
  hostedLingerMs,
  hostedServiceUrls = null,
  accountRuntime = null,
  accountProjects = null,
  accountRequired = false,
  docAssembly = null,
} = {}) {
  if (mode !== 'hosted' && mode !== 'lan') throw new TypeError("createSharedDocService: mode must be 'hosted' or 'lan'");
  const say = typeof log === 'function' ? log : undefined;
  // When loopback trust is disabled, loopback origins are treated the same as other origins (Section 10)
  const isLoopback = trustLoopback === false ? () => false : isLoopbackOption;
  const joinChallenges = createChallenges({ now, ttlMs: limits.challengeTtlMs });
  const adminChallenges = createChallenges({ now, ttlMs: limits.challengeTtlMs });
  const limiter = createRateLimiter({ now, windowMs: limits.rateWindowMs, maxFailures: limits.maxFailures, cooldownMs: limits.cooldownMs });
  const storeOf = () => store;
  const registry = mode === 'hosted' ? serviceRegistry ?? null : null;
  const registryOf = () => registry;
  const isTenantSpace = (space) => isProjectId(space) || Boolean(accountRuntime?.hasProject?.(space));
  /** Whether service identity is still usable at this moment (queried per message and before resume): control connections check registry, data connections also check project and toggle */
  function serviceRefusal(principal) {
    if (typeof principal?.service !== 'string' && principal?.scope !== 'service') return null;
    if (!registry) return 'forbidden';
    if (principal.realm === 'account' && principal.identityVersion === 2) {
      // v2 project/member/run authority lives in the account ledger. The LAN
      // username store cannot admit or revoke it; the service registry still can.
      try { registry.refresh({ force: true }); } catch { return 'service-revoked'; }
      return registry.has(principal.service, principal.serviceKid) ? null : 'service-revoked';
    }
    if (!isTenantSpace(principal.tenantId)) return registry.has(principal.service, principal.serviceKid) ? null : 'service-revoked';
    const record = storeOf()?.peek(principal.tenantId) ?? null;
    const refused = serviceAdmission({ registry, record, service: principal.service, kid: principal.serviceKid, role: principal.role });
    if (refused) return refused;
    // Service connections entering project on behalf of member (Cloud Agent): check list and ban list
    // again as a member (`docs/plan/cloud-agent-contract.md` Section 4.5).
    // When kicking or removing from list, this connection would already be closed; this is the second
    // guard: checked per message and before resume, so even if connection closure was missed, nothing can
    // be sent
    if (principal.scope === 'member') {
      return admissionOf(record, { username: principal.username, deviceId: principal.deviceId, creator: principal.creator === true });
    }
    return null;
  }
  /** Cloud Agent connections of read-only members cannot modify project: determined by project record permissions at **this moment** (also blocks connections changed to read-only after establishment) */
  function readonlyRefusal(principal, type) {
    if (principal?.realm === 'account') return null;
    if (principal?.service !== 'agent' || principal.scope !== 'member' || !AGENT_WRITE_TYPES.includes(type)) return null;
    const record = storeOf()?.peek(principal.tenantId) ?? null;
    return record && memberAccess(record, principal.username, principal.creator === true) === 'rw' ? null : 'forbidden';
  }

  const auth = createHandshakeAuth({
    store: storeOf,
    challenges: joinChallenges,
    limiter,
    clusterToken: mode === 'hosted' ? clusterToken : undefined,
    acceptToken: mode === 'hosted',
    isLoopback,
    remoteOf,
    localDevice,
    services: registryOf,
    isDirectLocal,
    now,
    log: say,
  });
  if (accountRuntime && !accountProjects) throw new TypeError('accountProjects required for account runtime');
  function authenticate(req) {
    if (!accountRuntime) return auth.authenticate(req);
    const protocols = offeredProtocols(req);
    if (protocols.some(item => item.startsWith('promptcut.account.'))) return accountRuntime.authenticate(req);
    const ticketProtocol = protocols.find(item => item.startsWith('promptcut.ticket.'));
    if (ticketProtocol) {
      const token = ticketProtocol.slice('promptcut.ticket.'.length);
      if (typeof accountRuntime.hasServiceTicket === 'function' && accountRuntime.hasServiceTicket(token)) {
        return accountRuntime.authenticate(req);
      }
    }
    const principal = auth.authenticate(req);
    // In the account realm the old username/device/password handshake can never enter cloud data.
    return principal?.scope === 'admin' || (principal?.scope === 'service' && !principal.tenantId) ? principal : null;
  }
  function handleSharedHttp(req, res) {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (accountProjects && pathname.startsWith('/hosted/shared/account')) {
      void (async () => {
        let readiness;
        if (pathname === '/hosted/shared/account/join' || pathname === '/hosted/shared/account/session') {
          try { readiness = await accountRuntime.requireAssetReady(); }
          catch {
            if (!res.destroyed && !res.headersSent) {
              res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
              res.end(JSON.stringify({ ok: false, code: 'session-unavailable' }));
            }
            return;
          }
        }
        if (!res.destroyed) await accountProjects.handlePublic(req, res, { readiness });
      })().catch(error => {
        say?.('account.http-error', { code: String(error?.code ?? 'internal') });
        if (!res.destroyed && !res.headersSent) {
          res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, code: 'account-unavailable' }));
        }
      });
      return true;
    }
    if (mode === 'hosted' && pathname.startsWith('/hosted/shared/account')) {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, code: 'account-unavailable' }));
      return true;
    }
    if (accountRuntime && pathname.startsWith('/shared/') && pathname !== '/shared/service-challenge') {
      res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, code: 'account-required', error: tr("This app version has expired and cannot move to the cloud"), message: tr("This app version has expired and cannot move to the cloud") }));
      return true;
    }
    return sharedHttp.handle(req, res, '');
  }

  const sharedHttp = createSharedHttp({
    store: storeOf,
    challenges: joinChallenges,
    limiter,
    mode,
    isLoopback,
    remoteOf,
    now,
    log: say,
    createPerHour: limits.createPerHour,
    maxProjects: limits.maxProjects,
    ...(typeof onCreate === 'function' ? { onCreate } : {}),
    authenticate: auth.authenticate,
    services: registryOf,
  });
  const prefix = mode === 'hosted' ? '' : wsPath.replace(/\/+$/, '');

  const service = createDocService({
    ...serviceOptions,
    ...(accountRuntime ? { authority: accountRuntime.authority } : {}),
    gate(principal, type, msg) {
      const reason = isProjectId(principal?.tenantId) ? roomUnavailableReason(storeOf()?.peek(principal.tenantId)) : null;
      // Host service identity: allowlist (default-deny), then check the registry and project toggle
      return reason ?? serviceGate(principal, type, msg) ?? serviceRefusal(principal) ??
        (principal?.realm === 'account' ? accountRuntime.gate(principal, type, msg) : readonlyRefusal(principal, type) ?? serviceOptions.gate?.(principal, type, msg) ?? null);
    },
    resumeGate(principal) {
      const reason = isProjectId(principal?.tenantId) ? roomUnavailableReason(storeOf()?.peek(principal.tenantId)) : null;
      return reason ?? serviceRefusal(principal) ?? (principal?.realm === 'account' ? accountRuntime.resumeGate(principal) : serviceOptions.resumeGate?.(principal) ?? null);
    },
    ...(mode === 'lan' ? { server, path: wsPath } : { http: (req, res) => handleSharedHttp(req, res) || serviceOptions?.http?.(req, res) === true }),
    authenticate,
    enableHttpTransport: mode === 'hosted' && !!accountRuntime,
    healthExtra: mode === 'hosted' && (accountRuntime || accountRequired) ? () => ({ accountMode: accountRuntime ? 'v2' : 'legacy',
      accountRequired: accountRequired === true, assetReady: accountRuntime?.sessionReady === true }) : undefined,
    remoteOf,
    now,
    ...(say ? { log: say } : {}),
  });
  accountRuntime?.bindService(service, { registry, urls: hostedServiceUrls ?? {} });
  if (accountRuntime?.authority) service.setAuthority?.(accountRuntime.authority);

  const localStore = dataDir ? createFileStore({ dir: dataDir, ...(say ? { log: say } : {}) }) : createMemoryStore();
  const tenantDir = (space) => (dataDir && isTenantSpace(space) ? path.join(dataDir, 'tenants', space) : null);
  /** Space → log store; project version and content store share one copy */
  const spaceStores = new Map([[LOCAL_SPACE, localStore]]);
  function storeForSpace(space) {
    let st = spaceStores.get(space);
    if (!st) {
      const dir = tenantDir(space);
      st = dir ? createFileStore({ dir, ...(say ? { log: say } : {}) }) : createMemoryStore();
      spaceStores.set(space, st);
    }
    return st;
  }

  service.mountRenderQueue((space) => createRenderQueue({ now, send: service.send }));
  service.mount(endpointsModule());
  /** Space → { project, content, events }: three instances in same space grouped; events module borrows the other two */
  const bundles = new Map();
  function bundleForSpace(space) {
    let b = bundles.get(space);
    if (!b) {
      const projectStore = storeForSpace(space);
      const operationCoordinator = docAssembly?.coordinatorForSpace({ space, store: projectStore, directory: tenantDir(space) });
      const project = projectModule({ store: projectStore, operationCoordinator });
      const content = contentModule({ store: storeForSpace(space) });
      // Cost record (C10 remaining, section 3): shares this space's store with the content store, isolated by project space
      b = {
        project, content, events: eventsModule({ project, content }), costs: costsModule({ space, store: storeForSpace(space) }),
        // Presence (A3 phase 2): member page "Editing", Agent scope and messages are only forwarded
        // in memory, broadcast over the project channel
        presence: presenceModule({ project }),
        // Pending merge table (conflict merge window): stored by "project × user" in this space's store,
        // independent of project JSON
        merge: pendingMergeModule({ store: storeForSpace(space), now }),
        ...(docAssembly ? { selection: docAssembly.selectionForSpace({ space, project }) } : {}),
      };
      bundles.set(space, b);
    }
    return b;
  }
  docAssembly?.bindTenantResolver(space => bundleForSpace(space));

  /**
   * After account project deletion (`op: "delete"` in `/hosted/shared/account/admin`), clean up this
   * space the same way as deleting shared projects the old way (`dropSpace` in `sharedModule` below):
   * close still-connected sessions with 4004, have each module drop instances for this space, and delete
   * the document service data directory `<dataDir>/tenants/<projectId>/`.
   * Previously, the account method only recorded "deleted" in the ledger and closed page connections,
   * leaving content in document service indefinitely: becoming orphan data, and when this id was reused
   * on recreation (move to the cloud reusing local project id), initialization hit old data, throwing
   * 503 `initialization-conflict` ([ruling] found in H04, report docs/reports/AGENT-claude-abandon-move.md).
   * Registrations and tombstones in the ledger are untouched (relied on as proof that "cloud project
   * no longer exists").
   */
  accountRuntime?.authority?.subscribeProjectChanges?.((projectId, op) => {
    if (op !== 'delete' || projectId === LOCAL_SPACE || !accountRuntime.hasProject?.(projectId)) return;
    try {
      service.closeSpace(projectId, 4004, 'deleted');
      service.dropSpace(projectId);
      spaceStores.delete(projectId);
      bundles.delete(projectId);
      const dir = tenantDir(projectId);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      say?.('account.project.purged', { projectId });
    } catch (err) {
      say?.('module.error', { module: 'shared', hook: 'account-delete', message: String(err?.message ?? err) });
    }
  });
  service.mount(spacedModule({ create: (space) => bundleForSpace(space).project }));
  service.mount(spacedModule({ create: (space) => bundleForSpace(space).content }));
  service.mount(spacedModule({ create: (space) => bundleForSpace(space).events }));
  service.mount(spacedModule({ create: (space) => bundleForSpace(space).costs }));
  service.mount(spacedModule({ create: (space) => bundleForSpace(space).presence }));
  service.mount(spacedModule({ create: (space) => bundleForSpace(space).merge }));
  if (docAssembly) service.mount(spacedModule({ create: (space) => bundleForSpace(space).selection }));
  service.mount(sharedModule({
    store: storeOf,
    challenges: adminChallenges,
    limiter,
    accountRuntime,
    claimsOf: (connId) => service.claimsOf(connId),
    // Creator action rate limiting checks loopback by connection source address, using the same
    // criterion as handshake (connection only records address; build request with only peer address)
    isLoopbackRemote: (remote) => {
      try {
        return !!isLoopback({ socket: { remoteAddress: remote }, headers: {} });
      } catch {
        return false;
      }
    },
    now,
    linkOrigin,
    hostedServices: registry ? { registry: registryOf, releaseClaims: (connId) => service.releaseClaims(connId, 'service-disabled'), urls: hostedServiceUrls ?? {} } : null,
    dropSpace(space) {
      // Notify first (records are already deleted): failing to clean data directory does not affect stop notifications
      if (typeof onDelete === 'function') {
        try { onDelete(space); } catch (err) { say?.('module.error', { module: 'shared', hook: 'onDelete', message: String(err?.message ?? err) }); }
      }
      service.dropSpace(space);
      spaceStores.delete(space);
      bundles.delete(space);
      const dir = tenantDir(space);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    },
  }));
  const extensionCtx = {
    store: storeOf,
    registry,
    now,
    accountRuntime,
    ...(Number.isFinite(hostedLingerMs) ? { lingerMs: hostedLingerMs } : {}),
  };
  for (const ext of docServiceExtensions) {
    const mod = ext.create(extensionCtx);
    if (mod) service.mount(mod);
  }

  /** Import into an old, durably moved space must discard both sessions and replay caches. */
  service.reloadSpace = space => {
    if (!isProjectId(space) || !roomUnavailableReason(storeOf()?.peek(space))) throw new Error('Room must be fenced before reload');
    service.closeSpace(space); service.dropSpace(space); spaceStores.delete(space); bundles.delete(space);
  };
  return {
    service,
    /** Credential store (may be null) */
    get store() { return store; },
    /** Host service registry (null if absent) */
    get serviceRegistry() { return registry; },
    authenticate,
    accountProjects,
    /**
     * Attached mode: host passes HTTP requests in; if `<path>/shared/…`, processes it and returns true;
     * otherwise returns false and does nothing.
     * Standalone-mode endpoints are already mounted on self-hosted server, and this function can also
     * be used (prefix is empty string).
     */
    handleHttp(req, res) {
      return sharedHttp.handle(req, res, prefix);
    },
    /** Path prefix of shared endpoints (portion before `/shared/`) */
    sharedPrefix: `${prefix}/shared/`,
  };
}
