import { useTimelineContext } from "./TimelineContext";
import { useStore } from "../../store/project";
import { useDragPayload } from "../dnd";
import { useScrub } from "./useScrub";
import { xOfTime } from "./utils";
import { RULER_H } from "./Ruler";
import { RENDER_H } from "./RenderBar";
import { tr } from "../../i18n/index.ts";

/** Center line of the ruler row after subtracting the bottom progress line: the pill, tick marks and tick times are all vertically centered on it */
const MID_Y = (RULER_H - RENDER_H) / 2;

/** Time label on the playhead: like 0:00.0, "minutes:seconds.tenths", which reads faster than plain seconds */
function stamp(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * Playhead: a 1px vertical line in the main text color runs through all tracks, and in the ruler row
 * a pill in the main text color shows the current time,
 * at the same height as the tick times on the ruler (both vertically centered in the ruler row);
 * drag it to move the playhead.
 * The line color goes through --ui-fg (mapped in skins.css); the pill is in timeline.css.
 */
export function Playhead() {
  const t = useStore((s) => s.t);
  const { pxPerSec } = useTimelineContext();
  const startScrub = useScrub();
  // Get out of the mouse's way while a card / media item is dragged from the left rail (HTML5 drag and drop) passes over: the clip layer is its own stacking context (index.tsx), and the insert gaps and track rows are entirely below the playhead,
  // so when dragover lands on this 11px strip, the insert gap receives dragleave and clears the drop preview: the preview flashes, and releasing on this strip cannot create a new track either
  const dropping = useDragPayload() !== null;

  return (
    <div
      data-pc="playhead"
      // z must be lower than the left track column (that column is sticky z-30). It used to be z-40, and when scrolling horizontally
      // the playhead would be drawn over the track column stuck to the left, so the red line and time bubble ran straight through the row header.
      // z-20 is still above the track rows (auto), and since it comes after the ruler in the DOM it also covers the ruler.
      className="absolute bottom-0 z-20 flex justify-center cursor-ew-resize w-[11px] touch-none"
      style={{ left: `${xOfTime(t, pxPerSec)}px`, top: 0, transform: "translateX(-50%)", pointerEvents: dropping ? "none" : undefined }}
      onPointerDown={(e) => startScrub(e, { jumpToPointer: false })}
      title={tr("Drag = move the playhead (hold Alt to disable snapping)")}
    >
      <div className="absolute bottom-0 w-px bg-white pointer-events-none" style={{ top: MID_Y }} />
      <span className="pc-tl-playhead-label" style={{ top: MID_Y }}>{stamp(t)}</span>
    </div>
  );
}
