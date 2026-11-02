/**
 * Entry point for online runtime and cloud extension seams (public side).
 *
 * Responsibilities:
 *   1. Pass-through seams (`buildInfo`, `apiGuard`, `updateCheck`, `UpdateNotice`):
 *      Safe downgrade across all when `cloud/online/` is absent in community edition
 *      (`CODE_VERSION = null`, `bootApiGuard` no-op, `startUpdateCheck` returns a silent controller
 *      with `stale: false`, `UpdateNotice` does not render).
 *   2. Sync manager cloud backend interface (`SyncCloudBackend`):
 *      Wraps the 7 cloud modules originally referenced directly by `syncManager.ts` (hosted
 *      relay, recovery coordinator, tombstone verification, cloud account client, Cloud Agent
 *      endpoint / identity / notice); community edition provides harmless default implementations.
 */
// @ts-expect-error Pure JS module without type declarations (imports of .mjs from `src/` are marked this way too)
import { RecoveryCoordinator } from "../../server/recovery/coordinator.mjs";
import { tr } from "../i18n/index.ts";

/* ======================================================================== *
 * 1. Pass-through seams: buildInfo / apiGuard / updateCheck / UpdateNotice
 * ======================================================================== */

export interface BuildInfo {
  codeVersion: string | null;
}

let currentBuildInfo: BuildInfo = { codeVersion: null };
export let CODE_VERSION: string | null = null;

export function registerBuildInfo(info: Partial<BuildInfo> | (() => BuildInfo) | null): void {
  const resolved = typeof info === "function" ? info() : info;
  const ver = typeof resolved?.codeVersion === "string" && resolved.codeVersion.trim()
    ? resolved.codeVersion.trim()
    : null;
  currentBuildInfo = { codeVersion: ver };
  CODE_VERSION = ver;
}

export function getBuildInfo(): BuildInfo {
  return currentBuildInfo;
}

/*
 * The shapes below must match the real implementation under `cloud/online/`: they **are** the
 * interface agreed upon by both sides.
 *
 * When merging five tasks on 2026-10-27, they were found not to match: here it wrote `{ online, entryModuleUrl, codeVersion,
 * onVersionSignal, locationLike, fetchTarget, wsTarget }` and a handle with `uninstall()`,
 * while `cloud/online/apiGuard.ts` actually takes `{ href, base }` and returns a path manifest
 * `string[]`; the same goes for `UpdateCheckController`, where here it wrote `state` /
 * `notifyProjectMinVersion` / `refreshNow`, while the real implementation is `getState()` /
 * `subscribe()` / `stop()`.
 *
 * The reason they could stay out of sync: `tsconfig.json` include only had `["src"]`, and
 * `cloud/` was never type-checked, so the "zero tsc errors" reported by each task never inspected
 * the cloud code they wrote. `cloud` has now been added to include.
 */
export interface ApiGuardOptions {
  /** Page URL (relative URLs resolved against it); defaults to `location.href` */
  href?: string;
  /** Build base (`import.meta.env.BASE_URL`), defaults to `/` */
  base?: string;
}

/**
 * Installs the guard, returning the path manifest it actually permits.
 *
 * **The first parameter is `online` and cannot be omitted.** The closed-source side
 * `cloud/online/apiGuard.ts` exports two functions: `bootApiGuard(online, options)` honors this
 * predicate, while `installApiGuard(options)` **installs unconditionally**. On 2026-10-28, two
 * reviewers found: the cloud table registered the latter, while the seam here dropped `online`
 * entirely, meaning **the online guard was also installed in desktop builds and the dev server of
 * the private repo**, rejecting the desktop editor's own `/api/*` and breaking completely.
 * Therefore, the shape here must include `online`, passed in from `ONLINE` by the page startup
 * sequence (`src/online/pageBoot.ts`).
 */
export type ApiGuardInstaller = (online: boolean, options?: ApiGuardOptions) => string[] | null;

let apiGuardInstaller: ApiGuardInstaller | null = null;

