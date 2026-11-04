/**
 * Interface shape of Cloud Agent service (contract sections 2.3 and 2.4); based on actual
 * responses from `server/agent-service/http.mjs`, accepting extra fields for fault tolerance
 *
 * (formerly in `src/ai/cloud/types.ts`, `src/ai/cloud/events.ts`, `src/ai/cloud/endpoint.ts`,
 * `src/ai/cloud/useCloud.ts`, common types and pure predicate functions moved up to public side
 * `src/ai/chatTypes.ts`)
 */
import type { ChatMessage } from "./types.ts";

/** Account event rows carry the immutable doc grant binding; seq is eventSeq. */
export interface CloudAcceptedBinding {
  projectId: string; conversationId: string; messageId: string; senderAccountId: string;
}
export interface CloudRunBinding extends CloudAcceptedBinding {
  runId: string; runGrantId: string; instanceId: string; instanceGeneration: number; serviceKid: string;
}
export type CloudAccountMessage = ChatMessage & {
  cloudAccepted?: CloudAcceptedBinding;
  cloudRun?: CloudRunBinding;
  cloudAcceptedMessageId?: string;
  cloudSettlement?: 'pending';
};

export interface CloudModelChoice {
  id: string;
  label?: string;
}

export interface CloudInfo {
  accountMode?: boolean;
  executorMounted?: boolean;
  enabled: boolean;
  /** Model configured by host; not selectable in UI when there is only one or none */
  models: CloudModelChoice[];
  defaultModel: string | null;
  /** Thinking effort tiers recognized by cloud (excluding "default"); not selectable in UI when none */
  efforts?: string[];
  /** ID of chat still running for this member in this project */
  running: string[];
  limits: { rounds?: number; runMs?: number };
  usage?: { tokens?: number; limitTokens?: number | null };
}

export type CloudChatState = "idle" | "running" | "interrupted" | "failed" | "revoked";

export interface CloudChatItem {
  projectId?: string;
  ownerAccountId?: string;
  visibility?: 'shared' | 'private';
  creatorReadOnly?: boolean;
  queueRevision?: number;
  /** Account mode: a task is currently running in chat (currentRunId provided by document service); pre-deletion confirmation warns based on this */
  running?: boolean;
  /** Account mode: deletion is halfway done (task has not fully stopped yet), chat stays at "Deleting", only the person deleting it can continue */
  deleting?: boolean;
  /** The account currently deleting it (when partially deleted and task has not fully stopped); its own page resumes processing after reopening */
  deletingBy?: string;
  id: string;
  title: string;
  /** Milliseconds; 0 if not provided by server */
  updatedAt: number;
  state: CloudChatState;
  lastSeq: number;
  startedOn?: string | null;
  reason?: string | null;
}

/** An event in the event stream (contract section 2.4); fields retrieved by type */
export interface CloudEvent {
  type: string;
  seq?: number;
  runId?: string;
  [k: string]: unknown;
}

/** Page state: playhead and selection included when sending message (contract 9.4) */
export interface CloudPageState {
  t: number;
  selection: string[];
}

export interface CloudSendBody {
  requestId?: string;
  selectionSnapshot?: { pageId: string };
  prompt: string;
  model?: string;
  effort?: string;
  creativity?: string | null;
  script?: string;
  library?: unknown[];
  pageState?: CloudPageState;
  /** Attachments already uploaded to this chat working directory (`url` in `POST …/attachments` response); server only recognizes those actually in working directory */
  attachments?: { url: string }[];
  /** Page id of the page that sent this message (contract section 28): when present, Cloud Agent can instruct this page to perform playhead and other operations via reverse channel in this round */
  pageId?: string;
}

export interface CloudSendAccepted {
  runId: string | null; seq: number;
  messageId?: string; queuePosition?: number; queueRevision?: number;
}
export interface CloudQueueItem {
  messageId: string; arrivalSeq: number;
  state: 'queued' | 'preparing' | 'running' | 'cancelled' | 'done';
  position: number | null; runId: string | null;
  /** Final state signed by document service (only present after settlement; older servers do not include it) */
  outcome?: { status: string; reason: string | null } | null;
}
export interface CloudQueueSnapshot {
  conversationId: string; queueRevision: number; aclRevision: number;
  currentRunId: string | null; items: CloudQueueItem[];
}
export interface CloudSender { accountId: string; name: string }

/** Notice left for you by document service after someone deleted a chat related to you (fetched when opening project, acknowledged after popup) */
export interface CloudNotice {
  noticeId: string;
  conversationId: string;
  title: string;
  deletedByAccountId: string;
  deletedByName: string;
  /** Whether the person deleting is the person who opened this chat (owner) or project creator (creator) */
  deletedByRole: "owner" | "creator";
  /** Whether you are the person who opened this chat (owner) or a member who sent messages in a shared chat (participant) */
  recipientRole: "owner" | "participant";
  createdAt: number;
}

/* ---------------- Pure functions for message id and queue idle head (formerly in `src/ai/cloud/events.ts`) ---------------- */

export const userMessageId = (runId: string) => `cu-${runId}`;
export const accountMessageId = (messageId: string) => `cq-${messageId}`;
export const assistantMessageId = (runId: string) => `ca-${runId}`;

/**
 * When chat is idle (no round running), the first message in line is about to start and does not
 * count as "queuing": UI does not list it in queue, only writes a line "Sent, waiting for cloud
 * to process…" (`sendState: "accepted"`) under its own bubble; removes this line once it starts
 * running or someone else's round is running ahead. 
 * When a round is running ahead, shows position in line as usual (user decision, 2026-10-08:
 * "UI shows position in queue"). Folding the same snapshot multiple times produces identical
 * results.
 */
export function isIdleHead(queue: CloudQueueSnapshot | null | undefined, item: CloudQueueItem): boolean {
  return Boolean(queue && !queue.currentRunId && item.state === "queued" && item.position === 1);
}

/* ---------------- Endpoint availability and state shape (formerly in `src/ai/cloud/endpoint.ts`, `src/ai/cloud/useCloud.ts`) ---------------- */

export interface CloudAgentEndpoint {
  /** Whether this project is backed by Cloud Agent service (whether the "Cloud" item should appear) */
  available: boolean;
  /** Creator did not turn off toggle (when off, "Cloud" item is present, grayed out, with reason) */
  enabled: boolean;
  /** Root address `/v1` of Agent service, without trailing slash */
  url: string | null;
}

export const CLOUD_OFF: CloudAgentEndpoint = Object.freeze({ available: false, enabled: false, url: null });

export interface CloudAgentState extends CloudAgentEndpoint {
  /** Currently connected shared project id; null if not connected to a shared project */
  projectId: string | null;
  /** Number of times identity interface slot was (re)injected: re-fetched based on this if identity becomes ready later than "cloud available" */
  identityVersion: number;
  accountMode: boolean;
  accountId: string | null;
}
