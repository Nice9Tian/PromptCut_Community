import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { playEnter } from "../../enterMotion";
import type { ChatMessage, MessagePart, ToolCallInfo } from "../../../ai/types";
import { RoleName } from "../RoleAvatar";
import { LiveMarkdown } from "../../../ai/Markdown";
import { bareToolName } from "./iconRuns";
import { isReportTool, parseProgressReport, reportTitle, type ProgressReport } from "../../../ai/progressReport";
import { isUserMessageCall, sayingsOf } from "../../../ai/userMessages";
import "./agent.css";
import { tr } from "../../../i18n/index.ts";

/**
 * Gets the ordered parts of a message. New messages carry parts; old session history has none,
 * so fall back to the old "text → status → tool" order, to make sure it stays readable.
 */
export function partsOf(m: ChatMessage): MessagePart[] {
  if (m.parts && m.parts.length > 0) return m.parts;
  const legacy: MessagePart[] = [];
  if (m.text) legacy.push({ kind: "text", text: m.text });
  for (const s of m.statuses || []) legacy.push({ kind: "status", text: s });
  for (const t of m.tools || []) legacy.push({ kind: "tool", ...t });
  return legacy;
}

/**
 * The step names inside the thinking, rendered as a ticker.
 *
 * Why not plain text: the `<think>` that comes back through the relay service often does not hold a
 * chain of thought, but a one-sentence step name ("**Clarifying article link and scope**").
 * Laying it out as-is in the bubble pushes the body text apart, and the user is interrupted
 * mid-read by a block of English; hiding it behind the "Show thinking" switch is as good as not
 * having it, since he cannot tell what it is busy with.
 * Compromise: extract only the step names and lay them out line by line, with the last one
 * breathing-animated while the message is not finished: you see at a glance "it is still going and
 * where it has got to", without taking the body text's place.
 *
 * Now only Detailed mode still uses it; Concise mode's "current step" moved to the ThinkingStrip
 * above the input box.
 */
export function StepStrip({ steps, live }: { steps: string[]; live: boolean }) {
  if (!steps.length) return null;
  return (
    <div className="ai-steps">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <div key={i} className={"ai-step" + (live && last ? " is-live" : " is-done")}>
            <span className="ai-step-dot" />
            <span className="ai-step-label">{s}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The tool that is executing and has no result yet (if there is one, it is the one running at this moment) */
export function runningTool(parts: MessagePart[]): ToolCallInfo | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === "tool") return p.ok === undefined ? p : null;
  }
  return null;
}

/** An unfinished message: prefer the progress reported by the kernel, otherwise fall back to "Thinking / Running X" */
export function activityText(m: ChatMessage, busyTool: ToolCallInfo | null): string {
  if (m.progress?.text) return m.progress.text;
  return busyTool ? tr("Running {0}", bareToolName(busyTool.name)) : tr("Thinking");
}

/**
 * The round count and success or failure in the progress, on a line of small text of its own; not
 * shown when there is no round information (CLI driver).
 * `liveElapsedMs`: elapsed time that the UI advances by itself (see LiveProgressMeta); if not
 * given, use the number reported in the progress.
 */
export function progressMeta(m: ChatMessage, liveElapsedMs?: number): string | null {
  const p = m.progress;
  if (!p?.round) return null;
  // maxRounds being null means "unlimited rounds" (deep autonomy + autonomy rounds set to 0): Infinity passed through JSON becomes null.
  // Writing "round 12/?" would make people think information was lost, but there is simply no denominator
  const bits = [p.maxRounds ? tr("Round {0}/{1}", p.round, p.maxRounds) : tr("Round {0} (unlimited)", p.round)];
  if (p.completed || p.failed) bits.push(tr("Succeeded {0} · Failed {1}", p.completed ?? 0, p.failed ?? 0));
  const elapsed = liveElapsedMs ?? p.elapsedMs;
  if (elapsed) bits.push(tr("{0} s", Math.floor(elapsed / 1000)));
  return bits.join(" · ");
}

