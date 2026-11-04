import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../../ai/types";
import { LiveMarkdown } from "../../../ai/Markdown";
import { attachIcon } from "./attachIcon";
import { OUTBOX_RESEND_EVENT, OUTBOX_TEXT } from "../../../ai/outbox";
import "./chat.css";
import "./queue.css";
import { tr } from "../../../i18n/index.ts";

/**
 * The few things "Rewind to here" needs. In AiPanel they are relayed through a ref, so the reference
 * never changes: MessageRow is memoized, and things that change, such as the message count or whether
 * a run is in progress, cannot be passed down as props, otherwise every streamed chunk would re-render
 * all user bubbles.
 * So they are all functions, read at the moment the confirmation layer is opened.
 */
export interface RewindHandlers {
  /** How many messages rewinding to this one removes (including itself) */
  countFrom: (userMessageId: string) => number;
  /** Whether this tab is running right now: if so, the confirmation layer adds "The current run will be stopped first" */
  isRunning: () => boolean;
  /** Whether the input box has content right now: if so, warn that it will be replaced */
  hasDraft: () => boolean;
  onRewind: (userMessageId: string) => void;
}

/** The window event sent by "Resend" (defined in outbox.ts, shared with the mobile page) */
export const CLOUD_RESEND_EVENT = OUTBOX_RESEND_EVENT;

/** Counterclockwise rewind arrow */
function IconRewind() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3v4h4" />
      <path d="M2.9 7A5.2 5.2 0 1 1 4.6 11.6" />
    </svg>
  );
}

/**
 * One user message: a right-aligned accent-color bubble, with no avatar.
 *
 * Attachments sit above the body, each as a small file capsule: which files were sent can be matched
 * at a glance with the cards in the input area a moment ago, without reading a string like
 * "[Attachments: a, b, c]".
 *
 * On hover a small toolbar appears to the left of the bubble, containing "Rewind to here"; clicking
 * it expands the confirmation layer below the bubble.
 */
export function UserBubble(props: { m: ChatMessage; rewind?: RewindHandlers }) {
  const { m, rewind } = props;
  /** Snapshot at the moment the confirmation layer opens: how many messages will be removed, whether a run is in progress, whether the input box has a draft */
  const [confirm, setConfirm] = useState<{ count: number; running: boolean; draft: boolean } | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  // After opening, focus lands on "Cancel" first: pressing Enter after a mis-click won't actually rewind
  useEffect(() => {
    if (!confirm) return;
    confirmRef.current?.querySelector<HTMLButtonElement>("[data-pc='ai-rewind-cancel']")?.focus();
  }, [confirm]);

  const toggleConfirm = () => {
    if (!rewind) return;
    setConfirm((cur) => (cur ? null : { count: rewind.countFrom(m.id), running: rewind.isRunning(), draft: rewind.hasDraft() }));
  };

  return (
    <div className="ai-user-turn">
      <div className="ai-user-line">
        {rewind && (
          <div className={`ai-user-tools${confirm ? " is-open" : ""}`}>
            <button
              type="button"
              className="pc-icon-btn"
              data-pc="ai-rewind"
              title={tr("Go back to before this message was sent: it and the chat after it are removed from the interface, and this message is put back in the input box")}
              aria-label={tr("Rewind to here")}
              aria-expanded={!!confirm}
              onClick={toggleConfirm}
            >
              <IconRewind />
            </button>
          </div>
        )}
        <div className={`ai-message user${m.sendState === "sending" || m.sendState === "queued" ? " is-sending" : m.sendState === "failed" ? " is-failed" : ""}`}>
          {m.attachments && m.attachments.length > 0 && (
            <div className="ai-bubble-files">
              {m.attachments.map((a, i) => (
                <span key={a.id || i} className="ai-bubble-file" title={a.name}>
                  <span aria-hidden="true">{attachIcon(a.kind)}</span>
                  <span className="ai-bubble-file-name">{a.name}</span>
                </span>
              ))}
            </div>
          )}
          {/* When only attachments were sent the body is empty; don't leave an empty paragraph that makes the bubble taller */}
          {m.text ? (
            <div className="ai-message-text">
              <LiveMarkdown text={m.text} live={!!m.pending} />
            </div>
          ) : null}
          {m.sendState === "sending" && <div className="ai-message-send-state" data-pc="cloud-send-state" data-state="sending">{tr("Sending…")}</div>}
          {m.sendState === "accepted" && <div className="ai-message-send-state" data-pc="cloud-send-state" data-state="accepted">{tr("Sent, waiting for the cloud to start processing…")}</div>}
          {m.sendState === "queued" && <div className="ai-message-send-state" data-pc="cloud-send-state" data-state="queued">{OUTBOX_TEXT.queued}</div>}
          {m.error && <div className="ai-message-error" data-pc={m.sendState === "failed" ? "cloud-send-failed" : undefined}>{m.error}</div>}
          {m.sendState === "failed" && m.resendable && (
            <button type="button" className="ai-message-resend" data-pc="cloud-resend"
              onClick={() => window.dispatchEvent(new CustomEvent(CLOUD_RESEND_EVENT, { detail: { id: m.id } }))}>
              {OUTBOX_TEXT.resend}
            </button>
          )}
        </div>
      </div>
      {rewind && confirm && (
        <div
          className="ai-rewind-confirm"
          role="alertdialog"
          aria-label={tr("Confirm rewind")}
          data-pc="ai-rewind-dialog"
          ref={confirmRef}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setConfirm(null);
          }}
        >
          <p>
            {tr("After rolling back, this message and the {0} messages after it will be removed, and the Agent will forget them. Changes already made on the timeline", confirm.count)}<strong>{tr("will not")}</strong>{tr(" be undone.")}
          </p>
          {confirm.running && <p className="ai-rewind-note">{tr("The current run will be stopped first.")}</p>}
          {confirm.draft && <p className="ai-rewind-note">{tr("The current content of the input box will be replaced by this message.")}</p>}
          <div className="ai-rewind-actions">
            <button
              type="button"
              className="pc-btn-primary"
              data-pc="ai-rewind-confirm"
              onClick={() => {
                setConfirm(null);
                rewind.onRewind(m.id);
              }}
            >
              {tr("Rewind")}
            </button>
            <button type="button" className="ai-rewind-cancel" data-pc="ai-rewind-cancel" onClick={() => setConfirm(null)}>
              {tr("Cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
