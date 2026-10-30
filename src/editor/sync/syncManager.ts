/**
 * 页面的同步管理(c65-design.md 第 4、6、8、9 节):页面用 WebSocket 接文档服务、把 DocSync 挂上 store。
 *
 * - **本机项目**:连本机编辑器的 `/docservice`(回环什么都不带 = `local` 空间),项目号就是 `project.id`。
 *   载入另一个项目(开始页、打开 .proc、新建)时换一条连接、一个新的 DocSync,并把载入的内容以根替换写进去
 *   (打开的文件就是用户要的那一份);载入的还是同一个项目时是对它的一次根替换。
 * - **共享项目**:按进入时的连接(凭证明,`server/auth/client.mjs`),项目号就是共享项目的 `projectId`。
 *   在共享项目里载入别的项目 = 离开共享项目、回到本机空间(不会把别的文件整份盖到大家的项目上)。
 * - `?join=<项目号>`:第二个页面加入同一个本机项目,内容以文档服务为准,不做根替换(V2 的真实页面版用)。
 * - 无头实例(`?headless=1`)、只读查看、连不上本机文档服务时不接:store 照旧用快照栈。
 *
 * 界面状态(同步状态、离线对话框、撤销提示条、成员列表、阻断弹窗、气泡)放在这里的一个小仓库里,
 * 组件用 `useSync(selector)` 读。
 */
import { useSyncExternalStore } from "react";
import { bindStore, DocSync, type CommitSummary, type LocalBackup, type PausedInfo, type SyncNotice, type SyncStatus, type UndoResult, type Writer } from "../../store/docsync";
import { actions, getState, subscribe, setProjectLoader } from "../../store/project";
import { entitiesOf, entityOfPath, type PathOp } from "../../kernel/diffProject";
import type { Project } from "../../kernel/project";
import { isViewOnly, setProjectAccess } from "../io/viewOnly";
import { SyncLink, type AnyMsg, type CloseInfo } from "./link";
import { classifyEnterFailure, classifyProtocolError } from "./enterFailure";
import { client, errorStatus, route, hosted, type Candidate, type SharedMode, type Where } from "./sharedApi";
import { currentAssociation, noteConvertedFrom, publishGoneConversion, setAssociation, takeLoadedAssociation, type CollaborationDescriptor, type CloudProjectAssociation, currentCloudAssociation, setCloudAssociation, takeLoadedCloudAssociation, handleCloudAssociationReopen, setRealtimeRevGetter, setCloudSnapshotGetter } from "./recoveryAssociation";
import { reopenPlan } from "./cloudSnapshot";
import { convertGoneProject, restoreOfflineEdits, type GoneProof } from "./cloudGone";




// @ts-expect-error Browser-safe service identity validation.
import { serviceIdentity } from "../../../server/recovery/descriptor.mjs";


import { accountNameKey, clipOfEntity, entityLabel, rolledBackText, writerLabel, type DisplayNames, type Me } from "./labels";
import { undoConflictPlan } from "./undoConflict";
import { connectSharedAssets, disconnectSharedAssets, lanAssetBaseOf, receiveSharedAssetEndpoints } from "../media/assetTiers";
import { bindCardSync, noteProjectForCardSync, detachCardSync, takeMineCard, receiveCardSyncNotice } from "./cardSync";
import { accountCardTicket } from "./accountCardSync";
import { createAccountLinkLife } from "./accountLinkLife";
import { bindAgentSide, releaseAgentSide } from "./agentSideBinding";
import { bindRenderNode, unbindRenderNode } from "./renderNodeHandoff";
import { receivePresence, resyncPresenceLink, setPresenceLink } from "./presence";
import { ONLINE } from "../../online/mode";
import { cacheCollabSecrets } from "./collabSecrets";
import { accountHostedFailure, applyHostedChange, applyHostedOptionChange, hostedChangeNotices, HOSTED_SERVICE_TEXT, hostedOptionText, parseHosted, type HostedOptionName, type HostedServiceName, type HostedView } from "./hostedServices";
import {
  ensureOnlineExtensionsLoaded,
  getSyncCloudBackend,
  subscribeSyncCloudBackend,
  type AccountMemberOperation,
  type AccountMemberResult,
  type AccountMembersSnapshot,
  type CloudAccountClient,
  type CloudIdentity,
  type ProjectSession,
  type RecoveryCoordinatorHandlers,
  type RecoveryCoordinatorLike,
} from "../../online/boot";



/**
 * 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」),值同 `ONLINE`。只用在剪枝处,
 * 写成 `!ONLINE_BUILD && !ONLINE`:在线构建里整句折成 false,单测里把 `mode.ts` 换成在线桩时照旧按 `ONLINE` 走。
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";
/** 账号项目：续会话读创建者改过的服务开关、自己的权限与成员变化的间隔(毫秒)；会话快到期时随时续 */
export const ACCOUNT_METADATA_RENEW_MS = 15_000;
/** 进了云端项目那条气泡的键:同键只留一条,进了别的项目就替换掉上一条(issue #15) */
export const ENTERED_TOAST_KEY = "cloud-entered";
/** 进了云端项目那条气泡停留多久(毫秒)。调用方自带文案的(「搬到云端」)不受这个数管,见 `enterAccountProject` */
export const ENTERED_TOAST_MS = 8000;
import { loadBrowserDevice } from "../../online/device";

import { hostedWsUrlOf } from "../../online/invite";
const discoverRoom = async (opts: Record<string, unknown>): Promise<Candidate> => { await ensureOnlineExtensionsLoaded(); return getSyncCloudBackend().discoverRoom(opts) as Promise<Candidate>; };
const relayFetch = (access: unknown): typeof fetch => getSyncCloudBackend().relayFetch(access);
const authorizeRelayAsset = async (candidate: Candidate, ticket: string): Promise<void> => { await ensureOnlineExtensionsLoaded(); return getSyncCloudBackend().authorizeRelayAsset(candidate, ticket); };
const queryGone = async (descriptor: CollaborationDescriptor, opts?: { signal?: AbortSignal }) => { await ensureOnlineExtensionsLoaded(); return getSyncCloudBackend().queryGone(descriptor, opts); };
const setHostedAgent = (projectId: string, raw: unknown) => getSyncCloudBackend().setHostedAgent(projectId, raw);
const setHostedAgentEnabled = (projectId: string, enabled: boolean) => getSyncCloudBackend().setHostedAgentEnabled(projectId, enabled);
const clearHostedAgent = () => getSyncCloudBackend().clearHostedAgent();
const setCloudIdentity = (next: CloudIdentity | null) => getSyncCloudBackend().setCloudIdentity(next);
const accountCloudIdentity = (options: Parameters<ReturnType<typeof getSyncCloudBackend>["accountCloudIdentity"]>[0]) => getSyncCloudBackend().accountCloudIdentity(options);
const setCloudConsentSource = (next: { client: CloudAccountClient; accountId: string } | null) => getSyncCloudBackend().setCloudConsentSource(next);
const accountConnectionProtocols = (session: ProjectSession) => getSyncCloudBackend().accountConnectionProtocols(session);
const projectLink = (origin: string, projectId: string, linkToken?: string) => getSyncCloudBackend().projectLink(origin, projectId, linkToken);

class AccountFailure extends Error {
  status: number;
  code: string;
  body?: Record<string, unknown>;
  constructor(status: number, code: string, message?: string, body?: Record<string, unknown>) {
    const created = getSyncCloudBackend().createAccountFailure(status, code, message, body) as Error & { status: number; code: string; body?: Record<string, unknown> };
    super(created.message);
    this.status = created.status;
    this.code = created.code;
    if (created.body) this.body = created.body;
    return created as this;
  }
  static [Symbol.hasInstance](instance: unknown): boolean {
    return getSyncCloudBackend().isAccountFailure(instance);
  }
}

class CloudDelegationError extends Error {
  readonly code: string;
  constructor(reason: string) {
    const created = getSyncCloudBackend().createCloudDelegationError(reason);
    super(created.message);
    this.name = "CloudDelegationError";
    this.code = created.code;
    return created as this;
  }
}

class RecoveryCoordinator {
  private inner: RecoveryCoordinatorLike | null = null;
  private readonly handlers: RecoveryCoordinatorHandlers;
  constructor(handlers: RecoveryCoordinatorHandlers) {
    this.handlers = handlers;
    subscribeSyncCloudBackend(() => { this.inner = null; });
  }
  private resolve(): RecoveryCoordinatorLike {
    if (!this.inner) this.inner = getSyncCloudBackend().createRecoveryCoordinator(this.handlers);
    return this.inner;
  }
  get generation(): number {
    return this.resolve().generation;
  }
  start(descriptor: CollaborationDescriptor, contentId?: string): void {
    void ensureOnlineExtensionsLoaded().then(() => { this.resolve().start(descriptor, contentId); });
  }
  cancel(): void {
    this.resolve().cancel();
  }
}
import { createOnlineBackups, type OnlineBackups } from "./onlineBackups";
import { ACCOUNT_MOVE_TEXT, createAttemptStore } from "./accountMove";
import { nextRecovery, offlineStoreOf, unsentAtRisk, RECOVERED_SHOW_MS, UNSENT_NO_STORE_TOAST, type OfflineStore } from "./onlineStatus";
import { applyMerge, cardConflictThing, selectionList, staleSelections, type Box, type MergeThing, type Selection } from "./mergeItems";
import { MergeTable } from "./mergeTable";
import { offlineThings } from "./offlineTransfer";
import { cacheKey, defaultStore, defaultStoreDurable } from "./offlineCache";

/* ---------------- 界面状态 ---------------- */

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  /** 编辑器绑在局域网上(以 PROMPTCUT_LAN_HOST=1 启动):能当局域网主机 */
  lanHost: boolean;
  /** 页面是本机编辑器给的(回环地址打开);纯浏览器(在线浏览器模式)不能当局域网主机 */
  localEditor: boolean;
}

export interface MemberRow {
  deviceId: string | null;
  deviceName: string | null;
  username: string;
  displayName: string;
  creator: boolean;
  tags: { editing: boolean; rendering: boolean; agents: number };
  /** `service: 'agent'` 的那一项是代这位成员进项目的云端 Agent */
  conns: { role: string; conversation?: number | string; service?: string }[];
  /** 托管方的服务(不是成员):这一行按服务名显示(`hostedServices.ts`),不计入成员数、没有踢人按钮 */
  service?: string;
}

export interface SharedInfo {
  projectId: string;
  name: string;
  mode: SharedMode;
  where: Where;
  base: string;
  username: string;
  /** 以创建者身份进入 */
  creator: boolean;
  hostDeviceName?: string;
  accountId?: string;
  /**
   * 服务端发的权限（`'r'` 只读 / `'rw'` 读写）。游客进别人的项目一律是 `'r'`（2026-10-23 用户定）。
   * 界面据此走只读（`src/editor/io/viewOnly.ts`）；真正拦住写的是服务端，不是这一项。
   */
  access?: 'r' | 'rw';
}

export interface UndoNoticeView {
  id: number;
  kind: "undo" | "redo" | "agent";
  result: UndoResult;
  /** 出提示时的项目(实体名按它取) */
  project: Project;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "warn";
  /** 气泡上的一个按钮(在线页面的「下载备份」):点了照样不关气泡,用户自己关 */
  action?: { label: string; run: () => void; pc?: string };
  /**
   * 同一类气泡的键:再推一条同键的,旧的那条让位(issue #15 —— 原来每进一次云端项目就叠一条常驻气泡,
   * 在氛围式里来回点几个项目就叠成一摞)。不给键的照旧各自独立
   */
  key?: string;
}

export type Blocked = "kicked" | "removed" | "deleted";

export interface AgentOp {
  /** 事件 id(`events.event` 的 eventId) */
  eventId: string;
  /** 这次工具调用的 callId(事件里带了才有;AI 栏按它对上 SSE 的工具调用) */
  callId?: string;
  opId: string;
  inverse?: PathOp[];
  rev?: number;
  by?: Writer;
  state: "ready" | "done" | "none";
}

/**
 * AI 栏的一条工具调用记录(D2,c65-design.md 第 7 节):Agent 服务端每个工具调用发「创建」「完成」两条事件,
 * 按 `eventId` 合成这一条;文字回复是一条 `kind: "text"`。只存摘要,完整参数在内容库 `event-detail`,展开时再拉。
 */
export interface EventRecord {
  eventId: string;
  kind: "tool" | "text";
  tool?: string;
  icon?: string | null;
  target?: string | null;
  args?: string | null;
  callId?: string;
  actor?: Record<string, unknown>;
  /** null = 还在跑(只收到了创建) */
  status: "ok" | "error" | "cancelled" | null;
  summary?: string | null;
  durationMs?: number | null;
  at?: number;
  text?: string;
  /** 这次调用写进项目的那次提交(成功的写才有) */
  opId?: string;
  detailKey?: string | null;
}

export interface SyncView {
  hostRegistration: string | null;
  association: CollaborationDescriptor | null;
  reopenState: string | null;
  /** 页面接上了文档服务(不然 store 用快照栈) */
  active: boolean;
  kind: "local" | "shared" | "off";
  status: SyncStatus;
  paused: PausedInfo | null;
  offlineOpen: boolean;
  shared: SharedInfo | null;
  members: MemberRow[];
  /** 托管方服务的可用与开关(成员列表顶层的 `hosted`);放本机的项目与没有登记表的托管端没有 */
  hosted: HostedView | null;
  blocked: Blocked | null;
  notice: UndoNoticeView | null;
  toasts: Toast[];
  device: DeviceInfo | null;
  /** AI 栏记录的版本号:agentOps 变了就加一 */
  agentOpsVersion: number;
  /** 工具调用记录(eventRecords)的版本号:变了就加一 */
  eventsVersion: number;
  /** 还没拿到文档服务确认的本地提交条数(在线页面的离线提示用;桌面不更新,恒为 0) */
  unconfirmed: number;
  /** 在线页面从离线回来的恢复阶段(C10 契约第 10 节,`onlineStatus.ts` 的 `nextRecovery`) */
  recovery: "recovering" | "recovered" | null;
  /** 在线页面内存里的本地备份份数(`onlineBackups.ts`) */
  onlineBackups: number;
  /** 当前项目的历史序号（文档服务确认的 rev） */
  rev: number | null;
  /**
   * 待合并表(「冲突合并」窗口,`mergeItems.ts`):当前项目里这位用户还没处理完的东西。
   * 按「项目 × 用户」存在文档服务(连不上时先用本机暂存的副本),离线重连与 0.7.20 的撤销冲突共用。
   */
  merge: { things: MergeThing[]; version: number; blocked: string | null };
  /** 「冲突合并」窗口开着(重连转进新的离线批次时自动打开;导航栏的「冲突合并」按钮也打开它) */
  mergeOpen: boolean;
  /**
   * 离线改动现在存在哪(离线常驻提示与离开确认用,`onlineStatus.ts`):`saved` = 已存在本机(账号云端项目落盘到浏览器本地缓存、
   * 桌面版的本机恢复文件);`page` = 只在这个页面里(在线页面里旧办法的口令房间,或浏览器本地缓存这次没写成)。
   */
  offlineStore: OfflineStore;
}

let view: SyncView = {
  hostRegistration: null,
  association: null,
  reopenState: null,
  active: false,
  kind: "off",
  status: "idle",
  paused: null,
  offlineOpen: false,
  shared: null,
  members: [],
  hosted: null,
  blocked: null,
  notice: null,
  toasts: [],
  device: null,
  agentOpsVersion: 0,
  eventsVersion: 0,
  unconfirmed: 0,
  recovery: null,
  onlineBackups: 0,
  rev: null,
  merge: { things: [], version: 0, blocked: null },
  mergeOpen: false,
  offlineStore: ONLINE ? "page" : "saved",
};
const viewListeners = new Set<() => void>();

function patch(p: Partial<SyncView>) {
  view = { ...view, ...p };
  // 界面的只读开关跟着当前项目的权限走(`src/editor/io/viewOnly.ts`)。只在这里拨一次:
  // 退出项目的地方有七八处,各记一遍迟早漏一处,漏了就会把只读状态带进下一个项目
  if ('shared' in p) setProjectAccess(view.shared ? (view.shared.access ?? 'rw') : null);
  for (const l of viewListeners) l();
}

export function getSyncView(): SyncView {
  return view;
}

// 探针与排障的只读口子(同 __pcStore、__pcCloud 一类的 __pc* 钩子):这一刻连没连上、没确认的条数、离线改动存在哪。
// 界面自己用 useSync,不走这里;探针拿它核对真状态,免得只能从界面上的提示倒推
if (typeof window !== "undefined") {
  (window as unknown as { __pcSync?: { view: () => SyncView } }).__pcSync = { view: () => view };
}

export function subscribeSync(l: () => void): () => void {
  viewListeners.add(l);
  return () => viewListeners.delete(l);
}

export function useSync<T>(selector: (v: SyncView) => T): T {
  return useSyncExternalStore(subscribeSync, () => selector(view), () => selector(view));
}

