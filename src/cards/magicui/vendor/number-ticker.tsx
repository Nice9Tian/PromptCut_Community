/**
 * 来源: 复刻自 Magic UI (https://magicui.design/docs/components/number-ticker)
 * MIT License
 *
 * 本地改动:
 * - 移除了 framer-motion 的 useInView 和 delay 的 setTimeout，改为使用 requestAnimationFrame + performance.now() 来处理延迟和挂载即播。
 * - 移除了 clsx 和 tailwind-merge，改用本地 cn 函数。
 * - 从 motion/react 导入而非 framer-motion。
 * - 将 useEffect 替换为 useLayoutEffect 解决首帧空白问题。
 * - 调整 useSpring 参数以加快收敛，确保1.6秒内完成动画。
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useSpring, motion } from "motion/react";
import { cn } from "./cn";

export function NumberTicker({
  value,
  direction = "up",
  delay = 0,
  className,
  decimalPlaces = 0,
  startImmediately = true, // added parameter to skip useInView
  style,
}: {
  value: number;
  direction?: "up" | "down";
  className?: string;
  delay?: number; // delay in s
  decimalPlaces?: number;
  startImmediately?: boolean;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const motionValue = useSpring(direction === "down" ? value : 0, {
    damping: 30,
    stiffness: 200,
    mass: 1,
  });

  useEffect(() => {
    if (!startImmediately) return;

    let rAF: number;
    const startTime = performance.now();
    const delayMs = delay * 1000;

    const tick = (now: number) => {
      if (now - startTime >= delayMs) {
        motionValue.set(direction === "down" ? 0 : value);
      } else {
        rAF = requestAnimationFrame(tick);
      }
    };
    rAF = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rAF);
  }, [motionValue, delay, value, direction, startImmediately]);

  useEffect(() => {
    return motionValue.on("change", (latest) => {
      if (ref.current) {
        ref.current.textContent = Intl.NumberFormat("en-US", {
          minimumFractionDigits: decimalPlaces,
          maximumFractionDigits: decimalPlaces,
        }).format(Number(latest.toFixed(decimalPlaces)));
      }
    });
  }, [motionValue, decimalPlaces]);

  // Set initial value to prevent empty first frame
  useLayoutEffect(() => {
    if (ref.current && !ref.current.textContent) {
      ref.current.textContent = Intl.NumberFormat("en-US", {
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces,
      }).format(direction === "down" ? value : 0);
    }
  }, [value, direction, decimalPlaces]);

  return (
    <span
      className={cn(
        "inline-block tabular-nums tracking-wider",
        className,
      )}
      style={style}
      ref={ref}
    />
  );
}
