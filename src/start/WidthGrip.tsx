/**
 * The divider you drag to resize. The project sidebar on the left and the side panel on the right of the
 * chat page share this one.
 *
 * **No line is drawn normally** (user decision, 2026-10-23: no permanent vertical line); a line in the
 * emphasis color lights up only when the mouse presses on it or when it gets keyboard focus. So the two
 * bars and the main area normally look like one connected piece, and you see where the boundary is only
 * when you are about to drag.
 *
 * Double-click returns to the default width; the arrow keys can adjust it too (Shift takes big steps):
 * being mouse-only would lock keyboard users out.
 */
import type { JSX, PointerEvent as ReactPointerEvent } from "react";
import { clampWidth, type WidthSpec } from "./sideWidth";

export function WidthGrip(props: {
  spec: WidthSpec;
  /** Which side the divider is on: `right` when the bar is on the left, `left` when the bar is on the right */
  side: "left" | "right";
  width: number;
  label: string;
  pc: string;
  /** Called every frame while dragging */
  onWidth: (px: number) => void;
  /** Called on release, double-click and key press (only this one is written locally) */
  onWidthCommit: (px: number) => void;
  /**
   * Add or subtract on the current width. Arrow keys must go through this one; do not compute
   * `width + step` yourself --
   * when an arrow key is held, the repeated presses all land in the same frame, and each one reads the
   * old `width`, computes the same number, and the width gets stuck.
   */
  onWidthNudge: (delta: number) => void;
}): JSX.Element {
  /** When the bar is on the right, dragging the mouse left makes it wider, so the direction has to be reversed */
  const dir = props.side === "right" ? 1 : -1;

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const grip = e.currentTarget;
    const startX = e.clientX;
    const startW = props.width;
    grip.setPointerCapture(e.pointerId);
    const at = (ev: PointerEvent) => clampWidth(props.spec, startW + (ev.clientX - startX) * dir);
    const move = (ev: PointerEvent) => props.onWidth(at(ev));
    const up = (ev: PointerEvent) => {
      props.onWidthCommit(at(ev));
      grip.releasePointerCapture(e.pointerId);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  };

  return (
    <div
      className="ps-grip"
      data-side={props.side}
      data-pc={props.pc}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuemin={props.spec.min}
      aria-valuemax={props.spec.max}
      aria-valuenow={props.width}
      tabIndex={0}
      onPointerDown={onDown}
      onDoubleClick={() => props.onWidthCommit(props.spec.def)}
      onKeyDown={(e) => {
        const step = (e.shiftKey ? 32 : 8) * dir;
        if (e.key === "ArrowLeft") { e.preventDefault(); props.onWidthNudge(-step); }
        if (e.key === "ArrowRight") { e.preventDefault(); props.onWidthNudge(step); }
        if (e.key === "Home") { e.preventDefault(); props.onWidthCommit(props.spec.def); }
      }}
    />
  );
}
