/**
 * AI 提供方与云端扩展接缝（登记式替换型，参照 `docs/plan/community-seams.md`）。
 *
 * 公开侧默认提供完整可工作的本机 Agent 回退（`CLOUD_OFF_STATE`、空历史摘要、无云端告知轮询，
 * 使 `AiPanel`、`OnlineAgentPage`、`AgentPage`、`useVibeLocal` 在社区版未登记云端提供方时直接走本机 Agent）；
 * 私有侧由扩展入口调用 `registerAiCloudProvider()` 登记云端 AI 提供方实现。
 * Node 单测下的目录探测加载器见同目录的 `extensionsLoad.mjs`。
 */
import type { ChatAttachment, ChatMessage } from "./types.ts";
import type { CloudAttachmentInfo } from "./cloudAttach.ts";
import type { OutboxItem } from "./outbox.ts";
import { DOC_LINK_DOWN_TEXT } from "./outbox.ts";
import { CLOUD_CHAT_LIMIT, CLOUD_CHAT_TEXT } from "./chatTexts.ts";
import {
  CLOUD_OFF,
  type CloudAgentEndpoint,
  type CloudAgentState,
  type CloudChatItem,
  type CloudInfo,
  type CloudQueueSnapshot,
  type CloudSender,
} from "./chatTypes.ts";

export {
  CLOUD_OFF,
  DOC_LINK_DOWN_TEXT,
  type CloudAgentEndpoint,
  type CloudAgentState,
  type CloudChatItem,
  type CloudInfo,
  type CloudQueueSnapshot,
  type CloudSender,
};

/**
 * 在线页面里云端 Agent 服务的路径（与页面同源）。
 *
 * 原来定义在 `src/ai/cloud/endpoint.ts`（归闭源），而 `src/start/browseChats.ts` 这个公开文件要用它。
 * 它只是一个路径常量，没有任何云端实现在里面，所以提到公开侧单处定义，`endpoint.ts` 从这里取，
 * 免得两边各写一份之后漂掉（活 C 的 C2 就是这么漂的）。
 */
export const ONLINE_AGENT_PATH = "/agent/v1";

export const CLOUD_OFF_STATE: CloudAgentState = Object.freeze({
  ...CLOUD_OFF,
  projectId: null,
  identityVersion: 0,
  accountMode: false,
  accountId: null,
});

/* ---------------- 纯错误与会话控制辅助（原在 `src/ai/cloud/cloudApi.ts`、`src/ai/cloud/consent.ts`） ---------------- */

export class CloudError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "CloudError";
    this.code = code;
    this.status = status;
  }
  static [Symbol.hasInstance](instance: unknown): boolean {
    if (!instance || typeof instance !== "object") return false;
    if (Function.prototype[Symbol.hasInstance].call(CloudError, instance)) return true;
    const e = instance as { name?: unknown; code?: unknown; status?: unknown };
    return instance instanceof Error && e.name === "CloudError" && typeof e.code === "string" && typeof e.status === "number";
  }
}

export class CloudConsentRequiredError extends Error {
  constructor() {
    super("使用云端 Agent 前，请先阅读并确认告知。");
  }
}

export interface CloudControlScopeToken {
  key: string;
  conversationId: string;
  epoch: number;
}

/** Tracks async control operations across account/project/conversation changes, including A→B→A. */
export function createCloudControlScopeGuard() {
  let current: CloudControlScopeToken = { key: "", conversationId: "", epoch: 0 };
  return {
    update(key: string, conversationId: string): CloudControlScopeToken {
      if (key !== current.key || conversationId !== current.conversationId) {
        current = { key, conversationId, epoch: current.epoch + 1 };
      }
      return current;
    },
    isCurrent(token: CloudControlScopeToken) {
      return token.epoch === current.epoch && token.key === current.key && token.conversationId === current.conversationId;
    },
  };
}

