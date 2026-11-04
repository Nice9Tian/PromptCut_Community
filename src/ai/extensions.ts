/**
 * AI provider and cloud extension seam (registration-based replacement type, see
 * `docs/plan/community-seams.md`).
 *
 * The public side provides a complete, working local Agent fallback by default (`CLOUD_OFF_STATE`,
 * an empty history summary, no cloud notice polling, so that `AiPanel`, `OnlineAgentPage`,
 * `AgentPage` and `useVibeLocal` go straight to the local Agent when the community edition has not
 * registered a cloud provider); the private side has the extension entry call
 * `registerAiCloudProvider()` to register the cloud AI provider implementation.
 * For the directory-probing loader used in Node unit tests, see `extensionsLoad.mjs` in the same
 * directory.
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
import { tr } from "../i18n/index.ts";

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
 * Path of the Cloud Agent service in the online page (same origin as the page).
 *
 * It used to be defined in `src/ai/cloud/endpoint.ts` (closed source), but the public file
 * `src/start/browseChats.ts` needs it. It is only a path constant with no cloud implementation in
 * it, so it was moved up to be defined in one place on the public side, and `endpoint.ts` takes it
 * from here, to avoid the two sides each keeping a copy that later drifts apart (that is exactly how
 * C2 of task C drifted).
 */
export const ONLINE_AGENT_PATH = "/agent/v1";

export const CLOUD_OFF_STATE: CloudAgentState = Object.freeze({
  ...CLOUD_OFF,
  projectId: null,
  identityVersion: 0,
  accountMode: false,
  accountId: null,
});

/* ---------------- Pure error and session-control helpers (originally in `src/ai/cloud/cloudApi.ts` and `src/ai/cloud/consent.ts`) ---------------- */

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
    super(tr("Read and confirm the notice before using Cloud Agent."));
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
  if (!isCurrent()) throw new CloudError("forbidden", tr("The account, project or chat has changed. Reload the current chat before continuing."), 403);
  return submit();
}

export function requireAccountAbortControl(runId?: string, requestId?: string): { runId: string; requestId: string } {
  if (!runId || !requestId) throw new CloudError("forbidden", tr("Stopping a cloud chat requires the current run id and request id."), 403);
  return { runId, requestId };
}

/**
 * Error codes in section 2.3 of the contract → text shown to the user. If the server supplies its
 * own explanation (quota, reason), the server's is used
 */
