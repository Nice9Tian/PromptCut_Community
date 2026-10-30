import { useTimelineContext } from "./TimelineContext";
import { useStore } from "../../store/project";
import { useDragPayload } from "../dnd";
import { useScrub } from "./useScrub";
import { xOfTime } from "./utils";
import { RULER_H } from "./Ruler";
import { RENDER_H } from "./RenderBar";

/** 标尺行扣掉底边进度线后的中线:胶囊、刻度线、刻度时间都按它竖向居中 */
const MID_Y = (RULER_H - RENDER_H) / 2;

/** 播放头上的时间标签:0:00.0 这种「分:秒.十分之一秒」,读起来比纯秒数快 */
function stamp(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * 播放头:1px 主文字色竖线贯穿所有轨,标尺那一行里一枚主文字色胶囊写着当前时间,
 * 和标尺上的刻度时间在同一个高度(都在标尺行里竖向居中),拖它移动播放头。
 * 线的颜色走 --ui-fg(skins.css 映射),胶囊在 timeline.css。
 */
export function Playhead() {
  const t = useStore((s) => s.t);
  const { pxPerSec } = useTimelineContext();
  const startScrub = useScrub();
  // 从左栏拖卡片 / 素材(HTML5 拖放)经过时让开鼠标:片段层是独立层叠上下文(index.tsx),插入缝和轨道行整层都在播放头下面,
  // dragover 落到这 11px 竖条上,插入缝会收到 dragleave 把落点预览清掉 —— 预览闪一下,这一条上松手也建不了新序列
  const dropping = useDragPayload() !== null;

  return (
    <div
      data-pc="playhead"
      // z 必须低于左侧序列栏(那一栏是 sticky z-30)。原来是 z-40,横向滚动时
      // 播放头会画到贴住左边的序列栏上面去,红线和时间气泡直接穿过行头。
      // z-20 仍然高于轨道行(auto),也因为在 DOM 里排在标尺之后而盖得住标尺。
      className="absolute bottom-0 z-20 flex justify-center cursor-ew-resize w-[11px] touch-none"
      style={{ left: `${xOfTime(t, pxPerSec)}px`, top: 0, transform: "translateX(-50%)", pointerEvents: dropping ? "none" : undefined }}
      onPointerDown={(e) => startScrub(e, { jumpToPointer: false })}
      title="拖动 = 移动播放头(按 Alt 不吸附)"
    >
      <div className="absolute bottom-0 w-px bg-white pointer-events-none" style={{ top: MID_Y }} />
      <span className="pc-tl-playhead-label" style={{ top: MID_Y }}>{stamp(t)}</span>
    </div>
  );
}
