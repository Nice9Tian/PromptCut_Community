/**
 * UI while saving: while a save is in progress, overlay a "Saving" layer (foreground editing paused,
 * see `saveLock.ts`), and when saving ends, state the result clearly.
 *
 * - Saving: a semi-transparent scrim over the whole page, with a small card in the middle reading
 *   "Saving project" and the local writes being waited on; the scrim only lets the user see that
 *   editing is not possible right now, what actually blocks input is the interception that
 *   `saveLock.ts` attaches in the window capture phase.
 * - After it ends: when saving did not succeed (timeout waiting for local writes, disk write
 *   failure) or succeeded but has something to say (fell back to a browser download, media missing
 *   from the package, prerender snapshots not saved), a card that does not block operation appears
 *   at the top: the lock is already released and editing continues as usual; the card is dismissed
 *   with "Got it" or Esc.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { dismissSaveNotice, getSaveLockState, getSaveNotice, subscribeSaveLock, subscribeSaveNotice } from "./saveLock";
import "./ExportDialog.css";
import { tr } from "../i18n/index.ts";

export function SaveStatusLayer() {
  const lock = useSyncExternalStore(subscribeSaveLock, getSaveLockState, getSaveLockState);
  const notice = useSyncExternalStore(subscribeSaveNotice, getSaveNotice, getSaveNotice);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!notice || lock.saving) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissSaveNotice();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notice, lock.saving]);

  if (lock.saving) {
    const what = lock.kind === "procp" ? tr("packaging and saving project") : tr("Save project");
    return (
      <div className="pc-export-backdrop" data-pc="save-lock" data-step={lock.step ?? ""} style={{ zIndex: 400, cursor: "progress", background: "rgba(0, 0, 0, 0.35)" }}>
        <div className="pc-export-dialog" role="alertdialog" aria-modal="true" aria-busy="true" aria-label={tr("Running {0}", what)} style={{ maxWidth: 380 }}>
          <div className="pc-export-title">{tr("Now {0}…", what)}</div>
          <div className="pc-export-hint">{tr("Editing is temporarily unavailable until saving finishes.")}</div>
          {lock.step === "writing" ? (
            <div className="pc-export-ok" data-pc="save-lock-step">{tr("Writing file…")}</div>
          ) : lock.waiting.length > 0 ? (
            <div className="pc-export-ok" data-pc="save-lock-waiting" style={{ whiteSpace: "pre-line" }}>
              {tr("Wait for these local writes to finish first:\n{0}", lock.waiting.map((w) => `· ${w}`).join("\n"))}
            </div>
          ) : (
            <div className="pc-export-ok" data-pc="save-lock-step">{tr("Checking local changes…")}</div>
          )}
        </div>
      </div>
    );
  }

  if (!notice) return null;
  return (
    <div
      className="pc-export-dialog"
      role={notice.tone === "error" ? "alert" : "status"}
      data-pc="save-notice"
      data-tone={notice.tone}
      style={{ position: "fixed", top: 56, left: "50%", transform: "translateX(-50%)", zIndex: 400, maxWidth: 460, width: "calc(100% - 32px)" }}
    >
      <div className="pc-export-title">{notice.title}</div>
      <div className={notice.tone === "error" ? "pc-export-err" : "pc-export-ok"} style={{ whiteSpace: "pre-line" }}>{notice.message}</div>
      <div className="pc-export-actions">
        <button ref={okRef} type="button" className="pc-export-btn pc-export-primary" onClick={dismissSaveNotice}>{tr("Got it")}</button>
      </div>
    </div>
  );
}
