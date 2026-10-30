/**
 * 网站账号与项目成员接缝（公开侧扩展注册口，见 `docs/plan/community-boundary.md`）。
 *
 * 两条模式：
 * 1. **替换型接缝（成员源 `MemberSource`、加入源 `JoinSource`）**：
 *    - 公开侧默认实现走局域网共享项目（`server/auth/` 项目口令/票据/邀请码 + `server/lan/` 发现 + `src/editor/sync/` 实时成员同步）；
 *    - 云端实现（`cloud/account/ui-manifest.tsx`）在启动时注册并接管 `accountId` 分支，非账号项目仍回退局域网实现。
 * 2. **贯穿型与可选扩展槽（`AccountExtensions`）**：
 *    - 上传被拒文案、项目链接拼装、账号客户端工厂（`createAccountClient`）、开始页与协作设置的账号入口组件。
 *    - 未安装 `cloud/account/` 时按社区版默认策略运行，不报错、不崩溃。
 *
 * 本模块是唯一允许可选加载 `cloud/account/manifest.ts` 的加载点；公开侧业务文件只引本模块，不直接引 `cloud/` 或 `src/account/`。
 */
import type { JSX } from "react";

import type { JoinRequestStatus } from "./joinRequestText.ts";

export const MEMBERS_POLL_OPEN_MS = 3000;
export const MEMBERS_POLL_CLOSED_MS = 15_000;

export const GUEST_LIMITS = Object.freeze({
  projects: 1,
  conversations: 1,
  videos: 3,
  assetMB: 100,
  ttlDays: 3,
} as const);

export const GUEST_LIMITS_TEXT =
  `游客可创建 ${GUEST_LIMITS.projects} 个云端项目、开启 ${GUEST_LIMITS.conversations} 条 AI 对话、` +
  `上传 ${GUEST_LIMITS.videos} 条视频（每条 ≤ ${GUEST_LIMITS.assetMB} MB），项目与素材保留 ${GUEST_LIMITS.ttlDays} 天；` +
  `只能查看别人的项目。注册或登录账号后，当前游客项目和对话都会转到你的账号名下。`;

export const GUEST_CHAT_LIMIT_TEXT = "游客最多开启 1 条对话。注册或登录账号后可继续新建对话。";

export interface Account {
  id: string;
  name: string;
  email?: string | null;
}

export interface GuestLogin {
  id: string;
  name: string;
  token: string;
  expiresAt: number;
}

export interface GuestSavedProject {
  id: string;
  name: string;
}

export interface ThirdPartyProvider {
  provider: "google";
  clientId: string;
}

export type ThirdPartyLogin =
  | { kind: "signed-in"; account: Account }
  | { kind: "need-name"; ticket: string; email: string | null };

export interface CloudAgentConsent {
  accountId: string;
  accepted: boolean;
  noticeVersion: 1;
  acceptedAt?: number;
}

export interface CloudProject {
  projectId: string;
  name: string;
  authorityId: string;
  creatorAccountId?: string;
  url?: string;
}

export interface ProjectLists {
  owned: CloudProject[];
  joined: CloudProject[];
}

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

export interface AccountClientOptions {
  online: boolean;
  origin: string;
  device: { deviceId: string; deviceName: string };
  fetch?: typeof fetch;
  native?: (operation: string, args?: Record<string, unknown>) => Promise<unknown>;
  now?: () => number;
}

