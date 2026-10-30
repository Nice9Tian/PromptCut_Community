export type AiProvider = "claude" | "agy" | "codex" | "api";

export interface AuthInfo {
  loggedIn: boolean | null;
  detail?: string;
  fixHint?: string;
  loginCommand?: string[];
  status?: 'invalid' | 'unknown';
  reason?: string;
  authGeneration?: string;
  persistenceWarning?: string;
}

export interface ProviderInfo {
  id: AiProvider;
  label: string;
  available: boolean;
  version?: string;
  path?: string;
  note?: string;
  auth?: AuthInfo;
}

export type ApiVendor = "anthropic" | "openai" | "gemini";

export type LoginState = "idle" | "waiting" | "ok" | "timeout" | "failed";

/** API Key 的两路来源:自定义 API 里自己填的 / Router 分发密文导入的。各自加密、各自成文件,不混用 */
export type KeyKind = "custom" | "router";

/** 一路的连接配置。model 用 | 分隔多个备选,面板输入框旁的模型选择器按它列 */
export interface ApiProfile {
  vendor: ApiVendor;
  baseUrl: string;
  model: string;
}

export interface KeyState { set: boolean; last4: string }

export interface PublicAiConfig {
  version: number;
  defaultProvider: AiProvider | null;
  api: {
    vendor: ApiVendor;
    baseUrl: string;
    model: string;
    maxTokens: number;
    /** 当前生效的那一路的 Key(脱敏) */
    apiKey: KeyState;
    /** 当前生效的是哪一路;没设 Key 时为空串 */
    source: KeyKind | "";
    /** 两路各自的连接配置;上面的 vendor / baseUrl / model 是生效那一路的镜像。老服务端没有这个字段 */
    profiles?: Record<KeyKind, ApiProfile>;
  };
  /** 两路各自存没存 Key */
  keys: Record<KeyKind, KeyState>;
  /** 三家 CLI 各自的可选模型清单,用 | 分隔 */
  cliModels: { claude: string; codex: string; agy: string };
  toolProtocol: boolean;
  /**
   * 「深度自主」开着时这一次运行最多跑多少轮。**0 = 不限**。老服务端没有这个字段,
   * 界面按 300 显示。没开深度自主时它不起作用,走各条路自己的常规上限。
   */
  deepAutoRounds?: number;
  /** CLI 额度熔断(Claude Code / Codex):任一用量窗口到 thresholdPercent 就中断;每新增 checkEveryBytes 字节重查。老服务端没有这个字段 */
  quota?: QuotaConfig;
}

export interface QuotaConfig {
  enabled: boolean;
  thresholdPercent: number;
  checkEveryBytes: number;
}

/** /api/ai/quota 返回的用量 */
export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsText: string | null;
  resetsAt: number | null;
}
export interface QuotaInfo {
  provider: string;
  label: string;
  supported: boolean;
  ok: boolean;
  checkedAt: number;
  windows: QuotaWindow[];
  maxUsedPercent: number | null;
  worst: QuotaWindow | null;
  planType?: string;
  error?: string;
}

export interface AiConfigPatch {
  defaultProvider?: AiProvider | null;
  api?: {
    vendor?: ApiVendor;
    baseUrl?: string;
    model?: string;
    maxTokens?: number;
    apiKey?: string | null;
    /** 这次的 Key 写进哪一路(缺省 custom);不带 apiKey 时表示切换生效的那一路 */
    source?: KeyKind | "";
    /** 显式改某一路的连接配置,不受 source 影响 */
    profiles?: Partial<Record<KeyKind, Partial<ApiProfile>>>;
  };
  cliModels?: Partial<{ claude: string; codex: string; agy: string }>;
  toolProtocol?: boolean;
  /** 「深度自主」下的轮次上限;0 = 不限 */
  deepAutoRounds?: number;
  quota?: Partial<QuotaConfig>;
}

export interface SttInfo {
  engine: string;
  available: boolean;
  hint?: string;
}

