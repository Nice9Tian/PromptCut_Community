import { useStore } from "../../store/project";
import { useDragPayload } from "../dnd";
import { useTimelineContext } from "./TimelineContext";
import { DropGhost } from "./DropGhost";
import { xOfTime } from "./utils";
import { useDropTarget } from "./useDropTarget";
import { useReadOnly } from "../readOnly";

/**
 * 最下面那条常驻的「新建序列落区」(配色诊断与修正 v2 整屏):26 高,虚线控件描边,
 * 淡强调色底。把卡片或素材拖到这里松手 = 自动新建一条序列,片段落在松手的那个时间点上。
 */
export function NewTrackZone() {
  const trackCount = useStore((s) => s.project.tracks.length);
  const payload = useDragPayload();
  const { pxPerSec } = useTimelineContext();
  const { onDragOver, onDragLeave, onDrop, plan } = useDropTarget({ newTrackIndex: trackCount });

  const tone = plan ? " is-target" : payload ? " is-armed" : "";
  // 只读项目(游客)里拖东西进来落不下去,这一条「把卡片 / 素材拖到这里」的邀请就不画
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
            {payload ? "松手 = 新建一条序列,片段落在这个时间点" : "把卡片 / 素材拖到这里 = 新建一条序列"}
          </span>
        )}
        {plan && <DropGhost plan={plan} />}
      </div>
    </div>
  );
}