export interface CloudAccountClient {
  readonly account: Account | null;
  readonly principal: Account | null;
  readonly guest: GuestLogin | null;
  readonly authVersion: number;
  enterAsGuest(): Promise<GuestLogin>;
  newGuest(): Promise<GuestLogin>;
  leaveGuest(): void;
  subscribeAuth(listener: () => void): () => void;
  restore(): Promise<Account | null>;
  login(identifier: string, password: string, remember: boolean, requestId?: string): Promise<Account>;
  thirdPartyProviders(): Promise<ThirdPartyProvider[]>;
  loginWithThirdParty(provider: string, token: string, remember: boolean): Promise<ThirdPartyLogin>;
  registerWithThirdParty(ticket: string, name: string, remember: boolean): Promise<Account>;
  logout(): Promise<void>;
  cloudAgentConsent(): Promise<CloudAgentConsent>;
  acceptCloudAgentConsent(requestId?: string): Promise<CloudAgentConsent>;
  getStartOrg(): Promise<{ version: number; org: unknown | null; updatedAt: number }>;
  putStartOrg(
    baseVersion: number,
    org: unknown,
  ): Promise<
    | { conflict: false; version: number; org: unknown; updatedAt: number }
    | { conflict: true; version: number; org: unknown | null; updatedAt: number }
  >;
  lists(): Promise<ProjectLists>;
  create(
    name: string,
    initialProject: unknown,
    requestId: string,
    opts?: { projectId?: string; rev?: number; history?: unknown[] },
  ): Promise<{ projectId: string; authorityId: string }>;
  regenProjectLink(
    projectId: string,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number; linkToken: string }>;
  deleteProject(
    projectId: string,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number }>;
  setSecondaryPassword(
    projectId: string,
    password: string | null,
    expectedAccessRevision: number,
    requestId: string,
  ): Promise<{ eventId: string; accessRevision: number; hasSecondaryPassword: boolean }>;
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
  members(projectId: string): Promise<AccountMembersSnapshot>;
  memberAdmin(projectId: string, operation: AccountMemberOperation): Promise<AccountMemberResult>;
  joinRequestStatus(projectId: string): Promise<JoinRequestStatus>;
  sendJoinRequest(projectId: string, requestId: string): Promise<JoinRequestStatus>;
  join(
    projectId: string,
    requestId: string,
    joinOpts?: { token?: string; linkToken?: string; secondaryPassword?: string },
  ): Promise<ProjectSession>;
  session(projectId: string, opts?: { minRemainingMs?: number }): Promise<ProjectSession>;
}

/** 替换型接缝：项目成员源（桌面 `MembersPanel.tsx`、手机 `useMembers.ts` 与 `sheets.tsx` 共用） */
export interface MemberSource {
  readonly kind: "lan" | "account";
  /** 桌面端顶栏「云端账号项目」专用成员浮层；未注册或局域网项目走公开侧 `LegacyMembersButton` */
  readonly DesktopAccountPanel?: () => JSX.Element | null;
  /** 读取当前共享项目成员快照（失败或离线返回 `null`） */
  fetchMembers(): Promise<AccountMembersSnapshot | null>;
  /** 成员管理操作（踢人、解禁、改进入方式、审批加入申请） */
  memberAdmin(operation: AccountMemberOperation): Promise<AccountMemberResult>;
  /** 局域网/口令协作项目移除成员（凭创建者口令或委托票据） */
  kickLanMember?(
    row: { username: string; deviceId: string | null },
    auth: { password?: string; key?: string },
  ): Promise<{ ok: true; key: string } | { ok: false; error: string }>;
  /** 签发局域网/口令共享项目邀请链接 */
  createInvite?(
    creatorPassword: string,
  ): Promise<{ ok: true; link: string; expiresAt: number; maxUses: number | null } | { ok: false; error: string }>;
}

export interface LanInviteResolution {
  ok: true;
  base: string;
  code: string;
  projectId: string;
  name: string;
  mode: "free" | "restricted";
}

/** 替换型接缝：加入共享项目源（公开侧默认走局域网邀请码与握手，云端走网站账号项目加入） */
export interface JoinSource {
  readonly kind: "lan" | "account";
  /** 解析并核对局域网邀请链接（`#invite=<43位>&doc=<路径>`） */
  resolveLanInvite(rawLink: string): Promise<LanInviteResolution | { ok: false; error: string }>;
  /** 凭局域网邀请码与用户名（及可选口令）兑换并握手进入共享项目 */
  joinLanByInvite(params: {
    base: string;
    code: string;
    username: string;
    password?: string;
  }): Promise<{ ok: true; projectId: string } | { ok: false; error: string }>;
}

