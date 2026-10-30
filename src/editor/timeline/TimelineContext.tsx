import { createContext, useContext, useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import type React from "react";
import { useStore } from "../../store/project";
import type { TrackClip } from "../../kernel/project";
import { useDragPayload } from "../dnd";
import { HEADER_W_DEFAULT, HEADER_W_MIN, HEADER_W_MAX, type RowSize, DEFAULT_ROW_SIZE, ROW_SIZE_H, timeOfX, xOfTime } from "./utils";
import type { OverlayItem } from "./overlays";
import type { DropPlan } from "./dropPlan";
import type { ReorderState } from "./useReorder";

interface TimelineContextState {
  pxPerSec: number;
  setPxPerSec: (val: number) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  trackAreaRef: React.RefObject<HTMLDivElement | null>;
  draggingClipId: string | null;
  setDraggingClipId: (id: string | null) => void;
  draggingTrackId: string | null;
  setDraggingTrackId: (id: string | null) => void;
  /** 左栏拖进来时的落点预演(没在拖 = null);轨道行和新建轨落区共用同一份 */
  dropPlan: DropPlan | null;
  setDropPlan: React.Dispatch<React.SetStateAction<DropPlan | null>>;
  /** 正在拖行头换序(没在换 = null);行头和轨道行按它一起平移 */
  reorder: ReorderState | null;
  setReorder: React.Dispatch<React.SetStateAction<ReorderState | null>>;
  
  headerW: number;
  setHeaderW: (val: number) => void;
  commitHeaderW: () => void;
  resetHeaderW: () => void;
  rowSize: RowSize;
  setRowSize: (val: RowSize) => void;
  trackH: number;
  /**
   * 右键一段时多给一项「引用到输入框」。氛围式的详细编辑挂的就是这条时间轴
   * (`src/start/DetailEdit.tsx`),在那儿右键一张卡要能把它引用给 Agent;编辑界面没有这个输入框,不传。
   */
  quoteClip?: (clip: TrackClip, label: string) => void;
  /** 引用挂在片段上的某一张叠加卡。和 quoteClip 一样只有氛围式的详细编辑传(见 index.tsx) */
  quoteOverlay?: (clip: TrackClip, item: OverlayItem) => void;
}

const TimelineContext = createContext<TimelineContextState | null>(null);

export function TimelineProvider({ children, quoteClip, quoteOverlay }: {
  children: ReactNode;
  quoteClip?: (clip: TrackClip, label: string) => void;
  quoteOverlay?: (clip: TrackClip, item: OverlayItem) => void;
}) {
  const [pxPerSec, setPxPerSec] = useState(100);
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackAreaRef = useRef<HTMLDivElement>(null);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
  const [dropPlan, setDropPlan] = useState<DropPlan | null>(null);
  const [reorder, setReorder] = useState<ReorderState | null>(null);

  const [headerW, setHeaderWState] = useState(() => {
    try {
      const stored = localStorage.getItem("promptcut.timeline.headerW");
      if (stored) {
        const val = parseInt(stored, 10);
        if (!isNaN(val) && val >= HEADER_W_MIN && val <= HEADER_W_MAX) return val;
      }
    } catch {}
    return HEADER_W_DEFAULT;
  });
  const headerWRef = useRef(headerW);
  headerWRef.current = headerW;

  const setHeaderW = useCallback((val: number) => {
    setHeaderWState(val);
  }, []);

  const commitHeaderW = useCallback(() => {
    try {
      localStorage.setItem("promptcut.timeline.headerW", Math.round(headerWRef.current).toString());
    } catch {}
  }, []);

  const resetHeaderW = useCallback(() => {
    setHeaderWState(HEADER_W_DEFAULT);
    try {
      localStorage.setItem("promptcut.timeline.headerW", HEADER_W_DEFAULT.toString());
    } catch {}
  }, []);

  const [rowSize, setRowSizeState] = useState<RowSize>(() => {
    try {
      const stored = localStorage.getItem("promptcut.timeline.rowSize") as RowSize;
      if (stored === "small" || stored === "medium" || stored === "large") return stored;
    } catch {}
    return DEFAULT_ROW_SIZE;
  });
  
  const setRowSize = useCallback((val: RowSize) => {
    setRowSizeState(val);
    try {
      localStorage.setItem("promptcut.timeline.rowSize", val);
    } catch {}
  }, []);
  
  const trackH = ROW_SIZE_H[rowSize];

  // 拖动一结束(松手、按 Esc、拖出窗口)就把落点预演清掉,免得预览留在屏幕上
  const dragPayload = useDragPayload();
  useEffect(() => {
    if (!dragPayload) setDropPlan(null);
  }, [dragPayload]);

  // 拖着卡片 / 素材贴近左右边缘时自动横向滚动(HTML5 拖放自己不会滚,不然只能落在当前视野里)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !dragPayload) return;
    const EDGE = 60; // 触发自动滚动的边缘宽度(px)
    const MAX = 18; // 每帧最多滚多少 px
    let vx = 0;
    let raf = 0;
    const step = () => {
      if (vx) el.scrollLeft += vx;
      raf = requestAnimationFrame(step);
    };
    const onOver = (e: DragEvent) => {
      const r = el.getBoundingClientRect();
      const inner = r.left + headerWRef.current; // 行头列不算轨道区
      if (e.clientX < inner + EDGE) {
        vx = -Math.min(MAX, Math.ceil(((inner + EDGE - e.clientX) / EDGE) * MAX));
      } else if (e.clientX > r.right - EDGE) {
        vx = Math.min(MAX, Math.ceil(((e.clientX - (r.right - EDGE)) / EDGE) * MAX));
      } else {
        vx = 0;
      }
    };
    el.addEventListener("dragover", onOver);
    raf = requestAnimationFrame(step);
    return () => {
      el.removeEventListener("dragover", onOver);
      cancelAnimationFrame(raf);
    };
  }, [dragPayload]);

  // Zooming
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const pointerX = e.clientX - rect.left + el.scrollLeft - headerWRef.current;
        if (pointerX < 0) return;
        
        const timeAtPointer = timeOfX(pointerX, pxPerSec);
        const delta = e.deltaY < 0 ? 1.2 : 0.8;
        const newPxPerSec = Math.max(10, Math.min(1000, pxPerSec * delta));
        
        setPxPerSec(newPxPerSec);
        
        const newScrollLeft = xOfTime(timeAtPointer, newPxPerSec) - (e.clientX - rect.left - headerWRef.current);
        setTimeout(() => {
           if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, newScrollLeft);
        }, 0);
      }
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [pxPerSec]);
  
  // Middle mouse pan
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let isPanning = false;
    let startX = 0;
    let startScrollLeft = 0;

    const handlePointerDown = (e: PointerEvent) => {
      if (e.button === 1) { // Middle click
        if ((e.target as HTMLElement).closest("[data-clip-id]")) return;
        isPanning = true;
        startX = e.clientX;
        startScrollLeft = el.scrollLeft;
        el.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    };
    const handlePointerMove = (e: PointerEvent) => {
      if (isPanning) {
        el.scrollLeft = startScrollLeft - (e.clientX - startX);
      }
    };
    const handlePointerUp = (e: PointerEvent) => {
      if (isPanning) {
        isPanning = false;
        el.releasePointerCapture(e.pointerId);
      }
    };

    el.addEventListener("pointerdown", handlePointerDown);
    el.addEventListener("pointermove", handlePointerMove);
    el.addEventListener("pointerup", handlePointerUp);
    return () => {
      el.removeEventListener("pointerdown", handlePointerDown);
      el.removeEventListener("pointermove", handlePointerMove);
      el.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  // Auto scroll for playhead
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  useEffect(() => {
    if (playing && scrollRef.current) {
       const pos = xOfTime(t, pxPerSec);
       const el = scrollRef.current;
       if (pos > el.scrollLeft + el.clientWidth - headerWRef.current - 50) {
           el.scrollLeft = pos - el.clientWidth + headerWRef.current + 50;
       }
    }
  }, [t, playing, pxPerSec]);

  return (
    <TimelineContext.Provider value={{ pxPerSec, setPxPerSec, scrollRef, trackAreaRef, draggingClipId, setDraggingClipId, draggingTrackId, setDraggingTrackId, dropPlan, setDropPlan, reorder, setReorder, headerW, setHeaderW, commitHeaderW, resetHeaderW, rowSize, setRowSize, trackH, quoteClip, quoteOverlay }}>
      {children}
    </TimelineContext.Provider>
  );
}

export function useTimelineContext() {
  return useContext(TimelineContext)!;
}
