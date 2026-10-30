import { useState } from "react";
import type { JSX } from "react";
import { shortSessionId, useDesktopSessions, type DesktopSession } from "../../ai/desktopSessions";
import { ReportCard } from "./chat/AgentBubble";
import { KIND_LABEL, bareToolName, toolKind } from "./chat/iconRuns";
import "./DesktopSessionsStrip.css";

/**
 * 桌面 APP 会话在 AI 栏里的分组(计划 `docs/plan/agent-workflow-plan.md` A4;语义 `user-workflow.md`「Agent 接入方式」
 * 「进度可见」):每个会话单独一组,标明厂商和正在进行的操作;它用 report_progress 交的进度条目用 AI 栏同一张报告卡
 * (`ReportCard`)显示。桌面 APP 的文字输出本软件拿不到,所以组里只有操作和报告,没有文字回复。
 *
 * 数据:`src/ai/desktopSessions.ts`(编辑器进程经 SSE 推来)。没有桌面会话时整块不画。
 */
export function DesktopSessionsStrip(): JSX.Element | null {
  const sessions = useDesktopSessions();
  if (!sessions.length) return null;
  return (
    <div className="pc-desktop-sessions" data-pc="desktop-sessions" aria-label="桌面 APP 会话">
      {sessions.map((s) => (
        <DesktopGroup key={s.id} s={s} />
      ))}
    </div>
  );
}

/** 「正在修改 · update_clip」/「上一步:读取 · get_project」/「上一步失败:…」 */
export function operationText(s: DesktopSession): string {
  if (s.current) {
    const name = bareToolName(s.current.tool);
    return `正在${KIND_LABEL[toolKind(name)]} · ${name}`;
  }
  if (s.last) {
    const name = bareToolName(s.last.tool);
    return s.last.ok ? `上一步:${KIND_LABEL[toolKind(name)]} · ${name}` : `上一步失败:${name}`;
  }
  return "已接入,还没有操作";
}

function DesktopGroup({ s }: { s: DesktopSession }): JSX.Element {
  const [open, setOpen] = useState(true);
  const vendor = s.label || s.vendor || "桌面 APP";
  const reports = s.reports.slice(-5);
  return (
    <section className={`pc-desktop-group${s.current ? " is-busy" : ""}`} data-pc="desktop-session" data-session={s.id} data-vendor={s.vendor ?? ""}>
      <button
        type="button"
        className="pc-desktop-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`桌面 APP 会话 ${s.id}${s.client ? `(${s.client.name} ${s.client.version})` : ""} · ${s.calls} 次调用`}
      >
        <span className="pc-desktop-vendor" data-pc="desktop-vendor">{vendor}</span>
        <span className="pc-desktop-id">会话 {shortSessionId(s.id)}</span>
        <span className="pc-desktop-op" data-pc="desktop-op">{operationText(s)}</span>
        <span className="pc-desktop-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="pc-desktop-body" data-pc="desktop-reports">
          {s.last && !s.last.ok && s.last.error ? <div className="pc-desktop-error">{s.last.error}</div> : null}
          {reports.length ? (
            reports.map((r, i) => <ReportCard key={`${r.at}-${i}`} r={r.report} />)
          ) : (
            <div className="pc-desktop-empty">还没有交进度报告</div>
          )}
        </div>
      )}
    </section>
  );
}
