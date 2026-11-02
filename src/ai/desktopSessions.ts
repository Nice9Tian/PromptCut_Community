import { useSyncExternalStore } from "react";
import { parseProgressReport, type ProgressReport } from "./progressReport.ts";

/**
 * Grouping of desktop app sessions in the AI panel (plan `docs/plan/agent-workflow-plan.md` A4;
 * semantics `user-workflow.md` "Agent connection type", "Progress visibility"): each session has its
 * own group, indicating vendor and ongoing operation; progress items submitted via report_progress
 * are displayed as report cards in the AI panel.
 *
 * Data comes from the editor process (`server/agent/desktop-activity.mjs`): pushed entirely via SSE
 * `agent.desktop` (one copy pushed as soon as the page connects); here only the latest copy is
 * stored for subscribers. The page does not actively request: avoiding extra /api calls in online
 * builds.
 */

export interface DesktopCall {
  tool: string;
  ok: boolean;
  error?: string;
  at: number;
  ms: number;
}

export interface DesktopSession {
  /** Session identity (`desk-…`), also its chat ID in document service and bulletin board */
  id: string;
  /** Vendor id (claude-code, codex…) and human-readable name (Claude Code, Codex…) */
  vendor: string | null;
  label: string | null;
  client: { name: string; version: string } | null;
  firstSeen: number;
  lastSeen: number;
  calls: number;
  /** Running invocation; null if none */
  current: { tool: string; since: number } | null;
  last: DesktopCall | null;
  recent: DesktopCall[];
  reports: { at: number; report: ProgressReport }[];
}

let sessions: DesktopSession[] = [];
const listeners = new Set<() => void>();

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

function callOf(v: any): DesktopCall | null {
  if (!v || typeof v !== "object" || typeof v.tool !== "string") return null;
  return { tool: v.tool, ok: v.ok !== false, ...(typeof v.error === "string" ? { error: v.error } : {}), at: num(v.at), ms: num(v.ms) };
}

/** Copy pushed by the server (untrusted shape: validated item by item, discarding invalid ones) */
export function normalizeDesktopSessions(list: unknown): DesktopSession[] {
  if (!Array.isArray(list)) return [];
  const out: DesktopSession[] = [];
  for (const raw of list.slice(0, 32)) {
    if (!raw || typeof raw !== "object" || typeof (raw as any).id !== "string") continue;
    const r = raw as any;
    const reports: DesktopSession["reports"] = [];
    for (const it of Array.isArray(r.reports) ? r.reports : []) {
      const rep = parseProgressReport(it?.report);
      if (rep) reports.push({ at: num(it.at), report: rep });
    }
    out.push({
      id: r.id,
      vendor: str(r.vendor),
      label: str(r.label),
      client: r.client && typeof r.client.name === "string" ? { name: r.client.name, version: String(r.client.version ?? "") } : null,
      firstSeen: num(r.firstSeen),
      lastSeen: num(r.lastSeen),
      calls: num(r.calls),
      current: r.current && typeof r.current.tool === "string" ? { tool: r.current.tool, since: num(r.current.since) } : null,
      last: callOf(r.last),
      recent: (Array.isArray(r.recent) ? r.recent : []).map(callOf).filter((c: DesktopCall | null): c is DesktopCall => !!c),
      reports,
    });
  }
  return out;
}

export function applyDesktopSessions(list: unknown): void {
  sessions = normalizeDesktopSessions(list);
  for (const fn of listeners) fn();
}

export function getDesktopSessions(): DesktopSession[] {
  return sessions;
}

export function subscribeDesktopSessions(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useDesktopSessions(): DesktopSession[] {
  return useSyncExternalStore(subscribeDesktopSessions, getDesktopSessions, getDesktopSessions);
}

/** Session short name: `desk-AbCdEf12` → `AbCd` */
export function shortSessionId(id: string): string {
  return id.replace(/^desk-/, "").slice(0, 4);
}