/**
 * The elapsed time in the small round-count text advances every second. Progress is reported only
 * when the step changes (while waiting for the model to reply there may be no new report for tens
 * of seconds), and it used to copy the number in the progress as-is, so "Round 1/24 · 0 s" stayed
 * stuck at 0 s (online test, 2026-10-19).
 * It starts from the moment this progress was received and adds on top of the elapsed time it
 * reported; when a new progress arrives it realigns; it also computes one from this round's start
 * time and takes the larger. Once the run is finished the clock stops.
 */
export function LiveProgressMeta({ m }: { m: ChatMessage }) {
  const p = m.progress;
  const sig = p ? `${p.round}|${p.elapsedMs ?? 0}|${p.phase ?? ""}|${p.text ?? ""}` : "";
  const anchor = useRef<{ sig: string; elapsed: number; at: number } | null>(null);
  if (p && anchor.current?.sig !== sig) anchor.current = { sig, elapsed: p.elapsedMs ?? 0, at: Date.now() };
  const ticking = Boolean(m.pending && p?.round);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const now = Date.now();
  // This round's start time (the moment carried by the cloud's `run` event) is also counted as one: when the page is reopened the progress is replayed, and aligning by receive time would undercount;
  // take the larger of the two. If the start time is absurd (later than now, or more than a day ago, most likely because the clocks on the two sides are off), do not use it
  const sinceStart = typeof m.startedAt === "number" && now >= m.startedAt && now - m.startedAt < 86_400_000 ? now - m.startedAt : 0;
  const live = ticking && anchor.current ? Math.max(anchor.current.elapsed + (now - anchor.current.at), sinceStart) : undefined;
  const text = progressMeta(m, live);
  return text ? <div className="ai-activity-meta" data-pc="activity-meta">{text}</div> : null;
}

/**
 * The conclusion after a run finishes. completed is not shown (a normal finish needs no extra
 * word), while all the other kinds must be visible to the user: different reasons for stopping call
 * for different things to do.
 * When the user stopped it himself, only write "Stopped": he pressed it, so no explanation needed.
 */
export const OUTCOME_TEXT: Record<string, string> = {
  stalled: tr("Repeated actions were detected with no progress, so it stopped. The summary above explains how far it got."),
  round_limit: tr("The model round-trip limit for this run was reached. Completed changes are kept; add more instructions to continue."),
  aborted: tr("Stopped"),
};
export function outcomeText(m: ChatMessage): string | null {
  if (!m.outcome || m.outcome === "completed" || m.outcome === "error") return null;
  return OUTCOME_TEXT[m.outcome] || tr("This run ended with: {0}", m.outcome);
}

/** One segment in Concise mode: several actions, possibly followed by a report at the end */
export interface Segment {
  /** The actions of this segment, not including the report tool itself */
  tools: ToolCallInfo[];
  /** The parameters of the final report_progress call; null if this segment did not end with a report or the parameters cannot be parsed */
  report: ProgressReport | null;
}

/**
 * Splits a message into segments following the order of parts: each report tool call "closes a
 * segment".
 *
 * Read through, it goes "did a few things (icons) → hand in a stage summary (card) → did a few more
 * things → round summary". The report card's data is taken straight from the call parameters
 * without waiting for the tool result, which is only the line "Recorded".
 * If there are actions after the last report, they form a segment of their own, with no card.
 */
export function segmentsOf(parts: MessagePart[]): Segment[] {
  const out: Segment[] = [];
  let tools: ToolCallInfo[] = [];
  for (const p of parts) {
    if (p.kind !== "tool") continue;
    // Words addressed to the user (send_message sent to user) are drawn in the bubble and do not count as actions
    if (isUserMessageCall(p.name, p.input)) continue;
    if (isReportTool(p.name)) {
      out.push({ tools, report: parseProgressReport(p.input) });
      tools = [];
    } else {
      tools.push(p);
    }
  }
  if (tools.length) out.push({ tools, report: null });
  return out;
}