let toastSeq = 0;
/**
 * `ms` 给 `Infinity` 就不自己消失(用户点 × 关)。回这条气泡的号(`dismissToast` 用)。
 * 给了 `key`:同键的旧气泡先撤掉,屏幕上同一类永远只有一条
 */
export function pushToast(text: string, tone: Toast["tone"] = "info", ms = 6000, action?: Toast["action"], key?: string): number {
  const t: Toast = { id: ++toastSeq, text, tone, ...(action ? { action } : {}), ...(key ? { key } : {}) };
  patch({ toasts: [...(key ? view.toasts.filter((old) => old.key !== key) : view.toasts), t] });
  if (Number.isFinite(ms)) setTimeout(() => dismissToast(t.id), ms);
  return t.id;
}

export function dismissToast(id: number) {
  if (!view.toasts.some((t) => t.id === id)) return;
  patch({ toasts: view.toasts.filter((t) => t.id !== id) });
}

let noticeSeq = 0;
export function dismissNotice() {
  patch({ notice: null });
}

/* ---------------- 连接 ---------------- */

interface Current {
  link: SyncLink;
  kind: "local" | "shared";
  docProjectId: string;
  /** 这条连接连的文档服务地址(告诉 Agent 服务端,见 bindAgentSide) */
  url: string;
  unbind: () => void;
  offs: (() => void)[];
  /** Change the in-memory proof used by subsequent reconnects after a successful own-password update. */
  updateAuthentication?: (key: string) => void;
  setAccountAgentEnabled?: (enabled: boolean) => Promise<void>;
  /** 账号项目:创建者改托管方的渲染节点的开关,或它下面的子选项(「生成轨道流」)。成员调用被服务端拒(403) */
  setAccountHosted?: (change: { service: "render"; enabled: boolean } | { service: "render"; option: HostedOptionName; enabled: boolean }) => Promise<void>;
  accountMembers?: () => Promise<AccountMembersSnapshot>;
  /** 诊断:账号项目里这条连接的寿命 */
  accountLife?: () => { expiresAt: number | null; trusted: boolean | null; renews: number; expires: number; busy: boolean };
  accountMemberAdmin?: (operation: AccountMemberOperation) => Promise<AccountMemberResult>;
  /** 账号项目:创建者作废并重新生成项目链接,回新的项目链接(先续一次会话,拿当前的访问版本号) */
  regenAccountLink?: () => Promise<string>;
  /** 账号项目:创建者设置 / 修改(字符串)或清除(null)项目二级密码(同上,先续会话) */
  setAccountSecondaryPassword?: (password: string | null) => Promise<void>;
  /** 账号项目:现在的项目链接(创建者带当前的链接口令) */
  accountLink?: () => string;
}

let cur: Current | null = null;
let started = false;
const session = `page-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12)}`;

export function pageSession(): string {
  return session;
}

export async function accountProjectMembers(): Promise<AccountMembersSnapshot> {
  const current = cur;
  if (!view.shared?.accountId || !current?.accountMembers) throw new AccountFailure(503, 'members-unavailable');
  const result = await current.accountMembers();
  if (cur !== current) throw new AccountFailure(401, 'credential-revoked');
  return result;
}
export async function accountMemberAdmin(operation: AccountMemberOperation): Promise<AccountMemberResult> {
  const current = cur;
  if (!view.shared?.accountId || !current?.accountMemberAdmin) throw new AccountFailure(503, 'members-unavailable');
  const result = await current.accountMemberAdmin(operation);
  if (cur !== current) throw new AccountFailure(401, 'credential-revoked');
  return result;
}
/** Only leave this page. No logout, membership deletion, or conversion to a local project. */
export async function returnToAccountProjectHome(): Promise<void> {
  const current = cur;
  if (!view.shared?.accountId || !current) return;
  // Keep unsent edits visible if they cannot be confirmed; do not silently discard them.
  await current.link.ds.whenSettled({ timeoutMs: 5000 });
  if (cur !== current) return;
  current.link.stop();
  detach(); disconnectSharedAssets(); clearSharedResume();
  patch({ shared: null, members: [], hosted: null, blocked: null });
  window.dispatchEvent(new Event('pc-go-home'));
}

/** 当前连着的项目号(本机项目是 project.id,共享项目是共享项目的 projectId);没接文档服务时是 project.id */
export function currentDocProjectId(): string {
  return cur?.docProjectId ?? getState().project.id ?? "";
}

/** 本页面是谁(撤销提示条里认「你在另一个页面」用) */
export function me(): Me {
  const s = view.shared;
  if (s && view.device) return { session, userId: `${s.accountId ? `account:${s.accountId}` : s.username}@${view.device.deviceId}` };
  return { session, userId: "local" };
}

export function displayNames(): DisplayNames {
  const m: DisplayNames = new Map();
  for (const row of view.members) if (row.deviceId) m.set(`${row.username}@${row.deviceId}`, row.displayName);
  // 账号云端项目:`view.members` 是空的(成员名单另走账号接口),名字按账号记在 `accountNames` 里
  for (const [accountId, name] of accountNames) m.set(accountNameKey(accountId), name);
  return m;
}

/**
 * 账号云端项目里各成员账号的名字(提示气泡里「谁改的」用):进项目时取一次成员名单,之后成员有变化(会话里的权限版本变了)再取。
 * 离开项目清掉。取不到就没有名字,气泡照原来的退路显示。
 */
let accountNames = new Map<string, string>();
function accountNamesFrom(snapshot: AccountMembersSnapshot): void {
  const next = new Map<string, string>();
  for (const row of snapshot.members) if (row.accountName) next.set(row.accountId, row.accountName);
  accountNames = next;
}

function localWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/docservice`;
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/**
 * 设备信息:本机编辑器给的;纯浏览器(在线浏览器模式)用存在页面本地的随机 id 和「浏览器名 + 系统名 + 随机 4 位」
 * (C10a 契约第 2 节,`src/online/device.ts`),不经 `/api/docservice/device`。
 */
async function loadDevice(): Promise<DeviceInfo | null> {
  if (ONLINE) {
    const d = loadBrowserDevice();
    return { deviceId: d.deviceId, deviceName: d.deviceName, lanHost: false, localEditor: false };
  }
  /*
   * 局域网里的设备（「局域网里的第二块屏」：手机、平板打开主机的页面）问不到这个接口 ——
   * 除素材服务外的 `/api/**` 只答回环（`server/vite-plugin-api-guard.ts`），它们拿到的是 403。
   * 那就用页面自己的那一份身份，和在线浏览器同一条路（`src/online/device.ts`）：这台设备本来也没有
   * 编辑器进程，`localEditor` 为假。2026-10-26 端到端探针照出来的：不退回的话这些设备连不进共享项目。
   */
  const onLoopback = isLoopbackHost(location.hostname);
  const browserDevice = (): DeviceInfo => {
    const d = loadBrowserDevice();
    return { deviceId: d.deviceId, deviceName: d.deviceName, lanHost: false, localEditor: false };
  };
  try {
    const r = await fetch("/api/docservice/device", { cache: "no-store" });
    if (!r.ok) return onLoopback ? null : browserDevice();
    const j = await r.json();
    if (!j?.ok) return onLoopback ? null : browserDevice();
    return { deviceId: j.deviceId, deviceName: j.deviceName, lanHost: !!j.lanHost, localEditor: onLoopback };
  } catch {
    return onLoopback ? null : browserDevice();
  }
}

/* ---------------- 本地备份 ---------------- */

/**
 * 在线页面的本地备份只留在本页内存里(C10 契约第 10 节、第 18 节第 4 条;`onlineBackups.ts`):
 * 不写浏览器存储、不自动下载,关页面即丢。桌面照旧写编辑器进程的 `/api/project-backups`。
 */
const onlineBackupStore: OnlineBackups = createOnlineBackups({ projectName: () => getState().project.name });
onlineBackupStore.subscribe(() => patch({ onlineBackups: onlineBackupStore.list().length }));

export function onlineBackups(): OnlineBackups {
  return onlineBackupStore;
}

/**
 * 在线页面:存进内存,当场给「下载备份」按钮。
 * - 被覆盖:一条不打断操作的提示(气泡,10 秒后自己消失;面板里仍能下载);
 * - 丢弃离线修改:用户刚在对话框里点了「不要了」,气泡留着直到用户关。
 */
function saveOnlineBackup(b: LocalBackup) {
  const index = onlineBackupStore.save(b);
  const action = { label: "下载备份", pc: "backup-download", run: () => { onlineBackupStore.download(index); } };
  if (b.kind === "overwritten") {
    const what = entityLabel(b.entity, getState().project);
    pushToast(`${what}被别人覆盖了，你之前那一版已留在本页。关闭页面前可以下载备份。`, "info", 10_000, action);
  } else {
    pushToast(`已丢弃 ${b.batch.length} 步离线时的修改，这些修改已留在本页。关闭页面前可以下载备份。`, "warn", Infinity, action);
  }
}

async function saveBackup(b: LocalBackup) {
  // 离线批次逐项转进待合并表时的那一下整批回退:内容在待合并表里,这份只是安全网,不弹「已丢弃」(在线页面留在本页内存里)
  const quiet = b.kind === "offline-discard" && transferringBatch;
  if (quiet) {
    if (ONLINE) { onlineBackupStore.save(b); return; }
  } else if (ONLINE) {
    saveOnlineBackup(b);
    return;
  }
  const project = getState().project;
  const body =
    b.kind === "offline-discard"
      ? { ...b, projectName: project.name, pageSession: session, batch: b.batch.map((x) => ({ ...x, entities: entitiesOf(x.ops) })) }
      : { ...b, projectName: project.name, pageSession: session };
  try {
    const r = await fetch("/api/project-backups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    // 存不下来也要让用户知道:不能让他以为备份在那儿(转表时的安全网除外:内容在待合并表里)
    if (!quiet) pushToast(`本地备份没存下来(${(e as Error).message}),被覆盖的那一版找不回了。`, "warn", 10_000);
  }
}

/* ---------------- 远端改动描边 ---------------- */

const FLASH_MS = 1500;

function flashEntities(entities: string[]) {
  if (typeof document === "undefined") return;
  const ids = new Set<string>();
  const project = getState().project;
  for (const e of entities) {
    const clip = clipOfEntity(e);
    if (clip) ids.add(clip);
    const track = /^\/tracks\/@([^/]+)$/.exec(e);
    if (track) for (const c of project.tracks.find((t) => t.id === track[1])?.clips ?? []) ids.add(c.id);
  }
  if (!ids.size) return;
  // 等这次改动渲染出来再找元素(新插进来的片段这时才有 DOM)。用计时器不用 rAF:页面在后台时 rAF 不跑
  setTimeout(() => {
    for (const id of ids) {
      for (const el of document.querySelectorAll<HTMLElement>(`[data-clip-id="${CSS.escape(id)}"]`)) {
        el.setAttribute("data-remote-flash", "");
        const prev = Number(el.dataset.remoteFlashTimer || 0);
        if (prev) clearTimeout(prev);
        el.dataset.remoteFlashTimer = String(
          setTimeout(() => {
            el.removeAttribute("data-remote-flash");
            delete el.dataset.remoteFlashTimer;
          }, FLASH_MS),
        );
      }
    }
  }, 30);
}

/* ---------------- 绑定 ---------------- */

function onNotice(n: SyncNotice) {
  switch (n.kind) {
    case "undo":
    case "revert-remote": {
      const r = n.result;
      if (!r.skipped.length && !r.failed.length) return;
      // 别人在它基础上又改过的:按修改项细分,没被改过的直接撤,真冲突的进「冲突合并」窗口(2026-10-18 用户定);
      // 提示条只留「已不存在、没法退回」的
      const routed = r.skipped.length > 0 && r.conflict !== undefined && routeUndoConflict(r.conflict);
      const shown = routed ? { ...r, skipped: [] } : r;
      if (!shown.skipped.length && !shown.failed.length) return;
      patch({ notice: { id: ++noticeSeq, kind: n.kind === "undo" ? (n.redo ? "redo" : "undo") : "agent", result: shown, project: getState().project } });
      return;
    }
    case "overwritten": {
      // 文案按交互稿第 5 节,「找回入口待裁定」换成裁定定下的入口(c65-design.md 第 8 节)
      const who = writerLabel(n.by, me(), displayNames());
      pushToast(`你的近期修改已被 ${who} 覆盖。已将你修改的版本存入草稿备份（「项目」菜单 →「本地备份…」可找回）。`, "warn", 10_000);
      return;
    }
    case "remote":
      flashEntities(n.entities);
      return;
    case "rejected":
      pushToast(`有一步修改没被文档服务接受(${n.reason}),已撤回。`, "warn");
      return;
    case "replay-dropped":
      pushToast("有一步离线时的修改在最新历史序号上落不下去,已丢弃。", "warn");
      return;
    default:
      return;
  }
}

function refreshStatus() {
  if (!cur) return;
  const ds = cur.link.ds;
  // 离线批次被拒、停下:逐项转进待合并表(转不了才退回整份处理的离线对话框)
  if (ds.status === "paused" && mergeTable && !transferringBatch) transferOffline(cur.link);
  const status = ds.status;
  const paused = ds.pausedInfo;
  patch({ status, paused, offlineOpen: status === "paused" ? view.offlineOpen || view.status !== "paused" : false });
  attachMergeChannel(status === "online" ? cur.link : null);
  if (ONLINE) tickOnline();
}

/*
 * 在线页面:未确认的提交条数与恢复阶段(C10 契约第 10 节)。DocSync 不为「未确认条数变了」发事件,
 * 这里每 500 ms 看一眼(只在变了时才更新界面状态);状态变化时 `refreshStatus` 也顺带看一次。
 */
export const ONLINE_TICK_MS = 500;
let recoveryState: { phase: "recovering" | "recovered" | null; wasOffline: boolean; hadUnsent: boolean } = { phase: null, wasOffline: false, hadUnsent: false };
/** 这一轮的离线改动存不住(浏览器给不了存储,或写失败):气泡只在这两种时候说,口令房间那种「本来就不落盘」不说 */
let journalUnstorable = false;
/** 那句气泡这一轮说过了没有(常驻提示一直挂着,气泡出一次就够) */
let noStoreToasted = false;
let recoveredTimer: ReturnType<typeof setTimeout> | null = null;

function tickOnline() {
  if (!cur) return;
  const ds = cur.link.ds;
  const unconfirmed = ds.unconfirmed;
  const prevPhase = recoveryState.phase;
  recoveryState = nextRecovery(recoveryState, ds.status, unconfirmed);
  if (recoveryState.phase === "recovered" && prevPhase !== "recovered") {
    if (recoveredTimer) clearTimeout(recoveredTimer);
    recoveredTimer = setTimeout(() => {
      recoveredTimer = null;
      if (recoveryState.phase === "recovered") recoveryState = { ...recoveryState, phase: null };
      patch({ recovery: null });
    }, RECOVERED_SHOW_MS);
  }
  if (unconfirmed !== view.unconfirmed || recoveryState.phase !== view.recovery) patch({ unconfirmed, recovery: recoveryState.phase });
  // 存不住、又真攒下了没提交的改动:弹一次气泡说清为什么(常驻提示只说「在哪」)
  if (journalUnstorable && !noStoreToasted && unsentAtRisk(ds.status, unconfirmed, view.offlineStore)) {
    noStoreToasted = true;
    pushToast(UNSENT_NO_STORE_TOAST, "warn", 12_000);
  }
}

/* ---------------- Agent 服务端的项目副本:绑定与解绑在 `agentSideBinding.ts`,这里只答它要的票据 ---------------- */

/**
 * SSE 里的 `agent.ticket`:Agent 服务端要一张 agent 角色的连接票据(k:'conn', r:'agent', c:对话号)。
 * 在本页面这条共享项目的连接上签(身份与本页面相同),交回 POST /api/agent/ticket。
 */
export async function issueAgentTicket(req: { reqId?: unknown; projectId?: unknown; conversation?: unknown }): Promise<void> {
  if (ONLINE) return; // Agent 服务端在编辑器进程里,在线页面没有
  const reqId = typeof req.reqId === "string" ? req.reqId : null;
  if (!reqId) return;
  let reply: Record<string, unknown>;
  try {
    if (!cur || cur.kind !== "shared" || cur.docProjectId !== req.projectId) throw new Error("本页面没有连着这个共享项目");
    const r = await cur.link.request({ type: "auth.ticket", kind: "conn", role: "agent", conversation: Number(req.conversation) });
    if (r.type !== "auth.ticket.ok" || typeof r.ticket !== "string") throw new Error(String(r.reason ?? r.detail ?? r.type));
    reply = { reqId, ticket: r.ticket };
  } catch (e) {
    reply = { reqId, error: (e as Error).message };
  }
  await fetch("/api/agent/ticket", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reply) }).catch(() => undefined);
}

/**
 * 卡片源码同步(C6.6 第 5 节,`cardSync.ts`):编辑器进程要 page 角色的连接票据时在本页面的共享项目连接上签;
 * 提示走同一套气泡,写入身份按成员名单显示。
 */
