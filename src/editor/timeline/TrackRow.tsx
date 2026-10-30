import { Track } from "../../kernel/project";
import { ClipView } from "./ClipView";
import { DropGhost } from "./DropGhost";
import { useTimelineContext } from "./TimelineContext";
import { useDropTarget } from "./useDropTarget";
import { useRowOffset } from "./useReorder";

export function TrackRow({ track, index }: { track: Track; index: number }) {
  const { draggingTrackId, trackH } = useTimelineContext();
  const offset = useRowOffset(index, track.id);
  const { onDragOver, onDragLeave, onDrop, plan } = useDropTarget({ trackId: track.id });

  const isDraggingTarget = draggingTrackId === track.id;

  let bgClass = "bg-neutral-900";
  if (plan) {
    bgClass = plan.status === "forbidden" ? "bg-red-950/60" : "bg-neutral-800";
  } else if (isDraggingTarget) {
    bgClass = "bg-neutral-800";
  }

  return (
    <div
      data-track-id={track.id}
      className={`pc-tl-track relative border-b border-neutral-800/50 box-border ${bgClass} ${offset.dragging ? "z-40 opacity-90" : ""}`}
      style={{
        height: trackH,
        transform: offset.y ? `translateY(${offset.y}px)` : undefined,
        transition: offset.animated ? "transform 150ms cubic-bezier(0.2, 0, 0, 1)" : "none",
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {!track.hidden && track.clips.map((clip) => (
        <ClipView key={clip.id} clip={clip} track={track} />
      ))}

      {plan && <DropGhost plan={plan} />}

      {track.locked && (
        <div className="absolute inset-0 bg-black/20 pointer-events-none z-50 diagonal-stripes" />
      )}
    </div>
  );
}
