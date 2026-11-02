import { useCallback, useMemo, useRef, useState } from "react";
import type { ChatMessage, InboundAgentMessage, ToolCallInfo } from "../../../ai/types";
import { useInstallJobs } from "../../../ai/sttInstallStore";
import { isReportTool, parseProgressReport, reportTitle, type ProgressReport } from "../../../ai/progressReport";
import { isUserMessageCall } from "../../../ai/userMessages";
import { ToolDetail, ToolIcons, type ExtraIcon } from "./ToolIcons";
import { bareToolName, iconRuns, type IconRun } from "./iconRuns";
import { OpDetailPreview, SUMMARY_TONE_TEXT, useDetailPages, type DetailItem, type SummaryTone } from "./OpDetailPreview";
import { ReportCard, partsOf, segmentsOf } from "./AgentBubble";
import { inboundPlan, promptOf } from "./rowPlan";
import type { RowHandlers } from "./MessageList";
import type { ViewMode } from "./viewPrefs";
import "./agent.css";
import { tr } from "../../../i18n/index.ts";

/**
 * "Agent actions" at the bottom of the AI panel: the visualization that used to live in the bubble
 * (action icon group, action detail preview, stage / round summary), shown per round.
 *
 * User decision, 2026-10-20, original words: "Replace the Agent action log with the visualization
 * component from the bubble. The bubble should only show what is being done".
 * It replaces the old "Agent action log" (src/editor/sync/AgentEventLog.tsx: lists tool events per
 * project channel, not limited to this chat, so it mixes in other chats, other members and command
 * line calls). This one looks only at this chat's own messages and shows one round at a time: by
 * default it follows the latest round, clicking a bubble switches to that round, and you can also
 * page with ‹ ›. A step that wrote to the project still has "Undo this step" (AgentUndoButton) in
 * the action detail preview, as before.
 */

const OPEN_KEY = "pc.ai.activity.open";
function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeOpen(v: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, v ? "1" : "0");
  } catch {
    /* If it cannot be saved, it only applies this once */
  }
}

/**
 * Which round "Agent actions" shows: the round the user clicked; if none was clicked, or the clicked
 * round no longer exists, the latest round.
 * When a new round starts (the latest round changes), it goes back to following the latest.
 */
export function useRoundSelection(messages: readonly ChatMessage[]): { id: string | null; select: (id: string) => void } {
  const latest = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return messages[i].id;
    return null;
  }, [messages]);
  const latestRef = useRef(latest);
  latestRef.current = latest;
  const [picked, setPicked] = useState<{ id: string; latestAt: string | null } | null>(null);
  const select = useCallback((id: string) => setPicked({ id, latestAt: latestRef.current }), []);
  const valid = picked && picked.latestAt === latest && messages.some((m) => m.id === picked.id && m.role === "assistant");
  return { id: valid ? picked.id : latest, select };
}

type RowSeg = { tools: ToolCallInfo[]; report: ProgressReport | null; runs: IconRun[]; tone: SummaryTone | null };