export interface AccountProjectsHookResult {
  origin: string;
  account: Account | null;
  orgApi: {
    getStartOrg(): Promise<{ version: number; org: unknown | null; updatedAt: number }>;
    putStartOrg(
      baseVersion: number,
      org: unknown,
    ): Promise<
      | { conflict: false; version: number; org: unknown; updatedAt: number }
      | { conflict: true; version: number; org: unknown | null; updatedAt: number }
    >;
  } | null;
  busy: boolean;
  error: string;
  setError: (v: string) => void;
  shellOld: boolean;
  link: string;
  setLink: (v: string) => void;
  lists: ProjectLists | null;
  listError: string;
  refreshLists: () => Promise<void>;
  perform: (action: () => Promise<void>) => Promise<void>;
  enter: (projectId: string, name?: string, initial?: ProjectSession) => Promise<void>;
  open: (projectId: string, name?: string) => Promise<"ok" | "secondary-required" | "failed">;
  login: (name: string, password: string, remember: boolean) => Promise<void>;
  adoptSession: () => Promise<boolean>;
  logout: () => Promise<void>;
  create: (name: string) => Promise<void>;
  join: (raw?: string, secondaryPassword?: string) => Promise<"ok" | "not-listed" | "secondary-required" | "bad-secondary" | "expired">;
  guest: GuestLogin | null;
  guestProject: GuestSavedProject | null;
  enterAsGuest: () => Promise<boolean>;
  newGuest: () => Promise<boolean>;
  leaveGuest: () => void;
  openGuestProject: () => Promise<void>;
  request: JoinRequestStatus | null;
  sendRequest: () => Promise<void>;
  clearRequest: () => void;
  directSecondary: { projectId: string; link: string } | null;
  clearDirectSecondary: () => void;
  peekSession: (projectId: string) => Promise<ProjectSession>;
  projectLink: typeof projectLink;
}

export interface AccountExtensions {
  formatUploadError?: (code: string) => string;
  projectLink?: (origin: string, projectId: string, linkToken?: string) => string;
  createAccountClient?: (options: AccountClientOptions) => CloudAccountClient;
  useAccountProjects?: (opts: { online: boolean; onEnterEditor: () => void }) => AccountProjectsHookResult;
  AccountEntryOption?: (props: { disabled?: boolean }) => JSX.Element | null;
  AccountProjects?: (props: { online: boolean; onEnterEditor: () => void }) => JSX.Element | null;
  MobileAccountStart?: (props: { onEnterEditor: () => void }) => JSX.Element;
}

/* ---------------- 默认实现与状态 ---------------- */

const DEFAULT_MEMBER_SOURCE: MemberSource = {
  kind: "lan",
  async fetchMembers() {
    return null;
  },
  async memberAdmin() {
    throw new Error("当前项目未开启网站账号成员管理");
  },
};

const DEFAULT_JOIN_SOURCE: JoinSource = {
  kind: "lan",
  async resolveLanInvite() {
    return { ok: false, error: "连不上服务器，请稍后再试。" };
  },
  async joinLanByInvite() {
    return { ok: false, error: "连不上服务器，请稍后再试。" };
  },
};

let defaultLanMemberSource: MemberSource = DEFAULT_MEMBER_SOURCE;
let activeMemberSource: MemberSource = DEFAULT_MEMBER_SOURCE;
let defaultLanJoinSource: JoinSource = DEFAULT_JOIN_SOURCE;
let activeJoinSource: JoinSource = DEFAULT_JOIN_SOURCE;
let currentExtensions: AccountExtensions = {};

const listeners = new Set<() => void>();
function notifyListeners() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 单个订阅者报错不影响其余订阅者 */
    }
  }
}

export function subscribeAccountExtensions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 公开侧局域网成员源在模块初始化时登记为默认实现 */
export function setDefaultLanMemberSource(source: MemberSource): void {
  defaultLanMemberSource = source;
  if (activeMemberSource === DEFAULT_MEMBER_SOURCE || activeMemberSource.kind === "lan") {
    activeMemberSource = source;
    notifyListeners();
  }
}

export function getDefaultLanMemberSource(): MemberSource {
  return defaultLanMemberSource;
}

export function registerMemberSource(source: MemberSource): void {
  if (!source || typeof source.fetchMembers !== "function" || typeof source.memberAdmin !== "function") {
    throw new Error("registerMemberSource requires fetchMembers and memberAdmin functions");
  }
  activeMemberSource = source;
  notifyListeners();
}

export function getMemberSource(): MemberSource {
  return activeMemberSource;
}

export function resetMemberSource(): void {
  activeMemberSource = defaultLanMemberSource;
  notifyListeners();
}