export type RunEvent =
  | { type: "run"; runId: string }
  | { type: "session"; sessionId: string }
  | { type: "text"; delta: string }
  /** 模型的思考过程。和正文分开走,默认不显示,勾了「显示思考」才渲染 */
  | { type: "thinking"; delta: string; round?: number }
  | { type: "tool_call"; name: string; input?: unknown; callId?: string; round?: number }
  | { type: "tool_result"; name: string; ok: boolean; summary?: string; files?: string[]; callId?: string; output?: unknown; durationMs?: number; round?: number }
  | ({ type: "progress" } & RunProgress)
  | { type: "diagnostic"; stage: string; data?: unknown; callId?: string }
  | { type: "status"; text: string }
  | { type: "done"; sessionId?: string; usage?: unknown; outcome?: string; completed?: number; failed?: number }
  /**
   * 出错。
   *
   * `retryable` 是**驱动那边**判定的:这一轮是不是「接着说就有可能成」的那种中断
   * (比如 agy 把自己的内建工具拒了之后直接放弃,什么都没产出)。
   * 密钥错、模型名错、额度用光这些不带这个标记 —— 它们重试一百次也是同一个结果,
   * 自动续跑只会空烧额度。
   *
   * `retryPrompt` 是续跑时要发的那句话,**由驱动把中断原因拼进去**,前端原样发出去。
   * 这样模型不用自己开口问「刚才怎么了」,上下文直接摆在它面前。
   */
  | { type: "error"; message: string; retryable?: boolean; retryPrompt?: string; authProvider?: 'codex'; authReason?: string; authGeneration?: string };

export interface ChatAttachment {
  url: string;
  name: string;
  kind: "video" | "srt" | "json" | "other" | "image" | "audio" | "text" | "pdf";
  text?: string;
  durationSec?: number;
  id?: string;
  mime?: string;
  bytes?: number;
  srcPath?: string | null;
  path?: string;
  status?: "importing" | "ready" | "error";
  error?: string;
  jobId?: string;
  conversationId?: string;
  /**
   * 素材库里已经有的素材(不是用户这一轮用「+」发的附件)。
   * 这一类的 url 是卡片能直接引用的 /@media/<文件名>,服务端按「素材库」单列一段,不给磁盘路径。
   */
  library?: boolean;
  /** 云端对话的附件发送时由页面放进了素材库:素材库里的哪一条(随消息告诉 Agent 直接用它) */
  inLibrary?: { mediaId: string; url: string };
  /** 云端对话的附件没能放进素材库的原因(随消息告诉 Agent) */
  libraryError?: string;
}

export interface ToolCallInfo {
  callId?: string;
  durationMs?: number;
  name: string;
  input?: unknown;
  ok?: boolean;
  summary?: string;
  files?: string[];
  expanded?: boolean;
}

/**
 * 一条助手消息里按**发生顺序**排列的片段。
 * 只有 text / tools / statuses 三个数组时,渲染只能把文字全堆在最上面、
 * 工具调用全堆在下面,时序丢失——一轮里有多次工具调用时,用户滚到底只看得见工具块,
 * 看不见回复。parts 保留真实顺序,详细模式按它渲染。
 */
export type MessagePart =
  | { kind: "text"; text: string }
  /** 思考片段:和 text 一样按发生顺序插在 parts 里,渲染时由「显示思考」开关决定显不显示 */
  | { kind: "thinking"; text: string }
  | { kind: "status"; text: string }
  | ({ kind: "tool" } & ToolCallInfo);

/**
 * 这条回复实际是拿什么跑出来的。
 *
 * 必须逐条记,不能只记「现在选的是什么」:模型 / 推理档 / 加速档都是**发送那一刻
 * 现读**的(见 modelOptions.readChoice),用户中途换一次,同一段对话里前后几条就
 * 来自不同的模型;分工模式下还会按角色临时改用别家。排查时只看当前选择会认错人。
 */
