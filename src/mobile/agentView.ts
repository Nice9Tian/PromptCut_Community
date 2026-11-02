/**
 * View model for the mobile app Agent tab (semantics: `workflow/editing.md` "Mobile app UI";
 * for interaction, the Agent page of `prototypes/mobile-ui-demo/` is the reference).
 *
 * Pure functions, no React and no store, so node can run the tests directly (`agentView.test.mjs`):
 *   - Quotes: the "quote chip bar" above the input box holds quote items (`QuoteRef`); on send they
 *     are placed before the body text in the same format as the desktop "Quote to AI",
 *     `@card name(clip id)` (this is the format the Agent recognizes), and the message bubble then
 *     recognizes these leading strings again and draws them as chips;
 *   - One reply turn (`ChatMessage`) is split into: what is said to the user (bubble), the entries
 *     in the action card (one per tool call), and the turn / stage summary.
 */
import type { ChatMessage, MessagePart, ToolCallInfo } from "../ai/types.ts";
import { isReportTool, parseProgressReport, type ProgressReport } from "../ai/progressReport.ts";
import { isUserMessageCall, sayingsOf, type Saying } from "../ai/userMessages.ts";
import { KIND_LABEL, bareToolName, toolKind } from "../editor/right/chat/iconRuns.ts";
import { tr } from "../i18n/index.ts";

/* ---------------- Quotes ---------------- */

export interface QuoteRef {
  /** Id of the quoted clip (the transition id for a transition; for an overlay card it is "clip id#kind:definition id") */
  id: string;
  /** The human-readable name */
  label: string;
  /**
   * Which level is quoted. The default "card" = the whole segment, identical to before;
   * when quoting a single overlay card write "overlay card" —— two dim cards with the same name on one
   * segment are common, and without saying which one, the Agent can only ask back.
   */
  kind?: string;
}

/** How a quote is written in the body text: the same string that desktop AI panel "Quote to AI" inserts into the input box */
/** Quote kind for a single overlay card inside a clip; part of the wire format like the token itself */
// i18n-allow: wire format agents are told about, not interface text
export const OVERLAY_QUOTE_KIND = "叠加卡";

export function quoteToken(q: QuoteRef): string {
  // i18n-allow: the quote token is a wire format agents are told about, not interface text
  return `@${q.kind || "卡片"} ${q.label}(${q.id})`;
}

/** Body text on send: quotes first, separated by spaces, followed by what the user wrote */
export function withQuotes(text: string, quotes: readonly QuoteRef[]): string {
  const body = text.trim();
  if (!quotes.length) return body;
  return `${quotes.map(quoteToken).join(" ")} ${body}`;
}

// i18n-allow: the quote token is a wire format agents are told about, not interface text
const QUOTE_RE = /^@卡片 (.+?)\(([^()\s]+)\)(?:[ \t]+|$)/;

/** Recognize the leading quote strings of a user message (desktop and phone use the same form); the rest is what the user wrote */
export function splitQuotes(text: string): { quotes: QuoteRef[]; rest: string } {
  let rest = text.replace(/^\s+/, "");
  const quotes: QuoteRef[] = [];
  for (;;) {
    const m = QUOTE_RE.exec(rest);
    if (!m) break;
    quotes.push({ label: m[1], id: m[2] });
    rest = rest.slice(m[0].length);
  }
  return { quotes, rest };
}

/** Add one item to the quote bar: the same id is not added twice (tapping "Quote" repeatedly just confirms again) */
export function addQuote(list: readonly QuoteRef[], q: QuoteRef): QuoteRef[] {
  return list.some((x) => x.id === q.id) ? [...list] : [...list, q];
}

/* ---------------- One round of reply ---------------- */