const cardSyncHooks = {
  ticket: async (projectId: string): Promise<string> => {
    if (!cur || cur.kind !== "shared" || cur.docProjectId !== projectId) throw new Error("本页面没有连着这个共享项目");
    const r = await cur.link.request({ type: "auth.ticket", kind: "conn", role: "page" });
    if (r.type !== "auth.ticket.ok" || typeof r.ticket !== "string") throw new Error(String(r.reason ?? r.detail ?? r.type));
    return r.ticket;
  },
  toast: (text: string, tone: Toast["tone"], ms?: number) => pushToast(text, tone, ms),
  who: (actor: Record<string, unknown> | null | undefined) =>
    actor ? writerLabel({ actor, session: typeof actor.session === "string" ? actor.session : undefined }, me(), displayNames()) : "别人",
  // 断网期间改过、云端也被别人改过的卡:一张卡一条进「冲突合并」(本机已换成云端的版本,我的版本在表里,另有备份)
  conflict: (c: { key: string; mine: string; cloud: string; rev: number }) => {
    const table = mergeTable;
    if (!table) return false;
    void table.add([cardConflictThing({ key: c.key, mine: c.mine, cloud: c.cloud, rev: c.rev, at: Date.now(), batch: newBatchId() })]);
    patch({ mergeOpen: true });
    return true;
  },
};

/**
 * 桌面应用自动成为共享项目的渲染节点(`renderNodeHandoff.ts`):预渲染进程建新会话时要的 render 连接票据,
 * 在本页面的共享项目连接上签(`owner: { kind: 'user' }`:这是用户自己的桌面节点,能认领本项目任何成员的任务)。
 */
const renderNodeHooks = {
  ticket: async (projectId: string): Promise<string> => {
    if (!cur || cur.kind !== "shared" || cur.docProjectId !== projectId) throw new Error("本页面没有连着这个共享项目");
    const r = await cur.link.request({ type: "auth.ticket", kind: "conn", role: "render", owner: { kind: "user" } });
    if (r.type !== "auth.ticket.ok" || typeof r.ticket !== "string") throw new Error(String(r.reason ?? r.detail ?? r.type));
    return r.ticket;
  },
};

/**
 * 云端 Agent 的身份(契约 `docs/plan/cloud-agent-contract.md` 第 4.2 节):委托票据与对话委托都在本页面这条共享项目的连接上要
 * (`auth.ticket { kind: 'delegate', audience: 'agent', conversation? }`),身份与权限就是本页面这位成员的。在线页面与桌面版同一条路。
 * 票据不缓存(委托票据只活 2 分钟,每个请求现取;对话委托每发一条消息取一张新的)、不进日志。
 * 连接换了(离开项目、换项目)这份身份就作废:之后再要直接拒,不会拿到别的项目的票据。
 */
function cloudIdentityOf(link: SyncLink): CloudIdentity {
  const ask = async (conversation?: string): Promise<string> => {
    if (!cur || cur.link !== link || cur.kind !== "shared") throw new CloudDelegationError("closed");
    let r: AnyMsg;
    try {
      r = await link.request({ type: "auth.ticket", kind: "delegate", audience: "agent", ...(conversation ? { conversation } : {}) });
    } catch {
      throw new CloudDelegationError("closed");
    }
    if (r.type !== "auth.ticket.ok" || typeof r.ticket !== "string" || !r.ticket) throw new CloudDelegationError(String(r.reason ?? r.type));
    return r.ticket;
  };
  return { getTicket: () => ask(), getGrant: (conversationId) => ask(conversationId) };
}

/** 留在页面的 Agent 工具执行前记个位置,执行后取这期间本页面发出的提交(回包里带 opIds,server/agent/agent-side.mjs 用) */
export function pageOpMark(): number | null {
  return cur ? cur.link.ds.opMark() : null;
}

export function pageOpIdsSince(mark: number | null): string[] {
  if (!cur || mark === null) return [];
  return cur.link.ds.opIdsSince(mark);
}

function bind(link: SyncLink, kind: "local" | "shared", docProjectId: string, url: string, accountClient: CloudAccountClient | null = null, mergeUser: string | null = kind === "local" ? "local" : null) {
  const account = accountClient !== null;
  const prev = cur;
  if (!account) accountNames = new Map();
  if (prev) {
    for (const off of prev.offs) off();
    prev.unbind();
  }
  const unbind = bindStore(link.ds, { load: onLoad });
  let seenProject: Project | null = null;
  const offs = [
    link.ds.on("status", () => refreshStatus()),
    link.ds.on("notice", onNotice),
    // 卡片源码同步:项目用到的卡变了(时间轴上添了卡)再报一次(C6.6 第 5 节)
    subscribe(() => {
      const p = getState().project;
      if (p === seenProject) return;
      seenProject = p;
      noteProjectForCardSync(p);
      // 自动渲染节点:项目文档的 id(层表键用它)晚到时再交一次(同一个项目只换 id,不重建)
      if (!account && kind === "shared" && !ONLINE_BUILD && !ONLINE) bindRenderNode({ url, projectId: docProjectId, contentId: p.id || null }, renderNodeHooks);
    }),
    link.ds.on("project", () => { patch({ rev: link.ds.rev }); }),
    link.ds.on("status", () => { patch({ rev: link.ds.rev }); }),
  ];
  if (ONLINE) {
    recoveryState = { phase: null, wasOffline: false, hadUnsent: false };
    const tick = setInterval(tickOnline, ONLINE_TICK_MS);
    offs.push(() => clearInterval(tick));
  }
  cur = { link, kind, docProjectId, url, unbind, offs };
  bindMergeTable(docProjectId, mergeUser);
  // 账号云端项目(在线浏览器与桌面版都是):断网期间的修改落盘到浏览器本地缓存(旧办法的协作房间在桌面版另有本机恢复文件)
  if (mergeUser && account) offs.push(watchBrowserJournal(link, docProjectId, mergeUser));
  // 离线改动存在哪:账号项目落盘到浏览器本地缓存、桌面版有本机恢复文件 → 本机;在线页面的口令房间不落盘 → 只在本页。
  // 这台浏览器连 IndexedDB 和 localStorage 都给不了(隐私模式、存储被禁)时,缓存退到内存版、写进去不报错,
  // 那一份关页面就没 —— 一律算「只在这个页面里」,别让假的「已存在本机」把提示和离开确认都瞒过去
  journalUnstorable = !defaultStoreDurable();
  noStoreToasted = false;
  patch({ offlineStore: offlineStoreOf({ durable: !journalUnstorable, account, online: ONLINE }) });
  // 云端 Agent 的身份跟着共享项目的连接走:接上就绪,回本机空间撤掉(界面据此重取一次 info 与对话列表)
  setCloudIdentity(kind === "shared" && !account ? cloudIdentityOf(link) : null);
  setCloudConsentSource(kind === "shared" && accountClient ? { client: accountClient, accountId: accountClient.principal?.id ?? "" } : null);
  if (kind !== "shared") clearHostedAgent();
  if (kind === "shared" && !ONLINE_BUILD && !ONLINE) {
    const descriptor = currentAssociation();
    if (descriptor) offs.push(link.ds.on("project", () => persistJournal(link.ds, descriptor, getState().project.id ?? "")));
    if (descriptor?.where === "lan") {
      const checkHost = () => { void recoveryRequest("host-state", descriptor).then(r => { if (cur?.link === link) patch({ hostRegistration: r.state === "inactive" ? null : r.state }); }, () => { if (cur?.link === link) patch({ hostRegistration: "pending" }); }); };
      checkHost(); const timer = setInterval(checkHost, 2000); offs.push(() => clearInterval(timer));
    }
  }
  // 在场状态(A3 第二阶段):这个页面「正在编辑」的片段经这条连接发布,别的成员那边 Agent 的范围经它收
  setPresenceLink(link, docProjectId, me().userId ?? "", account);
  patch({ active: true, kind, rev: link.ds.rev, members: kind === "local" ? [] : view.members, hosted: kind === "local" ? null : view.hosted, notice: null });
  refreshStatus();
  // Agent 服务端与卡片源码同步都在编辑器进程里;在线页面没有编辑器进程(C10a 第 2 节),不去绑(在线构建里连同 /api/agent/bind、/api/cards/sync/bind 剪掉)
  if (!account && !ONLINE_BUILD && !ONLINE) {
    bindAgentSide(kind, docProjectId, url);
    bindCardSync({ kind, projectId: docProjectId, url }, getState().project, cardSyncHooks);
    /*
     * 桌面应用自动成为共享项目的渲染节点(语义 product/platforms.md「渲染节点」;`renderNodeHandoff.ts`):
     * 离开共享项目(回本机空间、取消协作、换开别的项目)撤掉;接上共享项目把共享配置交给预渲染进程。
     * 页面刚打开时先接本机空间(prev 为空)不算离开:别的标签页或上一次打开时交过的配置不动。
     */
    if (prev?.kind === "shared" && (kind !== "shared" || prev.docProjectId !== docProjectId)) unbindRenderNode(prev.docProjectId, kind === "shared" ? "switched" : "left");
    if (kind === "shared") bindRenderNode({ url, projectId: docProjectId, contentId: getState().project.id || null }, renderNodeHooks);
  }
  // 账号云端项目(桌面版):解掉 Agent 服务端留着的旧绑定,卡片源码同步凭账号办法的票据接上(渲染节点这次不接)
  if (accountClient && !ONLINE_BUILD && !ONLINE) bindAccountEditorSide(link, docProjectId, url, accountClient);
  if (prev && prev.link !== link) retire(prev.link);
}

/**
 * 桌面版进账号云端项目时编辑器进程那一侧要做的事(渲染节点不在内):
 * - Agent 服务端:账号项目里不绑(本机 Agent 走「页面代做」),但上一个项目留在服务端的绑定要解掉(`agentSideBinding.ts`);
 * - 卡片源码同步:编辑器进程要票据时,页面凭登录另取一份项目会话,交出其中的连接票据(`accountCardSync.ts`)。
 */
function bindAccountEditorSide(link: SyncLink, docProjectId: string, url: string, client: CloudAccountClient) {
  releaseAgentSide();
  const accountId = client.principal?.id;
  bindCardSync({ kind: "shared", projectId: docProjectId, url, account: true }, getState().project, {
    ...cardSyncHooks,
    ticket: accountCardTicket({
      session: (projectId) => client.session(projectId),
      isCurrent: () => cur?.link === link && !!accountId && client.principal?.id === accountId,
      stop: detachCardSync,
    }),
  });
}

/** 在线页面离开共享项目:没有本机文档服务可回,解开当前连接,store 回到快照栈(C10a) */
function detach() {
  const prev = cur;
  cur = null;
  bindMergeTable(null, null);
  accountNames = new Map();
  setCloudIdentity(null);
  setCloudConsentSource(null);
  setCloudAssociation(null);
  clearHostedAgent();
  setPresenceLink(null, null, "");
  if (prev) {
    for (const off of prev.offs) off();
    prev.unbind();
    retire(prev.link);
    if (prev.kind === "shared" && !ONLINE_BUILD && !ONLINE) unbindRenderNode(prev.docProjectId, "left");
    if (!ONLINE_BUILD && !ONLINE) {
      // 账号项目进来时已经解过 Agent 服务端的绑定,这里只解卡片源码同步
      if (!view.shared?.accountId) releaseAgentSide();
      detachCardSync();
    }
  }
  patch({ active: false, kind: "off", status: "idle", paused: null, offlineOpen: false, notice: null, unconfirmed: 0, recovery: null, hostRegistration: null });
}

/** 换下来的连接:等它手里没确认的提交落地(最多 5 s)再关 */
function retire(link: SyncLink) {
  link.ds
    .whenSettled({ timeoutMs: 5000 })
    .catch(() => undefined)
    .finally(() => link.stop());
}

function newLocalLink(docProjectId: string, initial: Project): SyncLink {
  const link: SyncLink = new SyncLink({
    url: localWsUrl(),
    protocols: () => ["promptcut.v1"],
    projectId: docProjectId,
    session,
    initial,
    saveBackup: (b) => void saveBackup(b),
    onMessage: onSideMessage,
    // 连上后补一次最近的工具调用记录(AI 栏的操作记录;文档服务按项目在内存里留最近 500 条)
    onOpen: () => void link.send({ type: "events.list", projectId: docProjectId }),
  });
  return link;
}

/** 切到本机空间里的这个项目;`load` 为真时把这份内容以根替换写进去(文件内容为准) */
function switchToLocal(project: Project, { load }: { load: boolean }): Project {
  if (ONLINE) {
    // 在线页面没有本机空间:离开共享项目就是断开(C10a 第 2 节)
    detach();
    patch({ shared: null, members: [], hosted: null, blocked: null });
    disconnectSharedAssets();
    return project;
  }
  const id = project.id || "untitled";
  const link = newLocalLink(id, project);
  if (load) link.ds.load(project);
  bind(link, "local", id, localWsUrl());
  patch({ shared: null, members: [], hosted: null, blocked: null });
  // C6.6:回到本机空间 = 回到本地素材服务
  disconnectSharedAssets();
  link.start();
  return link.ds.project;
}

/** store 的载入(loadProject)交到这里:同一个本机项目是根替换,别的项目换连接 */
function onLoad(project: Project): Project {
  const previousAssociation = currentAssociation();
  identitySave = null; lastIdentity = null;
  releaseHolding();
  recoveryCoordinator.cancel();
  cancelHostTask(previousAssociation);
  const association = takeLoadedAssociation(project);
  const cloudAssoc = takeLoadedCloudAssociation(project);
  patch({ association, reopenState: null, rev: cur?.link.ds.rev ?? null });
  if (cloudAssoc) {
    detach(); disconnectSharedAssets();
    setCloudAssociation(cloudAssoc);
    void handleCloudAssociationReopen(project, cloudAssoc, {
      toast: pushToast,
      // 「不是成员」那条带「发送申请」的提示,发成了要关掉(recoveryAssociation.ts 的 notMemberToast)
      dismissToast,
      openAsLocal: (p) => { switchToLocal(p, { load: false }); },
      enterProject: async (opts) => {
        await enterAccountProject(opts);
        const ds = cur?.link.ds;
        if (!ds || !ds.confirmedProject) return;
        // 固定非本机快照(`cloudSnapshot.ts`):文件里带着另存时的基准,就拿它和文件内容逐项比 ——
        // 云端没人动过直接提交;被别人改过进「冲突合并」,别人后来的改动不会被当成「我撤销的」
        const plan = reopenPlan(cloudAssoc, project, ds.rev, { batch: newBatchId(), at: Date.now() });
        if (plan.kind === "none") return;
        if (plan.kind === "table") {
          if (mergeTable) {
            void mergeTable.add(plan.things);
            patch({ mergeOpen: true });
            return "pending-merge";
          }
        } else if (plan.kind === "commit") {
          ds.mergeOffline(project, ds.rev);
          return;
        }
        // 老文件没有基准:照旧以连回时的云端为基准合上去(有冲突照离线批次办)
        if (JSON.stringify(project) !== JSON.stringify(ds.confirmedProject)) ds.mergeOffline(project, cloudAssoc.savedRev);
      },
    });
    return switchToLocal(project, { load: false });
  }
  if (association) {
    detach(); disconnectSharedAssets();
    patch({ shared: null, members: [], hosted: null, blocked: null });
    holdRecovery(project, association);
    if (started) recoveryCoordinator.start(association, project.id);
    return project;
  }
  if (!started && !cur) return project;
  if (ONLINE && !cur) return project;
  if (cur && cur.kind === "local" && project.id === cur.docProjectId) return cur.link.ds.load(project);
  if (cur?.kind === "shared") clearSharedResume();
  return switchToLocal(project, { load: true });
}

/* ---------------- 刷新之后回到共享项目 ---------------- */

/**
 * 同一个标签页刷新(整页重载)之后,回到刷新前打开的共享项目(C10a r2;语义没写到,按「对用户最小意外」做,待定级)。
 *
 * - 存在 `sessionStorage`:只属于这个标签页,关掉标签页就没了;
 * - 存进入用的候选(项目号、地址、名字、进入方式)、身份与用户名,以及派生出的 `K`
 *   (`client.buildAuthProtocols` 的 `onKey`,「缓存 K,不缓存口令」);不存口令,也不存邀请码;
 * - 主动离开(取消多用户协作、回开始页)、被踢、被移出、项目被删、换开别的项目时清掉;
 * - 连不上(离线、限速、设备信息没取到)时留着,下次刷新再试;凭证不对、项目没了、被踢过就清掉。
 */
const SHARED_RESUME_KEY = "pc.shared.resume";

interface SharedResume {
  candidate: Candidate;
  as: "member" | "creator";
  username: string;
  key: string;
}

function readSharedResume(): SharedResume | null {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(SHARED_RESUME_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const r = hosted.migrateHostedDeep(JSON.parse(raw)) as SharedResume;
    const c = r?.candidate;
    if (!c || typeof c.projectId !== "string" || typeof c.base !== "string" || typeof r.username !== "string" || typeof r.key !== "string" || !r.key) return null;
    if (r.as !== "member" && r.as !== "creator") return null;
    return r;
  } catch {
    return null;
  }
}

