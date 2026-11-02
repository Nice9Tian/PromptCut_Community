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

/**
 * The two sources of an API Key: the one filled in by hand under custom API / the one imported
 * from a Router distribution string. Each is encrypted separately and kept in its own file; they
 * are never mixed
 */
export type KeyKind = "custom" | "router";

/**
 * The connection config of one source. model separates several alternatives with |, and the model
 * selector beside the panel's input box lists them from it
 */
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
    /** The Key of the source currently in effect (masked) */
    apiKey: KeyState;
    /** Which source is currently in effect; an empty string when no Key is set */
    source: KeyKind | "";
    /**
     * The connection config of each of the two sources; the vendor / baseUrl / model above mirror the
     * source in effect. Old servers do not have this field
     */
    profiles?: Record<KeyKind, ApiProfile>;
  };
  /** Whether each of the two sources has a Key stored */
  keys: Record<KeyKind, KeyState>;
  /** The selectable model list of each of the three CLIs, separated by | */
  cliModels: { claude: string; codex: string; agy: string };
  toolProtocol: boolean;
  /**
   * The maximum number of rounds a run may take when "deep autonomy" is on. **0 = unlimited**. Old
   * servers do not have this field, and the UI displays it as 300. When deep autonomy is off it has no
   * effect, and each route uses its own usual limit.
   */
  deepAutoRounds?: number;
  /**
   * CLI quota circuit breaker (Claude Code / Codex): interrupt when any usage window reaches
   * thresholdPercent; recheck for every checkEveryBytes of new bytes. Old servers do not have this
   * field
   */
  quota?: QuotaConfig;
}

export interface QuotaConfig {
  enabled: boolean;
  thresholdPercent: number;
  checkEveryBytes: number;
}

/** The usage returned by /api/ai/quota */
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
    /**
     * Which source this Key is written into (default custom); without apiKey it means switching which
     * source is in effect
     */
    source?: KeyKind | "";
    /** Explicitly change the connection config of a given source, independent of source */
    profiles?: Partial<Record<KeyKind, Partial<ApiProfile>>>;
  };
  cliModels?: Partial<{ claude: string; codex: string; agy: string }>;
  toolProtocol?: boolean;
  /** Round limit under "deep autonomy"; 0 = unlimited */
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
  /**
   * The model's thinking process. It travels separately from the body text and is hidden by default;
   * it is rendered only when "Show thinking" is checked
   */
  | { type: "thinking"; delta: string; round?: number }
  | { type: "tool_call"; name: string; input?: unknown; callId?: string; round?: number }
  | { type: "tool_result"; name: string; ok: boolean; summary?: string; files?: string[]; callId?: string; output?: unknown; durationMs?: number; round?: number }
  | ({ type: "progress" } & RunProgress)
  | { type: "diagnostic"; stage: string; data?: unknown; callId?: string }
  | { type: "status"; text: string }
  | { type: "done"; sessionId?: string; usage?: unknown; outcome?: string; completed?: number; failed?: number }
  /**
   * An error.
   *
   * `retryable` is determined **on the driver side**: whether this round is the kind of interruption
   * where "just continuing might work" (for example, agy gives up outright after rejecting its own
   * built-in tool, producing nothing).
   * Wrong keys, wrong model names and exhausted quotas do not carry this flag: retrying a hundred
   * times gives the same result, and automatic resuming would only burn quota for nothing.
   *
   * `retryPrompt` is the sentence to send when resuming, **with the interruption reason spliced in by
   * the driver**, and the frontend sends it out unchanged.
   * That way the model does not have to ask "what just happened" itself, and the context is laid out
   * in front of it directly.
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
   * Media that is already in the media library (not an attachment the user sent this round with "+").
   * For this kind, url is a /@media/<file name> that a card can reference directly, and the server
   * lists it in a separate "media library" section without giving disk paths.
   */
  library?: boolean;
  /**
   * A cloud chat attachment is put into the media library by the page when it is sent: which entry
   * in the media library it is (told to the Agent along with the message, so it uses it directly)
   */
  inLibrary?: { mediaId: string; url: string };
  /**
   * The reason a cloud chat attachment could not be put into the media library (told to the Agent
   * along with the message)
   */
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
 * The parts of an assistant message, arranged in **order of occurrence**.
 * With only the three arrays text / tools / statuses, rendering can only pile all the text at the
 * top and all the tool calls below it, and the timing is lost: when one round has several tool
 * calls, a user who scrolls to the bottom sees only tool blocks and not the reply. parts keeps the
 * true order, and detailed mode renders from it.
 */
