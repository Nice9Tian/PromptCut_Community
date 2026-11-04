import { actions, getState } from "../../store/project";
import { useTimelineContext } from "./TimelineContext";

/**
 * Track reordering. While dragging a row header:
 * - the dragged row follows the pointer (no transition, so it feels "stuck to the hand")
 * - the rows making way shift by trackH, with a transition → this is the "early preview + sliding animation"
 * - on release, the dragged row first slides to the target slot and then commits, avoiding a flash when it lands
 *
 * The row header and the track row use the same offset (useRowOffset), so the whole track moves together.
 */
export interface ReorderState {
  id: string;
  from: number;
  to: number;
  /** Displacement (px) of the dragged row relative to its original position */
  dy: number;
  /** Settling phase after release: the dragged row gets a transition too at this point */
  settling?: boolean;
}

/** Duration (ms) of the settle animation after release */
export const SETTLE_MS = 140;

export function useReorderDrag() {
  const { reorder, setReorder, trackH } = useTimelineContext();

  const start = (e: React.PointerEvent, index: number, trackId: string) => {
    if (e.button !== 0) return;
    // Buttons on the row header and the rename input do not start a drag
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
      // A jitter of a pixel or two does not count as a drag, so a single click doesn't enter the reorder state
      if (!moved && Math.abs(dy) < 3) return;
      if (!moved) {
        moved = true;
        try {
          el.setPointerCapture(ev.pointerId);
        } catch {
          // Dragging works without capture too
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
        // Already released
      }
      if (!moved) return;
      const { to } = compute(ev.clientY);
      // Slide to the target slot first (with a transition), and change the document after the animation finishes
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

/** How much this row should be offset right now (shared by the row header and the track row) */
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
