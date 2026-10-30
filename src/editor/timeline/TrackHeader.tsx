import { useState } from "react";
import { Track } from "../../kernel/project";
import { actions } from "../../store/project";
import { ContextMenu } from "./ContextMenu";
import { useTimelineContext } from "./TimelineContext";
import { useReorderDrag, useRowOffset } from "./useReorder";
import { IconVolume, IconVolumeMute, IconDrag, IconEye, IconEyeOff, IconLock, IconUnlock } from "../../ui/icons";
import { useReadOnly } from "../readOnly";

/**
 * 序列行头(配色诊断与修正 v2 整屏)。
 * 左边拖动把手,中间名字(双击改名),右边「可见 / 锁定」两个图标——**常驻显示**,
 * 不再悬停才出现:用户要一眼看出哪条被锁了、哪条被藏了,悬停才显示等于藏起了状态。
 */
export function TrackHeader({ track, index }: { track: Track; index: number }) {
  const { trackH } = useTimelineContext();
  const { start: startReorder } = useReorderDrag();
  // 这个项目只给了只读权限(游客):换序、改名、静音 / 隐藏 / 锁定、删序列都不给
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
  /** 双击行名改名:只读项目里不给 */
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
        title={ro.title("按住上下拖 = 调整序列顺序")}
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
            track.name
          )}
        </div>
        {(track.muted || mutedClips > 0) && <span className="pc-track-mute-summary" title={track.muted ? "整条序列已静音" : `${mutedClips} 个片段已静音；放大时间轴可查看每段标记`}>
          {track.muted ? "已静音" : `${mutedClips} 静音`}
        </span>}
        <div className="pc-tl-row-acts" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" className={track.muted ? "is-active" : ""} disabled={ro.locked}
            onClick={() => actions.updateTrack(track.id, { muted: !track.muted })}
            title={ro.title(track.muted ? "打开序列声音" : "静音序列")} aria-label={track.muted ? "打开序列声音" : "静音序列"} aria-pressed={!!track.muted}>
            {track.muted ? <IconVolumeMute size={12} /> : <IconVolume size={12} />}
          </button>
          <button
            type="button"
            className={track.hidden ? "is-active" : ""}
            disabled={ro.locked}
            onClick={() => actions.updateTrack(track.id, { hidden: !track.hidden })}
            title={ro.title(track.hidden ? "已隐藏,点击显示" : "隐藏这条序列")}
            aria-pressed={!!track.hidden}
          >
            {track.hidden ? <IconEyeOff size={12} /> : <IconEye size={12} />}
          </button>
          <button
            type="button"
            className={track.locked ? "is-active" : ""}
            disabled={ro.locked}
            onClick={() => actions.updateTrack(track.id, { locked: !track.locked })}
            title={ro.title(track.locked ? "已锁定,点击解锁" : "锁定这条序列")}
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
          items={[{ label: ro.locked ? ro.why : "删除序列", disabled: ro.locked, action: () => actions.removeTrack(track.id) }]}
        />
      )}
    </>
  );
}
