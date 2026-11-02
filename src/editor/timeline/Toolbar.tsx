/**
 * 时间轴顶部工具行(配色诊断与修正 v2 整屏)。
 * 行高分段(小/中/大,选中格实心强调色)· 「行高 44px」等宽小字 · 分隔 ·
 * 右侧「缩放」+ 96px 滑条(对数刻度,10–1000 px/s)。
 */
import { useTimelineContext } from "./TimelineContext";
import { type RowSize, ROW_SIZE_H } from "./utils";
import { tr } from "../../i18n/index.ts";

const ZOOM_MIN = 10;
const ZOOM_MAX = 1000;
/** 滑条 0–100 ↔ px/s 对数映射:缩放感受是等比的,线性滑条会前紧后松 */
const toSlider = (pxPerSec: number) =>
  Math.round((Math.log(pxPerSec / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * 100);
const fromSlider = (v: number) => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, v / 100);

export function Toolbar() {
  const { rowSize, setRowSize, pxPerSec, setPxPerSec } = useTimelineContext();

  const options: { label: string; value: RowSize }[] = [
    { label: tr("Small"), value: "small" },
    { label: tr("Medium"), value: "medium" },
    { label: tr("Large"), value: "large" },
  ];
  const zoom = Math.max(0, Math.min(100, toSlider(pxPerSec)));

  return (
    <div className="pc-tl-bar" data-pc="timeline-toolbar">
      <div className="pc-tl-seg" role="group" aria-label={tr("Row height")}>
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
      <span className="pc-tl-meta">{tr("Row height {0}px", ROW_SIZE_H[rowSize])}</span>

      <div className="pc-tl-zoom">
        <span className="pc-tl-meta">{tr("Zoom")}</span>
        <div className="pc-tl-zoom-track" style={{ position: "relative" }}>
          <div className="pc-tl-zoom-fill" style={{ right: `${100 - zoom}%` }} />
          <div className="pc-tl-zoom-knob" style={{ left: `${zoom}%` }} />
          <input
            type="range"
            min={0}
            max={100}
            value={zoom}
            onChange={(e) => setPxPerSec(fromSlider(Number(e.target.value)))}
            aria-label={tr("Timeline zoom")}
            title={tr("Timeline zoom (Ctrl + scroll wheel also works)")}
          />
        </div>
      </div>
    </div>
  );
}
