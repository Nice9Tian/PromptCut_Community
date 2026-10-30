/**
 * 云端对话的诊断报告〔用户 2026-10-07 定〕:云端模式下「诊断报告」照常能用,内容是这段云端对话的过程、出错的原因、
 * 客户端与版本信息;**不含任何凭证**:委托票据、对话委托、模型 Key、请求头里的 Bearer 一概不进。
 *
 * 纯函数,不碰网络、不碰 store:对话消息(由云端事件重建的 `ChatMessage`)、会话状态、`info` 都由调用方传进来,Node 单测直接用。
 * 报告在页面里生成,不经任何 `/api/*`:在线页面用它就不违反「在线页面不请求编辑器进程的 `/api/*`」;桌面版同一份。
 *
 * 脱敏分三道:
 *   1. 键名:`grant`、`ticket`、`delegation` 之类的字段整条抹掉(这一版的消息里本来就没有,留着防以后有人往里放);
 *   2. `redactDebug`(`../debug.ts`,本机诊断报告用的同一个):Bearer、`sk-` 开头的 Key、带 key/token/secret 的查询参数、家目录;
 *   3. 云端补的几种形状:委托票据与对话委托是 `v1.<段>.<段>`(`server/auth/tickets.mjs`),再加 `AIza…` 一类的 Key。
 *      最后对整份 JSON 文本再扫一遍,哪里溜进来的都挡得住。
 *
 * （原在 `src/ai/cloud/report.ts`，上移至公开侧 `src/ai/cloudReport.ts`）
 */
import type { ChatMessage, MessagePart } from "./types.ts";
import { redactDebug } from "./debug.ts";
import type { CloudInfo } from "./chatTypes.ts";

export interface CloudReportSessionView {
  streaming: boolean;
  connection: "idle" | "connecting" | "live" | "reconnecting";
  problem: string | null;
  lastSeq: number;
}

export const CLOUD_REPORT_FORMAT = "PromptCut cloud conversation debug v1";

/** 单个字符串字段最长留多少字(工具入参里可能有整段文案);超了截断并写明 */
const FIELD_LIMIT = 4000;

/** 键名一出现就整条抹掉的字段(不看值) */
const SECRET_KEY = /^(grant|ticket|delegation|delegate|authorization|bearer|token|secret|key|apikey|api_key|password|cookie)$/i;

/** 委托票据与对话委托的形状:`v1.<base64url>.<base64url>`(`server/auth/tickets.mjs`、`delegation.mjs`) */
const TICKET_SHAPE = /\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
/** 模型 Key 的另几种常见形状(`sk-` 开头的 `redactDebug` 已处理) */
const KEY_SHAPES = [/\bAIza[0-9A-Za-z_-]{20,}/g, /\bsk-[A-Za-z0-9_-]{8,}/g, /\bxai-[A-Za-z0-9_-]{16,}/g, /\bgsk_[A-Za-z0-9]{16,}/g];

/** 把一段文本里票据形状与 Key 形状的串换掉 */
export function scrubCloudSecrets(text: string): string {
  let out = text.replace(TICKET_SHAPE, "[TICKET-REDACTED]");
  for (const re of KEY_SHAPES) out = out.replace(re, "[KEY-REDACTED]");
  return out;
}

function walk(v: unknown, depth = 0): unknown {
  if (typeof v === "string") {
    const s = scrubCloudSecrets(v);
    return s.length > FIELD_LIMIT ? `${s.slice(0, FIELD_LIMIT)}…(已截断,原 ${s.length} 字)` : s;
  }
  if (depth > 8) return "[层级过深,已省略]";
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => walk(x, depth + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEY.test(k) ? "[REDACTED]" : walk(x, depth + 1)]));
  }
  return v;
}

export interface CloudReportClient {
  mode: "online" | "desktop";
  userAgent?: string;
  language?: string;
  platform?: string;
  viewport?: { width: number; height: number; dpr?: number } | null;
  /** 在线构建嵌进页面的代码版本;桌面构建没有 */
  codeVersion?: string | null;
}