export function cloudErrorText(code: string, serverMessage?: string): string {
  switch (code) {
    case "unauthorized":
      return tr("Cloud Agent can't connect right now: authentication failed. Refresh the page or re-enter the project.");
    case "no-identity":
      return tr("Cloud Agent is unavailable right now: no identity credentials have been obtained yet.");
    case "forbidden":
      return tr("You don't have permission to use Cloud Agent for this project.");
    case "disabled":
      return tr("The project creator has turned off the Cloud Agent.");
    case "busy":
      return tr("The Cloud Agent is busy. Please try again later.");
    case "busy-conversation":
      return tr("This chat still has a round in progress. Wait for it to finish or stop it first.");
    case "quota-exceeded":
      return serverMessage || tr("This project's Cloud Agent quota has been used up.");
    case "no-model-key":
      return tr("Cloud Agent has no model configured yet. Contact the host.");
    case "too-large":
      return tr("The message is too long for Cloud Agent to accept. Shorten it and send again.");
    case "bad-grant":
      return tr("Authorization for this chat has expired. Please send again.");
    case "unavailable":
      return serverMessage || tr("Cloud Agent can't reach the document service right now. Try again later.");
    case "network":
      return tr("Can't reach the Cloud Agent service. Check your network.");
    // The limit of 50 chats and deletion (texts are collected in chatTexts.ts, confirmed by the user,
    // 2026-10-13); the purge-failed and creator-required messages were newly drafted on 2026-10-13 and
    // are listed in the report's text table
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
    // The server's notice check failed on receiving the message (the notice state changed between the
    // page's read and the send): the page also pops up the notice dialog at the same time
    case "consent-required":
      return tr("Read and confirm the notice before using Cloud Agent.");
    default:
      return serverMessage || tr("Cloud Agent error ({0}).", code);
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

/* ---------------- Seam interface definitions ---------------- */

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
 * The permit issued for the current send after one verified read. Outside code passes it around as
 * an opaque object; its authenticity is decided by the `WeakMap` in `consent.ts`.
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
  /**
   * Whether the chat has a round that has not finished (the server is still running, regardless of
   * whether the stream is connected at the moment)
   */
  streaming: boolean;
  connection: "idle" | "connecting" | "live" | "reconnecting";
  /** Reasons to show the user, such as cannot connect or wrong identity; cleared once connected */
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
  /**
   * What the page should show the user (send failed, identity not ready, the project turned the
   * switch off); cleared when the user dismisses it or on the next action
   */
  notice: string | null;
  clearNotice: () => void;
  /** Show the user one line (the page's own hints such as "some attachments were not included") */
  notify: (text: string) => void;
  conversationId: string;
  /** `files`: the attachments already uploaded (those returned by `attach`); their `url` goes to the
   *  server with the message, and the name is shown in this page's bubble.
   *  `staged`: the local bubble first put into the chat with `stage`; when it cannot be sent it is
   *  marked "not sent" */
  /**
   * `consentPermit`: the one-time permit issued by `grantCloudConsent` at the start of the same send;
   * if it is valid, the notice is not read from the account service a second time.
   */
  send: (
    text: string,
    files?: ChatAttachment[],
    staged?: string,
    consentPermit?: CloudConsentPermit | null,
    opts?: { queueOnNetwork?: boolean },
  ) => Promise<boolean>;
  /**
   * Account mode: the moment send is clicked, first puts a local bubble into the chat (optimistic
   * display) and returns its number; returns null when there is no session
   */
  stage: (text: string, files?: ChatAttachment[]) => string | null;
  /**
   * The local bubble was blocked before being sent (notice not confirmed, chat already switched
   * away, etc.): mark it as not sent
   */
  failStaged: (id: string, reason: string) => void;
  /**
   * Offline outbox (outbox.ts, present only with `useCloudChat({ outbox: true })`):
   * `offline()` the browser is offline right now; `mustQueue()` this chat already has queued items
   * (a newly sent message must queue behind them so the order stays intact);
   * `enqueue` queues the local bubble placed when send was clicked (it is sent automatically once the
   * network is back); `resend` runs a message that was not sent through the flow again by the current
   * state; `transient(err)` whether this error is the offline kind (cannot be sent now, but can be once
   * the network is back).
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
  /**
   * Upload a file to this chat's working directory (works even if the chat has not sent a message
   * yet); throws `CloudError` on error
   */
  attach: (file: File, signal?: AbortSignal) => Promise<CloudAttachmentInfo>;
  abort: (runId?: string, requestId?: string) => Promise<void>;
  switchVisibility: (visibility: "shared" | "private", requestId: string) => Promise<CloudChatItem>;
  newChat: () => void;
  openChat: (id: string) => void;
  /**
   * Delete a cloud chat (account mode). Use the same requestId for one deletion: when the task has
   * not stopped cleanly yet (agent-fence-pending) it throws, and the UI retries with the same request
   * id. On success, if the deleted chat is the one currently open, it falls back to a new chat
   * automatically.
   */
  removeChat: (id: string, requestId: string) => Promise<{ already: boolean }>;
  history: {
    items: CloudChatItem[];
    loading: boolean;
    refresh: (silent?: boolean, maxAgeMs?: number) => Promise<boolean>;
    /**
     * This project's chat list has been loaded (shared by several tabs; reading starts on entering the
     * project, so it is usually already there when a tab is opened)
     */
    loaded: boolean;
    /**
     * Number of chats this account has opened itself in this project (shared chats count under the
     * person who opened them); creating new ones is blocked once it reaches `limit` (50 for an account,
     * 1 for a guest)
     */
    ownedCount: number;
    atLimit: boolean;
    /** What this limit is: 50 for an account, 1 for a guest (`chatLimitOf`) */
    limit: number;
    /**
     * The current identity is a guest: when the quota is full, the UI does not say "delete a few, then
     * create" but "a guest can open only one chat per project; register an account to open more", and
     * the new-chat entry is grayed out
     */
    guest: boolean;
  };
  revoked?: boolean;
  model: string;
  setModel: (m: string) => void;
  /** Thinking effort; empty string = default (parameter not sent, the model's own default applies) */
  effort: string;
  setEffort: (e: string) => void;
}

export interface UseCloudChatOptions {
  tabId: string;
  cloud: CloudAgentState;
  enabled: boolean;
  autoAttach: boolean;
  initialConversation?: string | null;
  /**
   * Enable the offline outbox (effective only in account mode): messages sent while offline are
   * queued and sent automatically once the network is back
   */
  outbox?: boolean;
  /**
   * Preparation done on attachments before a queued message is actually sent (images, video and
   * audio are put into the media library, the same step as when send is clicked)
   */
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
   * List the chats in a cloud project. **Not a React hook**: `src/start/browseChats.ts` and its Node
   * unit tests call it directly, so it gets a slot of its own and cannot be put into the group of
   * hooks above.
   * The community edition returns an empty list by default: no cloud projects, hence no cloud chats.
   */
  // The shape of the parameters follows `CloudApiDeps` in `src/ai/cloud/cloudApi.ts` (a subset of it).
  // This is the interface the public side declares to the outside; if its shape does not match the
  // cloud implementation, the compiler should report it, not leave it until runtime
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

/* ---------------- Community edition default fallback implementation (in effect when no cloud provider is registered) ---------------- */

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

/* ---------------- Outward forwarding entry points (for the public-layer UI to call directly) ---------------- */

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

/* ---------------- Extension table normalization helpers (for the registering side or `extensionsLoad.mjs`) ---------------- */

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
