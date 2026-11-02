/**
 * The input box at the top of the start page: write one sentence and a project is created.
 *
 * Pressing Enter or clicking the arrow hands the text and the aspect ratio to the upper layer
 * (`OnlineStart.tsx`): the upper layer creates a cloud project (in the online browser projects always
 * go to the cloud, `product/platforms.md` "Projects that can be created in the cloud"), sets the size
 * according to the aspect ratio, enters its chat page, and then sends this sentence to the Cloud Agent
 * as the first message (`workflow/production.md` "User sends an instruction"). When the user is not
 * logged in, or a guest has already created a project, the upper layer passes `disabled`, and here the
 * box is grayed out with the reason.
 *
 * "+ media": clicking it makes the upper layer open a file picker; the chosen media is first recorded
 * on the page (a count is shown on this button), and after this sentence is sent and the project is
 * created, it is passed into the project through the same import as the editor
 * (`importMediaFiles` in `src/editor/left/importAssets.ts`), and then the message is sent.
 */
import { useRef, useState } from "react";
import type { JSX } from "react";
import type { Ratio } from "./types";
import { tr } from "../i18n/index.ts";

const RATIOS: Ratio[] = ["16:9", "9:16", "1:1"];
/** Aligned with max-height in the CSS: anything longer scrolls by itself instead of pushing the first screen away */
const MAX_H = 180;

export function PromptBox(props: { onSubmit: (text: string, ratio: Ratio) => void; onUpload: () => void; fileCount?: number; disabled?: string | null; busy?: boolean }): JSX.Element {
  const [text, setText] = useState("");
  const [ratio, setRatio] = useState<Ratio>("16:9");
  const area = useRef<HTMLTextAreaElement>(null);

  // The input box grows taller with its content. Not using rows: line breaks and pasting a large block must both be right immediately
  const fit = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
  };

  const send = () => {
    const t = text.trim();
    if (!t || props.disabled || props.busy) return;
    props.onSubmit(t, ratio);
    setText("");
    // After clearing, the height must shrink back too, otherwise an empty large box is left behind
    requestAnimationFrame(fit);
  };

  return (
    <div className="ps-prompt" data-pc="start-prompt">
      <textarea
        ref={area}
        className="ps-prompt-input"
        data-pc="start-prompt-input"
        value={text}
        placeholder={props.disabled ?? tr("Describe the video you want: a topic, shots, or just paste in your copy")}
        disabled={!!props.disabled}
        aria-label={tr("Describe the video you want")}
        onChange={(e) => {
          setText(e.target.value);
          fit();
        }}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter inserts a newline; Enter during IME composition does not count
          // (in Chinese input, Enter confirms a candidate)
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="ps-prompt-foot">
        {/* This one is the call to action: it uses the emphasis color to steer people toward "upload media",
   so it does not carry the same weight as the row of aspect-ratio chips on the right */}
        <button
          type="button"
          className="ps-chip is-cta"
          data-pc="start-prompt-upload"
          aria-label={tr("Upload media")}
          onClick={props.onUpload}
        >
          <span className="ps-chip-plus" aria-hidden="true">{tr("+")}</span>{tr("Media{0}", props.fileCount ? ` · ${props.fileCount}` : "")}
        </button>
        {RATIOS.map((r) => (
          <button
            key={r}
            type="button"
            className="ps-chip"
            aria-pressed={r === ratio}
            onClick={() => setRatio(r)}
          >
            {r}
          </button>
        ))}
        <button
          type="button"
          className="ps-prompt-send"
          data-pc="start-prompt-send"
          disabled={!text.trim() || !!props.disabled || props.busy}
          aria-label={tr("Create a project from this prompt")}
          title={props.busy ? tr("Creating project…") : undefined}
          onClick={send}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