/** Get the ordered parts of a message (same as `partsOf` in desktop AgentBubble: old history without parts falls back to "text → status → tool") */
export function partsOf(m: ChatMessage): MessagePart[] {
  if (m.parts && m.parts.length > 0) return m.parts;
  const legacy: MessagePart[] = [];
  if (m.text) legacy.push({ kind: "text", text: m.text });
  for (const s of m.statuses || []) legacy.push({ kind: "status", text: s });
  for (const t of m.tools || []) legacy.push({ kind: "tool", ...t });
  return legacy;
}

/** Status of one entry in the action card: done / running / not done (still no result when the round ended) / failed */
export type OpState = "done" | "run" | "todo" | "err";

export interface OpItem {
  key: string;
  state: OpState;
  /** Chinese names of the action categories (add, modify, read...) */
  kind: string;
  /** Tool name (with the server prefix removed) */
  name: string;
}

/** One line in the summary: done / to do / issues */
export interface ReportRow {
  state: "done" | "todo" | "ask";
  text: string;
}

export interface ReportView {
  title: string;
  rows: ReportRow[];
}

export interface RoundView {
  /** Which round this is (which assistant reply in the chat, counting from 1) */
  ordinal: number;
  /** What was said before the first action */
  before: Saying[];
  /** What was said after the first action */
  after: Saying[];
  items: OpItem[];
  reports: ReportView[];
  /** Action card title: "Round 1 · 5 actions" */
  title: string;
  /** Whether there is an action card to draw */
  hasCard: boolean;
}

const reportTitle = (r: ProgressReport): string => (r.final ? tr("Round summary") : r.stage ? tr("Stage · {0}", r.stage) : tr("Stage summary"));

function reportView(r: ProgressReport): ReportView {
  const rows: ReportRow[] = [
    ...r.done.map((text) => ({ state: "done" as const, text })),
    ...r.todo.map((text) => ({ state: "todo" as const, text })),
    ...r.problems.map((text) => ({ state: "ask" as const, text })),
  ];
  return { title: reportTitle(r), rows };
}

/** Position of a saying within the parts of this round (`Saying.key` is `s<part index>` or `t<part index>`) */
function sayingIndex(s: Saying): number {
  const n = Number(s.key.slice(1));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Split one round of reply. The order follows the chat page of the demo: first what was said before
 * acting, then the action card of this round, then what was said after acting.
 * Action entries exclude `send_message`, which talks to the user, and `report_progress` (the latter
 * becomes the summary).
 */
export function roundView(m: ChatMessage, ordinal: number): RoundView {
  const parts = partsOf(m);
  const items: OpItem[] = [];
  const reports: ReportView[] = [];
  let firstOp = -1;
  parts.forEach((p, i) => {
    if (p.kind !== "tool") return;
    if (isUserMessageCall(p.name, p.input)) return;
    if (isReportTool(p.name)) {
      const r = parseProgressReport(p.input);
      if (r) reports.push(reportView(r));
      return;
    }
    if (firstOp < 0) firstOp = i;
    const t: ToolCallInfo = p;
    const state: OpState = t.ok === true ? "done" : t.ok === false ? "err" : m.pending ? "run" : "todo";
    items.push({ key: `${m.id}:${i}`, state, kind: KIND_LABEL[toolKind(t.name)], name: bareToolName(t.name) });
  });
  const sayings = sayingsOf(m);
  const split = firstOp < 0 ? Infinity : firstOp;
  const before = sayings.filter((s) => sayingIndex(s) < split);
  const after = sayings.filter((s) => sayingIndex(s) >= split);
  return {
    ordinal,
    before,
    after,
    items,
    reports,
    title: tr("Turn {0} · {1} actions", ordinal, items.length),
    hasCard: items.length > 0 || reports.length > 0,
  };
}

/** Which round each assistant reply in the chat is */
export function ordinals(messages: readonly ChatMessage[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const m of messages) if (m.role === "assistant") out.set(m.id, ++n);
  return out;
}

/** Whether to draw a bubble for this user message: ones handed over by other Agents (`inbound`) are not drawn, same as desktop */
export function isUserBubble(m: ChatMessage): boolean {
  return m.role === "user" && !(m.inbound && m.inbound.length > 0);
}
