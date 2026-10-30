import { useTimelineContext } from "./TimelineContext";
import { useStore } from "../../store/project";
import { useScrub } from "./useScrub";
import { xOfTime } from "./utils";
import { RenderBar } from "./RenderBar";

/** 主刻度标签:mm:ss(00:05、01:30)。步长 0.5 秒时主刻度会落在 2.5 秒这种位置,补一位小数(00:02.5) */
function mss(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.round((t - m * 60) * 1000) / 1000;
  const mm = String(m).padStart(2, "0");
  return Number.isInteger(s) ? `${mm}:${String(s).padStart(2, "0")}` : `${mm}:${s.toFixed(1).padStart(4, "0")}`;
}

/** 标尺高度(px)。序列栏的表头(index.tsx)和播放头把手的位置都按它排 */
export const RULER_H = 22;

/**
 * 时间标尺:时间轴顶上唯一的一条(不再有开始—结束范围条)。
 * 主刻度(每 5 格)一道竖线、右边跟 mm:ss 时间;次刻度是短竖线。都用弱色,不抢片段的眼。
 * 底边那条线就是预渲染进度(RenderBar),不另占一行。
 */
export function Ruler() {
  const { pxPerSec } = useTimelineContext();
  const duration = useStore((s) => Math.max(s.project.duration, s.t + 10));
  const startScrub = useScrub();

  let step = 1;
  if (pxPerSec < 10) step = 10;
  else if (pxPerSec < 20) step = 5;
  else if (pxPerSec <= 200) step = 1;
  else if (pxPerSec <= 400) step = 0.5;
  else step = 0.1;

  // 防止 duration 被内容撑得极大(几万秒)生成数万个刻度节点卡死页面:超 1200 个就往上一档跳
  while (duration / step > 1200) {
    if (step === 1) step = 2;
    else if (step === 2) step = 5;
    else if (step === 5) step = 10;
    else if (step === 10) step = 30;
    else if (step === 30) step = 60;
    else step *= 2;
  }

  const ticks: number[] = [];
  for (let i = 0; i <= duration; i += step) ticks.push(Math.round(i * 1000) / 1000);

  return (
    <div
      data-pc="ruler"
      className="pc-tl-ruler relative cursor-ew-resize overflow-hidden select-none touch-none"
      style={{ height: RULER_H }}
      onPointerDown={(e) => startScrub(e, { jumpToPointer: true })}
      title="按住拖动 = 移动播放头(按 Alt 不吸附)"
    >
      {ticks.map((tick) => {
        const isMajor = Math.abs(tick % Math.max(1, step * 5)) < 1e-6 || tick === 0;
        return (
          <div
            key={tick}
            className={`pc-tl-tick${isMajor ? " is-major" : ""}`}
            style={{ left: `${xOfTime(tick, pxPerSec)}px` }}
          >
            {isMajor && <span className="pc-tl-tick-label">{mss(tick)}</span>}
          </div>
        );
      })}
      <div className="pc-tl-ruler-progress">
        <RenderBar />
      </div>
    </div>
  );
}