function rememberSharedResume(r: SharedResume): void {
  const { access: _access, routeProtocol: _route, originalHost: _host, ...candidate } = r.candidate;
  // Desktop pointers contain no K. A valid legacy K is migrated only after trusted room matching.
  const saved = ONLINE ? { ...r, candidate } : { candidate, as: r.as, username: r.username, key: "device-vault" };
  try { sessionStorage.setItem(SHARED_RESUME_KEY, JSON.stringify(saved)); } catch { /* 存不了:刷新后回开始页 */ }
}

function clearSharedResume(): void {
  try { sessionStorage.removeItem(SHARED_RESUME_KEY); } catch { /* 同上 */ }
}

/** 这个标签页刷新前开着共享项目(还没回去) */
export function hasSharedResume(): boolean {
  return readSharedResume() !== null;
}

/**
 * 回到刷新前打开的共享项目。已经在这个项目里回 true;没有记录回 false。
 * 调用方先把 store 换成一份空项目(同「加入别人的项目」),内容以文档服务为准。
 */
export async function resumeShared(): Promise<boolean> {
  const r = readSharedResume();
  if (!r) return false;
  if (cur?.kind === "shared" && cur.docProjectId === r.candidate.projectId) return true;
  const descriptor = descriptorOf(r.candidate);
  if (view.association?.roomId === descriptor.roomId && holding) return true;
  recoveryCoordinator.cancel(); detach(); disconnectSharedAssets(); releaseHolding();
  setAssociation(descriptor, true); patch({ association: descriptor, shared: null, reopenState: "recovering" });
  holdRecovery(getState().project, descriptor);
  recoveryCoordinator.start(descriptor, getState().project.id);
  return true;
}

/** 回开始页(顶栏「回到首页」)之后再刷新,留在开始页:忘掉这条记录 */
export function forgetSharedResume(): void {
  recoveryCoordinator.cancel();
  cancelHostTask(currentAssociation());
  releaseHolding();
  detach(); disconnectSharedAssets();
  patch({ reopenState: null, shared: null, members: [], hosted: null, blocked: null });
  clearSharedResume();
}

/* ---------------- 其余消息:成员、事件、通知 ---------------- */

const agentOps = new Map<string, AgentOp>();

function asOps(v: unknown): PathOp[] | undefined {
  return Array.isArray(v) && v.length ? (v as PathOp[]) : undefined;
}

/** 工具调用记录:eventId → 记录(插入序,超过上限丢最早的) */
const eventRecords = new Map<string, EventRecord>();
const EVENT_RECORDS_KEEP = 1000;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** 按 eventId 更新一条记录(创建、完成、文字、events.list 的条目都走这里);回合成后的记录 */
function upsertRecord(e: Record<string, unknown>): EventRecord | null {
  const eventId = str(e.eventId);
  if (!eventId) return null;
  const prev = eventRecords.get(eventId);
  const isText = e.phase === "text" || (typeof e.text === "string" && e.tool == null);
  const status = e.status === "ok" || e.status === "error" || e.status === "cancelled" ? e.status : e.phase === "create" ? null : prev?.status ?? null;
  const rec: EventRecord = {
    ...(prev ?? { eventId, kind: isText ? "text" : "tool", status: null }),
    ...(str(e.tool) !== undefined ? { tool: str(e.tool) } : {}),
    ...(e.icon !== undefined ? { icon: (e.icon as string | null) ?? null } : {}),
    ...(e.target !== undefined ? { target: (e.target as string | null) ?? null } : {}),
    ...(e.args !== undefined ? { args: (e.args as string | null) ?? null } : {}),
    ...(str(e.callId) ? { callId: str(e.callId) } : {}),
    ...(e.actor && typeof e.actor === "object" && !prev?.actor ? { actor: e.actor as Record<string, unknown> } : {}),
    ...(e.summary !== undefined ? { summary: (e.summary as string | null) ?? null } : {}),
    ...(typeof e.durationMs === "number" ? { durationMs: e.durationMs } : {}),
    ...(typeof e.at === "number" && prev?.at === undefined ? { at: e.at } : typeof e.createdAt === "number" && prev?.at === undefined ? { at: e.createdAt } : {}),
    ...(typeof e.text === "string" ? { text: e.text } : {}),
    ...(str(e.opId) ? { opId: str(e.opId) } : {}),
    ...(e.detailKey !== undefined ? { detailKey: (e.detailKey as string | null) ?? null } : {}),
    status: isText ? "ok" : status,
  };
  eventRecords.delete(eventId);
  eventRecords.set(eventId, rec);
  while (eventRecords.size > EVENT_RECORDS_KEEP) eventRecords.delete(eventRecords.keys().next().value!);
  return rec;
}

/** AI 栏的操作记录(最新的在前) */
export function eventRecordList(): EventRecord[] {
  return [...eventRecords.values()].reverse();
}

/** 按 eventId 取 AI 栏「撤销这步」要的那条写入记录 */
export function agentOpOfEvent(eventId: string): AgentOp | null {
  return agentOps.get(eventId) ?? null;
}

function rememberEvent(e: Record<string, unknown>) {
  const record = upsertRecord(e);
  if (record) patch({ eventsVersion: view.eventsVersion + 1 });
  const opId = typeof e.opId === "string" ? e.opId : null;
  const eventId = typeof e.eventId === "string" ? e.eventId : null;
  if (!opId || !eventId) return;
  const callId = typeof e.callId === "string" ? e.callId : typeof e.toolCallId === "string" ? e.toolCallId : record?.callId;
  const actor = e.actor as { session?: string } | undefined;
  const prev = agentOps.get(eventId);
  const rec: AgentOp = {
    eventId,
    callId,
    opId,
    inverse: asOps(e.inverse) ?? prev?.inverse,
    rev: typeof e.rev === "number" ? e.rev : prev?.rev,
    by: actor ? { actor, session: actor.session } : prev?.by,
    state: prev?.state === "done" ? "done" : "ready",
  };
  agentOps.set(eventId, rec);
  if (callId) agentOps.set(`call:${callId}`, rec);
  patch({ agentOpsVersion: view.agentOpsVersion + 1 });
}

/**
 * 渲染任务队列推给本页(作为发布方)的完成通知(C10 契约第 7 节:页面订阅 `task.done`,并入层表与就绪)。
 * 发布方自动订阅自己发布的 plan 与它切出的细任务;这里只转,不解释。
 */
const queueEventListeners = new Set<(msg: AnyMsg) => void>();
export function subscribeQueueEvents(cb: (msg: AnyMsg) => void): () => void {
  queueEventListeners.add(cb);
  return () => { queueEventListeners.delete(cb); };
}

function onSideMessage(msg: AnyMsg) {
  if (msg.type === "task.done" || msg.type === "task.failed") {
    for (const l of [...queueEventListeners]) { try { l(msg); } catch { /* 订阅方坏了不影响别人 */ } }
    return;
  }
  switch (msg.type) {
    case "service.endpoints":
      receiveSharedAssetEndpoints(msg.endpoints);
      return;
    case "shared.members.list":
      patch({ members: Array.isArray(msg.devices) ? (msg.devices as MemberRow[]) : [], hosted: parseHosted(msg.hosted) });
      // 托管端有没有云端 Agent、开没开、在哪(顶层 `hosted.agent`,比界面状态多一个 `url`;放本机的项目没有这个字段)
      setHostedAgent(view.shared?.projectId ?? currentDocProjectId(), (msg.hosted as { agent?: unknown } | undefined)?.agent ?? null);
      return;
    case "shared.notice":
      if (msg.event === "password-changed") pushToast("项目密码已被修改。你当前的连接不受影响，但下次进入需要新密码。", "info", 8000);
      // 改密码后选了退出、文档服务撤回了旧设备在那段时间里的修改:此刻在线的成员各一条(不在线的不补)
      if (msg.event === "content-rolled-back") pushToast(rolledBackText(msg.name), "info", 8000);
      // 创建者开关了托管方的服务:界面马上跟着变(紧接着还有一条刷新后的成员列表,以它为准)
      if (msg.event === "hosted-service-changed") {
        const next = applyHostedChange(view.hosted, msg.service, msg.enabled);
        if (next !== view.hosted) {
          patch({ hosted: next });
          const text = HOSTED_SERVICE_TEXT[msg.service as HostedServiceName]?.changed(msg.enabled === true);
          if (text) pushToast(text, "info", 6000);
        }
        // AI 栏里「云端」一项随之置灰或恢复
        if (msg.service === "agent" && typeof msg.enabled === "boolean") setHostedAgentEnabled(view.shared?.projectId ?? currentDocProjectId(), msg.enabled);
      }
      // 创建者改了托管方服务下面的子选项(渲染节点的「生成轨道流」):同上,界面马上跟着变,只在关闭时给别的成员一条提示
      if (msg.event === "hosted-option-changed") {
        const next = applyHostedOptionChange(view.hosted, msg.service, msg.option, msg.enabled);
        if (next !== view.hosted) {
          patch({ hosted: next });
          const text = hostedOptionText(msg.service, msg.option)?.changed(msg.enabled === true);
          if (text) pushToast(text, "info", 6000);
        }
      }
      return;
    case "events.event":
      rememberEvent(msg as Record<string, unknown>);
      return;
    case "events.listing":
      for (const it of Array.isArray(msg.items) ? msg.items : []) rememberEvent(it as Record<string, unknown>);
      return;
    case "presence.update":
    case "presence.state":
    case "presence.message":
      receivePresence(msg as Record<string, unknown>);
      return;
    case "merge.state":
      // 同一用户在别的设备、别的页面改了待合并表
      mergeTable?.receive(msg as { projectId?: unknown; things?: unknown; version?: unknown });
      return;
    default:
      return;
  }
}

/* ---------------- 验收用的钩子(只在开发模式) ---------------- */

if (typeof window !== "undefined" && import.meta.env?.DEV) {
  (window as unknown as { __pcSyncTest?: unknown }).__pcSyncTest = {
    /** 断网 ms 毫秒(离线对话框的验收) */
    drop: (ms: number) => cur?.link.dropFor(ms),
    /** 只断一次传输(会话在保留期内接续;HT-a 的页面验收) */
    cut: () => cur?.link.cutTransport() ?? false,
    /** 当前会话的诊断:实际用的传输、接续次数、未确认字节、是否对着没有会话层的旧服务端 */
    link: () => cur?.link.stats() ?? null,
    /** 交一条文档服务消息给页面(AI 栏「撤销这一步」:事件里的 opId 与 inverse 眼下由 c65-agent 那一路补) */
    inject: (msg: AnyMsg) => onSideMessage(msg),
    view: () => view,
    docProjectId: () => currentDocProjectId(),
    rev: () => cur?.link.ds.rev ?? null,
    agentOp: (callId: string) => agentOpFor(callId),
    /** 账号云端项目:这条连接能用到什么时候、换过几次会话(`accountLinkLife.ts`) */
    accountLife: () => cur?.accountLife?.() ?? null,
    events: () => eventRecordList(),
    /** 交一条卡片源码同步的提示给页面(和编辑器进程经 HMR 送来的同一条路;冲突合并里卡片那一行的验收用) */
    cardNotice: (n: Record<string, unknown>) => receiveCardSyncNotice(n),
    /** 待合并表现在的样子 */
    mergeThings: () => view.merge.things,
  };
}

/* ---------------- 启动 ---------------- */

/** 编辑器挂上时调一次(幂等)。连不上本机文档服务就什么都不接 */
export async function startSync(): Promise<void> {
  if (started) return;
  started = true;
  const q = new URLSearchParams(location.search);
  if (q.has("headless") || isViewOnly()) return;
  const device = view.device ?? (await loadDevice());
  if (!device) return;
  patch({ device });
  // 在线页面没有本机文档服务:只在从开始页进了共享项目之后才接(C10a 第 2 节)
  if (ONLINE) return;
  // 开始页上已经进了共享项目(「加入别人的项目」,C10a 第 4 节):不换回本机空间
  if (cur) return;
  const association = currentAssociation();
  if (association) { recoveryCoordinator.start(association, getState().project.id); return; }
  const join = q.get("join");
  if (join) {
    const link = newLocalLink(join, getState().project);
    bind(link, "local", join, localWsUrl());
    link.start();
    return;
  }
  switchToLocal(getState().project, { load: true });
}

/** `?join=` 打开的页面:内容以文档服务为准,演示卡之类的开场填充不要做 */
export function isJoinPage(): boolean {
  // C10a:从开始页「加入别人的项目」进来的(已经连着共享项目),以及在线页面(只能从加入进编辑器),
  // 内容同样以文档服务为准:编辑器挂上时不塞演示卡,不然每个加入的人都往大家的项目里加一遍
  if (ONLINE || currentAssociation() || cur?.kind === "shared" || hasSharedResume()) return true;
  try {
    return new URLSearchParams(location.search).has("join");
  } catch {
    return false;
  }
}

/* ---------------- 保存 ---------------- */

/** `.proc` 只在所有本地修改都拿到确认之后写(语义「项目文件」);没接文档服务时直接放行 */
export async function whenSaved(timeoutMs = 10_000): Promise<void> {
  if (identitySave) { try { await identitySave; } catch { if (!lastIdentity) throw new Error("协作身份未保存"); identitySave = saveRecoveryIdentity(lastIdentity.descriptor, lastIdentity.record); await identitySave; } }
  if (currentAssociation() && !cur && view.reopenState !== "unsupported") throw new Error("协作身份尚未恢复；请等待主机或重新认证后保存。文件内容已保留。");
  if (!cur) return;
  await cur.link.ds.whenSettled({ timeoutMs });
  const descriptor = currentAssociation();
  if (descriptor && !ONLINE_BUILD && !ONLINE) { persistJournal(cur.link.ds, descriptor, getState().project.id ?? ""); await journalWrite; }
}

/* ---------------- 离线 ---------------- */

export function setOfflineOpen(open: boolean) {
  patch({ offlineOpen: open });
}

export function replayOffline() {
  cur?.link.ds.replayOffline();
  patch({ offlineOpen: false });
  refreshStatus();
}

export function discardOffline() {
  cur?.link.ds.discardOffline();
  patch({ offlineOpen: false });
  refreshStatus();
}


/* ---------------- 冲突合并:待合并表 ---------------- */

/**
 * 当前项目里这位用户的待合并表(`mergeTable.ts`):连上文档服务以它为准,断网时用本机暂存的副本。
 * 用户按「项目 × 用户」:账号项目 `account:<号>`,口令项目 `user:<名>`,本机空间 `local`(与文档服务按连接身份取的同一口径)。
 */
let mergeTable: MergeTable | null = null;
/** 待合并表现在接在哪条连接上(在线才接) */
let mergeAttached: SyncLink | null = null;
/** 正在把离线批次转进待合并表(那一下整批回退不弹「已丢弃」) */
let transferringBatch = false;

function bindMergeTable(docProjectId: string | null, user: string | null) {
  if (mergeTable && mergeTable.projectId === docProjectId && mergeTable.user === user) return;
  mergeTable?.attach(null);
  mergeAttached = null;
  const table: MergeTable | null = docProjectId && user ? new MergeTable({ projectId: docProjectId, user, kv: defaultStore(), onChange: (things) => {
    // 换了项目之后旧表迟到的回调(本机暂存读得慢、旧连接的回包)不算
    if (!table || mergeTable !== table) return;
    patch({ merge: { things, version: view.merge.version + 1, blocked: table.blocked } });
  } }) : null;
  mergeTable = table;
  patch({ merge: { things: mergeTable?.things ?? [], version: view.merge.version + 1, blocked: null }, mergeOpen: false });
}

function attachMergeChannel(link: SyncLink | null) {
  if (!mergeTable || mergeAttached === link) return;
  mergeAttached = link;
  void mergeTable.attach(link ? { request: (msg) => link.request(msg as AnyMsg) } : null);
}

const newBatchId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * 离线批次被拒(断网期间项目被别人改过):基准 → 我这边逐项比出待合并的东西,交给待合并表;DocSync 当场回到云端现状照常同步,
 * 离线修改只留在待合并表里(`product/document-service.md`「离线」:连上后存进该用户的待合并记录)。打开「冲突合并」窗口。
 * 同步做完再等存储:等的这一会儿里的新修改不会被那一下整批回退带走。算不出基准时退回整份处理的离线对话框。
 */
function transferOffline(link: SyncLink) {
  const ds = link.ds, table = mergeTable;
  if (!table || ds.status !== "paused") return;
  const things = offlineThings(ds.recoveryJournal(), { batch: newBatchId(), at: Date.now() });
  if (!things) return;
  transferringBatch = true;
  try {
    ds.discardOffline();
  } finally {
    transferringBatch = false;
  }
  if (things.length) patch({ mergeOpen: true });
  // 在线页面的恢复阶段:离线修改没有提交,转进了待合并表,不能说「离线时的修改已全部提交」
  if (ONLINE) { recoveryState = { phase: null, wasOffline: false, hadUnsent: false }; patch({ recovery: null }); }
  void table.add(things).then((durable) => {
    if (!durable && table.pendingOps) pushToast("离线修改已转进「冲突合并」，但这台设备暂时存不下来；连上文档服务前请不要关闭页面。", "warn", 10_000);
  });
  clearBrowserJournal(link);
}