/** Runs a control submission only if identity/conversation scope still matches after consent is resolved. */
export async function withCloudControlConsent<T>(
  consent: () => Promise<unknown>,
  isCurrent: () => boolean,
  submit: () => Promise<T>,
): Promise<T> {
  await consent();
  if (!isCurrent()) throw new CloudError("forbidden", "账号、项目或对话已切换，请重新读取当前对话后再操作。", 403);
  return submit();
}

export function requireAccountAbortControl(runId?: string, requestId?: string): { runId: string; requestId: string } {
  if (!runId || !requestId) throw new CloudError("forbidden", "停止云端对话需要当前运行编号和请求编号。", 403);
  return { runId, requestId };
}

/** 契约 2.3 节的错误码 → 给用户看的话。服务端自己带了说明(额度、原因)的用服务端的 */
export function cloudErrorText(code: string, serverMessage?: string): string {
  switch (code) {
    case "unauthorized":
      return "云端 Agent 暂时连不上:身份验证没有通过。请刷新页面或重新进入项目。";
    case "no-identity":
      return "云端 Agent 暂时用不了:还没有取得身份证明。";
    case "forbidden":
      return "你没有权限使用这个项目的云端 Agent。";
    case "disabled":
      return "项目创建者已关闭云端 Agent。";
    case "busy":
      return "云端 Agent 正忙,请稍后再试。";
    case "busy-conversation":
      return "这个对话还有一轮在进行,等它结束或先停止。";
    case "quota-exceeded":
      return serverMessage || "这个项目的云端 Agent 额度已用完。";
    case "no-model-key":
      return "云端 Agent 还没有配置模型,请联系托管方。";
    case "too-large":
      return "消息太长了,云端 Agent 收不下。请缩短后再发。";
    case "bad-grant":
      return "这次对话的授权已失效,请重新发送。";
    case "unavailable":
      return serverMessage || "云端 Agent 暂时连不上文档服务,请稍后再试。";
    case "network":
      return "连不上云端 Agent 服务,请检查网络。";
    // 50 个上限与删除（文字集中在 chatTexts.ts，用户 2026-10-13 确认）；purge-failed 与 creator-required 两句是 2026-10-13 新起草的，列在报告的文字表里
    case "conversation-limit":
      return CLOUD_CHAT_TEXT.limitReached;
    case "guest-chat-limit":
      return CLOUD_CHAT_TEXT.guestLimit;
    case "delete-forbidden":
      return CLOUD_CHAT_TEXT.deleteForbidden;
    case "conversation-deleting":
      return CLOUD_CHAT_TEXT.conversationDeleting;
    case "conversation-deleted":
    case "no-conversation":
      return CLOUD_CHAT_TEXT.noConversation;
    case "agent-fence-pending":
      return CLOUD_CHAT_TEXT.deletePending;
    case "purge-failed":
      return CLOUD_CHAT_TEXT.purgeFailed;
    case "creator-required":
      return CLOUD_CHAT_TEXT.creatorRequired;
    // 服务端收消息时核告知没通过（页面那次读取之后、发出之前告知状态变了）：页面同时弹出告知框
    case "consent-required":
      return "使用云端 Agent 前，请先阅读并确认告知。";
    default:
      return serverMessage || `云端 Agent 出错了(${code})。`;
  }
}

