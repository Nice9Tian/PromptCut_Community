/**
 * 自定义横向滚动条:接管时间轴底部的横向滚动，隐藏原生横条而保留竖条(通过 timeline.css 的 .pc-tl-scroll 规则)。
 * - 条身代表整个总时长 (duration)。
 * - 滑块宽度代表当前可视时间区间;滑块位置按滚动进度摆(scrollLeft / 最大滚动量)，和平移的换算互逆，指针不会和滑块脱开。
 * - 拖动滑块中间 = 平移(只改 scrollLeft)。
 * - 拖动滑块两端把手 = 缩放(改 pxPerSec)，双击滑块或条身复位。
 * 样子和右侧竖条一致(10px 粗、同色底槽和滑块)，样式都在 timeline.css 的 .pc-tl-hbar*。
 */
import { useEffect, useState, useRef } from "react";
import { useStore } from "../../store/project";
import { useTimelineContext } from "./TimelineContext";
import { timeOfX, xOfTime } from "./utils";

type DragMode = "pan" | "left" | "right";

/** 缩放上下限(px / 秒),和两端把手夹的一致 */
const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 1000;

export function Scrollbar() {
  const { scrollRef, headerW, pxPerSec, setPxPerSec } = useTimelineContext();
  const duration = useStore((s) => s.project.duration);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewW, setViewW] = useState(0);
  // 最大滚动量(scrollWidth − clientWidth):滑块位置按它换算
  const [maxScroll, setMaxScroll] = useState(0);
  // 右侧竖条实际占的宽度(没有竖向溢出时是 0)，底槽的右端就停在它左边
  const [gutterW, setGutterW] = useState(0);
  // 正在拖哪一段:拖动时指针被捕获，:hover / :active 靠不住，用它给把手和光标上状态
  const [dragMode, setDragMode] = useState<DragMode | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setScrollLeft(el.scrollLeft);
      setViewW(el.clientWidth - headerW);
      setMaxScroll(Math.max(0, el.scrollWidth - el.clientWidth));
      setGutterW(Math.max(0, el.offsetWidth - el.clientWidth));
    };
    update();
    el.addEventListener("scroll", update);
    // 竖条出现 / 消失会改变内容盒宽度，这里也会跟着触发;
    // 内容层也盯着:缩放、总时长变化、播放头走过片尾都会改内容宽度，却不一定有 scroll 事件
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollRef, headerW]);

  const visStart = Math.max(0, timeOfX(scrollLeft, pxPerSec));
  const visEnd = timeOfX(scrollLeft + viewW, pxPerSec);

  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const widthPct = duration > 0 ? clamp((visEnd - visStart) / duration) : 1;
  // 两端把手各 12px，中间还得留一截能抓住平移，所以滑块最窄 48px。
  const minWidthPx = 48;
  const thumbW = `max(${minWidthPx}px, ${widthPct * 100}%)`;
  // 滚动进度 0~1:滑块左边在 [0, 条身宽 − 滑块宽] 里按它摆。
  // 以前按「可视起点 / 总时长」摆:长项目里滑块被最窄 48px 撑宽后，最后一段行程滑块停住了内容还在滚;
  // 而且可视起点夹在 0,scrollLeft 小于 0 秒前那段间距(24px)时一开始平移会先跳一截
  const progress = maxScroll > 0 ? clamp(scrollLeft / maxScroll) : 0;

  const trackRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ pxPerSec, viewW });
  stateRef.current = { pxPerSec, viewW };

  const handleDrag = (e: React.PointerEvent, mode: DragMode) => {
    e.preventDefault();
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const track = trackRef.current!;
    const trackW = track.getBoundingClientRect().width;
    const thumbPx = (track.firstElementChild as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
    const startScrollLeft = scrollRef.current?.scrollLeft ?? 0;
    const initialVisStart = visStart;
    const initialVisEnd = visEnd;
    const initialSpan = visEnd - visStart;

    try { el.setPointerCapture(e.pointerId); } catch {}
    setDragMode(mode);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dTime = (dx / trackW) * duration;
      const currentViewW = stateRef.current.viewW;
      const scroller = scrollRef.current;
      if (!scroller) return;

      if (mode === "pan") {
        // 滑块走完 (条身宽 − 滑块宽) 的行程 = 内容走完整个滚动范围:和上面摆滑块的换算互逆,指针始终按在抓住的那一点上
        const max = scroller.scrollWidth - scroller.clientWidth;
        const travel = trackW - thumbPx;
        if (max <= 0 || travel <= 0) return;
        scroller.scrollLeft = Math.max(0, Math.min(max, startScrollLeft + (dx * max) / travel));
      } else if (mode === "right") {
        const newSpan = Math.max(0.1, initialSpan + dTime);
        const newPxPerSec = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, currentViewW / newSpan));
        setPxPerSec(newPxPerSec);
        const target = xOfTime(initialVisStart, newPxPerSec);
        window.setTimeout(() => {
          if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, target);
        }, 0);
      } else if (mode === "left") {
        const wantSpan = Math.max(0.1, initialSpan - dTime);
        const newPxPerSec = Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, currentViewW / wantSpan));
        setPxPerSec(newPxPerSec);
        // 缩放被夹到上下限时,可视时长要按夹完的缩放重算,不然右边缘会漂
        const span = currentViewW / newPxPerSec;
        const target = xOfTime(initialVisEnd - span, newPxPerSec);
        window.setTimeout(() => {
          if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, target);
        }, 0);
      }
    };

    const onUp = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      try { el.releasePointerCapture(ev.pointerId); } catch {}
      setDragMode(null);
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const handleDoubleClick = () => {
    setPxPerSec(100);
    window.setTimeout(() => {
      if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    }, 0);
  };

  return (
    // 一行 14px:条身 10px，上下各 2px，和右侧竖条(占位 14px、可见 10px)一样粗。
    // 右边留出竖条那一格，底槽停在竖条左边，右下角空出一个拐角。
    <div className="pc-tl-hbar" style={{ paddingRight: gutterW }}>
      {/*
        左边这一格不是留白,是把序列栏补到时间轴最底部。
        原来这里只是 paddingLeft: headerW,于是序列栏的右分隔线到滚动区底部就断了,
        看着像那一栏没接到底。这里用同样的宽度和同样的右边框把它接上去。
      */}
      <div
        className="pc-tl-headers shrink-0 self-stretch"
        style={{ width: headerW }}
        aria-hidden="true"
      />
      <div
        ref={trackRef}
        className="pc-tl-hbar-track"
        onDoubleClick={handleDoubleClick}
      >
        <div
          className="pc-tl-hbar-thumb"
          data-drag={dragMode ?? undefined}
          style={{
            // 按滚动进度在 [0, 条身宽 − 滑块宽] 里摆,滑块永远不会戳出底槽
            left: `calc((100% - ${thumbW}) * ${progress})`,
            width: thumbW,
          }}
          onPointerDown={(e) => handleDrag(e, "pan")}
          onDoubleClick={(e) => { e.stopPropagation(); handleDoubleClick(); }}
        >
          {/* 左把手 */}
          <div
            className="pc-tl-hbar-grip is-left"
            onPointerDown={(e) => {
              e.stopPropagation();
              handleDrag(e, "left");
            }}
          />
          {/* 中间一截用于平移 */}
          <div className="pc-tl-hbar-pan" />
          {/* 右把手 */}
          <div
            className="pc-tl-hbar-grip is-right"
            onPointerDown={(e) => {
              e.stopPropagation();
              handleDrag(e, "right");
            }}
          />
        </div>
      </div>
    </div>
  );
}