export interface MessageRuntime {
  provider: AiProvider;
  /** 空 = 用该驱动自己的默认模型 */
  model: string;
  /** 推理强度档;空 = 跟随驱动自己的默认 */
  effort: string;
  /** 加速档(目前只有 Claude Code 有) */
  fast: boolean;
  /** 深度自主:轮次上限放宽到 300,且不给模型任何轮次提示 */
  deepAuto?: boolean;
  /** 文本协议模式:工具调用写在回复正文里。工具相关的异常先看这一条 */
  toolProtocol: boolean;
}

/** 其他 Agent 用 send_message 发来的一条消息 */
export interface InboundAgentMessage {
  /** 发来的 Agent 的对话 ID;不知道时是「未知」 */
  from: string;
  text: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /**
   * 这条用户消息其实是其他 Agent 发来的(AiPanel 自动投递时带上,text 仍是给模型看的 agentBus.formatInbound 全文)。
   * 界面据此不画用户气泡,交给紧跟着的回复在操作详细预览控件里展示;不靠正文前缀认,用户自己发的消息不会被误判。
   */
  inbound?: InboundAgentMessage[];
  /**
   * 这条回复是哪个角色产出的(角色的 id,如 director;旧记录里分工模式的角色回复带它)。
   * 界面用它取头像和角色名;普通对话没有这个字段,退回中性的「AI 助手」。
   */
  roleId?: string;
  /** 纯文字部分的拼接;简洁模式和会话历史都用它 */
  text: string;
  /**
   * 云端对话里这一页刚发出、服务端的记录还没回来的那条用户消息(乐观显示,`src/ai/cloud/session.ts` 的 `stage`):
   * `sending` 正在发、`accepted` 云端已收下、等它开始处理、`failed` 没发出去(原因在 `error`)、
   * `queued` 断网时发的、排着等网络恢复后自动发出(`src/ai/cloud/outbox.ts`)。
   * 服务端的记录到了就换成它,这个字段跟着本地气泡一起消失。
   */
  sendState?: "sending" | "accepted" | "failed" | "queued";
  /** 断网待发里不发了的那条(`sendState: "failed"`):气泡上带「重新发送」 */
  resendable?: boolean;
  attachments?: ChatAttachment[];
  /** 按发生顺序的片段,渲染以它为准;旧历史里没有时由 text/tools/statuses 兜底 */
  parts?: MessagePart[];
  tools?: ToolCallInfo[];
  statuses?: string[];
  error?: string;
  pending?: boolean;
  startedAt?: number;
  finishedAt?: number;
  progress?: RunProgress;
  outcome?: string;
  usage?: unknown;
  /** 这条回复用的模型/推理档/加速档/文本协议。旧历史里没有,报告里显示为「未记录」 */
  runtime?: MessageRuntime;
  /** 云端对话(`src/ai/cloud/events.ts`):这条回复折到过的最大事件序号,重复到达的事件据此只折一次 */
  cloudSeq?: number;
  /** 云端对话:这一轮的改动引出的预渲染重试此刻的进展(契约 cloud-agent-contract.md 第 16 节),气泡末尾常驻一行;失败与暂不可用用出错的样式 */
  cloudRender?: { state: string; text: string };
  trace?: { at: string; event: RunEvent }[];
  traceTruncated?: boolean;
  traceBytes?: number;
}

export interface RunProgress {
  phase: string;
  text: string;
  round?: number;
  maxRounds?: number;
  completed?: number;
  failed?: number;
  elapsedMs?: number;
  callId?: string;
  jobId?: string;
  waitingJobs?: boolean;
  waitingTimeout?: boolean;
}

export interface CliSetupJob {
  id: string;
  provider: AiProvider;
  kind: "install" | "login";
  state: "running" | "succeeded" | "failed";
  message: string;
  logs: string[];
  url?: string;
  deviceCode?: string;
  /** 这条登录任务的标准输入接着，能接用户粘贴的授权码（只有 Claude Code 的登录有；任务一结束就变 false） */
  acceptsCode?: boolean;
}