export type MessagePart =
  | { kind: "text"; text: string }
  /**
   * Thinking part: like text, it is inserted into parts in order of occurrence, and whether it is
   * shown at render time is decided by the "Show thinking" switch
   */
  | { kind: "thinking"; text: string }
  | { kind: "status"; text: string }
  | ({ kind: "tool" } & ToolCallInfo);

/**
 * What this reply was actually produced with.
 *
 * It must be recorded per message, not just "what is selected now": the model / reasoning tier / fast
 * mode are all **read at the moment of sending** (see modelOptions.readChoice), so if the user
 * switches once midway, the messages before and after in the same chat come from different models;
 * and in split-work mode another provider is temporarily used per role. Looking only at the current
 * selection when troubleshooting would blame the wrong party.
 */
export interface MessageRuntime {
  provider: AiProvider;
  /** Empty = use that driver's own default model */
  model: string;
  /** Reasoning effort tier; empty = follow the driver's own default */
  effort: string;
  /** Fast mode (currently only Claude Code has it) */
  fast: boolean;
  /** Deep autonomy: the round limit is raised to 300, and the model is given no round hints */
  deepAuto?: boolean;
  /** Text protocol mode: tool calls are written in the reply body. For tool-related anomalies, check this one first */
  toolProtocol: boolean;
}

/** A message sent by another Agent with send_message */
export interface InboundAgentMessage {
  /** The chat ID of the sending Agent; "Unknown" when it is not known */
  from: string;
  text: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /**
   * This user message was actually sent by another Agent (attached by AiPanel on automatic delivery;
   * text is still the full agentBus.formatInbound text meant for the model).
   * The UI therefore does not draw a user bubble, and leaves it to the reply that follows to show it
   * in the operation-detail preview control; it is not recognized by a prefix in the body text, so a
   * message the user sent themselves is never misjudged.
   */
  inbound?: InboundAgentMessage[];
  /**
   * Which role produced this reply (the role's id, such as director; role replies in split-work mode
   * in old records carry it).
   * The UI uses it to get the avatar and role name; a normal chat has no such field and falls back to
   * the neutral "AI assistant".
   */
  roleId?: string;
  /** The concatenation of the plain text parts; both concise mode and the session history use it */
  text: string;
  /**
   * In a cloud chat, the user message this tab has just sent whose server record has not come back yet
   * (optimistic display, `stage` in `src/ai/cloud/session.ts`):
   * `sending` being sent, `accepted` the cloud has received it and is waiting to start processing,
   * `failed` not sent (the reason is in `error`), `queued` sent while offline, queued to be sent
   * automatically once the network is back (`src/ai/cloud/outbox.ts`).
   * When the server's record arrives it replaces this, and this field disappears along with the local
   * bubble.
   */
  sendState?: "sending" | "accepted" | "failed" | "queued";
  /**
   * The one in the offline outbox that will no longer be sent (`sendState: "failed"`): the bubble
   * carries "Resend"
   */
  resendable?: boolean;
  attachments?: ChatAttachment[];
  /**
   * The parts in order of occurrence, which rendering goes by; in old history where it is absent,
   * text/tools/statuses serve as the fallback
   */
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
  /**
   * The model / reasoning tier / fast mode / text protocol used for this reply. Absent in old history,
   * shown as "Not recorded" in the report
   */
  runtime?: MessageRuntime;
  /**
   * Cloud chat (`src/ai/cloud/events.ts`): the largest event sequence number this reply has been
   * folded up to, so that an event arriving repeatedly is folded only once
   */
  cloudSeq?: number;
  /**
   * Cloud chat: the current progress of the prerender retry triggered by the changes of this round
   * (contract cloud-agent-contract.md section 16), shown as a persistent line at the end of the bubble;
   * failure and temporarily unavailable use the error style
   */
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
  /**
   * The standard input of this login task is still attached and can take an authorization code pasted
   * by the user (only Claude Code's login has this; it becomes false as soon as the task ends)
   */
  acceptsCode?: boolean;
}
