import { useSyncExternalStore } from "react";
import { parseProgressReport, type ProgressReport } from "./progressReport.ts";

/**
 * 桌面 APP 会话在 AI 栏里的分组(计划 `docs/plan/agent-workflow-plan.md` A4;语义 `user-workflow.md`「Agent 接入方式」
 * 「进度可见」):每个会话单独一组,标明厂商和正在进行的操作,它用 report_progress 交的进度条目按 AI 栏的报告卡显示。
 *
 * 数据来自编辑器进程(`server/agent/desktop-activity.mjs`):经 SSE 的 `agent.desktop` 整份推来(页面一连上就推一份),
 * 这里只存最新一份、给订阅者。页面不主动请求 —— 在线构建里也就没有多出来的 /api 调用。
 */

export interface DesktopCall {
  tool: string;
  ok: boolean;
  error?: string;
  at: number;
  ms: number;
}

export interface DesktopSession {
  /** 会话身份(`desk-…`),也是它在文档服务、公告板里的对话 ID */
  id: string;
  /** 厂商 id(claude-code、codex…)与给人看的名字(Claude Code、Codex…) */
  vendor: string | null;
  label: string | null;
  client: { name: string; version: string } | null;
  firstSeen: number;
  lastSeen: number;
  calls: number;
  /** 正在跑的调用;没有是 null */
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

/** 服务端推来的一份(不信任形状:逐项校验,坏的丢掉) */
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

/** 会话的短名:`desk-AbCdEf12` → `AbCd` */
export function shortSessionId(id: string): string {
  return id.replace(/^desk-/, "").slice(0, 4);
}