export function registerApiGuard(installer: ApiGuardInstaller | null): void {
  apiGuardInstaller = installer;
}

/**
 * Installs online API guard at the page entry point. In community edition (no cloud guard
 * registered or not in online mode), returns `null` directly.
 */
export function bootApiGuard(online: boolean, options: ApiGuardOptions = {}): string[] | null {
  if (!apiGuardInstaller) return null;
  if (!online) return null;
  try {
    return apiGuardInstaller(online, options);
  } catch {
    return null;
  }
}

export const installApiGuard = bootApiGuard;

/** Visibility source (consistent with `VisibilitySource` in `cloud/online/updateCheck.ts`) */
export interface VisibilitySource {
  readonly visibilityState?: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface UpdateCheckState {
  /** Whether a new version different from this page has been detected */
  readonly hasUpdate: boolean;
  /** This page's own code version (`null` for development builds) */
  readonly currentVersion: string | null;
  /** Remote code version when a new version is detected; `null` when not detected */
  readonly latestVersion: string | null;
}

export interface UpdateCheckEnv {
  base?: string;
  codeVersion?: string | null;
  entry?: string | null;
  fetch?: typeof globalThis.fetch;
  visibility?: VisibilitySource | null;
  intervalMs?: number;
  setInterval?: (callback: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval?: (id: any) => void;
}

export interface UpdateCheckController {
  /** Reads current state; returns the same object reference if state has not changed */
  getState: () => Readonly<UpdateCheckState>;
  /** Subscribes to state changes; returns unsubscribe function */
  subscribe: (listener: () => void) => () => void;
  /** Stops listeners and timers */
  stop: () => void;
}

export type StartUpdateCheckFn = (env?: UpdateCheckEnv) => UpdateCheckController;

let updateCheckStarter: StartUpdateCheckFn | null = null;

export function registerUpdateCheck(fn: StartUpdateCheckFn | null): void {
  updateCheckStarter = fn;
}

const NOOP_UPDATE_STATE: UpdateCheckState = Object.freeze({
  hasUpdate: false,
  currentVersion: null,
  latestVersion: null,
});

export function startUpdateCheck(env: UpdateCheckEnv = {}): UpdateCheckController {
  if (updateCheckStarter) {
    return updateCheckStarter(env);
  }
  // Community edition default: always "no new version", subscriptions are never called
  return {
    getState: () => NOOP_UPDATE_STATE,
    subscribe: () => () => {},
    stop: () => {},
  };
}

export interface UpdateNoticeExtension {
  /**
   * Entry script's own `import.meta.url` (accessible only to `main.tsx`). The real implementation on
   * the closed-source side strips it down to a filename relative to `base` before comparing: written
   * to match the real implementation shape (`string | undefined`, **does not accept null**),
   * avoiding another case of "declaration and implementation do not match".
   * `invokeMountUpdateNotice` is responsible for normalizing null to undefined.
   */
  mountUpdateNotice?: (entryUrl?: string) => void;
  /** Any React component with arbitrary props qualifies (the cloud one accepts `{ controller }`) */
  UpdateNoticeView?: (...args: never[]) => unknown;
}

let updateNoticeExt: UpdateNoticeExtension | null = null;
let pendingMountEntryUrl: string | null | undefined = undefined;
let hasPendingMountCall = false;
const updateNoticeListeners = new Set<() => void>();

export function registerUpdateNotice(ext: UpdateNoticeExtension | null): void {
  updateNoticeExt = ext;
  if (ext?.mountUpdateNotice && hasPendingMountCall) {
    try {
      ext.mountUpdateNotice(pendingMountEntryUrl ?? undefined);
    } catch {
      /* Ignore mount exceptions */
    }
  }
  for (const fn of [...updateNoticeListeners]) {
    try {
      fn();
    } catch {
      /* Ignore subscriber exceptions */
    }
  }
}

export function getUpdateNotice(): UpdateNoticeExtension | null {
  return updateNoticeExt;
}

export function subscribeUpdateNotice(fn: () => void): () => void {
  updateNoticeListeners.add(fn);
  return () => {
    updateNoticeListeners.delete(fn);
  };
}

export function invokeMountUpdateNotice(entryModuleUrl?: string | null): void {
  hasPendingMountCall = true;
  pendingMountEntryUrl = entryModuleUrl;
  if (updateNoticeExt?.mountUpdateNotice) {
    updateNoticeExt.mountUpdateNotice(entryModuleUrl ?? undefined);
  }
}

/* ======================================================================== *
 * 3. Sync manager cloud backend interface: SyncCloudBackend
 * ======================================================================== */

export interface ProjectSession {
  connectionTicket: string;
  assetTicket: string;
  agentDelegationTicket: string;
  expiresAt: number;
  projectId: string;
  creator: boolean;
  access: "r" | "rw";
  accessRevision: number;
  hosted: {
    agent: { available: boolean; enabled: boolean; url: string | null };
    render?: { available: boolean; enabled: boolean; streams?: boolean; streamsAllowed?: boolean };
  };
  linkToken?: string;
  hasSecondaryPassword?: boolean;
  needsSecondaryPassword?: boolean;
}

export interface AccountJoinRequestRow {
  accountId: string;
  joinRequestId: string;
  accountName: string | null;
  createdAt: number;
}

export interface AccountMembersSnapshot {
  v: 2;
  authorityId: string;
  projectId: string;
  accessRevision: number;
  self: { accountId: string; creator: boolean; access: "r" | "rw" };
  creatorAccountId: string;
  allowLinkJoin: boolean;
  members: { accountId: string; accountName: string | null; access: "r" | "rw"; joinedAt: number | null }[];
  devices: {
    accountId: string;
    accountName: string | null;
    deviceId: string;
    deviceName: string;
    creator: boolean;
    conns: { role: "page" | "agent" | "render"; service?: "agent" | "render"; conversation?: string | number }[];
  }[];
  bans?: { accountId: string; accountName: string | null; reason: "kick" }[];
  requests?: AccountJoinRequestRow[];
}

export interface AccountKickOperation {
  op: "kick" | "unban";
  accountId: string;
  expectedAccessRevision: number;
  requestId: string;
}

export interface AccountEntryOperation {
  op: "set-entry";
  allowLinkJoin: boolean;
  expectedAccessRevision: number;
  requestId: string;
}

export interface AccountJoinDecision {
  op: "approve-join" | "reject-join";
  accountId: string;
  joinRequestId: string;
  requestId: string;
}

export type AccountMemberOperation = AccountKickOperation | AccountEntryOperation | AccountJoinDecision;

export type AccountMemberResult =
  | { eventId: string; accessRevision: number; completed: false; state: "pending-services" }
  | { joinRequest: { accountId: string; joinRequestId: string; state: "approved" | "rejected" }; accessRevision: number };

export interface CloudAccountClient {
  readonly account: { id: string; name: string; email?: string | null } | null;
  readonly guest?: { id: string; name: string; token: string; expiresAt: number } | null;
  readonly principal: { id: string; name: string; email?: string | null } | null;
  readonly authVersion?: number;
  subscribeAuth(listener: () => void): () => void;
  session(projectId: string, opts?: { minRemainingMs?: number }): Promise<ProjectSession>;
  members(projectId: string): Promise<AccountMembersSnapshot>;
  memberAdmin(projectId: string, operation: AccountMemberOperation): Promise<AccountMemberResult>;
  setAgentEnabled(
    projectId: string,
    enabled: boolean,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number; completed: false }>;
  setHostedService(
    projectId: string,
    service: "agent" | "render",
    enabled: boolean,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number; completed: false }>;
  setHostedOption(
    projectId: string,
    service: "render",
    option: "streams",
    enabled: boolean,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number; completed: false }>;
  regenProjectLink(
    projectId: string,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number; linkToken: string }>;
  setSecondaryPassword(
    projectId: string,
    password: string | null,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number; hasSecondaryPassword: boolean }>;
  create?(
    name: string,
    initialProject: unknown,
    requestId: string,
    opts?: { projectId?: string; rev?: number; history?: unknown[] },
  ): Promise<{ projectId: string; authorityId: string }>;
  deleteProject?(
    projectId: string,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number }>;
  join?(
    projectId: string,
    requestId: string,
    joinOpts?: { token?: string; linkToken?: string; secondaryPassword?: string },
  ): Promise<ProjectSession>;
  cloudAgentConsent?(): Promise<{ accountId: string; accepted: boolean; noticeVersion: 1; acceptedAt?: number }>;
  acceptCloudAgentConsent?(requestId?: string): Promise<{ accountId: string; accepted: boolean; noticeVersion: 1; acceptedAt?: number }>;
  adminProof?(opts: { key: string; projectId: string; username: string; op: string; nonce: string }): Promise<string>;
  buildAuthProtocols?(opts: Record<string, unknown>): Promise<string[]>;
  verifyProtocols?(opts: Record<string, unknown>): Promise<unknown>;
  deriveKey?(password: string, salt: string, kdf?: unknown): Promise<string>;
  makeCredential?(password: string): Promise<unknown>;
}

export interface CloudIdentity {
  getTicket(): Promise<string> | string;
  getGrant?(conversationId: string): Promise<string | undefined> | string | undefined;
}

export interface RecoveryCoordinatorLike {
  readonly generation: number;
  start(descriptor: any, contentId?: string): void;
  cancel(): void;
}

export interface RecoveryCoordinatorHandlers {
  state: (reopenState: string, detail?: any) => void;
  gone: (descriptor: any, signal: AbortSignal) => Promise<any>;
  identity: (descriptor: any, contentId: string, signal: AbortSignal) => Promise<any>;
  host: (descriptor: any, signal: AbortSignal) => Promise<any>;
  discover: (descriptor: any, record: any, signal: AbortSignal) => Promise<any>;
  enter: (candidate: any, record: any, current: () => boolean) => Promise<any>;
}

/** Account exception fallback on the public side (matches shape of `AccountFailure` in `src/account/client.ts`) */
export class PublicAccountFailure extends Error {
  status: number;
  code: string;
  body?: Record<string, any>;
  constructor(status: number, code: string, message?: string, body?: Record<string, any>) {
    super(message || code);
    this.status = status;
    this.code = code;
    if (body) this.body = body;
  }
}

/** Cloud Agent delegation error fallback on public side (matches `CloudDelegationError` in `src/ai/cloud/identity.ts`) */
export class PublicCloudDelegationError extends Error {
  readonly code: string;
  constructor(reason: string) {
    super(tr("The document service did not issue a delegation for the Cloud Agent ({0})", reason));
    this.name = "CloudDelegationError";
    this.code = reason;
  }
}

export interface SyncCloudBackend {
  discoverRoom(opts: Record<string, any>): Promise<any>;
  relayFetch(access: any): typeof fetch;
  authorizeRelayAsset(candidate: any, ticket: string): Promise<void>;
  queryGone(descriptor: any, opts?: { signal?: AbortSignal }): Promise<any>;
  createRecoveryCoordinator(handlers: RecoveryCoordinatorHandlers): RecoveryCoordinatorLike;
  createAccountFailure(status: number, code: string, message?: string, body?: Record<string, any>): Error & { status: number; code: string };
  isAccountFailure(err: unknown): err is Error & { status: number; code: string; body?: Record<string, any> };
  accountConnectionProtocols(session: ProjectSession): string[];
  projectLink(origin: string, projectId: string, linkToken?: string): string;
  setHostedAgent(projectId: string, raw: unknown): void;
  setHostedAgentEnabled(projectId: string, enabled: boolean): void;
  clearHostedAgent(): void;
  setCloudIdentity(next: CloudIdentity | null): void;
  accountCloudIdentity(options: {
    projectId: string;
    isCurrent: () => boolean;
    session: () => Promise<{ projectId: string; agentDelegationTicket: string }>;
  }): CloudIdentity;
  createCloudDelegationError(reason: string): Error & { readonly code: string };
  setCloudConsentSource(next: { client: CloudAccountClient; accountId: string } | null): void;
}

const defaultSyncCloudBackend: SyncCloudBackend = {
  async discoverRoom() {
    throw Object.assign(new Error(tr("The community edition does not enable the cloud room relay service")), { reason: "unavailable" });
  },
  relayFetch() {
    return (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
  },
  async authorizeRelayAsset() {},
  async queryGone() {
    return { gone: false };
  },
  createRecoveryCoordinator(handlers) {
    return new RecoveryCoordinator(handlers);
  },
  createAccountFailure(status, code, message, body) {
    return new PublicAccountFailure(status, code, message, body);
  },
  isAccountFailure(err): err is Error & { status: number; code: string; body?: Record<string, any> } {
    return (
      err instanceof PublicAccountFailure ||
      (!!err &&
        typeof err === "object" &&
        typeof (err as any).status === "number" &&
        typeof (err as any).code === "string")
    );
  },
  accountConnectionProtocols(session) {
    return ["promptcut.v1", `promptcut.account.${session.connectionTicket}`];
  },
  projectLink(origin, projectId, linkToken) {
    const clean = String(origin || "").replace(/\/+$/, "");
    return linkToken ? `${clean}/s/${projectId}/${linkToken}` : `${clean}/p/${projectId}`;
  },
  setHostedAgent() {},
  setHostedAgentEnabled() {},
  clearHostedAgent() {},
  setCloudIdentity() {},
  accountCloudIdentity(options) {
    return {
      async getTicket() {
        if (!options.isCurrent()) throw new Error(tr("Proof of identity for the Cloud Agent has not been obtained yet"));
        const value = await options.session();
        return value.agentDelegationTicket;
      },
    };
  },
  createCloudDelegationError(reason) {
    return new PublicCloudDelegationError(reason);
  },
  setCloudConsentSource() {},
};

let registeredSyncBackend: SyncCloudBackend | null = null;
const syncBackendListeners = new Set<(backend: SyncCloudBackend) => void>();

export function registerSyncCloudBackend(backend: Partial<SyncCloudBackend> | null): void {
  registeredSyncBackend = backend ? { ...defaultSyncCloudBackend, ...backend } : null;
  const active = getSyncCloudBackend();
  for (const fn of [...syncBackendListeners]) {
    try {
      fn(active);
    } catch {
      /* Ignore */
    }
  }
}

export function getSyncCloudBackend(): SyncCloudBackend {
  return registeredSyncBackend ?? defaultSyncCloudBackend;
}

export function subscribeSyncCloudBackend(fn: (backend: SyncCloudBackend) => void): () => void {
  syncBackendListeners.add(fn);
  return () => {
    syncBackendListeners.delete(fn);
  };
}

/* ======================================================================== *
 * 4. Cloud extension manifest registration and dynamic loading (modeled after server/docservice/extensions.mjs)
 * ======================================================================== */

export interface OnlineExtensionManifest {
  buildInfo?: Partial<BuildInfo> | (() => BuildInfo);
  installApiGuard?: ApiGuardInstaller;
  startUpdateCheck?: StartUpdateCheckFn;
  updateNotice?: UpdateNoticeExtension;
  syncBackend?: Partial<SyncCloudBackend>;
  /** Settles only after all asynchronously registered sub-extensions are installed; `loadOnlineExtensions` awaits it, so "finished loading" means ready for use */
  ready?: Promise<unknown>;
}

export function registerOnlineExtensions(manifest: OnlineExtensionManifest | null | undefined): void {
  if (!manifest || typeof manifest !== "object") return;
  if (manifest.buildInfo !== undefined) registerBuildInfo(manifest.buildInfo);
  if (manifest.installApiGuard !== undefined) registerApiGuard(manifest.installApiGuard);
  if (manifest.startUpdateCheck !== undefined) registerUpdateCheck(manifest.startUpdateCheck);
  if (manifest.updateNotice !== undefined) registerUpdateNotice(manifest.updateNotice);
  if (manifest.syncBackend !== undefined) registerSyncCloudBackend(manifest.syncBackend);
}

export function resetOnlineExtensionsForTest(): void {
  registerBuildInfo(null);
  registerApiGuard(null);
  registerUpdateCheck(null);
  registerUpdateNotice(null);
  registerSyncCloudBackend(null);
  loadPromise = null;
}

function resolveCloudManifestUrl(cloudDirOverride?: string): string | null {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined>; versions?: { node?: string } } }).process;
  const override = cloudDirOverride ?? proc?.env?.PROMPTCUT_CLOUD_DIR;
  if (override && proc?.versions?.node) {
    const normalized = override.replace(/\\/g, "/").replace(/\/+$/, "");
    const prefix = normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
    return `${prefix}/online/manifest.ts`;
  }
  // The default branch uses an alias (see loadOnlineExtensions below) rather than concatenating
  // paths here. Previously, this was `["..","..","<closed-source-dir>","online","manifest.ts"].join("/")`
  // plus `new URL(rel, import.meta.url)`: the same issue as B1 (`.ts` is not included in build
  // artifacts and cannot be loaded in production builds), and because the path was split into an
  // array and joined, with `new URL` on the next line, **G1 did not catch it at the time** (gate
  // has been tightened).
  return null;
}

