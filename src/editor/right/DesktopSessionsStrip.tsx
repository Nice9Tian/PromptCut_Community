import { useState } from "react";
import type { JSX } from "react";
import { shortSessionId, useDesktopSessions, type DesktopSession } from "../../ai/desktopSessions";
import { ReportCard } from "./chat/AgentBubble";
import { KIND_LABEL, bareToolName, toolKind } from "./chat/iconRuns";
import "./DesktopSessionsStrip.css";
import { tr } from "../../i18n/index.ts";

/**
 * Grouping of desktop app sessions in the AI panel (plan `docs/plan/agent-workflow-plan.md` A4; semantics
 * `user-workflow.md` "Agent connection type" "Progress visibility"): each session gets its own group,
 * showing the vendor and the operation in progress; the progress entries it submits with report_progress
 * are shown with the same report card as the AI panel (`ReportCard`). This software cannot get the desktop
 * app's text output, so a group only has operations and reports, and no text replies.
 *
 * Data: `src/ai/desktopSessions.ts` (pushed from the editor process via SSE). When there are no desktop
 * sessions, the whole block is not drawn.
 */
export function DesktopSessionsStrip(): JSX.Element | null {
  const sessions = useDesktopSessions();
  if (!sessions.length) return null;
  return (
    <div className="pc-desktop-sessions" data-pc="desktop-sessions" aria-label={tr("Desktop app session")}>
      {sessions.map((s) => (
        <DesktopGroup key={s.id} s={s} />
      ))}
    </div>
  );
}

/** "Modifying · update_clip" / "Last step: reading · get_project" / "Last step failed: …" */
export function operationText(s: DesktopSession): string {
  if (s.current) {
    const name = bareToolName(s.current.tool);
    return tr("Running {0} · {1}", KIND_LABEL[toolKind(name)], name);
  }
  if (s.last) {
    const name = bareToolName(s.last.tool);
    return s.last.ok ? tr("Last step: {0} · {1}", KIND_LABEL[toolKind(name)], name) : tr("Last step failed: {0}", name);
  }
  return tr("Connected, no actions yet");
}

function DesktopGroup({ s }: { s: DesktopSession }): JSX.Element {
  const [open, setOpen] = useState(true);
  const vendor = s.label || s.vendor || tr("Desktop app");
  const reports = s.reports.slice(-5);
  return (
    <section className={`pc-desktop-group${s.current ? " is-busy" : ""}`} data-pc="desktop-session" data-session={s.id} data-vendor={s.vendor ?? ""}>
      <button
        type="button"
        className="pc-desktop-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={tr("Desktop app session {0}{1} · {2} calls", s.id, s.client ? `(${s.client.name} ${s.client.version})` : "", s.calls)}
      >
        <span className="pc-desktop-vendor" data-pc="desktop-vendor">{vendor}</span>
        <span className="pc-desktop-id">{tr("Session {0}", shortSessionId(s.id))}</span>
        <span className="pc-desktop-op" data-pc="desktop-op">{operationText(s)}</span>
        <span className="pc-desktop-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="pc-desktop-body" data-pc="desktop-reports">
          {s.last && !s.last.ok && s.last.error ? <div className="pc-desktop-error">{s.last.error}</div> : null}
          {reports.length ? (
            reports.map((r, i) => <ReportCard key={`${r.at}-${i}`} r={r.report} />)
          ) : (
            <div className="pc-desktop-empty">{tr("No progress report submitted yet")}</div>
          )}
        </div>
      )}
    </section>
  );
}
