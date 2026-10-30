import { actions, getState } from "../../store/project";
import { useTimelineContext } from "./TimelineContext";

/**
 * 序列换序。拖行头的时候:
 * - 被拖的那条跟着指针走(不带过渡,手感是「粘在手上」)
 * - 让位的那几条按 trackH 平移,带过渡 → 这就是「提前预览 + 滑动动画」
 * - 松手先把被拖的那条滑到目标格再提交,避免落位时闪一下
 *
 * 行头和轨道行用的是同一份偏移(useRowOffset),所以整条序列一起动。
 */
export interface ReorderState {
  id: string;
  from: number;
  to: number;
  /** 被拖那条相对原位的位移(px) */
  dy: number;
  /** 松手后的归位阶段:这时被拖的那条也带过渡 */
  settling?: boolean;
}

/** 松手归位的动画时长(ms) */
export const SETTLE_MS = 140;

export function useReorderDrag() {
  const { reorder, setReorder, trackH } = useTimelineContext();

  const start = (e: React.PointerEvent, index: number, trackId: string) => {
    if (e.button !== 0) return;
    // 行头上的按钮、改名输入框不触发拖动
    if ((e.target as HTMLElement).closest("button, input")) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const startY = e.clientY;
    const count = getState().project.tracks.length;
    let moved = false;

    const compute = (clientY: number) => {
      const dy = clientY - startY;
      const to = Math.max(0, Math.min(count - 1, Math.round((index * trackH + dy) / trackH)));
      return { dy, to };
    };

    const onMove = (ev: PointerEvent) => {
      const { dy, to } = compute(ev.clientY);
      // 抖动一两像素不算拖动,免得点一下就进换序态
      if (!moved && Math.abs(dy) < 3) return;
      if (!moved) {
        moved = true;
        try {
          el.setPointerCapture(ev.pointerId);
        } catch {
          // 没捕获也能拖
        }
      }
      setReorder({ id: trackId, from: index, to, dy });
    };

    const finish = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", finish);
      el.removeEventListener("pointercancel", finish);
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        // 已经放开了
      }
      if (!moved) return;
      const { to } = compute(ev.clientY);
      // 先滑到目标格(带过渡),动画走完再改文档
      setReorder({ id: trackId, from: index, to, dy: (to - index) * trackH, settling: true });
      window.setTimeout(() => {
        if (to !== index) actions.moveTrack(trackId, to);
        setReorder(null);
      }, SETTLE_MS);
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
  };

  return { start, reorder };
}

/** 这一行现在该偏移多少(行头和轨道行共用) */
export function useRowOffset(index: number, trackId: string) {
  const { reorder, trackH } = useTimelineContext();
  if (!reorder) return { y: 0, dragging: false, animated: true };

  if (reorder.id === trackId) {
    return { y: reorder.dy, dragging: true, animated: !!reorder.settling };
  }
  const { from, to } = reorder;
  let y = 0;
  if (from < to && index > from && index <= to) y = -trackH;
  else if (from > to && index >= to && index < from) y = trackH;
  return { y, dragging: false, animated: true };
}
