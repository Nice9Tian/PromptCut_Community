import type { JSX } from "react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { DEBUG_INLINE_LIMIT, copyDebugReport, downloadReportFile, saveReportToFile } from "../../ai/debug";
import { SUBMIT_URL, submitBlockedReason, submitReport } from "../../ai/reportSubmit";
import "./ReportDialog.css";
import { tr } from "../../i18n/index.ts";

/** Compile-time constant of the online build (see "online build pruning" in `src/online/pageFlag.ts` for how it is written and why): the online build prunes the "ask the local editor process to write to disk" path */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/**
 * Sub-window for the diagnostic report: the report sits in a text box, with three exits below:
 * copy / save as file / submit.
 *
 * It used to be "click Debugger and the report picks a route by its length and leaves". Users could
 * not see what the report looked like, and had no choice: short ones went to the clipboard, long
 * ones were written straight to disk and popped up a folder. Now the content is laid out first,
 * each of the three routes is a button, and the user decides which one to take.
 *
 * Reports that are too long **lock copy**: pasting several hundred KB into a chat box neither works
 * nor gets read, so rather than let the user copy successfully but be unable to send it, say so
 * plainly on the spot: "use save as file instead".
 */
export function ReportDialog(props: {
  open: boolean;
  /** Window title, e.g. "Environment diagnostics" */
  title: string;
  /** Report body; empty means still being collected */
  text: string;
  /** Filename prefix when saving to a file; falls back to title if not given */
  label?: string;
  /** The sentence at the top saying what is in this report */
  hint?: string;
  /**
   * How "Save as file" works; when not given: the desktop app asks the local editor to write to disk
   * and open the containing folder, the online page downloads a copy in the browser (the online page
   * does not request the editor process's `/api/*`). Returns the receipt shown to the user.
   */
  saveFile?: (text: string, label: string) => Promise<string> | string;
  onClose: () => void;
}): JSX.Element | null {
  const { open, title, text, hint, onClose } = props;
  const label = props.label || title;
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Start from a clean state on every reopen, so the previous "Copied" message does not linger
  useEffect(() => {
    if (open) { setBusy(""); setMsg(null); }
  }, [open]);

  // Esc closes the sub-window. Intercept it in the capture phase and call stopPropagation: the outer
  // AI settings dialog also listens for Esc, and without this one press would close both layers.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  const chars = text.length;
  const kb = Math.round(chars / 1024);
  const tooLongToCopy = chars > DEBUG_INLINE_LIMIT;
  const submitBlocked = submitBlockedReason(text);
  const collecting = !text;

  const run = async (what: string, fn: () => Promise<string>) => {
    setBusy(what);
    setMsg(null);
    try {
      setMsg({ tone: "ok", text: await fn() });
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy("");
    }
  };

  const doCopy = () => run("copy", async () => {
    await copyDebugReport(text);
    return tr("Copied to clipboard, just paste it to us");
  });

  const doSave = () => run("save", async () => {
    if (props.saveFile) return await props.saveFile(text, label);
    if (ONLINE_BUILD) return downloadReportFile(text, label);
    const out = await saveReportToFile(text, label);
    return tr("Saved and opened the containing folder: {0}", out.file);
  });

  const doSubmit = () => run("submit", () => submitReport(text, label));

  return createPortal(
    // Sits on top of the AI settings dialog, so its z-index must be one tier higher (that one is 10000)
    <div className="rpt-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rpt-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="rpt-head">
          <div className="rpt-title">{title}</div>
          <button className="rpt-x" onClick={onClose} title={tr("Close")} aria-label={tr("Close")}>×</button>
        </div>

        <div className="rpt-meta">
          <span>{collecting ? tr("Collecting…") : tr("{0} characters · about {1}KB", chars.toLocaleString(), kb)}</span>
          {hint && <span className="rpt-hint">{hint}</span>}
        </div>

        <textarea
          className="rpt-text"
          readOnly
          spellCheck={false}
          value={collecting ? "" : text}
          placeholder={tr("Collecting…")}
          onFocus={(e) => { if (!tooLongToCopy) e.currentTarget.select(); }}
        />

        {tooLongToCopy && (
          <div className="rpt-warn">
            {tr("The report is over {0} characters, so \"Copy\" is locked: content this long cannot be pasted into the chat box or read there. Use \"Save as file\" and send us the generated txt.", DEBUG_INLINE_LIMIT.toLocaleString())}
          </div>
        )}

        {msg && <div className={`rpt-msg${msg.tone === "err" ? " is-err" : ""}`}>{msg.text}</div>}

        <div className="rpt-actions">
          <button
            className="rpt-btn"
            disabled={collecting || tooLongToCopy || busy !== ""}
            title={tooLongToCopy ? tr("Report is too long to paste. Use \"Save as file\" instead") : tr("Copy the report to the clipboard")}
            onClick={doCopy}
          >
            {busy === "copy" ? tr("Copying…") : tr("Duplicate")}
          </button>
          <button
            className="rpt-btn"
            disabled={collecting || busy !== ""}
            title={ONLINE_BUILD ? tr("Download as file") : tr("Save as txt and open the containing folder")}
            onClick={doSave}
          >
            {busy === "save" ? tr("Saving…") : tr("Save as file")}
          </button>
          <span className="rpt-spacer" />
          <button
            className="rpt-btn rpt-primary"
            disabled={collecting || submitBlocked !== "" || busy !== ""}
            title={submitBlocked || tr("Send to {0}", SUBMIT_URL)}
            onClick={doSubmit}
          >
            {busy === "submit" ? tr("Submitting…") : tr("Submit")}
          </button>
        </div>
        {submitBlocked && !collecting && <div className="rpt-note">{submitBlocked}</div>}
      </div>
    </div>,
    document.body,
  );
}