/** 公开侧局域网加入源在模块初始化时登记为默认实现 */
export function setDefaultLanJoinSource(source: JoinSource): void {
  defaultLanJoinSource = source;
  if (activeJoinSource === DEFAULT_JOIN_SOURCE || activeJoinSource.kind === "lan") {
    activeJoinSource = source;
    notifyListeners();
  }
}

export function getDefaultLanJoinSource(): JoinSource {
  return defaultLanJoinSource;
}

export function registerJoinSource(source: JoinSource): void {
  if (!source || typeof source.resolveLanInvite !== "function" || typeof source.joinLanByInvite !== "function") {
    throw new Error("registerJoinSource requires resolveLanInvite and joinLanByInvite functions");
  }
  activeJoinSource = source;
  notifyListeners();
}

export function getJoinSource(): JoinSource {
  return activeJoinSource;
}

export function resetJoinSource(): void {
  activeJoinSource = defaultLanJoinSource;
  notifyListeners();
}

export function registerAccountExtensions(ext: Partial<AccountExtensions>): void {
  currentExtensions = { ...currentExtensions, ...ext };
  notifyListeners();
}

export function getAccountExtensions(): Readonly<AccountExtensions> {
  return currentExtensions;
}

export function resetAccountExtensions(): void {
  currentExtensions = {};
  activeMemberSource = defaultLanMemberSource;
  activeJoinSource = defaultLanJoinSource;
  notifyListeners();
}

/* ---------------- 贯穿型便捷入口（带默认兜底） ---------------- */

const DEFAULT_UPLOAD_REFUSAL_TEXT: Record<string, string> = {
  "guest-file-too-large": `游客上传的每一条源文件不能超过 ${GUEST_LIMITS.assetMB} MB。`,
  "guest-video-limit": `游客最多上传 ${GUEST_LIMITS.videos} 条视频。要传更多，请注册一个账号。`,
  "guest-read-only": "你在这个项目里只能查看，改不了内容。",
};

/**
 * 贯穿型接缝：素材上传被永久拒绝时的原因说明。
 * 云端已注册时走 `accountErrorText`；未注册（社区版或单独单测）时走内置兜底文案。
 */
export function formatUploadRejectionReason(code: string): string {
  if (currentExtensions.formatUploadError) return currentExtensions.formatUploadError(code);
  return DEFAULT_UPLOAD_REFUSAL_TEXT[code] ?? `请求失败（${code || "unknown"}）`;
}

/** 项目链接拼装（`<origin>/p/<id>` 或 `<origin>/s/<id>/<linkToken>`） */
export function projectLink(origin: string, projectId: string, linkToken?: string): string {
  if (currentExtensions.projectLink) return currentExtensions.projectLink(origin, projectId, linkToken);
  return new URL(linkToken ? `/editor/s/${projectId}/${linkToken}` : `/editor/p/${projectId}`, new URL(origin).origin).toString();
}

function createFallbackAccountClient(options: AccountClientOptions): CloudAccountClient {
  const cleanOrigin = new URL(options.origin).origin;
  const unavailable = async (): Promise<never> => {
    const err = new Error("当前版本未安装网站账号扩展") as Error & { status?: number; code?: string };
    err.status = 501;
    err.code = "not-account-cloud";
    throw err;
  };
  return {
    account: null,
    principal: null,
    guest: null,
    authVersion: 0,
    enterAsGuest: unavailable,
    newGuest: unavailable,
    leaveGuest: () => {},
    subscribeAuth: () => () => {},
    restore: async () => null,
    login: unavailable,
    thirdPartyProviders: async () => [],
    loginWithThirdParty: unavailable,
    registerWithThirdParty: unavailable,
    logout: async () => {},
    cloudAgentConsent: unavailable,
    acceptCloudAgentConsent: unavailable,
    getStartOrg: unavailable,
    putStartOrg: unavailable,
    lists: unavailable,
    create: unavailable,
    regenProjectLink: unavailable,
    deleteProject: unavailable,
    setSecondaryPassword: unavailable,
    setAgentEnabled: unavailable,
    setHostedService: unavailable,
    setHostedOption: unavailable,
    members: unavailable,
    memberAdmin: unavailable,
    joinRequestStatus: unavailable,
    sendJoinRequest: unavailable,
    join: unavailable,
    session: unavailable,
  };
}

