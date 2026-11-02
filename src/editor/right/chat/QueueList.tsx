import { useLayoutEffect, useRef, useState } from "react";
import { useQueue, remove, type QueuedItem } from "../../../ai/chatQueue";
import { playEnter, prefersReducedMotion } from "../../enterMotion";
import "./queue.css";
import type { ChatMessage } from "../../../ai/types";
import type { CloudQueueSnapshot, CloudSender } from "../../../ai/chatTypes";
import { accountMessageId, isIdleHead } from "../../../ai/chatTypes";
import { tr } from "../../../i18n/index.ts";

/** Server FIFO is already accepted; local insert/edit/remove controls do not apply. */
export function CloudQueueList(props: { queue?: CloudQueueSnapshot | null; messages: ChatMessage[]; senders?: Record<string, CloudSender>;
  /**
   * The cloud executor service is asking (`info.executorMounted`): while it is asking, the first item
   * in an idle chat starts immediately and doesn't count as queued; when it isn't asking, messages
   * really are waiting in line, so list them as before
   */
  executorMounted?: boolean }) {
  // The first item in an idle chat starts immediately and doesn't count as queued (under its bubble it
  // says "Sent, waiting for the cloud to start processing…", see isIdleHead in events.ts)
  const items = props.queue?.items.filter(item => item.state === 'queued' && !(props.executorMounted && isIdleHead(props.queue, item)))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)) ?? [];
  const waitingJobs = props.messages.some(m => m.role === 'assistant' && m.pending && (m.progress?.waitingJobs || m.progress?.phase === 'waiting_jobs'));
  const queuedLook = props.messages.find(m => m.role === 'assistant' && m.pending && ((m.progress as Record<string, any>)?.renderQueuePosition || m.progress?.phase === 'render_queued'));
  const renderQueuePos = (queuedLook?.progress as Record<string, any>)?.renderQueuePosition ?? 1;
  if (!items.length && !waitingJobs && !queuedLook) return null;
  return <section className="ai-queue" data-pc="cloud-queue" data-queue-revision={props.queue?.queueRevision} aria-label={tr("Persistent cloud queue")}>
    {queuedLook ? (
      <div className="ai-queue-head pc-cloud-render-queued" data-pc="cloud-queue-render-queued">
        {tr("The cloud render is busy with another project. You are No. {0} in the queue and it will continue when your turn comes.", renderQueuePos)}
      </div>
    ) : waitingJobs ? (
      <div className="ai-queue-head pc-cloud-waiting-jobs" data-pc="cloud-queue-waiting-jobs">
        {tr("The background job started by the previous message (transcription, shot detection, etc.) is still running. Your message will be handled once it finishes.")}
      </div>
    ) : (
      <div className="ai-queue-head">{tr("{0} queued · waiting for the execution service", items.length)}</div>
    )}
    {items.length > 0 && (
      <ol className="ai-queue-list">{items.map(item => {
        const id = accountMessageId(item.messageId), message = props.messages.find(row => row.id === id);
        return <li className="ai-queue-item" key={item.messageId} data-message-id={item.messageId} data-queue-position={item.position}>
          <span className="ai-queue-no">{tr("No. {0}", item.position)}</span>
          <span className="pc-cloud-sender">{props.senders?.[id]?.name ?? tr("Loading sender")}</span>
          <span className="ai-queue-text">{message?.text ?? tr("Loading message")}</span>
        </li>;
      })}</ol>
    )}
  </section>;
}

/** How long a row leaving the queue takes to fade out and collapse, same as ai-queue-row-leave in queue.css */
const LEAVE_MS = 160;

/** A row that just left the queue: stays at its old position (at) for a while to play the fade-out, with no buttons or automation hooks */
interface Ghost {
  item: QueuedItem;
  at: number;
}

export interface QueueListProps {
  tabId: string;
  /** This page is running right now (streaming) */
  running: boolean;
  /** "Insert": take this item out of the queue and send it immediately. The turn currently running gets interrupted (the abort at the start of send) */
  onInsert: (item: QueuedItem) => void;
  /** "Edit": put this item back into the input box and remove it from the queue. Whether to replace the input box content has already been asked here */
  onEdit: (item: QueuedItem) => void;
  /** "Resume": lift the pause and, if idle, send the head of the queue immediately */
  onResume: () => void;
  /** Whether the input box has content right now; if so, "Edit" asks for confirmation before replacing */
  hasDraft: () => boolean;
}

/**
 * Input queue, placed between the thinking strip and the input area; not rendered when the queue is empty.
 *
 * Messages the user submits while the Agent is running are queued here, and once this turn settles
 * useAiChat sends them automatically in order. When the user clicks "Stop" the queue pauses, and the
 * header changes to "Paused" and "Resume".
 *
 * Entering and leaving is animated: newly queued rows fade in (when the queue goes from empty to
 * non-empty the whole block floats up and fades in), and rows that are sent / deleted / taken for
 * editing fade out in place and collapse; when the queue empties the header collapses with it, so the
 * whole block doesn't vanish with a "pop".
 */