const REPORT_GROUPS = [
  { field: "done", label: tr("Completed"), mark: "✓", cls: "is-done" },
  { field: "todo", label: tr("To do"), mark: "○", cls: "is-todo" },
  { field: "problems", label: tr("Problems"), mark: "!", cls: "is-problem" },
] as const;

/**
 * A report card.
 *
 * Now that the Agent's text replies are hidden by default, this is the "conclusion" the user reads.
 * Stage cards are compact and one tier lower; the round summary has an extra ring of translucent
 * accent-color outline, to stand out a bit. Any of the three groups of entries is not shown when
 * empty, and when all are empty write one line, rather than leave an empty shell.
 *
 * A blocked one must look different from the "round summary": the ball is in the user's court, and
 * he must see at a glance that this is not done but waiting for his reply. Otherwise "stopped after
 * hitting the round limit" looks the same as "waiting for you" (docs/plan/agent-blind-stop.md).
 */
export function ReportCard({ r, enter }: { r: ProgressReport; enter?: boolean }) {
  const groups = REPORT_GROUPS.filter((g) => r[g.field].length > 0);
  const ref = useRef<HTMLDivElement>(null);
  // A report just handed in during streaming fades in (enterMotion); ones in history, or redisplayed when switching back to a tab, do not play it. It is seen only once, at the moment it mounts
  useLayoutEffect(() => {
    if (enter) playEnter(ref.current, "pc-enter-rise");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className={`ai-report${r.final ? " is-final" : ""}${r.blocked ? " is-blocked" : ""}`}>
      <div className="ai-report-head">
        {reportTitle(r)}
      </div>
      {groups.length ? (
        groups.map((g) => (
          <div key={g.field} className={`ai-report-group ${g.cls}`}>
            <div className="ai-report-label">
              <span className="ai-report-mark" aria-hidden>{g.mark}</span>
              {g.label}
            </div>
            <ul className="ai-report-list">
              {r[g.field].map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <div className="ai-report-empty">{tr("(nothing to report)")}</div>
      )}
    </div>
  );
}

/**
 * "Thinking and original text": the block at the bottom of the bubble when "Show thinking" is on.
 *
 * Text replies are no longer shown by default (see the report card for the conclusion), but when
 * troubleshooting you still need to see what it said and thought.
 * Laid out in the order they happened: adjacent text is merged into one paragraph, adjacent thinking
 * is merged into one paragraph, so it reads "think → say → think again".
 * It can be folded: the original text is often very long, so fold it when done, without going to the
 * top bar to turn the switch off.
 * A bubble that merged several rounds is divided into sections per round (sections): paragraphs
 * merge only within the same round, and only the round that is running is parsed as a stream,
 * otherwise the original text of hundreds of rounds in the whole group would be merged into one
 * paragraph and fully re-parsed every 250ms.
 */
function RawLog({ sections }: { sections: { key: string; parts: MessagePart[]; live: boolean }[] }) {
  const [open, setOpen] = useState(true);
  const items: { key: string; kind: "text" | "thinking"; text: string; live: boolean }[] = [];
  for (const sec of sections) {
    let local = 0;
    let last: (typeof items)[number] | null = null;
    for (const p of sec.parts) {
      if (p.kind !== "text" && p.kind !== "thinking") continue;
      if (last && last.kind === p.kind) last.text += p.kind === "thinking" ? "\n\n" + p.text : p.text;
      else {
        last = { key: `${sec.key}:${local++}`, kind: p.kind, text: p.text, live: sec.live };
        items.push(last);
      }
    }
  }
  if (!items.some((it) => it.text.trim())) return null;
  return (
    <div className="ai-rawlog">
      <button type="button" className="ai-rawlog-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        {tr("Thinking and raw text")}
      </button>
      {open && (
        <div className="ai-rawlog-body">
          {items.map((it) => {
            if (!it.text.trim()) return null;
            // Text always goes through LiveMarkdown: fully parsing Markdown / KaTeX token by token while streaming freezes the UI
            return it.kind === "text" ? (
              <div key={it.key} className="ai-message-text">
                <LiveMarkdown text={it.text} live={it.live} />
              </div>
            ) : (
              <div key={it.key} className="ai-rawlog-thinking">{it.text}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}


/**
 * The bubble for one round of replies: it holds only "what the Agent is doing" (user decision,
 * 2026-10-20, original words: "the bubble should only show what is being done").
 *
 * It lists, in order, what it said with send_message(to: "user"); if it never called it and replied
 * with text only, that text counts as one sentence (src/ai/userMessages.ts).
 * While running, a spinning line below says what is being done at this moment; errors, stops and the
 * progress of cloud rendering are still written at the very bottom.
 * Actions done, frames viewed and reports (round summary) are not in the bubble, but shown per round
 * in "Agent actions" below the bubble (ActivityPanel.tsx);
 * clicking the bubble makes "Agent actions" switch to this round.
 */
export function AgentBubble(props: {
  m: ChatMessage;
  showThinking: boolean;
  /** Whether "Agent actions" is currently showing this round */
  selected?: boolean;
  /** Click the bubble: make "Agent actions" switch to this round */
  onSelect?: (id: string) => void;
}) {
  const { m, showThinking, selected, onSelect } = props;
  const parts = partsOf(m);
  const live = !!m.pending;
  const busyTool = live ? runningTool(parts) : null;
  const sayings = sayingsOf(m);
  const ops = live || sayings.length ? 0 : segmentsOf(parts).reduce((n, s) => n + s.tools.length, 0);
  const outcome = live ? null : outcomeText(m);
  const lastText = sayings.length ? sayings[sayings.length - 1] : null;

  return (
    <div
      className={`ai-message assistant${onSelect ? " is-selectable" : ""}${selected ? " is-selected" : ""}`}
      data-pc="agent-bubble"
      data-selected={selected ? "1" : undefined}
      onClick={onSelect ? (e) => {
        // A click on a link or button is their own business; do not switch while text is being selected
        if ((e.target as HTMLElement).closest("a,button,input,textarea")) return;
        if (window.getSelection?.()?.toString()) return;
        onSelect(m.id);
      } : undefined}
    >
      {m.roleId && <div className="pc-role-header"><RoleName roleId={m.roleId} /></div>}
      {m.attachments && m.attachments.length > 0 && (
        <div className="ai-message-attach">{tr("[Attachments: {0}]", m.attachments.map((a) => a.name).join(", "))}</div>
      )}

      {sayings.map((s) => (
        <div key={s.key} className="ai-saying" data-pc="agent-saying" data-from={s.from}>
          {/* A text reply may be Markdown; while streaming, only the last sentence is parsed as a stream */}
          <LiveMarkdown text={s.text} live={live && s === lastText && s.from === "text"} />
        </div>
      ))}
      {ops > 0 && !m.error && (
        <div className="ai-saying-none" data-pc="agent-saying-none">{tr("Did {0} operations, see \"Agent operations\" below", ops)}</div>
      )}

      {/* Wrap "what is being done" and the small round-count line below it into one block: blocks in the bubble are separated only by gap, and these two lines must sit closer than the gap */}
      {live && (
        <div className="ai-activity-block">
          <div className="ai-activity" role="status" aria-live="polite">
            <span className="ai-spinner" aria-hidden />
            <span className="ai-activity-text">{activityText(m, busyTool)}</span>
            <span className="ai-activity-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </div>
          <LiveProgressMeta m={m} />
        </div>
      )}

      {m.error && <div className="ai-message-error" data-pc="agent-error" role="alert">{m.error}</div>}
      {outcome && <div className="ai-message-outcome">{outcome}</div>}
      {/* Cloud chat: the progress of prerender retries triggered by changes stays on one line (a render failure must not hide only in "Agent actions") */}
      {m.cloudRender && (
        <div className={m.cloudRender.state === "failed" || m.cloudRender.state === "unavailable" ? "ai-message-error" : "ai-message-outcome"} data-pc="cloud-render-note" data-state={m.cloudRender.state}>
          {m.cloudRender.text}
        </div>
      )}

      {showThinking && <RawLog sections={[{ key: m.id, parts, live }]} />}
    </div>
  );
}