export interface CloudReportInput {
  messages: ChatMessage[];
  conversationId: string;
  projectId?: string | null;
  /** Agent 服务的地址(页面打的那个);只留来源与路径 */
  serviceUrl?: string | null;
  view?: Pick<CloudReportSessionView, "streaming" | "connection" | "problem" | "lastSeq"> | null;
  info?: CloudInfo | null;
  /** 此刻选的模型(空 = 服务端缺省) */
  model?: string;
  /** 此刻选的思考强度(空 = 默认) */
  effort?: string;
  /** 页面上此刻挂着的提示(发送失败、身份没就绪、开关被关等) */
  notice?: string | null;
  client: CloudReportClient;
  now?: number;
}

interface ToolView { name: string; input?: unknown; ok?: boolean; summary?: string; durationMs?: number; callId?: string }

function toolsOf(m: ChatMessage): ToolView[] {
  const fromParts = (m.parts ?? []).filter((p): p is Extract<MessagePart, { kind: "tool" }> => p.kind === "tool");
  if (fromParts.length) {
    return fromParts.map((p) => {
      const t = (m.tools ?? []).find((x) => (p.callId ? x.callId === p.callId : x.name === p.name));
      return { name: p.name, callId: p.callId, input: p.input ?? t?.input, ok: p.ok, summary: p.summary, durationMs: p.durationMs ?? t?.durationMs };
    });
  }
  return (m.tools ?? []).map((t) => ({ name: t.name, callId: t.callId, input: t.input, ok: t.ok, summary: t.summary, durationMs: t.durationMs }));
}

/** 云端对话诊断报告的 JSON 文本(已脱敏)。每一轮 = 一条用户消息加紧随其后的那条回复 */
export function cloudConversationReport(input: CloudReportInput): string {
  const { messages } = input;
  const rounds: Record<string, unknown>[] = [];
  const errors: { round: number; message: string; outcome?: string }[] = [];
  let n = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    n++;
    const reply = messages[i + 1]?.role === "assistant" ? messages[i + 1] : undefined;
    if (reply?.error) errors.push({ round: n, message: reply.error, outcome: reply.outcome });
    rounds.push({
      round: n,
      user: m.text,
      reply: reply
        ? {
            text: reply.text,
            running: reply.pending === true,
            outcome: reply.outcome ?? (reply.pending ? "running" : undefined),
            error: reply.error,
            startedAt: reply.startedAt ? new Date(reply.startedAt).toISOString() : undefined,
            finishedAt: reply.finishedAt ? new Date(reply.finishedAt).toISOString() : undefined,
            durationMs: reply.startedAt && reply.finishedAt ? reply.finishedAt - reply.startedAt : undefined,
            usage: reply.usage,
            progress: reply.progress,
            tools: toolsOf(reply),
            statuses: reply.statuses ?? [],
            render: reply.cloudRender,
          }
        : null,
    });
  }

  let service: string | null = null;
  if (input.serviceUrl) {
    try { const u = new URL(input.serviceUrl, "http://localhost"); service = `${u.origin === "http://localhost" ? "" : u.origin}${u.pathname}`; } catch { service = null; }
  }

  const report = {
    format: CLOUD_REPORT_FORMAT,
    exportedAt: new Date(input.now ?? Date.now()).toISOString(),
    conversation: {
      id: input.conversationId,
      projectId: input.projectId ?? null,
      rounds: rounds.length,
      running: input.view?.streaming ?? messages.some((m) => m.pending === true),
      connection: input.view?.connection ?? null,
      lastSeq: input.view?.lastSeq ?? null,
      problem: input.view?.problem ?? null,
      pageNotice: input.notice ?? null,
    },
    errors,
    service: {
      url: service,
      enabled: input.info?.enabled ?? null,
      models: input.info?.models ?? null,
      defaultModel: input.info?.defaultModel ?? null,
      selectedModel: input.model || null,
      efforts: input.info?.efforts ?? null,
      selectedEffort: input.effort || null,
      limits: input.info?.limits ?? null,
      runningConversations: input.info?.running ?? null,
    },
    client: input.client,
    rounds,
    note: "这份报告在页面里生成,含这段云端对话的过程、出错原因和客户端信息;不含票据、委托、模型 Key 或任何凭证。过长的字段已截断并写明。",
  };
  const redacted = redactDebug(walk(report));
  return scrubCloudSecrets(JSON.stringify(redacted, null, 2));
}