let loadPromise: Promise<boolean> | null = null;

/**
 * Dynamically loads `<cloudDir>/online/manifest.ts`.
 * If the `cloud/` directory does not exist (community edition build or moving `cloud` away for
 * acceptance check), silently downgrades and returns `false`.
 */
export async function loadOnlineExtensions(options: { cloudDir?: string; forceReload?: boolean } = {}): Promise<boolean> {
  if (loadPromise && !options.forceReload && !options.cloudDir) {
    return loadPromise;
  }
  const run = (async () => {
    try {
      // If the caller explicitly provides a cloud directory (unit tests, moving cloud elsewhere for
      // acceptance check), concatenate based on it; otherwise use the alias, resolved by
      // `server/vite-plugin-cloud-seams.ts` to the closed-source directory or an empty stub. The specifier
      // must be a string literal.
      const targetUrl = resolveCloudManifestUrl(options.cloudDir);
      const mod = targetUrl
        ? await import(/* @vite-ignore */ targetUrl)
        : await import("#promptcut-cloud-online");
      // **Do not** fall back to `mod` itself as a table: in community edition, the alias resolves to an
      // empty stub, and `mod` is a namespace object that exports nothing (`typeof === "object"`), so
      // using it as a table would make this **return true** ("installed"), when in fact not a single
      // extension was registered. Found during review on 2026-10-28: unit tests only looked green because
      // alias resolution failed in Node and went to catch, while the guarantee on the browser path was
      // false.
      const manifest: OnlineExtensionManifest | undefined = mod?.manifest ?? mod?.default;
      if (!manifest || typeof manifest !== "object") return false;
      registerOnlineExtensions(manifest);
      await manifest.ready;
      return true;
    } catch {
      return false;
    }
  })();
  if (!options.cloudDir) {
    loadPromise = run;
  }
  return run;
}

export function ensureOnlineExtensionsLoaded(): Promise<boolean> {
  return loadOnlineExtensions();
}

// This file is a **pure seam registry** with no module-level side effects: it is statically
// imported by Node unit tests, and C10A-MODE-01 forbids modules loaded by unit tests from
// statically importing `mode.ts`, so `ONLINE` cannot be obtained here. The page startup sequence
// (installing guards, reading invite links, starting stage gates…) is in `src/online/pageBoot.ts`,
// imported by `main.tsx`.
