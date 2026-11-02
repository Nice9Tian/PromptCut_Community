import { useCallback, useEffect, useRef } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { VoiceSettings } from "./VoiceSettings";
import { closeVoiceSettings, useVoiceSettingsState } from "../ai/voiceSettingsStore";
import { tr } from "../i18n/index.ts";

/**
 * "Voiceover settings" subwindow. Opened by both the voiceover card on the start page and the button in the editor top bar; each mounts an instance
 * (the start page and the editor are never on screen at the same time). Mounted on body so it is not clipped by outer overflow.
 */
export function VoiceSettingsDialog(): JSX.Element | null {
  const st = useVoiceSettingsState();
  if (!st.open) return null;
  // key uses seq: re-reads settings every time it opens, without carrying over unsaved changes from last time
  return <Dialog key={st.seq} />;
}

function Dialog(): JSX.Element {
  const dirty = useRef(false);

  // When there are unsaved changes, prompt before closing the window to avoid losing adjustments to an accidental Esc
  const close = useCallback(() => {
    if (dirty.current && !confirm(tr("You have unsaved changes. Discard them and close?"))) return;
    closeVoiceSettings();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return createPortal(
    // Only recognize clicks initiated on the overlay itself: dragging text in an input box and releasing outside the window should not close the window
    <div className="vsd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="vsd-dialog" role="dialog" aria-modal="true" aria-label={tr("Voiceover settings")}>
        <div className="vsd-head">
          <div className="vsd-title">{tr("Voiceover settings")}</div>
          <button className="vsd-x" onClick={close} aria-label={tr("Close")}>×</button>
        </div>
        <div className="vsd-body">
          <VoiceSettings bare onDirtyChange={(d) => { dirty.current = d; }} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
