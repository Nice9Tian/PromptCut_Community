import { useRef } from "react";
import { tr } from "../i18n/index.ts";

/**
 * Panel drag handle. Shared by the left rail / right rail / timeline:
 * - axis="x" drags out a width, axis="y" drags out a height
 * - invert: the drag direction is opposite to the direction the size grows (the right rail grows wider when dragged
 *   left, the timeline grows taller when dragged up)
 * - double-click returns to the default size
 *
 * During a drag, `<body>` gets data-pc-resizing: the preview is an iframe, and once the mouse slides into it,
 * pointermove is no longer received (setPointerCapture is a fallback, but if capture fails on press it breaks),
 * so it is made to ignore mouse events for the moment. This also unifies the cursor and text-selection
 * disabling into the dragging state.
 *
 * A handle given `onNudge` can also be adjusted by keyboard (the one in Vibe mode detail editing uses it this way,
 * issue #40):
 * it can be tabbed to, arrow keys adjust step by step, Shift takes big steps, Home resets. Mouse-only would lock
 * keyboard users out
 * (same reasoning as the drag seams of the two rails on the start page, `src/start/WidthGrip.tsx`). Without it,
 * it stays as before and is not in the Tab order.
 */
export function ResizeHandle({
  axis,
  value,
  min,
  max,
  invert = false,
  disabled = false,
  onChange,
  onCommit,
  onReset,
  onNudge,
  title,
  pc,
}: {
  axis: "x" | "y";
  value: number;
  min: number;
  max: number | (() => number);
  invert?: boolean;
  disabled?: boolean;
  onChange: (next: number) => void;
  onCommit: () => void;
  onReset?: () => void;
  /**
   * Add or subtract on the current size (px). Only a handle given this takes keyboard input.
   *
   * Why not compute `value + step` itself: when an arrow key is held, the repeated presses all land in the same
   * frame, and each one reads a `value` that is still the old one,
   * so they compute the same number and the size gets stuck. How to handle it is up to each caller (same as
   * `onWidthNudge` in `WidthGrip.tsx`).
   */
  onNudge?: (delta: number) => void;
  title?: string;
  /** Marker for probes (`data-pc`) */
  pc?: string;
}) {
  const latest = useRef(value);
  latest.current = value;

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const start = axis === "x" ? e.clientX : e.clientY;
    const startValue = value;
    const sign = invert ? -1 : 1;

    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (synthetic events, etc.); dragging works even without capture
    }
    document.body.dataset.pcResizing = axis;
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const now = axis === "x" ? ev.clientX : ev.clientY;
      const upper = typeof max === "function" ? max() : max;
      onChange(Math.max(min, Math.min(upper, startValue + (now - start) * sign)));
    };
    const onUp = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        // Already released
      }
      delete document.body.dataset.pcResizing;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onCommit();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const cursorClass = disabled ? "" : (axis === "x" ? "cursor-col-resize" : "cursor-row-resize");
  const disabledClass = disabled ? "is-disabled" : "";

  const keyboard = !!onNudge && !disabled;
  /** When an arrow key is pressed, which way on the screen the divider moves */
  const stepKeys = axis === "x" ? { less: "ArrowLeft", more: "ArrowRight" } : { less: "ArrowUp", more: "ArrowDown" };

  return (
    <div
      data-pc-resize={axis}
      data-pc={pc}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={keyboard ? title : undefined}
      aria-valuenow={keyboard ? Math.round(value) : undefined}
      aria-valuemin={keyboard ? min : undefined}
      aria-valuemax={keyboard && typeof max === "number" ? max : undefined}
      tabIndex={keyboard ? 0 : undefined}
      style={{ pointerEvents: disabled ? "none" : "auto" }}
      className={`pc-gutter shrink-0 touch-none flex items-center justify-center ${
        axis === "x" ? "w-2 h-full" : "h-2 w-full"
      } ${cursorClass} ${disabledClass}`}
      title={title ?? (onReset ? tr("Drag to resize, double-click to reset") : tr("Drag to resize"))}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (!keyboard) return;
        // Moving toward the less end on the screen is the negative direction; for an inverted handle (right rail,
        // timeline) the size grows in exactly the opposite direction
        const screen = (e.shiftKey ? 32 : 8) * (invert ? -1 : 1);
        if (e.key === stepKeys.less) { e.preventDefault(); onNudge?.(-screen); }
        if (e.key === stepKeys.more) { e.preventDefault(); onNudge?.(screen); }
        if (e.key === "Home" && onReset) { e.preventDefault(); onReset(); }
      }}
    />
  );
}