/** UI gating only; the server remains authoritative for every conversation operation. */
export function cloudConversationControlPolicy(input: {
  accountMode: boolean;
  accountId: string | null;
  creator: boolean;
  conversation: CloudChatItem | null;
  queue: CloudQueueSnapshot | null | undefined;
  senders: Record<string, CloudSender> | undefined;
  legacyStreaming: boolean;
}) {
  if (!input.accountMode) {
    return {
      canSend: true,
      creatorReadOnly: false,
      canSwitchVisibility: false,
      currentRunId: null,
      streaming: input.legacyStreaming,
      canStop: input.legacyStreaming,
    };
  }
  const currentRunId = input.queue?.currentRunId ?? null;
  const active = currentRunId
    ? input.queue?.items.find((item) => item.runId === currentRunId && (item.state === "running" || item.state === "preparing")) ?? null
    : null;
  const sender = active ? input.senders?.[`cq-${active.messageId}`] : undefined;
  const creatorReadOnly = input.conversation?.creatorReadOnly === true;
  return {
    canSend: !creatorReadOnly,
    creatorReadOnly,
    canSwitchVisibility: Boolean(
      input.accountId &&
        input.conversation?.ownerAccountId === input.accountId &&
        (input.conversation.visibility === "shared" || input.conversation.visibility === "private"),
    ),
    currentRunId,
    streaming: Boolean(currentRunId && active),
    canStop: Boolean(currentRunId && active && (input.creator || sender?.accountId === input.accountId)),
  };
}

/* ---------------- 接缝接口定义 ---------------- */

export interface CloudConsentState {
  accountId: string | null;
  bindingVersion: number;
  accepted: boolean | null;
  pending: boolean;
  error: string | null;
}

export interface CloudConsentBinding {
  accountId: string;
  bindingVersion: number;
}

/**
 * 一次读取核过之后发给当次发送的许可。外头拿它当不透明对象传，真伪由 `consent.ts` 的 `WeakMap` 认。
 */
export interface CloudConsentPermit {
  readonly binding: CloudConsentBinding;
}

export interface CloudDigest {
  items: CloudChatItem[];
  running: string[];
  loading: boolean;
  refresh: () => Promise<void>;
}

export interface CloudSessionView {
  conversationId: string | null;
  /** 对话里有没有没收尾的一轮(服务端还在跑,不论此刻流连没连着) */
  streaming: boolean;
  connection: "idle" | "connecting" | "live" | "reconnecting";
  /** 连不上、身份不对这类要给用户看的原因;连上了就清掉 */
  problem: string | null;
  lastSeq: number;
  queue?: CloudQueueSnapshot | null;
  senders?: Record<string, CloudSender>;
  revoked: boolean;
}

