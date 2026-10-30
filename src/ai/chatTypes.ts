/**
 * 云端 Agent 服务的接口形状(契约 2.3、2.4 节);以 `server/agent-service/http.mjs` 的实际回包为准,只多不少地容错
 *
 * （原在 `src/ai/cloud/types.ts`、`src/ai/cloud/events.ts`、`src/ai/cloud/endpoint.ts`、`src/ai/cloud/useCloud.ts`，
 * 通用类型与纯判定函数上移至公开侧 `src/ai/chatTypes.ts`）
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
  /** 托管方配置的模型;一个或没有时界面不给选 */
  models: CloudModelChoice[];
  defaultModel: string | null;
  /** 云端认的思考强度档位(不含「默认」);没有时界面不给选 */
  efforts?: string[];
  /** 这位成员在这个项目里还在跑的对话 id */
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
  /** 账号模式：对话里此刻有任务在跑(文档服务给的 currentRunId)；删除前的确认据此提醒 */
  running?: boolean;
  /** 账号模式：删除办到一半(任务还没停稳)，对话停在「正在删除」，只有删它的人能继续 */
  deleting?: boolean;
  /** 正在删它的那个账号(删到一半、任务还没停稳时);就是它自己的页面在重新打开后接着办 */
  deletingBy?: string;
  id: string;
  title: string;
  /** 毫秒;服务端没给时是 0 */
  updatedAt: number;
  state: CloudChatState;
  lastSeq: number;
  startedOn?: string | null;
  reason?: string | null;
}

/** 事件流里的一个事件(契约 2.4 节);字段按类型取 */
export interface CloudEvent {
  type: string;
  seq?: number;
  runId?: string;
  [k: string]: unknown;
}

/** 页面状态:发消息时带上的播放头与选区(契约 9.4) */
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
  /** 已经传到这个对话工作目录里的附件(`POST …/attachments` 回包里的 `url`);服务端只认工作目录里真有的 */
  attachments?: { url: string }[];
  /** 发这条消息的那张页面的页面号(契约第 28 节):带了,这一轮里云端 Agent 才能经反向通道让这张页面执行播放头等操作 */
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
  /** 文档服务签的终态(结清以后才有;旧服务端不带) */
  outcome?: { status: string; reason: string | null } | null;
}
export interface CloudQueueSnapshot {
  conversationId: string; queueRevision: number; aclRevision: number;
  currentRunId: string | null; items: CloudQueueItem[];
}
export interface CloudSender { accountId: string; name: string }

/** 别人删了和你有关的对话以后，文档服务留给你的通知（打开项目时取、弹完回执） */
export interface CloudNotice {
  noticeId: string;
  conversationId: string;
  title: string;
  deletedByAccountId: string;
  deletedByName: string;
  /** 删的人是开这个对话的人(owner)，还是项目创建者(creator) */
  deletedByRole: "owner" | "creator";
  /** 你是开这个对话的人(owner)，还是在共有对话里发过消息的成员(participant) */
  recipientRole: "owner" | "participant";
  createdAt: number;
}

/* ---------------- 消息 id 与队列空闲排头纯函数（原在 `src/ai/cloud/events.ts`） ---------------- */

export const userMessageId = (runId: string) => `cu-${runId}`;
export const accountMessageId = (messageId: string) => `cq-${messageId}`;
export const assistantMessageId = (runId: string) => `ca-${runId}`;

/**
 * 对话空闲(没有在跑的一轮)时排在第一位的那条消息马上就要开始,不算「排队」:界面不把它列进队列,
 * 只在它自己的气泡下写一行「已发出，等待云端开始处理…」(`sendState: "accepted"`);开始跑了、或前面有别人的一轮在跑时去掉这行。
 * 前面有一轮在跑时照旧显示排在第几(2026-10-08 用户定「界面显示排在第几」)。同一份快照折几次结果相同。
 */
export function isIdleHead(queue: CloudQueueSnapshot | null | undefined, item: CloudQueueItem): boolean {
  return Boolean(queue && !queue.currentRunId && item.state === "queued" && item.position === 1);
}

/* ---------------- 端点可用性与状态形状（原在 `src/ai/cloud/endpoint.ts`、`src/ai/cloud/useCloud.ts`） ---------------- */

export interface CloudAgentEndpoint {
  /** 这个项目背后有云端 Agent 服务(「云端」一项该不该出现) */
  available: boolean;
  /** 创建者没关开关(关着时「云端」一项在、置灰、写原因) */
  enabled: boolean;
  /** Agent 服务的 `/v1` 根地址,不带末尾斜杠 */
  url: string | null;
}

export const CLOUD_OFF: CloudAgentEndpoint = Object.freeze({ available: false, enabled: false, url: null });

export interface CloudAgentState extends CloudAgentEndpoint {
  /** 此刻连着的共享项目号;没连共享项目是 null */
  projectId: string | null;
  /** 身份接口位被(重新)注入的次数:身份晚于「云端可用」才就绪时,据此重新取一次 */
  identityVersion: number;
  accountMode: boolean;
  accountId: string | null;
}
