/**
 * 在线运行时与云端扩展接缝入口（公开侧）。
 *
 * 职责：
 *   1. 贯穿型接缝（`buildInfo`、`apiGuard`、`updateCheck`、`UpdateNotice`）：
 *      社区版无 `cloud/online/` 时全部安全降级（`CODE_VERSION = null`、`bootApiGuard` 空操作、
 *      `startUpdateCheck` 返回 `stale: false` 的静默控制器、`UpdateNotice` 不渲染）。
 *   2. 同步管理器云端后端接口（`SyncCloudBackend`）：
 *      封装 `syncManager.ts` 原先直接引用的 7 个云端模块（托管中继、恢复协调器、墓碑核验、
 *      云端账号客户端、云端 Agent 端点/身份/告知），社区版提供无害缺省实现。
 */

/* ======================================================================== *
 * 1. 贯穿型接缝：buildInfo / apiGuard / updateCheck / UpdateNotice
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
 * 下面这几个形状必须和 `cloud/online/` 下的真实实现对得上 —— 它们**就是**两侧共同认的那份接口。
 *
 * 2026-10-27 合并五份活时发现原来对不上：这里写的是 `{ online, entryModuleUrl, codeVersion,
 * onVersionSignal, locationLike, fetchTarget, wsTarget }` 和一个带 `uninstall()` 的句柄，
 * 而 `cloud/online/apiGuard.ts` 实际收 `{ href, base }`、回一个路径清单 `string[]`；
 * `UpdateCheckController` 也一样，这里写 `state` / `notifyProjectMinVersion` / `refreshNow`，
 * 真实现是 `getState()` / `subscribe()` / `stop()`。
 *
 * 之所以能一直对不上：`tsconfig.json` 的 include 只有 `["src"]`，`cloud/` 从来没进过类型检查，
 * 所以各活报的「tsc 零报错」都没看过它们自己写的云端代码。include 已经加上 `cloud`。
 */
export interface ApiGuardOptions {
  /** 页面地址（相对地址按它解析）；缺省 `location.href` */
  href?: string;
  /** 构建的 base（`import.meta.env.BASE_URL`），缺省 `/` */
  base?: string;
}

/**
 * 装上守卫，回它实际放行的路径清单。
 *
 * **第一个参数是 `online`，不能省。** 闭源侧 `cloud/online/apiGuard.ts` 导出两个函数：
 * `bootApiGuard(online, options)` 认这个判据，`installApiGuard(options)` **无条件装**。
 * 2026-10-28 两位审查者查出：云端表注册的是后者，而这里的接缝又把 `online` 整个丢了，
 * 于是**私有仓库的桌面构建与 dev server 里也会装上在线守卫**，桌面编辑器自己的 `/api/*` 被拒、全废。
 * 所以这里的形状必须带 `online`，由页面启动序列（`src/online/pageBoot.ts`）把 `ONLINE` 传进来。
 */
export type ApiGuardInstaller = (online: boolean, options?: ApiGuardOptions) => string[] | null;

let apiGuardInstaller: ApiGuardInstaller | null = null;

export function registerApiGuard(installer: ApiGuardInstaller | null): void {
  apiGuardInstaller = installer;
}