/**
 * 按撤销(含 AI 栏「撤销这一步」)遇到冲突:被挡住的那几样按修改项细分(`undoConflict.ts`)。
 * 没被别人改过的直接撤(不进撤销栈);别人改过的进这位用户的待合并表(来源 `undo`),打开「冲突合并」窗口。
 * 没接上待合并表(还没连过文档服务)时回 false,退回原来的提示条。
 */
function routeUndoConflict(conflict: NonNullable<UndoResult["conflict"]>): boolean {
  const table = mergeTable, ds = cur?.link.ds;
  if (!table || !ds) return false;
  const plan = undoConflictPlan(ds.project, conflict, { batch: newBatchId(), baseRev: ds.rev, at: Date.now() },
    { manualDuration: getState().durationManual });
  if (plan.direct) {
    try { ds.commitAside(plan.direct); } catch (e) { pushToast(`没撤成：${(e as Error).message}`, "warn"); }
  }
  if (plan.things.length) {
    void table.add(plan.things);
    patch({ mergeOpen: true });
  }
  return true;
}

export function setMergeOpen(open: boolean) {
  patch({ mergeOpen: open });
}

/** 合并、删除选中的结果:给窗口里显示的一句话 */
export interface MergeOutcome { ok: boolean; message: string; stale?: string[] }

/**
 * 「合并」:把选中的二级项照我这边写进项目(一次普通修改,进撤销栈),写成的从待合并表里拿掉。
 * 每次都重新核对:`seen` 是窗口显示时各二级项的云端值,和现在的不一样(窗口打开后又被别人改过)的这次不并,交还给界面刷新再看。
 */
export function mergeSelected(sel: Selection, seen: Map<string, Box>): MergeOutcome {
  const table = mergeTable;
  if (!table || !cur || view.status !== "online") return { ok: false, message: "当前离线，连上后再合并。" };
  const ds = cur.link.ds;
  const things = table.things;
  const stale = staleSelections(ds.project, things, seen, sel);
  const chosen: Selection = new Map();
  for (const [key, props] of sel) {
    const kept = new Set([...props].filter((p) => !stale.includes(`${key}|${p}`)));
    if (kept.size) chosen.set(key, kept);
  }
  const r = applyMerge(ds.project, things, chosen, { manualDuration: getState().durationManual });
  // 卡片源码:交给编辑器进程照我这边的装回并传上去,成了再从表里拿掉(异步;结果另给一句气泡)
  if (r.external.length) void mergeCards(r.external);
  if (r.done.length) {
    try {
      ds.mergeOffline(r.project, ds.rev);
    } catch (e) {
      return { ok: false, message: `没合并成：${(e as Error).message}` };
    }
    void table.remove(r.done);
  }
  const n = r.done.reduce((k, d) => k + (chosen.get(d.key)?.size ? d.props.filter((p) => chosen.get(d.key)!.has(p)).length : 0), 0);
  const parts = [n ? `已合并 ${n} 项。` : r.external.length ? "" : "没有合并任何项。"];
  if (r.external.length) parts.push(`${r.external.length} 张卡片的源码正在照你这边写回去。`);
  if (stale.length) parts.push(`${stale.length} 项在窗口打开后又被别人改过，这次没有合并，请看过现在的值再决定。`);
  if (r.failed.length) parts.push(`${r.failed.length} 项没合并成：${[...new Set(r.failed.map((f) => f.reason))].join("；")}。`);
  return { ok: r.failed.length === 0 && stale.length === 0, message: parts.join(""), stale };
}

async function mergeCards(list: { key: string; props: string[]; thing: MergeThing }[]) {
  for (const x of list) {
    const r = await takeMineCard(x.thing.ref.id, String(x.thing.mine?.v ?? ""));
    if (r.ok) void mergeTable?.remove([{ key: x.key, props: x.props }]);
    else pushToast(`卡片 ${x.thing.ref.id.replace(/^src\//, "")} 没写回去:${r.error ?? ""}`, "warn", 10_000);
  }
}

/** 「删除选中」:从待合并表里拿掉,云端保持现状;断网时也能删(连上后再交给文档服务) */
export function deleteSelected(sel: Selection): MergeOutcome {
  const table = mergeTable;
  if (!table) return { ok: false, message: "没有待合并项。" };
  const list = selectionList(sel);
  const n = list.reduce((k, x) => k + x.props.length, 0);
  void table.remove(list);
  return { ok: true, message: `已删除 ${n} 项，云端保持现状。` };
}

/* ---------------- 浏览器本地缓存里的离线批次 ---------------- */

/**
 * 账号云端项目与在线页面:断网期间的修改(DocSync 的离线批次)落盘到浏览器本地缓存(`offlineCache.ts`,IndexedDB),
 * 关页面、刷新都不丢;再进这个项目时先恢复进来,照常走「第一条带期望版本去试」。都确认了就删掉。
 * 写入合并成每 `BROWSER_JOURNAL_MS` 一次。
 */
export const BROWSER_JOURNAL_MS = 300;
let journalSaved = true;
const journalKey = (projectId: string, user: string) => cacheKey("journal", projectId, user);

function watchBrowserJournal(link: SyncLink, projectId: string, user: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = () => {
    timer = null;
    const ds = link.ds;
    const kv = defaultStore();
    const key = journalKey(projectId, user);
    const job = ds.unconfirmed > 0 && ds.status !== "paused" ? kv.put(key, ds.recoveryJournal()) : ds.status === "online" && ds.unconfirmed === 0 ? kv.delete(key) : null;
    if (!job) return;
    journalSaved = false;
    // 写成了才算「已存在本机」;写不成(配额、隐私模式)如实改说「只在这个页面里」
    job.then(() => { journalSaved = true; if (cur?.link === link) patch({ offlineStore: "saved" }); },
      () => { journalSaved = false; journalUnstorable = true; if (cur?.link === link) patch({ offlineStore: "page" }); });
  };
  const schedule = () => { if (!timer) timer = setTimeout(write, BROWSER_JOURNAL_MS); };
  const offs = [link.ds.on("project", schedule), link.ds.on("status", schedule)];
  // 退出项目时把攒着的那一拍补写出去(不是丢掉):不然离线时最后 300 毫秒内的改动没落盘,
  // 「已存在本机」就不作数,而离开编辑界面时正是照它决定要不要问一句(`TopBar.tsx` 的 okToLeaveOnline)
  return () => { if (timer) { clearTimeout(timer); write(); } for (const off of offs) off(); };
}

function clearBrowserJournal(link: SyncLink) {
  const user = mergeTable?.user;
  if (!user) return;
  void defaultStore().delete(journalKey(link.ds.projectId, user)).catch(() => undefined);
}

/** 进项目前:浏览器本地缓存里有这个项目这位用户上次没交出去的离线批次,恢复进新连接的 DocSync */
async function restoreBrowserJournal(ds: DocSync, user: string): Promise<boolean> {
  try {
    const saved = await defaultStore().get(journalKey(ds.projectId, user));
    if (!saved) return false;
    ds.restoreJournal(saved as Parameters<DocSync["restoreJournal"]>[0]);
    return true;
  } catch {
    return false;
  }
}

/** 浏览器本地缓存里的离线批次最近一次存下了没有(离开页面的确认用) */
export function browserJournalSaved(): boolean {
  return journalSaved;
}

/** 离线对话框里「这段时间项目有以下改动」:谁改了哪些实体 */
export function pausedSummary(): { who: string; what: string[] }[] {
  const since = view.paused?.since ?? [];
  const project = getState().project;
  return since.map((s) => {
    const actor = s.actor as Record<string, unknown> | undefined;
    const entities = (s as { entities?: string[] }).entities ?? (s.paths ?? []).map(entityOfPath);
    return {
      who: writerLabel({ actor, session: s.session ?? (actor?.session as string | undefined) }, me(), displayNames()),
      what: [...new Set(entities.map((e) => entityLabel(e, project)))],
    };
  });
}

/* ---------------- 撤销:跳过去看 ---------------- */

export function jumpToEntity(entity: string) {
  const clip = clipOfEntity(entity);
  const project = getState().project;
  if (clip) {
    const c = project.tracks.flatMap((t) => t.clips).find((x) => x.id === clip);
    if (!c) return;
    actions.select([clip]);
    actions.seek(c.start);
    document.querySelector(`[data-clip-id="${CSS.escape(clip)}"]`)?.scrollIntoView?.({ block: "nearest", inline: "center" });
    return;
  }
  if (entity.startsWith("/meta/")) window.dispatchEvent(new Event("pc-open-project-settings"));
}

/* ---------------- AI 栏「撤销这一步」 ---------------- */

export function agentOpFor(callId: string | undefined): AgentOp | null {
  if (!callId) return null;
  return agentOps.get(`call:${callId}`) ?? agentOps.get(callId) ?? null;
}

/** 撤 Agent 那一步:以本页面身份提交逆操作 + undoOf,进本页面的撤销栈 */
export function revertAgentOp(rec: AgentOp): UndoResult | null {
  if (!cur) return null;
  const ds = cur.link.ds;
  if (!ds.canRevertRemote(rec.opId, rec.inverse)) {
    pushToast("这一步的改动记录不在本页面上,撤不了。", "warn");
    return null;
  }
  const result = ds.revertRemote({ opId: rec.opId, inverse: rec.inverse, rev: rec.rev, by: rec.by });
  if (result.done) {
    rec.state = "done";
    patch({ agentOpsVersion: view.agentOpsVersion + 1 });
  } else if (!result.skipped.length && !result.failed.length) {
    // 既没有被后来的改动挡住的、也没有落不下去的,却一处都没撤成:要说出来,不能让按钮点了没反应
    pushToast("这一步没撤成:它改过的地方现在已经是撤之前的样子(可能已被撤回过),没有需要退回的内容。", "warn");
  }
  return result;
}

/* ---------------- 共享项目 ---------------- */

export type EnterError = "auth" | "rate-limited" | "unreachable" | "no-project" | "kicked" | "not-ready" | "host-data-missing";

export interface EnterCredentials {
  as: "member" | "creator";
  username: string;
  password: string;
  /** 已派生好的 K(C10a:凭邀请码兑换自由进入的项目时服务端回的项目口令 K);给了就不再按密码派生 */
  key?: string;
}

/** 进入失败:原因,限速时另带服务端给的冷却秒数(C10a 表 A「请 {秒数} 秒后再试」) */
export type EnterResult = { ok: true } | { ok: false; error: EnterError; retryAfter?: number | null };

