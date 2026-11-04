/**
 * Custom horizontal scrollbar: takes over horizontal scrolling at the bottom of the timeline, hiding the native horizontal bar while keeping the vertical one (via the .pc-tl-scroll rule in timeline.css).
 * - The bar body represents the whole total duration (duration).
 * - The thumb width represents the currently visible time range; the thumb position follows scroll progress (scrollLeft / max scroll), the inverse of the pan conversion, so the pointer never drifts off the thumb.
 * - Dragging the middle of the thumb = pan (changes only scrollLeft).
 * - Dragging the handles at the thumb's two ends = zoom (changes pxPerSec); double-click the thumb or the bar body to reset.
 * It looks the same as the vertical bar on the right (10px thick, same-color groove and thumb); the styles are all in .pc-tl-hbar* in timeline.css.
 */
import { useEffect, useState, useRef } from "react";
import { useStore } from "../../store/project";
import { useTimelineContext } from "./TimelineContext";
import { timeOfX, xOfTime } from "./utils";

type DragMode = "pan" | "left" | "right";

/** Zoom lower and upper limits (px / second), the same as the ones the two end handles clamp to */
const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 1000;

export function Scrollbar() {
  const { scrollRef, headerW, pxPerSec, setPxPerSec } = useTimelineContext();
  const duration = useStore((s) => s.project.duration);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewW, setViewW] = useState(0);
  // Max scroll (scrollWidth - clientWidth): the thumb position is converted by it
  const [maxScroll, setMaxScroll] = useState(0);
  // Width actually taken by the vertical bar on the right (0 when there is no vertical overflow); the right end of the groove stops at its left
  const [gutterW, setGutterW] = useState(0);
  // Which part is being dragged: the pointer is captured while dragging, so :hover / :active can't be
  // relied on; use this to set the state of the handle and the cursor
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
    // The vertical bar appearing / disappearing changes the content box width, so this fires too;
    // the content layer is watched as well: zoom, total duration changes and the playhead moving past the end
    // all change the content width, but may not produce a scroll event
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
  // The two end handles are 12px each, and a middle section must stay grabbable for panning, so the thumb is at least 48px wide.
  const minWidthPx = 48;
  const thumbW = `max(${minWidthPx}px, ${widthPct * 100}%)`;
  // Scroll progress 0~1: the thumb's left edge is placed in [0, track width − thumb width] by it.
  // It used to be placed by "visible start / total duration": in a long project, once the 48px minimum
  // width widened the thumb, the thumb stopped over the last stretch of travel while the content kept scrolling;
  // also the visible start is clamped at 0, so when scrollLeft was below the gap before second 0 (24px),
  // the first pan would jump a bit
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
        // The thumb finishing its (track width − thumb width) travel = the content finishing the whole scroll range:
        // the exact inverse of the conversion used above to place the thumb, so the pointer always stays on the grabbed point
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
        // When zoom is clamped to its limits, the visible duration must be recomputed from the clamped zoom, or the right edge drifts
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
    // One row is 14px: the track is 10px with 2px above and below, as thick as the vertical bar on the right
    // (14px reserved, 10px visible). The right side leaves the cell of the vertical bar, the groove stops
    // at the left of the vertical bar, and the bottom-right leaves an empty corner.
    <div className="pc-tl-hbar" style={{ paddingRight: gutterW }}>
      {/*
        This slot on the left is not empty space; it extends the track bar to the bottom of the timeline.
        Previously this was just paddingLeft: headerW, so the track bar's right divider cut off at the
        bottom of the scroll area, looking like the bar didn't reach the bottom. Here we connect it with
        the same width and the same right border.
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
            // Place it in [0, track width − thumb width] by scroll progress, so the thumb never sticks out of the groove
            left: `calc((100% - ${thumbW}) * ${progress})`,
            width: thumbW,
          }}
          onPointerDown={(e) => handleDrag(e, "pan")}
          onDoubleClick={(e) => { e.stopPropagation(); handleDoubleClick(); }}
        >
          {/* Left handle */}
          <div
            className="pc-tl-hbar-grip is-left"
            onPointerDown={(e) => {
              e.stopPropagation();
              handleDrag(e, "left");
            }}
          />
          {/* Middle section for panning */}
          <div className="pc-tl-hbar-pan" />
          {/* Right handle */}
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
