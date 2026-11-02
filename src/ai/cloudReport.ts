/**
 * Diagnostic report for cloud chats [user decision, 2026-10-07]: "diagnostic report" remains
 * available in cloud mode, covering the cloud chat process, error causes, client and version
 * info; **contains no credentials**: delegation tickets, chat delegations, model keys, and Bearer
 * headers are completely excluded.
 *
 * Pure function, touches neither network nor store: chat messages (`ChatMessage` reconstructed
 * from cloud events), session state, and `info` are passed in by the caller; directly usable by
 * Node unit tests. The report is generated in the page without going through any `/api/*`: online
 * pages using it do not violate "online pages do not request `/api/*` from the editor process";
 * identical copy for desktop app.
 *
 * Three redaction passes:
 *   1. Key names: entirely wipe fields like `grant`, `ticket`, `delegation` (not present in this
 *      version's messages anyway, kept to prevent future additions);
 *   2. `redactDebug` (`../debug.ts`, same one used by local diagnostic reports): Bearer, keys
 *      starting with `sk-`, query params with key/token/secret, home directory;
 *   3. Cloud additions: delegation tickets and chat delegations are `v1.<segment>.<segment>`
 *      (`server/auth/tickets.mjs`), plus keys like `AIza…`.
 *      Finally rescan the entire JSON text to catch anything that slipped in anywhere.
 *
 * (Originally in `src/ai/cloud/report.ts`, moved up to public side `src/ai/cloudReport.ts`)
 */
import type { ChatMessage, MessagePart } from "./types.ts";
import { redactDebug } from "./debug.ts";
import type { CloudInfo } from "./chatTypes.ts";
import { tr } from "../i18n/index.ts";

export interface CloudReportSessionView {
  streaming: boolean;
  connection: "idle" | "connecting" | "live" | "reconnecting";
  problem: string | null;
  lastSeq: number;
}

export const CLOUD_REPORT_FORMAT = "PromptCut cloud conversation debug v1";

/** Max length for a string field (tool args may contain full text); truncated with notice if exceeded */
const FIELD_LIMIT = 4000;

/** Fields wiped entirely once key name matches (regardless of value) */
const SECRET_KEY = /^(grant|ticket|delegation|delegate|authorization|bearer|token|secret|key|apikey|api_key|password|cookie)$/i;

/** Delegation ticket and chat delegation shape: `v1.<base64url>.<base64url>` (`server/auth/tickets.mjs`, `delegation.mjs`) */
const TICKET_SHAPE = /\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
/** Other common model key shapes (those starting with `sk-` are handled by `redactDebug`) */
const KEY_SHAPES = [/\bAIza[0-9A-Za-z_-]{20,}/g, /\bsk-[A-Za-z0-9_-]{8,}/g, /\bxai-[A-Za-z0-9_-]{16,}/g, /\bgsk_[A-Za-z0-9]{16,}/g];

/** Replace strings matching ticket and key shapes in a text */
export function scrubCloudSecrets(text: string): string {
  let out = text.replace(TICKET_SHAPE, "[TICKET-REDACTED]");
  for (const re of KEY_SHAPES) out = out.replace(re, "[KEY-REDACTED]");
  return out;
}

function walk(v: unknown, depth = 0): unknown {
  if (typeof v === "string") {
    const s = scrubCloudSecrets(v);
    return s.length > FIELD_LIMIT ? tr("{0}… (truncated, original {1} characters)", s.slice(0, FIELD_LIMIT), s.length) : s;
  }
  if (depth > 8) return tr("[nesting too deep, omitted]");
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
  /** Code version embedded in page by online build; absent in desktop build */
  codeVersion?: string | null;
}

export interface CloudReportInput {
  messages: ChatMessage[];
  conversationId: string;
  projectId?: string | null;
  /** Agent service address (hit by the page); retains only origin and path */
  serviceUrl?: string | null;
  view?: Pick<CloudReportSessionView, "streaming" | "connection" | "problem" | "lastSeq"> | null;
  info?: CloudInfo | null;
  /** Currently selected model (empty = server default) */
  model?: string;
  /** Currently selected thinking effort (empty = default) */
  effort?: string;
  /** Prompts currently displayed on the page (send failure, identity not ready, switch turned off, etc.) */
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

/** JSON text of cloud chat diagnostic report (redacted). Each round = user message plus immediate reply */
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
    note: tr("This report is generated in the page. It contains the course of this cloud chat, the cause of errors and client information; it does not contain tickets, delegations, model keys or any credentials. Fields that are too long are truncated and marked."),
  };
  const redacted = redactDebug(walk(report));
  return scrubCloudSecrets(JSON.stringify(redacted, null, 2));
}
