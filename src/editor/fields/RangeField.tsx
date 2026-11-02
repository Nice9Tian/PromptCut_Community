import { useEffect, useRef, useState } from "react";
import { GESTURE_COMMIT_INTERVAL_MS, GESTURE_WINDOW_MS, STEP_BURST_MS, commitMerged, createLatestThrottle, newGestureKey } from "./mergedEdit";

/**
 * Slider for editing project content in the editor panel (user decision, 2026-10-20, `docs/semantics/workflow/editing.md` "Undo, redo"):
 * one drag (press to release) records only one undo step.
 *
 *   - While dragging: the slider handle follows the hand (local value), and the project value updates at most once per
 *     GESTURE_COMMIT_INTERVAL_MS, so the preview and collaborators see the throttled value, not one commit per pointer move;
 *     these commits carry the same mergeKey and merge into one undo step.
 *   - On release: commit the last value once more, and the drag ends.
 *   - Keyboard (arrow keys, Home / End) has no press and release: each press commits immediately, and repeated presses
 *     (no more than STEP_BURST_MS apart) merge into one step.
 *
 * `onValue` receives a number; clamping to range, validation and error reporting are done by the caller.
 */
export interface RangeFieldProps {
  value: number;
  onValue: (n: number) => void;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  className?: string;
  attrs?: Record<string, string>;
}

export function RangeField({ value, onValue, min, max, step, disabled, className, attrs }: RangeFieldProps) {
  const [live, setLive] = useState<number | null>(null);
  const keyBurst = useRef<string>("");
  if (!keyBurst.current) keyBurst.current = newGestureKey("range-step");
  // Event callbacks need the latest onValue; the throttle during a drag must not be replaced by a re-render
  const onValueRef = useRef(onValue);
  onValueRef.current = onValue;
  const gesture = useRef<{ throttle: ReturnType<typeof createLatestThrottle<number>>; stop: () => void } | null>(null);

  const endGesture = () => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    g.stop();
    g.throttle.flush();
    setLive(null);
  };
  useEffect(() => () => endGesture(), []);

  const begin = () => {
    if (gesture.current) return;
    const key = newGestureKey("range-drag");
    const throttle = createLatestThrottle<number>(
      (v) => commitMerged(key, GESTURE_WINDOW_MS, () => onValueRef.current(v)),
      GESTURE_COMMIT_INTERVAL_MS,
    );
    const up = () => endGesture();
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    gesture.current = { throttle, stop: () => { window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); } };
  };

  return (
    <input
      {...attrs}
      type="range"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={className}
      value={live ?? value}
      onPointerDown={begin}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (!Number.isFinite(v)) return;
        const g = gesture.current;
        if (g) {
          setLive(v);
          g.throttle.push(v);
        } else {
          commitMerged(keyBurst.current, STEP_BURST_MS, () => onValue(v));
        }
      }}
    />
  );
}
