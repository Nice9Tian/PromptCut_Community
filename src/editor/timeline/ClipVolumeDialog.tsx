import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TrackClip, Track } from "../../kernel/project";
import { actions } from "../../store/project";

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
        if (!result.ok) setError(result.error ?? "音量设置失败");
        else onClose();
      }}>
        <h3 id={titleId}>调整声音音量</h3>
        <p className="pc-volume-name">{clip.label || "媒体片段"}</p>
        <div className="pc-volume-controls">
          <input autoFocus type="range" aria-label="声音音量" min="0" max="100" step="1"
            value={valid ? value : 0} onChange={(e) => setPercent(e.target.value)} />
          <label><input type="number" aria-label="音量百分比" min="0" max="100" step="1"
            value={percent} onChange={(e) => setPercent(e.target.value)} /> %</label>
        </div>
        <p>0% 为无声，100% 为原声。点击确定后生效。</p>
        {(clip.audioMuted || track.muted || track.hidden) && <p>当前片段或序列已静音或隐藏，调整音量不会解除该状态。</p>}
        {error && <p role="alert">{error}</p>}
        <div className="pc-volume-actions">
          <button type="button" onClick={() => setPercent("100")}>恢复原声</button>
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" disabled={!valid || track.locked}>确定</button>
        </div>
      </form>
    </dialog>, document.body,
  );
}
