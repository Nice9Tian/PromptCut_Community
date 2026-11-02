/**
 * The chat page's input box. It was split out because it appears in **two places** (user decision,
 * 2026-10-26, issue #4):
 *
 *   - normally at the bottom of the chat column (`.ps-chat-foot`);
 *   - when "Detail editing" is expanded and the right side panel is also open, it moves to the bottom of
 *     the chat panel in the side panel (`ExtChatPanel.tsx`): detail editing takes up the whole chat area,
 *     and an input box left directly under the timeline is unsuitable (the original wording of issue #4).
 *
 * Both places share the **same** React state, so a half-typed draft follows when it moves, with no
 * separate moving logic; after the move the textarea remounts, and focus is restored by the caller
 * (`ChatView.tsx`).
 *
 * `narrow` only controls the frame and the auto-grow cap used in the narrow rail; whether it can send and
 * when the stop button appears follow exactly the same rules in both places.
 */
import { useLayoutEffect } from "react";
import type { JSX, RefObject } from "react";
import { tr } from "../i18n/index.ts";

/** Auto-grow cap, aligned with max-height of `.ps-chat-input` / the narrow-rail rule in CSS */
const MAX_H = 200;
const MAX_H_NARROW = 110;

export function Composer(props: {
  text: string;
  onText: (t: string) => void;
  /** Send the sentence in the input box */
  onSend: () => void;
  /** Stop this round (when the input box is empty and a run is in progress, the send button turns into this) */
  onStop: () => void;
  area: RefObject<HTMLTextAreaElement | null>;
  canSend: boolean;
  canStop: boolean;
  stopMode: boolean;
  placeholder: string;
  /** The line of small text under the input box: why it cannot send, how many are queued, that a reference was put in */
  note: string;
  /** Inside the panel in the right side panel (narrow) */
  narrow: boolean;
}): JSX.Element {
  const max = props.narrow ? MAX_H_NARROW : MAX_H;

  // Recompute the height when the text changes or the whole box moves: after moving it cannot stay at the height computed at the previous place
  useLayoutEffect(() => {
    const el = props.area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [props.text, props.narrow, props.area, max]);

  return (
    <div className={props.narrow ? "ps-ext-chat-foot" : "ps-chat-foot"}>
      <div className="ps-chat-box">
        <textarea
          ref={props.area}
          className="ps-chat-input"
          data-pc="start-chat-input"
          value={props.text}
          disabled={!props.canSend}
          placeholder={props.placeholder}
          aria-label={tr("Write a message")}
          onChange={(e) => props.onText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter inserts a newline; Enter during IME composition does not count
            // (in Chinese input, Enter confirms a candidate)
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              props.onSend();
            }
          }}
        />
        {props.stopMode ? (
          <button
            type="button"
            className="ps-prompt-send"
            data-pc="start-chat-stop"
            disabled={!props.canStop}
            aria-label={tr("Stop this turn")}
            title={props.canStop ? tr("Stop this turn") : tr("You can only stop tasks you started")}
            onClick={props.onStop}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          </button>
        ) : (
          <button
            type="button"
            className="ps-prompt-send"
            data-pc="start-chat-send"
            disabled={!props.text.trim() || !props.canSend}
            aria-label={tr("Send")}
            onClick={props.onSend}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
      <p className="ps-chat-note" role="status" data-pc="start-chat-note">{props.note}</p>
    </div>
  );
}