export function QueueList(props: QueueListProps) {
  const { tabId, running, onInsert, onEdit, onResume, hasDraft } = props;
  const { items, paused } = useQueue(tabId);
  /** The item currently being asked to confirm "replace the input box content" */
  const [confirmEdit, setConfirmEdit] = useState<string | null>(null);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const prevItems = useRef(items);
  /** The sentence still shown while the queue is empty and the header is collapsing (the last header text before it emptied) */
  const lastHead = useRef("");

  useLayoutEffect(() => {
    const before = prevItems.current;
    if (before === items) return;
    prevItems.current = items;
    const was = new Set(before.map((it) => it.id));
    const now = new Set(items.map((it) => it.id));
    if (before.length === 0 && items.length > 0) {
      playEnter(sectionRef.current, "pc-enter-rise");
    } else {
      // The list scrolls by itself; rows don't shift (a few extra pixels would make the scrollbar flicker), they only fade in
      for (const it of items) {
        if (!was.has(it.id)) playEnter(listRef.current?.querySelector(`[data-pc-queue="${CSS.escape(it.id)}"]`), "pc-enter-fade");
      }
    }
    // With reduced motion requested by the system, leave no ghost row: without an animation it would just be a row of dead text hanging around for 160ms
    if (prefersReducedMotion()) return;
    const gone: Ghost[] = before.flatMap((item, at) => (now.has(item.id) ? [] : [{ item, at }]));
    if (gone.length === 0) return;
    setGhosts((cur) => [...cur, ...gone]);
    window.setTimeout(() => setGhosts((cur) => cur.filter((g) => !gone.includes(g))), LEAVE_MS);
  }, [items]);

  if (items.length === 0 && ghosts.length === 0) return null;

  /** Only ghost rows remain: the queue was just emptied and is collapsing */
  const leaving = items.length === 0;
  // The user stopped it, or nothing is running right now (nobody will come to send the head of the queue): show both as paused, with a "Resume"
  const halted = paused || !running;
  if (!leaving) {
    lastHead.current = halted ? tr("Paused · {0} queued", items.length) : tr("{0} queued · will send automatically when the Agent finishes", items.length);
  }

  // Insert ghost rows back at their original positions (insert by original index from small to large, so earlier insertions fill in the later positions exactly)
  type Row = { ghost: false; it: QueuedItem; no: number } | { ghost: true; g: Ghost };
  const rows: Row[] = items.map((it, i) => ({ ghost: false, it, no: i + 1 }));
  for (const g of [...ghosts].sort((a, b) => a.at - b.at)) rows.splice(Math.min(g.at, rows.length), 0, { ghost: true, g });

  return (
    <section className="ai-queue" data-pc={leaving ? undefined : "ai-queue"} aria-label={tr("Input queue")} ref={sectionRef}>
      <div className={`ai-queue-head${halted && !leaving ? " is-paused" : ""}${leaving ? " is-leaving" : ""}`}>
        {leaving ? (
          <span className="ai-queue-head-text">{lastHead.current}</span>
        ) : halted ? (
          <>
            <span className="ai-queue-head-text">{lastHead.current}</span>
            <button
              type="button"
              className="ai-queue-btn is-accent"
              data-pc="queue-resume"
              title={tr("Send the first message in the queue now; the rest then send automatically in order as usual")}
              onClick={onResume}
            >
              {tr("Resume")}
            </button>
          </>
        ) : (
          <span className="ai-queue-head-text">{lastHead.current}</span>
        )}
      </div>
      <ol className="ai-queue-list" ref={listRef}>
        {rows.map((row) => {
          if (row.ghost) {
            const it = row.g.item;
            return (
              <li key={`ghost:${it.id}`} className="ai-queue-item is-leaving" aria-hidden="true">
                <span className="ai-queue-no" />
                <span className={`ai-queue-text${it.text ? "" : " is-faint"}`}>{it.text || tr("(attachments only)")}</span>
              </li>
            );
          }
          const { it, no } = row;
          const files = it.attachments ?? [];
          return (
            <li key={it.id} className="ai-queue-item" data-pc-queue={it.id}>
              <span className="ai-queue-no">{no}</span>
              {confirmEdit === it.id ? (
                <>
                  <span className="ai-queue-text is-faint">{tr("The input box has content. Replace it with this one?")}</span>
                  <button
                    type="button"
                    className="ai-queue-btn is-accent"
                    data-pc="queue-edit-confirm"
                    onClick={() => { setConfirmEdit(null); onEdit(it); }}
                  >
                    {tr("Replace")}
                  </button>
                  <button type="button" className="ai-queue-btn" onClick={() => setConfirmEdit(null)}>
                    {tr("Cancel")}
                  </button>
                </>
              ) : (
                <>
                  <span className={`ai-queue-text${it.text ? "" : " is-faint"}`} title={it.text || undefined}>
                    {it.text || tr("(attachments only)")}
                  </span>
                  {files.length > 0 && (
                    <span className="ai-queue-files" title={files.map((f) => f.name).join("\n")}>
                      {tr("Attachments {0}", files.length)}
                    </span>
                  )}
                  <button
                    type="button"
                    className="ai-queue-btn is-accent"
                    data-pc="queue-insert"
                    title={running ? tr("Send this one now: interrupts the current run") : tr("Send this one now")}
                    onClick={() => onInsert(it)}
                  >
                    {tr("Insert")}
                  </button>
                  <button
                    type="button"
                    className="ai-queue-btn"
                    data-pc="queue-edit"
                    title={tr("Move back to the input box to edit, and remove from the queue")}
                    onClick={() => (hasDraft() ? setConfirmEdit(it.id) : onEdit(it))}
                  >
                    {tr("Edit")}
                  </button>
                  <button
                    type="button"
                    className="ai-queue-btn ai-queue-x"
                    data-pc="queue-remove"
                    title={tr("Remove from the queue")}
                    aria-label={tr("Delete item {0}", no)}
                    onClick={() => remove(tabId, it.id)}
                  >
                    ×
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
