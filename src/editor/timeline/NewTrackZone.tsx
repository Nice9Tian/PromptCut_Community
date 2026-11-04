import { useStore } from "../../store/project";
import { useDragPayload } from "../dnd";
import { useTimelineContext } from "./TimelineContext";
import { DropGhost } from "./DropGhost";
import { xOfTime } from "./utils";
import { useDropTarget } from "./useDropTarget";
import { useReadOnly } from "../readOnly";
import { tr } from "../../i18n/index.ts";

/**
 * The always-present "new track drop zone" at the very bottom (color diagnosis and fix v2, full screen):
 * 26 high, dashed control outline, light accent-color background. Releasing a card or media here =
 * automatically creates a new track, with the clip landing at the time point of the release.
 */
export function NewTrackZone() {
  const trackCount = useStore((s) => s.project.tracks.length);
  const payload = useDragPayload();
  const { pxPerSec } = useTimelineContext();
  const { onDragOver, onDragLeave, onDrop, plan } = useDropTarget({ newTrackIndex: trackCount });

  const tone = plan ? " is-target" : payload ? " is-armed" : "";
  // In a read-only project (guest), things dragged in cannot land, so this "drag a card / media here" invitation is not drawn
  const ro = useReadOnly();
  if (ro.locked) return null;

  return (
    <div style={{ padding: "9px 2px 11px" }}>
      <div
        data-pc="new-track-zone"
        className={`pc-tl-newzone relative${tone}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {!plan && (
          <span className="pointer-events-none" style={{ marginLeft: Math.max(0, xOfTime(0, pxPerSec) - 10) }}>
            {payload ? tr("Release = create a new track, the clip lands at this time point") : tr("Drag a card / media here = create a new track")}
          </span>
        )}
        {plan && <DropGhost plan={plan} />}
      </div>
    </div>
  );
}
