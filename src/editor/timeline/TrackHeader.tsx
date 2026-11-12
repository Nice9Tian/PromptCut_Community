import { useState } from "react";
import { activeCutKind, Track } from "../../kernel/project";
import { actions, useStore } from "../../store/project";
import { ContextMenu } from "./ContextMenu";
import { useTimelineContext } from "./TimelineContext";
import { useReorderDrag, useRowOffset } from "./useReorder";
import { IconVolume, IconVolumeMute, IconDrag, IconEye, IconEyeOff, IconLock, IconUnlock } from "../../ui/icons";
import { useReadOnly } from "../readOnly";
import { tr } from "../../i18n/index.ts";
import { shownName } from "../../i18n/names.ts";

/**
 * Track header (color diagnosis and fix v2, full screen).
 * Drag handle on the left, name in the middle (double-click to rename), and two icons on the right,
 * "visible / locked": **always shown**, no longer appearing only on hover: users need to see at a glance
 * which track is locked and which is hidden, and showing them only on hover amounts to hiding the state.
 */
export function TrackHeader({ track, index }: { track: Track; index: number }) {
  const { trackH } = useTimelineContext();
  const is3dCut = useStore((s) => activeCutKind(s.project) === "3d");
  const { start: startReorder } = useReorderDrag();
  // This project only grants read-only permission (guest): reordering, renaming, mute / hide / lock, and deleting tracks are all disallowed
  const ro = useReadOnly();
  const offset = useRowOffset(index, track.id);
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(track.name);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const mutedClips = track.clips.filter(clip => clip.audioMuted || clip.audioVolume === 0).length;

  const handleBlur = () => {
    setIsEditing(false);
    if (name.trim() !== track.name) {
      actions.updateTrack(track.id, { name: name.trim() || track.name });
    }
  };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleBlur();
    if (e.key === "Escape") {
      setIsEditing(false);
      setName(track.name);
    }
  };
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };
  /** Double-click the row name to rename: not allowed in a read-only project */
  const startEditing = () => { if (!ro.locked) setIsEditing(true); };

  return (
    <>
      <div
        data-pc-track-header={track.id}
        className={`pc-tl-row select-none touch-none${offset.dragging ? " is-dragging z-40 relative" : ""}`}
        style={{
          height: trackH,
          transform: offset.y ? `translateY(${offset.y}px)` : undefined,
          transition: offset.animated ? "transform 150ms cubic-bezier(0.2, 0, 0, 1)" : "none",
        }}
        title={ro.title(tr("Press and drag up or down = reorder tracks"))}
        onContextMenu={handleContextMenu}
        onPointerDown={(e) => { if (!ro.locked) startReorder(e, index, track.id); }}
      >
        <IconDrag size={12} />
        <div className={`pc-tl-row-name${track.hidden ? " is-muted" : ""}`} onDoubleClick={startEditing}>
          {isEditing ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              onPointerDown={(e) => e.stopPropagation()}
            />
          ) : (
            shownName(track.name)
          )}
        </div>
        {is3dCut && (
          <span
            data-pc="track-depth-hint"
            className="pc-track-depth-badge"
            title={tr("In a 3D cut, occlusion follows 3D depth rather than track order; tracks only group clips and break equal-depth ties")}
          >
            {tr("Depth")}
          </span>
        )}
        {(track.muted || mutedClips > 0) && <span className="pc-track-mute-summary" title={track.muted ? tr("Whole track is muted") : tr("{0} clips muted; zoom in on the timeline to see each segment's marker", mutedClips)}>
          {track.muted ? tr("Muted") : tr("{0} muted", mutedClips)}
        </span>}
        <div className="pc-tl-row-acts" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" className={track.muted ? "is-active" : ""} disabled={ro.locked}
            onClick={() => actions.updateTrack(track.id, { muted: !track.muted })}
            title={ro.title(track.muted ? tr("Unmute track") : tr("Mute track"))} aria-label={track.muted ? tr("Unmute track") : tr("Mute track")} aria-pressed={!!track.muted}>
            {track.muted ? <IconVolumeMute size={12} /> : <IconVolume size={12} />}
          </button>
          <button
            type="button"
            className={track.hidden ? "is-active" : ""}
            disabled={ro.locked}
            onClick={() => actions.updateTrack(track.id, { hidden: !track.hidden })}
            title={ro.title(track.hidden ? tr("Hidden, click to show") : tr("Hide this track"))}
            aria-pressed={!!track.hidden}
          >
            {track.hidden ? <IconEyeOff size={12} /> : <IconEye size={12} />}
          </button>
          <button
            type="button"
            className={track.locked ? "is-active" : ""}
            disabled={ro.locked}
            onClick={() => actions.updateTrack(track.id, { locked: !track.locked })}
            title={ro.title(track.locked ? tr("Locked, click to unlock") : tr("Lock this track"))}
            aria-pressed={!!track.locked}
          >
            {track.locked ? <IconLock size={12} /> : <IconUnlock size={12} />}
          </button>
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[{ label: ro.locked ? ro.why : tr("Delete track"), disabled: ro.locked, action: () => actions.removeTrack(track.id) }]}
        />
      )}
    </>
  );
}
