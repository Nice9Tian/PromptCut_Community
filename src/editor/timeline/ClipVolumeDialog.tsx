import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TrackClip, Track } from "../../kernel/project";
import { actions } from "../../store/project";
import { tr } from "../../i18n/index.ts";

export function ClipVolumeDialog({ clip, track, onClose }: { clip: TrackClip; track: Track; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [percent, setPercent] = useState(String(Math.round((clip.audioVolume ?? 1) * 100)));
  const [error, setError] = useState("");
  const value = Number(percent);
  const valid = percent.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= 100;
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);

  return createPortal(
    <dialog ref={dialog} className="pc-clip-volume-dialog" aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const result = actions.setClipVolume(clip.id, value / 100);
        if (!result.ok) setError(result.error ?? tr("Failed to set volume"));
        else onClose();
      }}>
        <h3 id={titleId}>{tr("Adjust volume")}</h3>
        <p className="pc-volume-name">{clip.label || tr("Media clip")}</p>
        <div className="pc-volume-controls">
          <input autoFocus type="range" aria-label={tr("Clip volume")} min="0" max="100" step="1"
            value={valid ? value : 0} onChange={(e) => setPercent(e.target.value)} />
          <label><input type="number" aria-label={tr("Volume percentage")} min="0" max="100" step="1"
            value={percent} onChange={(e) => setPercent(e.target.value)} /> %</label>
        </div>
        <p>{tr("0% is silent, 100% is the original volume. Takes effect after you click OK.")}</p>
        {(clip.audioMuted || track.muted || track.hidden) && <p>{tr("This clip or track is muted or hidden. Adjusting the volume will not lift that state.")}</p>}
        {error && <p role="alert">{error}</p>}
        <div className="pc-volume-actions">
          <button type="button" onClick={() => setPercent("100")}>{tr("Restore original volume")}</button>
          <button type="button" onClick={onClose}>{tr("Cancel")}</button>
          <button type="submit" disabled={!valid || track.locked}>{tr("OK")}</button>
        </div>
      </form>
    </dialog>, document.body,
  );
}
