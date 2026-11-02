import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../../ai/types";
import { currentStep } from "../../../ai/thinkingSteps";
import { isReportTool } from "../../../ai/progressReport";
import { partsOf, runningTool } from "./AgentBubble";
import { bareToolName, KIND_LABEL, toolKind } from "./iconRuns";
import "./agent.css";
import { tr } from "../../../i18n/index.ts";

/**
 * A strip above the input box: what step the Agent running in this page is doing right now.
 *
 * Previously the steps were stacked vertically in the bubble (StepStrip); after dozens of steps the
 * bubble got stretched very long, and the "now" that really matters sank to the very bottom and
 * scrolled away with the message list. Changed to be pinned above the input box and show only the
 * current step: wherever you scroll, you can see what it is busy with and for how long.
 */

/** Elapsed time: within a minute "12s", longer "3m05s" */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * The sentence on the strip. Prefer the step title from the thinking (the progress the model reports
 * itself, closest to what it is thinking); if there is none, look at the tool that is running; if
 * neither, it is still thinking.
 */
export function stripText(m: ChatMessage): string {
  const p = m.progress as Record<string, any> | undefined;
  if (p?.waitingJobs || p?.phase === 'waiting_jobs') {
    return p.text || tr("Background jobs started by the previous message (transcription, shot detection, etc.) are still running. Your message will be handled when they finish.");
  }
  if (p?.renderQueuePosition || p?.phase === 'render_queued') {
    const pos = p.renderQueuePosition ?? 1;
    return tr("Cloud rendering is busy with another project. You are number {0} in the queue and it will continue when your turn comes.", pos);
  }
  const parts = partsOf(m);
  const step = currentStep(parts);
  if (step) return step;
  const t = runningTool(parts);
  if (t) return isReportTool(t.name) ? tr("Writing summary") : tr("Now {0}: {1}", KIND_LABEL[toolKind(t.name)], bareToolName(t.name));
  return tr("Thinking…");
}

export function ThinkingStrip(props: { messages: ChatMessage[]; streaming: boolean }) {
  const { messages, streaming } = props;
  // Look only at the last Agent message still running. In split-work mode several may be pending at once, the strip has only one line, so follow the latest one
  let m: ChatMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const x = messages[i];
    if (x.role === "assistant" && x.pending) {
      m = x;
      break;
    }
  }
  const active = !!m && (streaming || !!m.pending);

  const [now, setNow] = useState(() => Date.now());
  // For the start time, prefer the message's own startedAt; old data has none, so record the moment this message was first seen
  const seenAt = useRef<{ id: string; at: number } | null>(null);
  if (m && seenAt.current?.id !== m.id) seenAt.current = { id: m.id, at: m.startedAt ?? Date.now() };

  // Elapsed time refreshes every second; when not running, stop the clock, so an invisible timer doesn't keep waking the whole panel
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!m || !active) return null;
  const text = stripText(m);
  const startedAt = m.startedAt ?? seenAt.current?.at ?? now;

  return (
    <div className="ai-tstrip">
      <span className="ai-tstrip-dot" aria-hidden />
      <span className="ai-tstrip-textwrap" role="status" aria-live="polite">
        {/* key follows the text: changing a step remounts it and replays the fade-in animation once */}
        <span key={text} className="ai-tstrip-text" title={text}>
          {text}
        </span>
      </span>
      <span className="ai-tstrip-time" title={tr("Elapsed time")}>
        {fmtElapsed(now - startedAt)}
      </span>
    </div>
  );
}