/** Visualization of one round: Concise mode is the icon group + action detail preview; Detailed mode lists each action and report card in the order they happened */
function RoundActivity(props: {
  m: ChatMessage;
  inbound?: InboundAgentMessage[];
  view: ViewMode;
  installJobs: ReturnType<typeof useInstallJobs>;
  expanded: Set<string>;
  on: RowHandlers;
}) {
  const { m, inbound, view, installJobs, expanded, on } = props;
  const parts = partsOf(m);
  const live = !!m.pending;
  const prefix = m.id;
  const segments = useMemo(() => segmentsOf(parts), [parts]);
  const inboundIcon: ExtraIcon | null = inbound?.length
    ? { key: `${prefix}:in`, className: "ai-op--agent", label: tr("Received {0} messages from other Agents", inbound.length), count: inbound.length }
    : null;
  const segs: RowSeg[] = segments.map((s, si) => ({
    tools: s.tools,
    report: s.report,
    runs: iconRuns(s.tools),
    // Summary color: red if this round ended in an error (the summary of the last segment), yellow if it reported problems, otherwise green
    tone: s.report ? (si === segments.length - 1 && (m.error || m.outcome === "error") ? "err" : s.report.problems.length || s.report.blocked ? "warn" : "ok") : null,
  }));
  const items: DetailItem[] = [];
  if (inbound?.length) items.push({ type: "inbound", key: `${prefix}:in`, messages: inbound });
  segs.forEach((seg, si) => {
    for (const run of seg.runs) {
      const tools = run.items.map((i) => seg.tools[i]);
      // Installing the engine has its own progress bar in the icon row, so it stays out of the action detail preview
      if (bareToolName(tools[0].name) === "stt_install") continue;
      items.push({ type: "run", key: `${prefix}:i${si}:${run.key}`, tools });
    }
    if (seg.report && seg.tone) items.push({ type: "report", key: `${prefix}:i${si}:report`, report: seg.report, tone: seg.tone });
  });
  const pages = useDetailPages(items);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [interacted, setInteracted] = useState(false);
  const [jump, setJump] = useState<{ key: string; seq: number } | null>(null);
  const onToggleIcon = (key: string) => {
    setInteracted(true);
    setFocusKey(key);
    setJump((j) => ({ key, seq: (j?.seq ?? 0) + 1 }));
  };
  const onPage = useCallback((key: string, byUser: boolean) => {
    setFocusKey(key);
    if (byUser) setInteracted(true);
  }, []);
  const selectedKey = interacted ? focusKey : null;
  const glowKey = !interacted && live ? focusKey : null;
  const reportIcon = (seg: RowSeg, si: number): ExtraIcon | null => {
    if (!seg.report || !seg.tone) return null;
    const title = reportTitle(seg.report);
    return { key: `${prefix}:i${si}:report`, className: `ai-op--summary tone-${seg.tone}`, label: `${title}:${SUMMARY_TONE_TEXT[seg.tone]}` };
  };

  if (!segs.length && !inboundIcon) {
    // Leave a trace on errors: a failed round cannot just say "no actions"; it must say it was because of the failure, and include the reason
    if (!live && (m.error || m.outcome === "error")) {
      return (
        <div className="ai-activity-empty is-failed" data-pc="agent-activity-empty" data-failed="1">
          {tr("This round failed, no operations were performed{0}", m.error ? `:${m.error}` : tr("."))}
        </div>
      );
    }
    return <div className="ai-activity-empty" data-pc="agent-activity-empty">{live ? tr("No actions yet") : tr("No actions in this round")}</div>;
  }

  if (view === "verbose") {
    return (
      <div className="ai-activity-verbose">
        {parts.map((p, pidx) => {
          if (p.kind === "status") return <div key={pidx} className="ai-tool-chip info">{tr("Info: {0}", p.text)}</div>;
          if (p.kind !== "tool" || isUserMessageCall(p.name, p.input)) return null;
          if (isReportTool(p.name)) {
            const r = parseProgressReport(p.input);
            if (r) return <ReportCard key={pidx} r={r} enter={live} />;
          }
          const key = `${m.id}:${pidx}`;
          return <ToolDetail key={key} t={p as ToolCallInfo} open={expanded.has(key)} installJobs={installJobs} onToggle={() => on.toggleTool(key)} />;
        })}
      </div>
    );
  }

  return (
    <>
      {segs.length === 0 && inboundIcon ? (
        <ToolIcons tools={[]} runs={[]} keyPrefix={`${prefix}:i0`} installJobs={installJobs} lead={inboundIcon}
          selectedKey={selectedKey} focusKey={glowKey} onToggleIcon={onToggleIcon} />
      ) : null}
      {segs.map((seg, si) => (
        <ToolIcons
          key={si}
          tools={seg.tools}
          runs={seg.runs}
          keyPrefix={`${prefix}:i${si}`}
          installJobs={installJobs}
          lead={si === 0 ? inboundIcon : null}
          tail={reportIcon(seg, si)}
          selectedKey={selectedKey}
          focusKey={glowKey}
          onToggleIcon={onToggleIcon}
        />
      ))}
      <OpDetailPreview pages={pages} items={items} jump={jump} onPage={onPage} live={live} />
    </>
  );
}

export function AgentActivityPanel(props: {
  messages: ChatMessage[];
  /** Which round to show (given by useRoundSelection) */
  selectedId: string | null;
  onSelect: (id: string) => void;
  view: ViewMode;
  installJobs: ReturnType<typeof useInstallJobs>;
  expanded: Set<string>;
  on: RowHandlers;
}) {
  const { messages, selectedId, onSelect, view, installJobs, expanded, on } = props;
  const [open, setOpen] = useState(readOpen);
  const plan = useMemo(() => inboundPlan(messages), [messages]);
  const rounds = useMemo(() => messages.filter((m) => m.role === "assistant"), [messages]);
  if (!rounds.length) return null;
  const idx = Math.max(0, rounds.findIndex((m) => m.id === selectedId));
  const m = rounds[idx] ?? rounds[rounds.length - 1];
  const prompt = promptOf(messages, m.id, plan);
  const promptText = (prompt?.text ?? "").replace(/\s+/g, " ").trim();
  const ops = segmentsOf(partsOf(m)).reduce((n, s) => n + s.tools.length, 0);

  return (
    <div className="pc-activity" data-pc="agent-activity" data-round-id={m.id} data-round-index={idx + 1}>
      <div className="pc-activity-head">
        <button
          type="button"
          className="pc-activity-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            writeOpen(!open);
          }}
        >
          <span>{tr("{0} Agent operations", open ? "▾" : "▸")}</span>
          <span className="pc-activity-count">{tr("Round {0}/{1} · {2} operations{3}", idx + 1, rounds.length, ops, m.pending ? tr(" · in progress") : "")}</span>
        </button>
        <button type="button" className="pc-activity-nav" data-pc="agent-activity-prev" aria-label={tr("Previous round")} title={tr("Previous round")}
          disabled={idx <= 0} onClick={() => onSelect(rounds[idx - 1].id)}>‹</button>
        <button type="button" className="pc-activity-nav" data-pc="agent-activity-next" aria-label={tr("Next round")} title={tr("Next round")}
          disabled={idx >= rounds.length - 1} onClick={() => onSelect(rounds[idx + 1].id)}>›</button>
      </div>
      {open ? (
        <div className="pc-activity-body">
          {promptText ? <div className="pc-activity-prompt" title={promptText}>{tr("Reply: {0}", promptText)}</div> : null}
          {/* Remount the whole block when the round changes: the page the action detail preview is flipped to and the icon that was clicked belong to that round itself */}
          <RoundActivity key={m.id} m={m} inbound={plan.inboundFor.get(m.id)?.list} view={view} installJobs={installJobs} expanded={expanded} on={on} />
        </div>
      ) : null}
    </div>
  );
}