/** Account v2 cloud entry. Server projection wins; no local root upload or legacy password proof. */
export async function enterAccountProject(options: { client: CloudAccountClient; origin: string; projectId: string;
  name: string; initial: Project; firstSession?: ProjectSession;
  /** 进来之后那条带「复制项目链接」的气泡换一句话(账号办法的「搬到云端」用,`accountMoveFlow.ts`);不给是缺省那句 */
  enteredText?: string;
  /**
   * 弹不弹进来之后那条气泡。缺省弹。
   *
   * 从「我的项目」列表点进一个已经加入过的项目时给 false(issue #15):那不是新加入,没有「把链接发给别人」这件事,
   * 而氛围式里来回点几个项目就会叠一摞常驻气泡。新建、凭链接加入、搬到云端照旧弹。
   */
  announce?: boolean;
  /**
   * 换过去的那一刻(云端内容已经到手、编辑器还没接上去)调一次,给的是云端发来的内容;抛错就不换、整次进入失败,编辑器留在原来的项目里。
   * 「搬到云端」用它保证换过去时编辑器里的内容与云端一致(`accountMove.ts` 的 `MoveDeps.enter`)。同步调用,中间没有空当
   */
  guard?: (cloud: Project) => void }): Promise<void> {
  await ensureDevice();
  const origin = new URL(options.origin).origin, base = `${origin}/hosted/`, url = hostedWsUrlOf(base);
  let current = options.firstSession ?? await options.client.session(options.projectId);
  let first = true, stopped = false, renewing: Promise<ProjectSession> | null = null;
  const projectAccountId = options.client.principal?.id;
  const isCurrent = () => !stopped && cur?.link === link && options.client.principal?.id === projectAccountId;
  /** 本页自己正在改托管方服务的开关(改完续会话读到新状态时不给自己弹「创建者关闭了…」) */
  let ownHostedChange = 0;
  const projectSession = (value: ProjectSession) => {
    if (!isCurrent()) return;
    // 账号项目没有 `hosted-service-changed` / `hosted-option-changed` 这两种通知:成员靠每次续会话读到的状态知道创建者改了什么。
    // 与口令项目同一个规矩:只在关闭时给别的成员一条提示,打开时不提示(文案同一处,`hostedChangeNotices`)
    if (ownHostedChange === 0 && view.shared) for (const text of hostedChangeNotices(view.hosted, value.hosted)) pushToast(text, "info", 6000);
    patch({ shared: view.shared ? { ...view.shared, creator: value.creator } : null, hosted: value.hosted });
    setHostedAgent(options.projectId, value.hosted.agent);
    // 自己的权限变了(只读改可写):换一个会话,新连接才写得进去
    if (ready) void life.accessSeen(value.access);
    // 成员有变化(有人加入、被踢、改权限)时重取一次名字
    if (ready && value.accessRevision !== namesRevision) {
      namesRevision = value.accessRevision;
      void options.client.members(options.projectId).then((snapshot: AccountMembersSnapshot) => { if (isCurrent()) accountNamesFrom(snapshot); }, () => { if (namesRevision === value.accessRevision) namesRevision = null; });
    }
  };
  let namesRevision: number | null = null;
  // 会话剩不到 60 秒就续（下面 `ticket.info` 与云端身份两处）。续的时候要让网站登录也至少还剩 70 秒：登录令牌只活 2 分钟，客户端缺省剩 10 秒才续它，
  // 而会话的到期时间跟着登录令牌走；不这样要求的话，最后 50 秒里续出来的会话照样剩不到 60 秒，云端 Agent 每发一个请求就续一次
  // （2026-10-17 实测一分钟最多 50 次 `/account/session`）
  const renew = (): Promise<ProjectSession> => renewing ??= options.client.session(options.projectId, { minRemainingMs: 70_000 }).then((value: ProjectSession) => {
    current = value; projectSession(value); return value;
  }).finally(() => { renewing = null; });
  // 页面这条连接只能用到票据背后的访问令牌到期:到期前换到新会话上,换不成如实转离线(`accountLinkLife.ts`)
  const life = createAccountLinkLife({
    session: ({ minRemainingMs }) => options.client.session(options.projectId, { minRemainingMs }).then((value: ProjectSession) => { current = value; projectSession(value); return value; }),
    link: () => link,
    onTerminal: error => fail(error),
  });
  const protocols = async () => { if (stopped) throw new AccountFailure(401, 'credential-revoked');
    const ticket = await life.ticket(first ? current : null); first = false;
    return accountConnectionProtocols({ connectionTicket: ticket } as ProjectSession); };
  const ticket = Object.assign(async () => (await ticket.info())?.ticket ?? null, {
    info: async ({ force = false }: { force?: boolean } = {}) => {
      if (stopped || cur?.link !== link) return null;
      if (force || current.expiresAt <= Date.now() + 60_000) await renew();
      if (stopped || cur?.link !== link) return null;
      return { ticket: current.assetTicket, exp: current.expiresAt };
    },
  });
  let ready = false;
  let resolveEntry!: () => void, rejectEntry!: (error: unknown) => void;
  const opened = new Promise<void>((resolve, reject) => { resolveEntry = resolve; rejectEntry = reject; });
  const fail = (error: unknown) => { stopped = true; link.stop(); if (cur?.link === link) { setCloudConsentSource(null); setCloudIdentity(null);
    // 登录失效、被踢、项目没了:编辑器进程那条卡片源码同步的连接一起停(回本机空间,不再向本页面要票据)
    if (!ONLINE_BUILD && !ONLINE) detachCardSync();
    if (error instanceof AccountFailure && error.status === 403 && ['banned', 'not-listed'].includes(error.code))
      patch({ blocked: error.code === 'banned' ? 'kicked' : 'removed' });
  } if (!ready) rejectEntry(error);
    else { disconnectSharedAssets(); pushToast(error instanceof Error ? error.message : '云端登录已失效，请重新登录。', 'warn', Infinity); } };
  const link = new SyncLink({ url, projectId: options.projectId, initial: options.initial, initialize: false, session,
    // 接续不带票据:文档服务规定接续项旁边不能有鉴权项(带了握手回 400,只能白等保留期过完再重建会话);
    // 接续时服务端按会话里记下的身份重新核对登录与成员资格。票据只在建新会话时出示(`protocols`)
    protocols,
    saveBackup: b => void saveBackup(b), onMessage: onSideMessage,
    // 服务端关连接的码不当终局(可写改只读时也是 4003):退避着凭新票据重连,取票据的接口说不行才收场 ——
    // 401 登录失效、403 被踢 / 不在名单、404 项目没了(文案用客户端里已有的那句「这个云端项目已不存在。」)
    isFatalClose: () => false,
    onProtocolError: error => { const e = error as { status?: number }; if (e.status === 401 || e.status === 403) { fail(error); return true; }
      if (e.status === 404) { fail(new AccountFailure(404, 'project-gone')); return true; }
      pushToast(error instanceof Error ? error.message : '云端服务暂时不可用，正在等待重连。', 'warn'); return false; },
    onAuthExpired: () => { void life.authExpired(); },
    onOpen: () => { life.opened(); void (async () => {
      // 重新建成会话(断线重连、到期前换会话):进项目时接好的东西都还在,只把跟着连接走的那几样在新连接上重建 ——
      // 选区与在场(`resyncPresenceLink`)、工具调用记录(`events.list`);发布方登记由 `SyncLink.renew` 自己重报;
      // 其余(素材票据、成员名单、云端 Agent 的身份、卡片源码同步)不走这条连接。清单见 `docs/reports/AGENT-v18-cardsync.md`
      if (ready) { if (!stopped && cur?.link === link) { resyncPresenceLink(); link.send({ type: 'events.list', projectId: options.projectId }); refreshStatus(); } return; }
      await sharedStateReady(link);
      if (stopped) return;
      // 以谁的身份进:账号或游客(`client.principal`)。原先看 `client.account`,游客那里必是 null,
      // 游客点自己的项目必报「请先登录账号。」(claude/guest-enter,0.7.21 线上实测)
      const account = options.client.principal;
      if (!account) throw new AccountFailure(401, 'login-required');
      options.guard?.(link.ds.project);
      recoveryCoordinator.cancel(); releaseHolding(); setAssociation(null); clearSharedResume();
      setCloudAssociation({
        accountProject: true,
        projectId: options.projectId,
        docServiceUrl: base,
        origin,
        savedRev: link.ds.rev,
        savedAt: new Date().toISOString(),
      });
      patch({ shared: { projectId: options.projectId, name: options.name, mode: 'free', where: 'hosted', base,
        username: account.name, accountId: account.id, creator: current.creator, access: current.access ?? 'rw' },
        members: [], hosted: current.hosted, blocked: null, association: null, reopenState: null });
      bind(link, 'shared', options.projectId, url, options.client, `account:${account.id}`);
      projectSession(current);
      setCloudIdentity(accountCloudIdentity({ projectId: options.projectId, isCurrent, session: async () => {
        if (current.expiresAt <= Date.now() + 60_000) await renew();
        return current;
      } }));
      if (cur?.link === link) cur.accountLife = () => life.describe();
      if (cur?.link === link) cur.setAccountAgentEnabled = async enabled => {
        if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
        await renew();
        if (!isCurrent() || !current.creator) throw new AccountFailure(403, 'creator-required');
        await options.client.setAgentEnabled(options.projectId, enabled, current.accessRevision, crypto.randomUUID());
        await renew();
      };
      if (cur?.link === link) cur.setAccountHosted = async change => {
        if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
        ownHostedChange += 1;
        try {
          await renew();
          if (!isCurrent() || !current.creator) throw new AccountFailure(403, 'creator-required');
          try {
            if ('option' in change) await options.client.setHostedOption(options.projectId, change.service, change.option, change.enabled, current.accessRevision, crypto.randomUUID());
            else await options.client.setHostedService(options.projectId, change.service, change.enabled, current.accessRevision, crypto.randomUUID());
          } catch (error) {
            // 被拒(例如不在「生成轨道流」的权限分组)或没做成:马上再读一次会话,开关与置灰照服务器的真实状态,
            // 不等下一次定时续会话;读不到也照样把原来的错误交给界面明说
            await renew().catch(() => undefined);
            throw error;
          }
          await renew();
        } finally { ownHostedChange -= 1; }
      };
      if (cur?.link === link) {
        // 作废并重新生成项目链接、项目二级密码(10-14 第 3.3 节):与上面的开关同一个规矩 —— 先续一次会话拿到当前的访问版本号
        // (账本按它防并发改动,写死 0 会被拒成 409),改完再续一次,让页面手里的版本号与链接口令跟上
        cur.regenAccountLink = async () => {
          if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
          await renew();
          if (!isCurrent() || !current.creator) throw new AccountFailure(403, 'creator-required');
          const out = await options.client.regenProjectLink(options.projectId, current.accessRevision, crypto.randomUUID());
          await renew().catch(() => undefined);
          return projectLink(origin, options.projectId, out.linkToken);
        };
        cur.setAccountSecondaryPassword = async password => {
          if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
          await renew();
          if (!isCurrent() || !current.creator) throw new AccountFailure(403, 'creator-required');
          await options.client.setSecondaryPassword(options.projectId, password, current.accessRevision, crypto.randomUUID());
          await renew().catch(() => undefined);
        };
        cur.accountLink = () => projectLink(origin, options.projectId, current.creator ? current.linkToken ?? undefined : undefined);
      }
      if (cur?.link === link) {
        cur.accountMembers = async () => {
          if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
          try {
            const snapshot = await options.client.members(options.projectId);
            if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
            return snapshot;
          } catch (error) {
            if (error instanceof AccountFailure && (error.status === 401 || error.code === 'banned' || error.code === 'not-listed')) fail(error);
            throw error;
          }
        };
        cur.accountMemberAdmin = async operation => {
          if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
          const result = await options.client.memberAdmin(options.projectId, operation);
          if (!isCurrent()) throw new AccountFailure(401, 'credential-revoked');
          return result;
        };
      }
      if (cur?.link === link) {
        // 每 3 秒看一眼连接到期没有(本机算，不发请求)；续会话(读创建者改过的服务开关、自己的权限、成员变化)
        // 每 15 秒一次，会话快到期时随时续。原来每 3 秒无条件续一次，2 分钟 34 次 `/account/session`(2026-10-19 在线实测)，
        // 文档服务每次都要签三张票据
        let lastRenew = Date.now();
        const metadataTimer = setInterval(() => {
          if (!isCurrent()) return;
          if (Date.now() - lastRenew >= ACCOUNT_METADATA_RENEW_MS || current.expiresAt <= Date.now() + 60_000) {
            lastRenew = Date.now();
            void renew().catch((error: unknown) => { if (error instanceof AccountFailure && (error.status === 401 || error.status === 403)) fail(error); });
          }
          void life.tick();
        }, 3000);
        cur.offs.push(() => clearInterval(metadataTimer));
        // 页面回到前台、网络恢复、电脑睡眠醒来:不等定时器(后台标签页的定时器会被浏览器压到一分钟一次),当场看一眼连接到期没有
        const wake = () => { if (isCurrent() && (typeof document === "undefined" || document.visibilityState !== "hidden")) void life.tick(); };
        if (typeof window !== "undefined") {
          window.addEventListener("online", wake); window.addEventListener("focus", wake); window.addEventListener("pageshow", wake);
          document.addEventListener("visibilitychange", wake);
          cur.offs.push(() => { window.removeEventListener("online", wake); window.removeEventListener("focus", wake); window.removeEventListener("pageshow", wake); document.removeEventListener("visibilitychange", wake); });
        }
      }
      await connectSharedAssets(link, base, { online: ONLINE_BUILD || ONLINE, account: { base: `${origin}/media/api/asset`, projectId: options.projectId, ticket } });
      link.send({ type: 'events.list', projectId: options.projectId });
      ready = true; resolveEntry();
      // 成员名字(提示气泡里「谁改的」)进来就取一次,之后成员有变化再取
      projectSession(current);
      // 链接在点的时候再拼:创建者重新生成过项目链接的,复制到的是带新口令的那一条
      const linkText = () => projectLink(origin, options.projectId, current.creator ? current.linkToken ?? undefined : undefined);
      // 同一个键:再进别的项目时替换掉上一条,不叠(issue #15)。缺省那句只是提醒可以把链接发给别人,8 秒就够
      // (氛围式顶栏另有一颗常驻的「复制项目链接」);调用方自带文案的(「搬到云端」)是一次性的要紧通知,照旧常驻、由用户自己关
      if (options.announce !== false) pushToast(options.enteredText ?? '已进入云端项目，可以将项目链接发给另一位已登录成员。', 'info',
        options.enteredText ? Infinity : ENTERED_TOAST_MS, {
          label: '复制项目链接', pc: 'cloud-project-copy', run: () => { const text = linkText(); void navigator.clipboard.writeText(text).then(
            () => pushToast('项目链接已复制。', 'info'), () => pushToast(`项目链接：${text}`, 'info', Infinity)); },
        }, ENTERED_TOAST_KEY);
    })().catch(fail); },
    onClosed: info => { if (!ready || info.fatal) fail(new AccountFailure(info.fatal ? 403 : 0, info.reason || 'network'));
      else refreshStatus(); },
  });
  // 上次在这个项目里断网时没交出去的修改(浏览器本地缓存):先恢复进来,连上后照常提交,被拒就逐项转进待合并表
  if (projectAccountId) await restoreBrowserJournal(link.ds, `account:${projectAccountId}`);
  const timeout = setTimeout(() => { if (!ready) fail(new AccountFailure(503, 'session-unavailable')); }, 20_000);
  link.start();
  try { await opened; } finally { clearTimeout(timeout); }
}

const KICKED_KEY = "pc.shared.kicked";
const CREATORS_KEY = "pc.shared.creators";

function readJson<T>(key: string, fallback: T): T {
  try {
    // 旧托管主机名换成新的(hosted-default.mjs 的 RETIRED_HOSTED_HOSTS):恢复凭证、本机记录照旧能用
    const v = hosted.migrateHostedDeep(JSON.parse(localStorage.getItem(key) ?? ""));
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 存不了就算了:只影响提示文案 */
  }
}

/** 这台设备上建过的共享项目的创建者用户名(打开时「我是创建者」预填用) */
export function knownCreator(projectId: string): string | null {
  return readJson<Record<string, string>>(CREATORS_KEY, {})[projectId] ?? null;
}

function rememberCreator(projectId: string, username: string) {
  writeJson(CREATORS_KEY, { ...readJson<Record<string, string>>(CREATORS_KEY, {}), [projectId]: username });
}

function kickedKey(projectId: string, username: string) {
  return `${projectId}\n${username}`;
}

function rememberKicked(projectId: string, username: string, on: boolean) {
  const all = readJson<Record<string, number>>(KICKED_KEY, {});
  if (on) all[kickedKey(projectId, username)] = Date.now();
  else delete all[kickedKey(projectId, username)];
  writeJson(KICKED_KEY, all);
}

function wasKicked(projectId: string, username: string): boolean {
  return !!readJson<Record<string, number>>(KICKED_KEY, {})[kickedKey(projectId, username)];
}

/**
 * 设备信息:没取过就现取(开始页上还没进编辑器、`startSync` 没跑过时,「加入别人的项目」先要它)。
 * 取不到回 null(桌面运行环境里编辑器进程没应答)。
 */
export async function ensureDevice(): Promise<DeviceInfo | null> {
  if (view.device) return view.device;
  const device = await loadDevice();
  if (device) patch({ device });
  return device;
}

/**
 * 进入共享项目:取挑战、凭证明连上;连上之后本页面改连这个项目的空间,项目内容以文档服务为准
 * (项目还空着时,DocSync 把当前这份以根替换写进去 —— 新建共享项目就是这样把当前项目带过去的)。
 */
export async function enterShared(candidate: Candidate, cred: EnterCredentials, options: { initialize?: boolean; current?: () => boolean } = {}): Promise<EnterResult> {
  const current = options.current ?? (() => true);
  const device = await ensureDevice();
  if (!device) return { ok: false, error: "not-ready" };
  let key: string | undefined = cred.key;
  let firstDial = true;
  const make = async () => {
    if (candidate.access && !firstDial) {
      const fresh = await discoverRoom({ service: candidate.service, roomId: candidate.projectId, username: cred.username, as: cred.as, deviceId: device.deviceId, key });
      candidate.access = fresh.access; candidate.routeProtocol = fresh.routeProtocol;
    }
    firstDial = false;
    const protocols = await client.buildAuthProtocols({
      base: candidate.base,
      projectId: candidate.projectId,
      username: cred.username,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      as: cred.as,
      ...(candidate.access ? { fetch: relayFetch(candidate.access) } : {}),
      ...(key ? { key } : { password: cred.password }),
      role: "page",
      onKey: (k) => {
        key = k;
      },
    });
    return candidate.routeProtocol ? [...protocols, candidate.routeProtocol] : protocols;
  };
  // 先取一次挑战:限速(429)、项目没了(404)、连不上,在这一步就分得清
  let first: string[] | null;
  try {
    first = await make();
  } catch (e) {
    const { status, retryAfter } = errorStatus(e);
    if (status === 429) return { ok: false, error: "rate-limited", retryAfter };
    const terminal = classifyProtocolError(e);
    if (terminal) return { ok: false, error: terminal };
    return { ok: false, error: "unreachable" };
  }
  if (!current()) return { ok: false, error: "not-ready" };
  const wsUrl = candidate.ws ?? route.wsBaseOf(candidate.base);
  const outcome = await new Promise<"open" | CloseInfo>((resolve) => {
    let settled = false;
    const endIdentity = (link: SyncLink, failure: "auth" | "kicked" | "removed" | "deleted") => {
      if (cur?.link !== link || expectedClose === link) return;
      if (failure === "kicked") rememberKicked(candidate.projectId, cred.username, true);
      const descriptor = currentAssociation();
      recoveryCoordinator.cancel(); cancelHostTask(descriptor);
      clearSharedResume(); detach(); disconnectSharedAssets();
      patch({ blocked: failure === "auth" ? null : failure, shared: null, members: [], hosted: null, reopenState: failure === "auth" ? "needs-auth" : failure === "deleted" ? "deleted" : "rejected" });
      if (failure === "auth") pushToast("原协作身份已失效，请重新认证；本地内容已保留。", "warn", Infinity);
      // 即便隧道在致命关闭帧到达前中断，可信发现接口的 deleted 也必须持久注销。
      if (failure === "deleted" && descriptor && !ONLINE_BUILD && !ONLINE) {
        void recoveryRequest("revoke", descriptor).catch(() => pushToast("房间已删除，但本机注销记录保存失败，请检查磁盘并重试。", "warn", Infinity));
      }
    };
    const link = new SyncLink({
      docSync: holding?.ds.projectId === candidate.projectId ? holding.ds : undefined,
      initialize: options.initialize === true,
      url: wsUrl,
      protocols: () => {
        if (first) {
          const p = first;
          first = null;
          return p;
        }
        return make();
      },
      resumeProtocols: candidate.access ? async () => {
        const fresh = await discoverRoom({ service: candidate.service, roomId: candidate.projectId, username: cred.username, as: cred.as, deviceId: device.deviceId, key });
        candidate.access = fresh.access; candidate.routeProtocol = fresh.routeProtocol;
        return fresh.routeProtocol ? [fresh.routeProtocol] : [];
      } : undefined,
      projectId: candidate.projectId,
      session,
      initial: getState().project,
      saveBackup: (b) => void saveBackup(b),
      onMessage: onSideMessage,
      onResponse: async msg => { if (msg.type === "auth.ticket.ok" && typeof msg.ticket === "string") await authorizeRelayAsset(candidate, msg.ticket); },
      onProtocolError: error => {
        if (!settled) return false;
        const failure = classifyProtocolError(error);
        if (!failure) return false;
        endIdentity(link, failure === "no-project" ? "deleted" : failure);
        return true;
      },
      onOpen: () => { void (async () => {
        if (!current()) { link.stop(); resolve({ code: 0, reason: "cancelled", fatal: false, neverOpened: true }); return; }
        if (settled) {
          // 重连上了:重新订阅成员变化
          link.send({ type: "shared.watch" });
          void connectSharedAssets(link, candidate.base, { online: ONLINE, fallback: lanAssetBaseOf(candidate) });
          return;
        }
        try { await sharedStateReady(link); } catch { link.stop(); if (!settled) { settled = true; resolve({ code: 0, reason: "host-data-missing", fatal: false, neverOpened: true }); } return; }
        if (!current() || settled) { if (!current()) link.stop(); return; }
        settled = true;
        if (holding?.ds === link.ds) releaseHolding();
        const descriptor = descriptorOf(candidate);
        setAssociation(descriptor);
        bind(link, "shared", candidate.projectId, wsUrl, null, `user:${cred.username}`);
        if (cur?.link === link) cur.updateAuthentication = k => { key = k; };
        patch({
          // 口令那条路(本机 / 局域网)还没有只读成员这种身份,进去就是读写(`server/auth/delegation.mjs` 的 memberAccess)
          shared: { projectId: candidate.projectId, name: candidate.name, mode: candidate.mode, where: candidate.where, base: candidate.base, username: cred.username, creator: cred.as === "creator", hostDeviceName: candidate.hostDeviceName, access: 'rw' },
          members: [],
          hosted: null,
          blocked: null,
        });
        rememberKicked(candidate.projectId, cred.username, false);
        if (cred.as === "creator") rememberCreator(candidate.projectId, cred.username);
        // 同一个标签页刷新之后回到这里(只存派生出的 K,不存口令;见 resumeShared)
        if (key) rememberSharedResume({ candidate, as: cred.as, username: cred.username, key });
        patch({ association: descriptor, reopenState: "connected" });
        if (key) {
          lastIdentity = { descriptor, record: { candidate, as: cred.as, username: cred.username, key, profile: "default" } };
          identitySave = saveRecoveryIdentity(descriptor, { candidate, as: cred.as, username: cred.username, key, profile: "default" });
          try { await identitySave; } catch { pushToast("协作身份未能可靠保存；请重试保存，否则下次打开需要重新认证。", "warn", Infinity); }
        }
        if (!current()) { link.stop(); resolve({ code: 0, reason: "cancelled", fatal: false, neverOpened: true }); return; }
        if (candidate.originalHost && !ONLINE_BUILD && !ONLINE) {
          try { await recoveryRequest("activate-host", descriptor); } catch { pushToast("本机房间已恢复，云端登记尚未恢复，请查看协作状态。", "warn"); }
          if (!current()) { link.stop(); resolve({ code: 0, reason: "cancelled", fatal: false, neverOpened: true }); return; }
        }
        link.send({ type: "shared.watch" });
        link.send({ type: "events.list", projectId: candidate.projectId });
        // C6.6:这个共享项目的素材服务(服务地址登记里的 asset)当作当前连接的远程素材服务
        // 在线浏览器模式:素材服务与本页同源,也要认(c10a;assetTiers.pickAssetEndpoint)
        void connectSharedAssets(link, candidate.base, { online: ONLINE, fallback: lanAssetBaseOf(candidate) });
        resolve("open");
      })(); },
      onClosed: (info) => {
        if (!settled) {
          if (info.neverOpened && info.reason !== "protocols") {
            settled = true;
            link.stop();
            resolve(info);
          }
          return;
        }
        // 自己删项目(取消多用户协作)时的 4004 是预料之中的,不弹阻断弹窗
        if (info.fatal && cur?.link === link && expectedClose !== link) {
          const blocked: Blocked = info.code === 4004 ? "deleted" : info.reason === "removed" ? "removed" : "kicked";
          endIdentity(link, blocked);
        }
        refreshStatus();
      },
    });
    if (holding?.ds === link.ds) holding.target.link = link;
    link.start();
    setTimeout(() => {
      if (settled) return;
      settled = true;
      link.stop();
      resolve({ code: 0, reason: "timeout", fatal: false, neverOpened: true });
    }, 15_000);
  });
  if (outcome === "open") return { ok: true };
  if (outcome.reason === "host-data-missing") return { ok: false, error: "host-data-missing" };
  // 打开前就断:浏览器里分不出握手被拒和没连上,拿新证明问一次 shared/verify 再定(enterFailure.ts)
  const failed = await classifyEnterFailure(outcome, {
    fresh: make,
    verify: (protocols) => client.verifyProtocols({ base: candidate.base, protocols, ...(candidate.access ? { fetch: relayFetch(candidate.access) } : {}) }),
    wasKicked: () => wasKicked(candidate.projectId, cred.username),
  });
  return { ok: false, ...failed };
}

