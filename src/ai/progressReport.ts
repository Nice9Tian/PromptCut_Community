import type { ChatMessage, MessagePart, ToolCallInfo } from "./types.ts";
import { tr } from "../i18n/index.ts";

/**
 * The progress report the Agent hands to the user (the parameters of the report_progress tool).
 *
 * Since the redesign, the Agent's text replies are not shown by default; what the user sees is the
 * three groups of entries it submits at the end of a stage / the end of a task.
 * The UI reads the input in the tool_call event directly, without waiting for the tool result,
 * which is only the line "Recorded".
 * The parsing rules are kept consistent with the server's server/progress-report.mjs: a call the
 * server rejects is not recognized here either.
 * The tool_result reported back by CLI drivers cannot tell a rejection (ok is always true), and the
 * Agent resends once following the error; if the UI also drew the rejected one as a card, the user
 * would see two identical ones.
 */
export const REPORT_TOOL = "report_progress";

export interface ProgressReport {
  /** true = the whole task is finished; false = a stage summary */
  final: boolean;
  /**
   * true = stopped to wait for the user's reply (the ball is in their court): a needed capability is
   * missing, an ambiguous instruction needs clarifying, or candidates need the user to choose.
   * Implies final: stopping here means this round is over. The UI uses it to draw the card as "Waiting
   * for your reply" rather than "Summary of this round"; otherwise "stopped after hitting the round
   * limit" and "waiting for you" look the same and the user cannot tell them apart
   * (docs/plan/agent-blind-stop.md).
   */
  blocked?: boolean;
  stage?: string;
  done: string[];
  todo: string[];
  problems: string[];
}

/**
 * Each provider reports tool names differently: Claude carries the `mcp__promptcut__` prefix, others
 * may use the bare name or `promptcut.xxx`.
 * Only "ends with a separator + report_progress" is accepted, so that some xxx_report_progress is
 * not mistaken for it one day.
 */
export function isReportTool(name: string | undefined): boolean {
  return !!name && (name === REPORT_TOOL || /(?:__|[.:/])report_progress$/.test(name));
}

/**
 * The same limits as the server: at most 8 entries per group, 60 characters per entry, 12
 * characters for the stage name
 */
const MAX_ITEMS = 8;
const MAX_ITEM_CHARS = 60;
const MAX_STAGE_CHARS = 12;

const clip = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const given = (v: unknown) => v !== undefined && v !== null;

/**
 * Missing or null counts as an empty group; if it is not an array, or any entry is not a string, the
 * whole thing is rejected (returns null)
 */
function items(v: unknown): string[] | null {
  if (!given(v)) return [];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== "string") return null;
    const t = s.trim();
    if (t) out.push(clip(t, MAX_ITEM_CHARS));
  }
  return out.slice(0, MAX_ITEMS);
}

/** input may be an object, or a JSON string that has not been parsed yet (codex's arguments are a string) */
export function parseProgressReport(input: unknown): ProgressReport | null {
  let v = input;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  // has_done / has_todo / has_problem are redundant fields for the model's self-check; ignored
  if (given(o.final) && typeof o.final !== "boolean") return null;
  if (given(o.blocked) && typeof o.blocked !== "boolean") return null;
  if (given(o.stage) && typeof o.stage !== "string") return null;
  const done = items(o.done);
  const todo = items(o.todo);
  const problems = items(o.problems);
  if (!done || !todo || !problems) return null;
  // All three groups empty and not even final given: the parameters have not finished streaming, or
  // this is not a report at all
  if (!done.length && !todo.length && !problems.length && typeof o.final !== "boolean") return null;
  const stage = typeof o.stage === "string" ? clip(o.stage.trim(), MAX_STAGE_CHARS) : "";
  // blocked implies final, the same rule as the server's server/progress-report.mjs
  const blocked = o.blocked === true;
  return { final: o.final === true || blocked, ...(blocked ? { blocked: true } : {}), ...(stage ? { stage } : {}), done, todo, problems };
}

/** The reports in a message in order; for old history without parts, look in tools */
export function reportsOf(m: Pick<ChatMessage, "parts" | "tools">): ProgressReport[] {
  const calls: ToolCallInfo[] = m.parts
    ? m.parts.filter((p): p is Extract<MessagePart, { kind: "tool" }> => p.kind === "tool")
    : (m.tools ?? []);
  const out: ProgressReport[] = [];
  for (const t of calls) {
    if (!isReportTool(t.name)) continue;
    const r = parseProgressReport(t.input);
    if (r) out.push(r);
  }
  return out;
}

/**
 * The title line on the card and on the icon. It is used in three places (the report card, the
 * summary icon on the action bar, the icon's detail popover), so it is written only once: it used to
 * be written separately in each, and adding `blocked` almost changed only one of them.
 */
export function reportTitle(r: ProgressReport): string {
  if (r.blocked) return tr("Waiting for your reply");
  return r.final ? tr("Round summary") : r.stage ? tr("Stage · {0}", r.stage) : tr("Stage summary");
}

/**
 * Condense into one sentence (for the "prior context" after switching model / falling back): only
 * non-empty groups are joined
 */
export function reportText(r: ProgressReport): string {
  const segs: string[] = [];
  if (r.done.length) segs.push(tr("Done: {0}", r.done.join(tr(", "))));
  if (r.todo.length) segs.push(tr("To do: {0}", r.todo.join(tr(", "))));
  if (r.problems.length) segs.push(tr("Issues: {0}", r.problems.join(tr(", "))));
  const body = segs.join("; ");
  const text = r.stage && body ? `[${r.stage}] ${body}` : body;
  // "Waiting for the user" must also be preserved in the "prior context" after switching model /
  // falling back: otherwise the new round would think it can carry on by itself
  return r.blocked && text ? tr("{0} (stopped, waiting for the user to reply)", text) : text;
}