/**
 * 在页面入口装上在线接口守卫。社区版（未注册云端守卫或非在线模式）直接回 `null`。
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

/** 可见性来源（与 `cloud/online/updateCheck.ts` 的 `VisibilitySource` 一致） */
export interface VisibilitySource {
  readonly visibilityState?: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface UpdateCheckState {
  /** 是否检测到与本页不同的新版本 */
  readonly hasUpdate: boolean;
  /** 本页自己的代码版本（开发构建为 `null`） */
  readonly currentVersion: string | null;
  /** 检测到新版本时的远端代码版本；未检测到时为 `null` */
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
  /** 读取当前状态；状态未变时返回同一个对象引用 */
  getState: () => Readonly<UpdateCheckState>;
  /** 订阅状态变化；返回取消订阅函数 */
  subscribe: (listener: () => void) => () => void;
  /** 停止监听与定时器 */
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
  // 社区版缺省：永远「没有新版本」，订阅不会被调用
  return {
    getState: () => NOOP_UPDATE_STATE,
    subscribe: () => () => {},
    stop: () => {},
  };
}

export interface UpdateNoticeExtension {
  /**
   * 入口脚本自己的 `import.meta.url`（只有 `main.tsx` 拿得到）。闭源侧的真实现要把它剥成
   * 相对 `base` 的文件名再比 —— 形状照真实现写（`string | undefined`，**不收 null**），
   * 免得又出现「声明和实现对不上」。`invokeMountUpdateNotice` 负责把 null 归一成 undefined。
   */
  mountUpdateNotice?: (entryUrl?: string) => void;
  /** 任意入参的 React 组件都算（云端那个收 `{ controller }`） */
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
      /* 忽略挂载异常 */
    }
  }
  for (const fn of [...updateNoticeListeners]) {
    try {
      fn();
    } catch {
      /* 忽略订阅方异常 */
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
 * 3. 同步管理器云端后端接口：SyncCloudBackend
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

/** 公开侧兜底的账号异常（与 `src/account/client.ts` 的 `AccountFailure` 形状一致） */
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

/** 公开侧兜底的云端 Agent 委托异常（与 `src/ai/cloud/identity.ts` 的 `CloudDelegationError` 形状一致） */
export class PublicCloudDelegationError extends Error {
  readonly code: string;
  constructor(reason: string) {
    super(`文档服务没有签发云端 Agent 的委托(${reason})`);
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
    throw Object.assign(new Error("社区版未启用云端房间中继服务"), { reason: "unavailable" });
  },
  relayFetch() {
    return (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
  },
  async authorizeRelayAsset() {},
  async queryGone() {
    return { gone: false };
  },
  createRecoveryCoordinator() {
    let gen = 0;
    return {
      get generation() {
        return gen;
      },
      start() {
        gen++;
      },
      cancel() {
        gen++;
      },
    };
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
        if (!options.isCurrent()) throw new Error("还没有取得云端 Agent 的身份证明");
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
      /* 忽略 */
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
 * 4. 云端扩展清单注册与动态加载（仿 server/docservice/extensions.mjs）
 * ======================================================================== */

export interface OnlineExtensionManifest {
  buildInfo?: Partial<BuildInfo> | (() => BuildInfo);
  installApiGuard?: ApiGuardInstaller;
  startUpdateCheck?: StartUpdateCheckFn;
  updateNotice?: UpdateNoticeExtension;
  syncBackend?: Partial<SyncCloudBackend>;
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
  // 缺省那一支走别名（见下面 loadOnlineExtensions），不在这里拼路径。
  // 原来这里是 `["..","..","<闭源目录>","online","manifest.ts"].join("/")` 加
  // `new URL(rel, import.meta.url)`：和 B1 同一个毛病（`.ts` 不进产物，正式构建里加载不到），
  // 而且因为路径是拆成数组再 join 的、`new URL` 又在下一句，**G1 当时没抓到它**（闸门已收紧）。
  return null;
}

let loadPromise: Promise<boolean> | null = null;

/**
 * 动态加载 `<cloudDir>/online/manifest.ts`。
 * 若 `cloud/` 目录不存在（社区版构建或把 `cloud` 挪走验收），静默降级返回 `false`。
 */
export async function loadOnlineExtensions(options: { cloudDir?: string; forceReload?: boolean } = {}): Promise<boolean> {
  if (loadPromise && !options.forceReload && !options.cloudDir) {
    return loadPromise;
  }
  const run = (async () => {
    try {
      // 调用方显式给了云端目录（单测、把 cloud 挪到别处验收）就按它拼；否则走别名，
      // 由 `server/vite-plugin-cloud-seams.ts` 解析到闭源目录或空桩。说明符必须是字面量。
      const targetUrl = resolveCloudManifestUrl(options.cloudDir);
      const mod = targetUrl
        ? await import(/* @vite-ignore */ targetUrl)
        : await import("#promptcut-cloud-online");
      // **不要**把 `mod` 本身当表兜底：社区版里别名解析到空桩，`mod` 是个什么都没导出的
      // 命名空间对象（`typeof === "object"`），拿它当表会让这里**回 true**（「装上了」），
      // 而其实一个扩展都没注册。2026-10-28 审查查出来的 —— 单测看起来绿只是因为在 Node 里
      // 别名解析失败走了 catch，浏览器路径上那个保证是假的。
      const manifest: OnlineExtensionManifest | undefined = mod?.manifest ?? mod?.default;
      if (!manifest || typeof manifest !== "object") return false;
      registerOnlineExtensions(manifest);
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

// 这个文件是**纯接缝注册表**，没有模块级副作用：它会被 Node 单测静态 import，
// 而 C10A-MODE-01 不许被单测载入的模块静态引 `mode.ts`，所以这里拿不到 `ONLINE`。
// 页面的启动序列（装守卫、读邀请链接、起舞台闸门……）在 `src/online/pageBoot.ts`，由 `main.tsx` 引。