/** 自己要关掉的那条共享项目连接(取消多用户协作时删项目会收到 4004,不算被删) */
let expectedClose: SyncLink | null = null;

/** 接下来当前这条共享项目连接会被服务端关掉(自己删项目),不弹阻断弹窗 */
export function expectSharedClose(on = true) {
  expectedClose = on ? cur?.link ?? null : null;
}

/**
 * 离开共享项目回到本机空间,并把 `project`(缺省当前这份)以根替换写进本机项目(C10a 第 6 节「取消勾选」:
 * 项目真身拉回本机)。在线页面没有本机空间,只是断开。
 */
export function leaveSharedToLocal(project: Project = getState().project): Project {
  recoveryCoordinator.cancel(); cancelHostTask(currentAssociation()); setAssociation(null);
  releaseHolding();
  patch({ association: null, reopenState: null });
  clearSharedResume();
  patch({ shared: null, members: [], hosted: null, blocked: null });
  const out = switchToLocal(project, { load: true });
  expectedClose = null;
  return out;
}

let identitySave: Promise<void> | null = null;
let lastIdentity: { descriptor: CollaborationDescriptor; record: RecoveryIdentity } | null = null;
interface RecoveryIdentity { candidate: Candidate; as: "member" | "creator"; username: string; key: string; profile?: string }
export function descriptorOf(candidate: Candidate): CollaborationDescriptor {
  return { version: 1, roomId: candidate.projectId, where: candidate.where,
    service: serviceIdentity(candidate.service ?? (candidate.where === "hosted" ? candidate.base : hosted.resolveHostedUrl() || candidate.base)), hint: serviceIdentity(candidate.base) };
}
export async function recoveryRequest(endpoint: string, descriptor: CollaborationDescriptor, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, any>> {
  if (ONLINE_BUILD) throw new Error("在线页面没有本机身份接口");
  const r = await fetch(`/api/collaboration/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ descriptor, ...fields, task: session, taskVersion: recoveryCoordinator.generation }), signal, redirect: "error" });
  const body = await r.json();
  if (!r.ok || !body.ok) throw Object.assign(new Error("协作恢复失败"), { reason: body.error, retryAfter: body.retryAfter });
  return body;
}
function cancelHostTask(descriptor: CollaborationDescriptor | null) {
  if (!ONLINE_BUILD && !ONLINE && descriptor?.version === 1 && descriptor.where === "lan") void recoveryRequest("cancel-host", descriptor).catch(() => undefined);
}
if (!ONLINE_BUILD && !ONLINE && typeof window !== "undefined") window.addEventListener("pagehide", () => {
  const descriptor = currentAssociation(); recoveryCoordinator.cancel();
  if (descriptor?.version === 1 && descriptor.where === "lan") {
    navigator.sendBeacon?.("/api/collaboration/cancel-host", new Blob([JSON.stringify({ descriptor, task: session, taskVersion: recoveryCoordinator.generation })], { type: "application/json" }));
  }
});
async function saveRecoveryIdentity(descriptor: CollaborationDescriptor, record: RecoveryIdentity): Promise<void> {
  const { access: _access, routeProtocol: _route, originalHost: _host, ...candidate } = record.candidate;
  record = { ...record, candidate };
  if (ONLINE) {
    // Existing browser entry only. Restrictive storage errors remain visible to the user.
    const all = readJson<Record<string, RecoveryIdentity>>("pc.shared.identities", {});
    localStorage.setItem("pc.shared.identities", JSON.stringify({ ...all, [JSON.stringify([descriptor.service, descriptor.roomId, record.as, record.username])]: record }));
    return;
  }
  await recoveryRequest("identity", descriptor, { record, contentId: getState().project.id });
}
/**
 * 文档服务确认原云端项目已不存在（证明已核对过）：把手上这份内容转成一个独立的本地项目。
 * 内容用正在保留的那一份（文件里的内容，加上这台设备上还没发出去的离线修改）；换新的本地项目号；清掉协作关联
 * （多用户协作缺省关）；本机存的旧房间身份一并注销；保存落点与草稿归属由订阅者清掉（原文件保留）；界面提示一次。
 */
let goneConversion = 0;
async function becomeLocalAfterGone(answer: { proof: GoneProof }) {
  const descriptor = currentAssociation();
  if (!descriptor || descriptor.where !== "hosted" || answer?.proof?.projectId !== descriptor.roomId) return;
  const kept = holding?.ds.projectId === descriptor.roomId ? holding : null;
  const contentId = getState().project.id ?? "";
  const ticket = ++goneConversion;
  const stillHere = () => ticket === goneConversion && currentAssociation() === descriptor && holding === kept;
  // 先把这台设备上没发出去的离线修改并进来，再转换；并不进来就不转、不注销本机身份，内容原样保留
  if (kept && !ONLINE_BUILD && !ONLINE) {
    try {
      await restoreOfflineEdits({ restored: kept.restored,
        readJournal: async () => (await recoveryRequest("select", descriptor, { contentId })).journal ?? null,
        restoreJournal: (journal) => kept.ds.restoreJournal(journal as Parameters<DocSync["restoreJournal"]>[0]) });
      kept.restored = true;
    } catch (e) {
      if (!stillHere()) return;
      if ((e as { reason?: string }).reason === "offline-edits-unreadable") {
        patch({ reopenState: "waiting-storage" });
        setTimeout(() => { if (stillHere()) recoveryCoordinator.start(descriptor, contentId); }, 3000);
      } else patch({ reopenState: "damaged" });
      return;
    }
    if (!stillHere()) return;
  }
  const source = kept ? kept.ds.project : getState().project;
  let converted;
  try { converted = convertGoneProject(source, descriptor, answer.proof); }
  catch { patch({ reopenState: "damaged" }); return; }
  recoveryCoordinator.cancel(); releaseHolding(); setAssociation(null); clearSharedResume();
  detach(); disconnectSharedAssets();
  patch({ association: null, reopenState: null, shared: null, members: [], hosted: null, blocked: null });
  if (!ONLINE_BUILD && !ONLINE) void recoveryRequest("revoke", descriptor).catch(() => undefined);
  noteConvertedFrom(converted.project, converted.from);
  // 走载入：没有关联的项目由 onLoad 接到本机空间（文件内容为准的一次根替换）
  actions.loadProject(converted.project, getState().filePath);
  publishGoneConversion({ projectId: converted.project.id!, name: converted.project.name, from: converted.from });
}

const movedRooms = createAttemptStore(typeof localStorage === "undefined" ? null : localStorage);
function movedRoomAssociation(): CollaborationDescriptor | null {
  const d = currentAssociation();
  return !ONLINE_BUILD && !ONLINE && d?.version === 1 && d.where === "lan" && d.roomId && movedRooms.isMovedRoom(d.roomId) ? d : null;
}
/**
 * 文件里记着的本机协作房间已经在「搬到云端」时关掉(这台设备的保护存储里是已注销,页面存储里记着是搬迁关的):
 * 用手上这份内容当一个普通的本地项目开,清掉房间关联;之后保存出来的文件不再带它。
 */
function becomeLocalAfterMove() {
  const descriptor = movedRoomAssociation();
  if (!descriptor) return;
  const kept = holding;
  const source = kept && kept.ds.projectId === descriptor.roomId ? kept.ds.project : getState().project;
  recoveryCoordinator.cancel(); releaseHolding(); setAssociation(null); clearSharedResume();
  detach(); disconnectSharedAssets();
  patch({ association: null, reopenState: null, shared: null, members: [], hosted: null, blocked: null });
  actions.loadProject(source, getState().filePath);
  pushToast(ACCOUNT_MOVE_TEXT.reopenedLocal, "info", 10_000);
}

const recoveryCoordinator = new RecoveryCoordinator({
  state: (reopenState: string, detail?: { proof: GoneProof }) => {
    if (reopenState === "gone" && detail?.proof) { void becomeLocalAfterGone(detail); return; }
    // 本机协作房间是「搬到云端」时关掉的:带着它的关联的旧文件(当时写不回去的那份)按普通本地项目开,不停在「原房间已删除」
    if (reopenState === "deleted" && movedRoomAssociation()) { queueMicrotask(becomeLocalAfterMove); return; }
    patch({ reopenState });
  },
  // 信任表只有随软件分发的那一张（`gone-proof.mjs` 的 `TRUSTED_GONE_AUTHORITIES`，`queryGone` 的缺省值）：这里不传、也不许传别的表。
  // 守门测试 `server/test/gone-trust-source.test.mjs` 会拦。
  gone: (descriptor: CollaborationDescriptor, signal: AbortSignal) => queryGone(descriptor, { signal }),
  identity: async (descriptor: CollaborationDescriptor, contentId: string, signal: AbortSignal) => {
    if (ONLINE) {
      const identities = Object.values(readJson<Record<string, RecoveryIdentity>>("pc.shared.identities", {})).filter(r => descriptorOf(r.candidate).service === descriptor.service && r.candidate.projectId === descriptor.roomId);
      const resume = readSharedResume();
      const selected = identities.find(r => r.as === resume?.as && r.username === resume?.username) ?? (identities.length === 1 ? identities[0] : null);
      if (!selected && resume && descriptorOf(resume.candidate).service === descriptor.service && resume.candidate.projectId === descriptor.roomId && /^[A-Za-z0-9_-]{43}$/.test(resume.key)) return { identities: [resume], selected: resume };
      return { identities, selected };
    }
    let result = await recoveryRequest("select", descriptor, { contentId }, signal);
    if (result.recoveryMove?.terminal) throw Object.assign(new Error("房间搬迁需要处理"), { reason: result.recoveryMove.error === "auth" ? "auth"
      : result.recoveryMove.error === "deleted" ? "deleted" : result.recoveryMove.error === "host-auth" || result.recoveryMove.error === "host-conflict" ? "host-conflict" : "relocation-damaged" });
    if (!signal.aborted && !result.selected && !result.revoked) {
      const legacy = readSharedResume();
      if (legacy && /^[A-Za-z0-9_-]{43}$/.test(legacy.key) && legacy.candidate.projectId === descriptor.roomId && descriptorOf(legacy.candidate).service === descriptor.service) {
        await saveRecoveryIdentity(descriptor, legacy);
        result = await recoveryRequest("select", descriptor, { contentId }, signal);
      }
    }
    if (!signal.aborted && result.selected && !result.revoked) {
      let settings = result.settings;
      if (!settings) {
        const legacy = readJson<Record<string, unknown>>("pc.shared.local", {})[descriptor.roomId!];
        if (legacy) {
          await recoveryRequest("settings-write", descriptor, { settings: legacy }, signal);
          settings = legacy;
          const all = readJson<Record<string, unknown>>("pc.shared.local", {}); delete all[descriptor.roomId!];
          localStorage.setItem("pc.shared.local", JSON.stringify(all));
        }
      }
      if (settings) cacheCollabSecrets(descriptor.roomId!, settings);
    }
    if (!signal.aborted && result.selected && holding && holding.ds.projectId === descriptor.roomId && !holding.restored) {
      try { if (result.journal) holding.ds.restoreJournal(result.journal); holding.restored = true; }
      catch { throw Object.assign(new Error("离线恢复数据损坏"), { reason: "recovery-storage" }); }
      if (holding.ds.unconfirmed) persistJournal(holding.ds, descriptor, contentId);
    }
    return result;
  },
  host: async (descriptor: CollaborationDescriptor, signal: AbortSignal) => (await recoveryRequest("restore-host", descriptor, {}, signal)).candidate,
  discover: async (descriptor: CollaborationDescriptor, record: RecoveryIdentity, signal: AbortSignal) => {
    if (record.candidate.where === "hosted") {
      const service = record.candidate.service ?? descriptor.service;
      const relayBase = `${service!.replace(/\/+$/, "")}/hosting/relay/${descriptor.roomId}/doc`;
      // A persisted relay address never contains a current route capability; discover it afresh.
      if (record.candidate.base.replace(/\/+$/, "") !== relayBase) {
        const device = await ensureDevice(); if (!device) throw new Error("设备信息尚未就绪");
        try {
          await client.buildAuthProtocols({ base: record.candidate.base, projectId: descriptor.roomId!, username: record.username, as: record.as, key: record.key,
            deviceId: device.deviceId, deviceName: device.deviceName,
            fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) }) });
          return { ...record.candidate, projectId: descriptor.roomId };
        } catch (e) {
          if (signal.aborted || (e as { reason?: string }).reason !== "relocated") throw e;
          // Only the durably sealed old service may redirect recovery to its trusted authority.
        }
      }
      const device = await ensureDevice(); if (!device) throw new Error("设备信息尚未就绪");
      return discoverRoom({ service, roomId: descriptor.roomId, username: record.username, as: record.as, deviceId: device.deviceId, key: record.key });
    }
    if (!ONLINE_BUILD && !ONLINE) {
      let room;
      try {
        const r = await fetch(`/api/docservice/lan-discover?name=${encodeURIComponent(record.candidate.name)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
        const found = r.ok ? await r.json() : null;
        room = found?.hosts?.find((h: { projectId: string }) => h.projectId === descriptor.roomId);
      } catch { if (signal.aborted) throw signal.reason; /* Discovery failure must still permit the trusted relay. */ }
      if (room) {
        const direct = { ...record.candidate, base: room.docservice, asset: room.asset, projectId: descriptor.roomId };
        // A stale multicast answer is a hint, never a reason to keep retrying an unreachable route.
        try { await client.buildAuthProtocols({ base: direct.base, projectId: direct.projectId!, username: record.username, as: record.as, key: record.key, deviceId: view.device!.deviceId, deviceName: view.device!.deviceName, fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) }) }); return direct; } catch { /* Try authenticated outbound relay. */ }
      }
    }
    // Kept only as a trusted device-owned hint; file-provided hints never receive a key.
    const device = await ensureDevice();
    if (!device) throw new Error("设备信息尚未就绪");
    return discoverRoom({ service: record.candidate.service ?? descriptor.service, roomId: descriptor.roomId, username: record.username, as: record.as, deviceId: device.deviceId, key: record.key });
  },
  enter: (candidate: Candidate, record: RecoveryIdentity, current: () => boolean) => enterShared(candidate, { ...record, password: "" }, { current }),
});
let holding: { ds: DocSync; target: { link: SyncLink | null }; off: () => void; restored: boolean } | null = null;
let journalWrite: Promise<unknown> = Promise.resolve();
function persistJournal(ds: DocSync, descriptor: CollaborationDescriptor, contentId: string) {
  const journal = ds.recoveryJournal();
  journalWrite = journalWrite.catch(() => undefined).then(() => recoveryRequest("journal", descriptor, { contentId, journal }));
  void journalWrite.catch(() => pushToast("离线修改未能可靠保存，请保留当前页面并重试。", "warn", Infinity));
}
function sharedStateReady(link: SyncLink): Promise<void> {
  return new Promise((resolve, reject) => {
    const ready = () => !!link.ds.confirmedProject && (link.ds.status === "online" || link.ds.status === "paused");
    if (ready()) { resolve(); return; }
    const timeout = setTimeout(() => { off(); reject(new Error("服务状态未恢复")); }, 10000);
    const off = link.ds.on("status", () => { if (ready()) { clearTimeout(timeout); off(); resolve(); } });
    // Initial root acknowledgement can leave status unchanged (online -> online).
    void link.ds.whenSettled({ timeoutMs: 10000 }).then(() => { if (ready()) { clearTimeout(timeout); off(); resolve(); } }, () => undefined);
  });
}
function holdRecovery(project: Project, descriptor: CollaborationDescriptor) {
  if (descriptor.version !== 1) return;
  const target: { link: SyncLink | null } = { link: null };
  const ds = new DocSync(project, { projectId: descriptor.roomId!, session, initialize: false, send: msg => target.link?.send(msg as unknown as AnyMsg), saveBackup: b => void saveBackup(b) });
  const offStore = bindStore(ds, { load: onLoad });
  const offJournal = ds.on("project", () => {
    if (ONLINE_BUILD || ONLINE || !holding?.restored || holding.ds !== ds) return;
    persistJournal(ds, descriptor, project.id ?? "");
  });
  holding = { ds, target, restored: false, off: () => { offStore(); offJournal(); } };
}
function releaseHolding() { holding?.off(); holding = null; }
setProjectLoader(onLoad);
setRealtimeRevGetter(() => cur?.link?.ds?.rev ?? null);
// 另存 .proc 时的「非本机内容确定快照」:只在连着这个云端项目时给(以本地副本打开时 cur 是本机空间,不能拿它的序号与内容)
setCloudSnapshotGetter((projectId) => {
  const ds = cur?.kind === "shared" && cur.docProjectId === projectId ? cur.link.ds : null;
  return ds?.confirmedProject ? { rev: ds.rev, project: ds.confirmedProject } : null;
});

