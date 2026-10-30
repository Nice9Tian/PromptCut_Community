import { useEffect, useRef, useState } from "react";
import { GESTURE_COMMIT_INTERVAL_MS, GESTURE_WINDOW_MS, STEP_BURST_MS, commitMerged, createLatestThrottle, newGestureKey } from "./mergedEdit";

/**
 * 编辑面板里改项目内容的滑块(2026-10-20 用户定,`docs/semantics/workflow/editing.md`「撤销、重做」):
 * 一次拖动(按下到松开)只记一步撤销。
 *
 *   - 拖动中:滑块手柄跟着手走(本地的值),项目里的值最快每 GESTURE_COMMIT_INTERVAL_MS 更新一次,
 *     预览和协作同伴看到的是限速后的值,不是每次指针移动一条提交;这些提交带同一个 mergeKey,并成一步撤销。
 *   - 松手:把最后一个值补交一次,拖动结束。
 *   - 键盘(方向键、Home / End)没有按下松开:每一下立即提交,连按(相隔不超过 STEP_BURST_MS)并成一步。
 *
 * `onValue` 收到的是数;夹范围、校验、报错由调用方做。
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
  // 事件回调里要拿最新的 onValue;拖动中的 throttle 不能因为重渲被换掉
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
