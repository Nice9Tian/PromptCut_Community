/**
 * The AI panel's "Agent action log" (D2, c65-design.md section 7: the page's AI panel updates the matching record by event id, with a virtualized list).
 *
 * The data is tool-call events on the document service's project channel (`events.event`; for each tool call the Agent server sends two, "created" and "completed"),
 * which syncManager merges by `eventId` into one record keeping only a summary; full parameters are in the content store and are not pulled here.
 * It appears here whether the call came from this page's chat, the command line (`/api/mcp/call`), another page, or someone else's Agent in a shared project.
 *
 * An entry that was written into the project (the completed event carries `opId`) has "Undo this step" (c65-undo-draft.md section 4): no second confirmation, clickable even if it is not the latest step,
 * and after a successful undo it turns gray and reads "Undone"; the inverse operation is submitted as this page's identity + `undoOf`, into the user's own undo stack (ruled in c65-design.md section 8).
 *
 * List virtualization: rows have a fixed height and only the visible rows (plus a few above and below as margin) are rendered, so even with many records there are only a dozen or so DOM nodes.
 */
import { useMemo, useRef, useState, type UIEvent } from "react";
import { agentOpOfEvent, displayNames, eventRecordList, me, revertAgentOp, useSync, type EventRecord } from "./syncManager";
import { writerLabel } from "./labels";
import "./sync.css";
import { tr } from "../../i18n/index.ts";

const ROW_H = 30;
const VIEW_ROWS = 7;
const OVERSCAN = 4;
const OPEN_KEY = "pc.ai.eventLog.open";

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

function statusMark(r: EventRecord): { ch: string; cls: string; title: string } {
  if (r.kind === "text") return { ch: "…", cls: "text", title: tr("Text reply") };
  if (r.status === null) return { ch: "●", cls: "running", title: tr("In progress") };
  if (r.status === "ok") return { ch: "✓", cls: "ok", title: tr("Done") };
  if (r.status === "cancelled") return { ch: "—", cls: "error", title: tr("Cancelled") };
  return { ch: "✕", cls: "error", title: tr("Error occurred") };
}

function Row({ r, top }: { r: EventRecord; top: number }) {
  const mark = statusMark(r);
  const who = r.actor ? writerLabel({ actor: r.actor, session: r.actor.session as string | undefined }, me(), displayNames()) : "";
  const op = r.opId ? agentOpOfEvent(r.eventId) : null;
  const done = op?.state === "done";
  const label = r.kind === "text" ? (r.text ?? "").replace(/\s+/g, " ").slice(0, 80) : r.tool ?? "?";
  const target = r.target ? r.target.replace(/^[a-zA-Z]+Id:/, "") : "";
  const title = [label, target, who, r.summary ?? "", typeof r.durationMs === "number" ? `${Math.round(r.durationMs)} ms` : ""].filter(Boolean).join(" · ");
  return (
    <div className="pc-evlog-row" style={{ top, height: ROW_H }} data-pc="agent-event" data-event-id={r.eventId} data-status={mark.cls} title={title}>
      <span className={`pc-evlog-mark pc-evlog-mark--${mark.cls}`} aria-label={mark.title}>
        {mark.ch}
      </span>
      <span className="pc-evlog-tool">{label}</span>
      {target ? <span className="pc-evlog-target">{target}</span> : null}
      <span className="pc-evlog-who">{who}</span>
      {op ? (
        <button type="button" className="pc-dialog-opt pc-evlog-undo" data-pc="agent-undo" disabled={done} onClick={() => revertAgentOp(op)}>
          {done ? tr("Undone") : tr("Undo this step")}
        </button>
      ) : null}
    </div>
  );
}

export function AgentEventLog() {
  const active = useSync((v) => v.active);
  const version = useSync((v) => v.eventsVersion);
  useSync((v) => v.agentOpsVersion);
  const [open, setOpen] = useState(readOpen);
  const [scrollTop, setScrollTop] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const records = useMemo(() => eventRecordList().filter((r) => r.kind === "tool"), [version]);
  if (!active || records.length === 0) return null;

  const total = records.length;
  const height = Math.min(total, VIEW_ROWS) * ROW_H;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const shown = records.slice(first, last);

  return (
    <div className="pc-evlog" data-pc="agent-event-log">
      <button
        type="button"
        className="pc-evlog-head"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          writeOpen(!open);
        }}
      >
        <span>{tr("{0} Agent action log", open ? "▾" : "▸")}</span>
        <span className="pc-evlog-count">{tr("{0} items", total)}</span>
      </button>
      {open ? (
        <div
          ref={boxRef}
          className="pc-evlog-box"
          style={{ height }}
          onScroll={(e: UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div style={{ position: "relative", height: total * ROW_H }}>
            {shown.map((r, i) => (
              <Row key={r.eventId} r={r} top={(first + i) * ROW_H} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