/** A choice binds an existing device identity; file role fields never participate. */
export async function recoveryIdentities(): Promise<{ as: "creator" | "member"; username: string; profile?: string }[]> {
  const descriptor = currentAssociation();
  if (!descriptor) return [];
  const saved = await recoveryRequest("select", descriptor, { contentId: getState().project.id });
  return (saved.identities ?? []).map((r: RecoveryIdentity) => ({ as: r.as, username: r.username, profile: r.profile ?? "default" }));
}
export async function chooseRecoveryIdentity(as: string, username: string, profile = "default") {
  const descriptor = currentAssociation();
  if (!descriptor) return;
  const contentId = getState().project.id;
  const saved = await recoveryRequest("select", descriptor, { contentId });
  const selected = saved.identities?.find((r: RecoveryIdentity) => r.as === as && r.username === username && (r.profile ?? "default") === profile);
  if (!selected || saved.revoked) throw new Error("这个身份无法恢复");
  await recoveryRequest("identity", descriptor, { contentId, record: selected });
  recoveryCoordinator.start(descriptor, contentId);
}
/** Explicit movement runs in the original host's service; reopening follows the same coordinator. */
export async function moveSharedToHosted(): Promise<{ ok: true } | { ok: false; error: string }> {
  const descriptor = currentAssociation(), original = cur?.link;
  if (ONLINE_BUILD || ONLINE || !descriptor || descriptor.where !== "lan" || !original || cur?.kind !== "shared") return { ok: false, error: "not-original-host" };
  try {
    await whenSaved(10000); await identitySave;
    if (cur?.link !== original || currentAssociation() !== descriptor) return { ok: false, error: "cancelled" };
    await recoveryRequest("move-hosted", descriptor);
    if (cur?.link !== original || currentAssociation() !== descriptor) return { ok: false, error: "cancelled" };
    const project = structuredClone(getState().project);
    recoveryCoordinator.cancel(); cancelHostTask(descriptor); releaseHolding(); detach(); disconnectSharedAssets();
    setAssociation(descriptor, true); patch({ association: descriptor, shared: null, members: [], hosted: null, blocked: null, reopenState: "waiting-host" });
    holdRecovery(project, descriptor); recoveryCoordinator.start(descriptor, project.id);
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as { reason?: string }).reason ?? "relocation-network" }; }
}
export async function moveSharedToLan(): Promise<{ ok: true } | { ok: false; error: string }> {
  const descriptor = currentAssociation(), original = cur?.link;
  if (ONLINE_BUILD || ONLINE || !descriptor || descriptor.where !== "hosted" || !original || cur?.kind !== "shared") return { ok: false, error: "not-ready" };
  try {
    await whenSaved(10000); await identitySave;
    if (cur?.link !== original || currentAssociation() !== descriptor) return { ok: false, error: "cancelled" };
    const result = await recoveryRequest("move-lan", descriptor, { contentId: getState().project.id });
    if (cur?.link !== original || currentAssociation() !== descriptor) return { ok: false, error: "cancelled" };
    const project = structuredClone(getState().project), destination = result.descriptor as CollaborationDescriptor;
    recoveryCoordinator.cancel(); releaseHolding(); detach(); disconnectSharedAssets();
    setAssociation(destination, true); patch({ association: destination, shared: null, members: [], hosted: null, blocked: null, reopenState: "waiting-host" });
    holdRecovery(project, destination); recoveryCoordinator.start(destination, project.id);
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as { reason?: string }).reason ?? "relocation-network" }; }
}
/** The user supplies a password after seeing the destination; no cached secret is sent to a file URL. */
export async function authenticateRecovery(username: string, password: string, as: "creator" | "member"): Promise<EnterResult> {
  const descriptor = currentAssociation();
  const device = await ensureDevice();
  if (!descriptor || descriptor.version !== 1 || !device) return { ok: false, error: "not-ready" };
  recoveryCoordinator.cancel();
  const generation = recoveryCoordinator.generation;
  let key: string | undefined;
  const candidate: Candidate = descriptor.where === "hosted"
    ? { where: "hosted", projectId: descriptor.roomId!, base: descriptor.service!, service: descriptor.service!, name: getState().project.name, mode: "free" }
    : await discoverRoom({ service: descriptor.service, roomId: descriptor.roomId, username, password, as, deviceId: device.deviceId, onKey: (k: string) => { key = k; } });
  const result = await enterShared(candidate, { as, username, password, key }, { current: () => recoveryCoordinator.generation === generation });
  if (!result.ok) patch({ reopenState: result.error === "auth" ? "needs-auth" : result.error === "kicked" ? "rejected" : "waiting-host" });
  return result;
}

/** 当前是不是连着共享项目(项目设置「多用户协作」按它显示勾选状态) */
export function currentSharedLink(): SyncLink | null {
  return cur && cur.kind === "shared" ? cur.link : null;
}

/** 当前共享项目连接的文档服务地址(纯浏览器节点的 render 连接连同一个地址,M7 契约第 5 节);没连共享项目回 null */
export function currentSharedUrl(): string | null {
  return cur && cur.kind === "shared" ? cur.url : null;
}

/** 被踢 / 被移出 / 项目被删之后点「开始页」:回到本机空间,回开始页 */
export function leaveBlocked() {
  clearSharedResume();
  patch({ blocked: null, shared: null, members: [], hosted: null });
  switchToLocal(getState().project, { load: false });
  window.dispatchEvent(new Event("pc-go-home"));
}

/* ---------------- 创建者操作 ---------------- */

export type AdminError = "forbidden" | "rate-limited" | "bad-message" | "offline" | "other";

/**
 * 做一次创建者操作(契约 `auth-contract.md` 第 7 节):同一连接取挑战、按创建者密码派生 K、算证明、发 `shared.admin`。
 * 密码每次当场给(不缓存);`key` 是同一次操作流程里刚验证过的那份 K(验证身份与真正的操作是两次证明)。
 */
export async function adminOp(
  op: string,
  auth: { password?: string; key?: string },
  fields: Record<string, unknown> = {},
): Promise<{ ok: true; reply: AnyMsg; key: string } | { ok: false; error: AdminError }> {
  const s = view.shared;
  if (!cur || cur.kind !== "shared" || !s) return { ok: false, error: "offline" };
  const link = cur.link;
  let ch: AnyMsg;
  try {
    ch = await link.request({ type: "shared.challenge" });
  } catch {
    return { ok: false, error: "offline" };
  }
  if (ch.type !== "shared.challenge.ok") return { ok: false, error: ch.reason === "rate-limited" ? "rate-limited" : "forbidden" };
  const key = auth.key ?? (await client.deriveKey(auth.password ?? "", ch.salt as string, ch.kdf as never));
  const m = await client.adminProof({ key, projectId: s.projectId, username: s.username, op, nonce: ch.nonce as string });
  let reply: AnyMsg;
  try {
    reply = await link.request({ type: "shared.admin", op, proof: { nonce: ch.nonce, m }, ...fields });
  } catch {
    return { ok: false, error: "offline" };
  }
  if (reply.type === "shared.admin.ok") {
    const descriptor = currentAssociation();
    const replacement = op === "set-creator-password" && s.creator ? fields.creator : op === "set-password" && !s.creator ? fields.project : null;
    if (descriptor && lastIdentity && replacement && typeof (replacement as { key?: unknown }).key === "string") {
      const record = { ...lastIdentity.record, key: (replacement as { key: string }).key };
      if (cur?.link === link) cur.updateAuthentication?.(record.key);
      lastIdentity = { descriptor, record }; identitySave = saveRecoveryIdentity(descriptor, record);
      rememberSharedResume(record);
      try { await identitySave; } catch { pushToast("新密码已生效，但本机恢复凭证保存失败；请重试保存。", "warn", Infinity); }
    }
    if (descriptor && !ONLINE_BUILD && !ONLINE) void recoveryRequest("host-update", descriptor).catch(() => pushToast("云端权限登记待重试，本机权限已更新。", "warn"));
    return { ok: true, reply, key };
  }
  const reason = String(reply.reason ?? "");
  return { ok: false, error: reason === "forbidden" || reason === "rate-limited" || reason === "bad-message" ? (reason as AdminError) : "other" };
}

/**
 * 创建者开关托管方的服务(契约 `docs/plan/hosted-render-contract.md` 第 3 节):`shared.admin { op: 'set-hosted-service' }`,
 * 证明与其它创建者操作相同(`key` 是同一次流程里刚验证过的 K)。成功后马上把本页的开关状态改过来
 * (服务端随后还会推一条刷新后的成员列表,以它为准)。
 */
export async function setHostedService(service: HostedServiceName, enabled: boolean, key: string): Promise<HostedChangeResult> {
  if (view.shared?.accountId) {
    // 账号项目:不走创建者密码的证明,凭账号的登录态,服务端按创建者身份把关(成员回 403)。改完续一次会话,界面照读到的状态走
    try {
      if (service === 'agent') await setAccountAgentEnabled(enabled);
      else await setAccountHosted({ service, enabled });
      return { ok: true };
    } catch (error) { return accountHostedFailure(error); }
  }
  const r = await adminOp("set-hosted-service", { key }, { service, enabled });
  if (!r.ok) return r;
  patch({ hosted: applyHostedChange(view.hosted, service, enabled) });
  // 创建者自己这一页的 AI 栏也马上跟着变(通知只发给别的连接)
  if (service === "agent") setHostedAgentEnabled(view.shared?.projectId ?? currentDocProjectId(), enabled);
  return { ok: true };
}

/**
 * 创建者改托管方服务下面的子选项(渲染节点的「生成轨道流」,契约 `docs/plan/hosted-render-contract.md` 第 3.1 节):
 * `shared.admin { op: 'set-hosted-option' }`,证明与其它创建者操作相同。成功后马上把本页的状态改过来(服务端随后还会推一条刷新后的成员列表)。
 * 账号项目(云端账号那条路):创建者经 `/hosted/shared/account/admin` 的 `set-hosted-option` 改,凭账号的登录态,成员被服务端拒。
 */
export async function setHostedOption(service: HostedServiceName, option: HostedOptionName, enabled: boolean, key: string): Promise<HostedChangeResult> {
  if (view.shared?.accountId) {
    if (service !== 'render') return { ok: false, error: 'bad-message' };
    try { await setAccountHosted({ service, option, enabled }); return { ok: true }; }
    catch (error) { return accountHostedFailure(error); }
  }
  const r = await adminOp("set-hosted-option", { key }, { service, option, enabled });
  if (!r.ok) return r;
  patch({ hosted: applyHostedOptionChange(view.hosted, service, option, enabled) });
  return { ok: true };
}

/** The account branch uses the live bearer/admin revision; no legacy password challenge. */
export async function setAccountAgentEnabled(enabled: boolean): Promise<void> {
  if (!cur?.setAccountAgentEnabled) throw new AccountFailure(503, 'session-unavailable');
  await cur.setAccountAgentEnabled(enabled);
}

/** 账号项目:创建者改托管方的渲染节点的开关或它的子选项(同上,凭账号的登录态) */
async function setAccountHosted(change: Parameters<NonNullable<Current["setAccountHosted"]>>[0]): Promise<void> {
  if (!cur?.setAccountHosted) throw new AccountFailure(503, 'session-unavailable');
  await cur.setAccountHosted(change);
}

/** 改托管方服务开关的结果。账号项目失败时另带 `message`(服务端给的拒绝原因翻成的一句话),见 `hostedServices.ts` 的 `accountHostedFailure` */
export type HostedChangeResult = { ok: true } | { ok: false; error: AdminError; message?: string };


/** 新的一份口令凭证(改项目密码、改名单、改创建者密码用),kdf 与项目记录一致用缺省 */
export function makeCredential(password: string) {
  return client.makeCredential(password);
}

/**
 * 账号云端项目:作废并重新生成项目链接(10-14 第 3.3 节)。旧链接失效,已经进来的成员不受影响,新人用回的新链接。
 * 只有账号项目有这一项(旧办法的房间走「作废并重新生成邀请码」)。
 */
export async function regenAccountProjectLink(): Promise<{ ok: true; link: string } | { ok: false; error: string }> {
  if (!view.shared?.accountId || !cur?.regenAccountLink) return { ok: false, error: "当前不是账号云端项目。" };
  try { return { ok: true, link: await cur.regenAccountLink() }; }
  catch (e) { return { ok: false, error: e instanceof Error && e.message ? e.message : "重新生成项目链接失败。" }; }
}

/** 账号云端项目:设置 / 修改项目二级密码(字符串,照原样,不去空白)或清除(null 或空串)(10-14 第 3.3 节) */
export async function setAccountSecondaryPassword(password: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!view.shared?.accountId || !cur?.setAccountSecondaryPassword) return { ok: false, error: "当前不是账号云端项目。" };
  try { await cur.setAccountSecondaryPassword(password || null); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error && e.message ? e.message : "设置项目二级密码失败。" }; }
}

/** 账号云端项目现在的项目链接(创建者带当前的链接口令);不在账号项目里回 null */
export function currentAccountProjectLink(): string | null {
  return view.shared?.accountId && cur?.accountLink ? cur.accountLink() : null;
}

/**
 * 「搬到云端」要带上去的历史序号与提交摘要(10-14 第 3.3 节):读当前这条本机文档连接的 `DocSync`
 * (本地项目连本机文档服务、旧办法的协作房间连房间),只在它连的正是这份内容(`contentId`)时给;
 * 还没拿到文档服务确认的序号(`rev` 为 0)或已经在账号云端项目里时回 null。
 */
export function currentDocLineage(contentId: string): { rev: number; history: CommitSummary[] } | null {
  const ds = cur?.link.ds;
  if (!cur || !ds || view.shared?.accountId || !contentId || ds.project.id !== contentId) return null;
  const rev = ds.rev;
  if (!Number.isSafeInteger(rev) || rev < 1) return null;
  return { rev, history: ds.history.filter((h) => h.rev <= rev) };
}
