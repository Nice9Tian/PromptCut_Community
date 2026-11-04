import { useStore } from "../../store/project";
import { useDragPayload } from "../dnd";
import { useTimelineContext } from "./TimelineContext";
import { xOfTime } from "./utils";
import { useDropTarget } from "./useDropTarget";
import { tr } from "../../i18n/index.ts";

/**
 * Insert gaps between tracks: when dragging a card / media between two tracks, a blue line appears, and
 * releasing inserts a new track at that position.
 * It exists only during a drag, and normally does not block clicks and drags on clips.
 */
export function InsertZones() {
  const tracks = useStore((s) => s.project.tracks);
  const payload = useDragPayload();
  if (!payload) return null;
  return (
    <>
      {tracks.map((t, i) => (
        <InsertZone key={t.id} index={i} />
      ))}
    </>
  );
}

function InsertZone({ index }: { index: number }) {
  const { pxPerSec, trackH } = useTimelineContext();
  const { onDragOver, onDragLeave, onDrop, plan } = useDropTarget({ newTrackIndex: index });

  return (
    <div
      data-pc-insert={index}
      className="absolute inset-x-0 z-40"
      style={{ top: Math.max(0, index * trackH - 5), height: 10 }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {plan && (
        <>
          <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full pointer-events-none bg-[var(--ui-accent)]" />
          <div
            className="absolute top-1/2 z-50 flex h-5 -translate-y-1/2 items-center whitespace-nowrap rounded px-1.5 text-[10px] text-white pointer-events-none bg-[var(--ui-accent)]"
            // The topmost gap sits against the top edge of the clip layer: if the label moved up by half, 5px would slip under the sticky green bar (the clip layer is one layer below it), so place it going down from the top edge instead
            style={index === 0
              ? { left: `${xOfTime(plan.start, pxPerSec)}px`, top: 0, transform: "none", translate: "none" }
              : { left: `${xOfTime(plan.start, pxPerSec)}px` }}
          >
            {tr("{0} · new track", plan.label)}
          </div>
        </>
      )}
    </div>
  );
}
