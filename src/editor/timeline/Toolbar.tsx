/**
 * 时间轴顶部工具行(配色诊断与修正 v2 整屏)。
 * 行高分段(小/中/大,选中格实心强调色)· 「行高 44px」等宽小字 · 分隔 ·
 * 右侧「缩放」+ 96px 滑条(对数刻度,10–1000 px/s)。
 */
import { useTimelineContext } from "./TimelineContext";
import { type RowSize, ROW_SIZE_H } from "./utils";

const ZOOM_MIN = 10;
const ZOOM_MAX = 1000;
/** 滑条 0–100 ↔ px/s 对数映射:缩放感受是等比的,线性滑条会前紧后松 */
const toSlider = (pxPerSec: number) =>
  Math.round((Math.log(pxPerSec / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * 100);
const fromSlider = (v: number) => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, v / 100);

export function Toolbar() {
  const { rowSize, setRowSize, pxPerSec, setPxPerSec } = useTimelineContext();

  const options: { label: string; value: RowSize }[] = [
    { label: "小", value: "small" },
    { label: "中", value: "medium" },
    { label: "大", value: "large" },
  ];
  const zoom = Math.max(0, Math.min(100, toSlider(pxPerSec)));

  return (
    <div className="pc-tl-bar" data-pc="timeline-toolbar">
      <div className="pc-tl-seg" role="group" aria-label="行高">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={rowSize === opt.value ? "is-on" : ""}
            aria-pressed={rowSize === opt.value}
            onClick={() => setRowSize(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <span className="pc-tl-meta">行高 {ROW_SIZE_H[rowSize]}px</span>

      <div className="pc-tl-zoom">
        <span className="pc-tl-meta">缩放</span>
        <div className="pc-tl-zoom-track" style={{ position: "relative" }}>
          <div className="pc-tl-zoom-fill" style={{ right: `${100 - zoom}%` }} />
          <div className="pc-tl-zoom-knob" style={{ left: `${zoom}%` }} />
          <input
            type="range"
            min={0}
            max={100}
            value={zoom}
            onChange={(e) => setPxPerSec(fromSlider(Number(e.target.value)))}
            aria-label="时间轴缩放"
            title="时间轴缩放(也可以 Ctrl + 滚轮)"
          />
        </div>
      </div>
    </div>
  );
}