export function createAccountClient(options: AccountClientOptions): CloudAccountClient {
  return currentExtensions.createAccountClient
    ? currentExtensions.createAccountClient(options)
    : createFallbackAccountClient(options);
}

/* ---------------- 可选加载点（唯一动态加载 cloud/account/ 的位置） ---------------- */

// 云端扩展包走**别名**，由 `server/vite-plugin-cloud-seams.ts` 在构建时解析到闭源目录或空桩。
// 原来这里写的是 `new URL("../../../<闭源目录>/account/manifest.ts", import.meta.url)` 加
// `@vite-ignore` 的动态 import，三重问题：① 公开文件在拼闭源路径（G1 判红）；
// ② 没有 PROMPTCUT_CLOUD_DIR 的等价物，子模块布局下相对路径指到 `community/` 而不是私有根，
//    静默落空，而私有仓库文件齐全所以看不出来；③ `.ts` 不进产物、`@vite-ignore` 又让 Vite 不解析它，
//    正式构建里根本加载不到。下面两处 import 的说明符必须是**字面量**，Vite 才解析得到。

function isModuleNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const msg = String((err as { message?: unknown }).message ?? "");
  // ERR_PACKAGE_IMPORT_NOT_DEFINED：Node 直接跑这个文件时（单测、服务端）没有 Vite 的别名表，
  // `#promptcut-cloud-*` 解析不到就是这个码。那正是「没装云端扩展」，不是错误。
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_IMPORT_NOT_DEFINED") return true;
  return (
    msg.includes("Cannot find module") ||
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Failed to load module script") ||
    msg.includes("Importing a module script failed") ||
    msg.includes("error loading dynamically imported module") ||
    msg.includes("Does the file exist")
  );
}

let coreLoadPromise: Promise<boolean> | null = null;
let uiLoadPromise: Promise<boolean> | null = null;

/**
 * 尝试加载 `cloud/account/manifest.ts`（以及浏览器环境下的 `cloud/account/ui-manifest.tsx`）。
 * 社区版移走 `cloud/` 时捕获 MODULE_NOT_FOUND 并返回 `false`，保持局域网默认实现运行。
 */
export async function loadAccountExtensions(opts: { manifestUrl?: string; includeUi?: boolean } = {}): Promise<boolean> {
  if (opts.manifestUrl) {
    try {
      const mod = (await import(/* @vite-ignore */ opts.manifestUrl)) as { register?: () => Promise<void> | void };
      if (typeof mod.register === "function") await mod.register();
      return true;
    } catch (err) {
      if (isModuleNotFound(err)) return false;
      throw err;
    }
  }

  if (!coreLoadPromise) {
    coreLoadPromise = (async () => {
      try {
        const mod = (await import("#promptcut-cloud-account")) as { register?: () => Promise<void> | void };
        // 空桩什么都不导出，所以「装上了」的判据是 register 在不在，不是 import 成没成
        if (typeof mod.register !== "function") return false;
        await mod.register();
        return true;
      } catch (err) {
        if (isModuleNotFound(err)) return false;
        throw err;
      }
    })();
  }

  const coreLoaded = await coreLoadPromise;
  const wantUi = opts.includeUi ?? typeof document !== "undefined";
  if (coreLoaded && wantUi) {
    if (!uiLoadPromise) {
      uiLoadPromise = (async () => {
        try {
          const uiMod = (await import("#promptcut-cloud-account-ui")) as { registerUi?: () => Promise<void> | void };
          if (typeof uiMod.registerUi !== "function") return false;
          await uiMod.registerUi();
          return true;
        } catch (err) {
          if (isModuleNotFound(err)) return false;
          // Node 环境（如不经过 Vite JSX 转译的纯 Node 测试）无法解析 .tsx，静默跳过 UI 扩展
          if (err instanceof SyntaxError || String((err as Error)?.message ?? "").includes("Unexpected token")) {
            return false;
          }
          throw err;
        }
      })();
    }
    await uiLoadPromise;
  }
  return coreLoaded;
}

// 模块导入时异步预热核心接缝（不阻塞，失败静默当未装扩展处理）
void loadAccountExtensions({ includeUi: typeof document !== "undefined" }).catch(() => false);