export interface CloudChatStoreLike {
  get: () => ChatMessage[];
  set: (next: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  replace: (next: ChatMessage[]) => void;
  subscribe: (fn: () => void) => () => void;
}

export interface CloudChat {
  store: CloudChatStoreLike;
  messages: ChatMessage[];
  view: CloudSessionView;
  info: CloudInfo | null;
  /** 页面上要给用户看一下的(发送失败、身份没就绪、项目关了开关),用户关掉或下一次操作时清掉 */
  notice: string | null;
  clearNotice: () => void;
  /** 给用户看一句话(「某些附件没带上」之类页面自己的提示) */
  notify: (text: string) => void;
  conversationId: string;
  /** `files`:已经传好的附件(`attach` 回来的那些);其 `url` 随消息带给服务端,名字显示在本页的气泡里。
   *  `staged`:先用 `stage` 放进对话的那条本地气泡;发不出去时它标成「没发出去」 */
  /** `consentPermit`：同一次发送开头 `grantCloudConsent` 发的一次性许可；有效就不再向账号服务读第二次告知。 */
  send: (
    text: string,
    files?: ChatAttachment[],
    staged?: string,
    consentPermit?: CloudConsentPermit | null,
    opts?: { queueOnNetwork?: boolean },
  ) => Promise<boolean>;
  /** 账号模式:点发送的那一刻先在对话里放一条本地气泡(乐观显示),回它的号;没有会话时回 null */
  stage: (text: string, files?: ChatAttachment[]) => string | null;
  /** 本地气泡在发出之前就被挡下了(没确认告知、对话已切走等):标成没发出去 */
  failStaged: (id: string, reason: string) => void;
  /**
   * 断网待发(outbox.ts,只在 `useCloudChat({ outbox: true })` 时有):
   * `offline()` 浏览器此刻断着网;`mustQueue()` 这个对话里已经有排着的(新发的要排在它后面,顺序不乱);
   * `enqueue` 把点发送时放的那个本地气泡排进去(网络恢复后自动发出);`resend` 不发了的那条按当前状态重新走一遍;
   * `transient(err)` 这个错是不是断网一类(发不出去、但等网络恢复能发)。
   */
  outbox: {
    items: readonly OutboxItem[];
    offline: () => boolean;
    mustQueue: () => boolean;
    enqueue: (text: string, files: ChatAttachment[] | undefined, staged: string) => boolean;
    resend: (localId: string) => void;
    transient: (err: unknown) => boolean;
  };
  dropStaged: (id: string) => void;
  /** 传一个文件到这个对话的工作目录(对话还没发过消息也行);出错抛 `CloudError` */
  attach: (file: File, signal?: AbortSignal) => Promise<CloudAttachmentInfo>;
  abort: (runId?: string, requestId?: string) => Promise<void>;
  switchVisibility: (visibility: "shared" | "private", requestId: string) => Promise<CloudChatItem>;
  newChat: () => void;
  openChat: (id: string) => void;
  /**
   * 删除一个云端对话（账号模式）。requestId 一次删除用同一个：任务还没停稳（agent-fence-pending）时抛错，
   * 界面用同一个请求号重试。成功时如果删的是当前打开的，自动退到一个新对话。
   */
  removeChat: (id: string, requestId: string) => Promise<{ already: boolean }>;
  history: {
    items: CloudChatItem[];
    loading: boolean;
    refresh: (silent?: boolean, maxAgeMs?: number) => Promise<boolean>;
    /** 这个项目的对话列表读到过（几个分页共用一份，进入项目就开始读；打开分页时通常已经有了） */
    loaded: boolean;
    /** 这位账号在这个项目里自己开的对话数（共有对话算在开它的人名下）；满 `limit` 个就不让新建（账号 50 个，游客 1 个） */
    ownedCount: number;
    atLimit: boolean;
    /** 这个上限是几个：账号 50，游客 1（`chatLimitOf`） */
    limit: number;
    /** 当前身份是游客：满额时界面不是「删几个再建」，而是「游客每个项目只能开一个对话，注册账号才能多开」，新建入口置灰 */
    guest: boolean;
  };
  revoked?: boolean;
  model: string;
  setModel: (m: string) => void;
  /** 思考强度;空串 = 默认(不带这个参数,随模型自己的默认) */
  effort: string;
  setEffort: (e: string) => void;
}

export interface UseCloudChatOptions {
  tabId: string;
  cloud: CloudAgentState;
  enabled: boolean;
  autoAttach: boolean;
  initialConversation?: string | null;
  /** 开断网待发(只在账号模式下起作用):断网时发的消息排着,网络恢复后自动发出 */
  outbox?: boolean;
  /** 待发的那条真发出去之前对附件做的准备(图片、视频、音频放进素材库,同点发送时那一步) */
  prepareFiles?: (files: ChatAttachment[]) => Promise<ChatAttachment[]>;
}

export interface AiCloudProvider {
  useCloudAgent: () => CloudAgentState;
  useCloudDigest: (cloud: CloudAgentState, enabled: boolean) => CloudDigest;
  useCloudChat: (opts: UseCloudChatOptions) => CloudChat;
  useCloudNotices: (cloud: CloudAgentState, enabled: boolean) => void;
  cloudConsentState: () => CloudConsentState;
  subscribeCloudConsent: (listener: () => void) => () => void;
  refreshCloudConsent: (expected?: CloudConsentBinding) => Promise<boolean>;
  grantCloudConsent: (expected: CloudConsentBinding) => Promise<{ accepted: boolean; permit: CloudConsentPermit | null }>;
  acceptCloudConsent: () => Promise<void>;
  onCloudConsentRequired: (listener: (binding: CloudConsentBinding, origin: string) => void) => () => void;
  cloudTicket: () => Promise<string>;
  /**
   * 列一个云端项目里的对话。**不是 React hook** —— `src/start/browseChats.ts` 和它的 Node 单测
   * 直接调，所以单独开一个槽，不能塞进上面那组 hook 里。
   * 社区版缺省返回空列表：没有云端项目，也就没有云端对话。
   */
  // 入参的形状照 `src/ai/cloud/cloudApi.ts` 的 `CloudApiDeps` 写（取它的子集）——
  // 这里是公开侧对外声明的那份接口，形状对不上云端实现的话编译期就该报，不该留到运行期
  listCloudChats: (deps: {
    baseUrl: () => string | null;
    projectId?: () => string | null;
    ticket?: () => Promise<string>;
    fetchImpl?: typeof fetch;
  }) => Promise<CloudChatItem[]>;
}

export interface AiExtensionEntry {
  readonly name: string;
  readonly provider?: Partial<AiCloudProvider>;
  readonly create?: (deps?: Record<string, unknown>) => unknown;
}

/* ---------------- 社区版默认回退实现（未登记云端提供方时生效） ---------------- */

const IDLE_CONSENT: CloudConsentState = Object.freeze({
  accountId: null,
  bindingVersion: 0,
  accepted: null,
  pending: false,
  error: null,
});

const IDLE_VIEW: CloudSessionView = Object.freeze({
  conversationId: null,
  streaming: false,
  connection: "idle",
  problem: null,
  lastSeq: 0,
  queue: null,
  senders: Object.freeze({}),
  revoked: false,
});

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_ITEMS: CloudChatItem[] = [];
const EMPTY_RUNNING: string[] = [];
const EMPTY_OUTBOX_ITEMS: readonly OutboxItem[] = Object.freeze([]);
const NOOP = () => {};
const NOOP_UNSUB = () => NOOP;
const NOOP_ASYNC_VOID = async () => {};
const NOOP_ASYNC_FALSE = async () => false;

const IDLE_STORE: CloudChatStoreLike = Object.freeze({
  get: () => EMPTY_MESSAGES,
  set: NOOP,
  replace: NOOP,
  subscribe: NOOP_UNSUB,
});

const IDLE_DIGEST: CloudDigest = Object.freeze({
  items: EMPTY_ITEMS,
  running: EMPTY_RUNNING,
  loading: false,
  refresh: NOOP_ASYNC_VOID,
});

const IDLE_CHAT: CloudChat = Object.freeze({
  store: IDLE_STORE,
  messages: EMPTY_MESSAGES,
  view: IDLE_VIEW,
  info: null,
  notice: null,
  clearNotice: NOOP,
  notify: NOOP,
  conversationId: "cc-community-local",
  send: NOOP_ASYNC_FALSE,
  stage: () => null,
  failStaged: NOOP,
  outbox: Object.freeze({
    items: EMPTY_OUTBOX_ITEMS,
    offline: () => false,
    mustQueue: () => false,
    enqueue: () => false,
    resend: NOOP,
    transient: () => false,
  }),
  dropStaged: NOOP,
  attach: async () => {
    throw new CloudError("disabled", cloudErrorText("disabled"), 403);
  },
  abort: NOOP_ASYNC_VOID,
  switchVisibility: async () => {
    throw new CloudError("disabled", cloudErrorText("disabled"), 403);
  },
  newChat: NOOP,
  openChat: NOOP,
  removeChat: async () => ({ already: true }),
  history: Object.freeze({
    items: EMPTY_ITEMS,
    loading: false,
    refresh: NOOP_ASYNC_FALSE,
    loaded: true,
    ownedCount: 0,
    atLimit: false,
    limit: CLOUD_CHAT_LIMIT,
    guest: false,
  }),
  revoked: false,
  model: "",
  setModel: NOOP,
  effort: "",
  setEffort: NOOP,
});

export const COMMUNITY_AI_CLOUD_PROVIDER: AiCloudProvider = Object.freeze({
  useCloudAgent: () => CLOUD_OFF_STATE,
  listCloudChats: async () => [],
  useCloudDigest: () => IDLE_DIGEST,
  useCloudChat: () => IDLE_CHAT,
  useCloudNotices: NOOP,
  cloudConsentState: () => IDLE_CONSENT,
  subscribeCloudConsent: () => NOOP_UNSUB,
  refreshCloudConsent: NOOP_ASYNC_FALSE,
  grantCloudConsent: async () => ({ accepted: false, permit: null }),
  acceptCloudConsent: NOOP_ASYNC_VOID,
  onCloudConsentRequired: () => NOOP_UNSUB,
  cloudTicket: async () => {
    throw new CloudError("no-identity", cloudErrorText("no-identity"), 401);
  },
});

let currentProvider: AiCloudProvider = COMMUNITY_AI_CLOUD_PROVIDER;
let registeredCustom = false;

export function registerAiCloudProvider(patch: Partial<AiCloudProvider>): void {
  if (!patch || typeof patch !== "object") return;
  currentProvider = Object.freeze({ ...currentProvider, ...patch });
  registeredCustom = true;
}

export function resetAiCloudProvider(): void {
  currentProvider = COMMUNITY_AI_CLOUD_PROVIDER;
  registeredCustom = false;
}

export function hasAiCloudProvider(): boolean {
  return registeredCustom;
}

export function getAiCloudProvider(): AiCloudProvider {
  return currentProvider;
}

/* ---------------- 对外转调入口（供公开层 UI 直接调用） ---------------- */

export function useCloudAgent(): CloudAgentState {
  return currentProvider.useCloudAgent();
}

export function useCloudDigest(cloud: CloudAgentState, enabled: boolean): CloudDigest {
  return currentProvider.useCloudDigest(cloud, enabled);
}

export function useCloudChat(opts: UseCloudChatOptions): CloudChat {
  return currentProvider.useCloudChat(opts);
}

export function useCloudNotices(cloud: CloudAgentState, enabled: boolean): void {
  return currentProvider.useCloudNotices(cloud, enabled);
}

export function cloudConsentState(): CloudConsentState {
  return currentProvider.cloudConsentState();
}

export function subscribeCloudConsent(listener: () => void): () => void {
  return currentProvider.subscribeCloudConsent(listener);
}

export function refreshCloudConsent(expected?: CloudConsentBinding): Promise<boolean> {
  return currentProvider.refreshCloudConsent(expected);
}

export function grantCloudConsent(
  expected: CloudConsentBinding,
): Promise<{ accepted: boolean; permit: CloudConsentPermit | null }> {
  return currentProvider.grantCloudConsent(expected);
}

export function acceptCloudConsent(): Promise<void> {
  return currentProvider.acceptCloudConsent();
}

export function onCloudConsentRequired(listener: (binding: CloudConsentBinding, origin: string) => void): () => void {
  return currentProvider.onCloudConsentRequired(listener);
}

export function cloudTicket(): Promise<string> {
  return currentProvider.cloudTicket();
}

/* ---------------- 扩展表归一化辅助（供登记方或 `extensionsLoad.mjs` 使用） ---------------- */

const FROZEN_EMPTY: readonly AiExtensionEntry[] = Object.freeze([]);

export function applyAiManifest(raw: unknown): readonly AiExtensionEntry[] {
  if (!Array.isArray(raw)) return FROZEN_EMPTY;
  const entries: AiExtensionEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || !rec.name) continue;
    const provider =
      rec.provider && typeof rec.provider === "object" ? (rec.provider as Partial<AiCloudProvider>) : undefined;
    if (provider) registerAiCloudProvider(provider);
    entries.push(
      Object.freeze({
        name: rec.name,
        ...(provider ? { provider } : {}),
        ...(typeof rec.create === "function"
          ? { create: rec.create as (deps?: Record<string, unknown>) => unknown }
          : {}),
      }),
    );
  }
  return entries.length > 0 ? Object.freeze(entries) : FROZEN_EMPTY;
}
