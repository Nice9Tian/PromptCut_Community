/**
 * 来源: 复刻自 Magic UI (https://magicui.design/docs/components/typing-animation)
 * MIT License
 * 
 * 本地改动:
 * - 移除了 setInterval/setTimeout，改用 requestAnimationFrame + performance.now()。
 * - 去除了 clsx/tailwind-merge，使用 cn.ts。
 * - 移除了 text-4xl 和 leading-[5rem] 以避免与传入字号冲突，并暴露 style prop。
 * - 默认 duration 降低至 120 以匹配时长预算。
 * - 声画共用字素事件表；舞台传入 t 时可随机访问，独立预览保持 rAF 时钟。
 * - 移除基础样式中的 drop-shadow-sm，由调用方控制。
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "./cn";
import { createTypingSchedule, typingTextAt } from "../../../kernel/typingEvents";
import type { TypingSchedule } from "../../../kernel/typingEvents";

interface TypingAnimationProps {
  text: string;
  duration?: number;
  schedule?: TypingSchedule;
  /** Stage-local seconds plus the persisted source offset support seek/split without restarting. */
  t?: number;
  sourceOffset?: number;
  /** 挂载钟(见 CardProps.mountClockMs):有它就按它取字,算法与旧的「挂载即播」逐位相同,不加边界容差。 */
  mountClockMs?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function TypingAnimation({
  text,
  duration = 120,
  schedule: suppliedSchedule,
  t,
  sourceOffset = 0,
  mountClockMs,
  className,
  style,
}: TypingAnimationProps) {
  const schedule = useMemo(() => suppliedSchedule ?? createTypingSchedule({ text, duration }), [suppliedSchedule, text, duration]);
  const [displayedText, setDisplayedText] = useState<string>("");

  useEffect(() => {
    if (t !== undefined) return;
    let rAF: number;
    const startTime = performance.now();
    const tick = (now: number) => {
      const elapsed = now - startTime + sourceOffset * 1000;
      // 两个毫秒钟点相减,和旧实现同一个算式:不加边界容差(见 TYPING_BOUNDARY_EPSILON_MS)
      setDisplayedText(typingTextAt(schedule, elapsed, 0));
      if (elapsed < schedule.settleMs) rAF = requestAnimationFrame(tick);
    };
    rAF = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rAF);
  }, [schedule, sourceOffset, t]);
  const visibleText = mountClockMs !== undefined ? typingTextAt(schedule, mountClockMs + sourceOffset * 1000, 0)
    : t === undefined ? displayedText : typingTextAt(schedule, (t + sourceOffset) * 1000);

  return (
    <h1
      className={cn(
        "font-display text-center font-bold tracking-[-0.02em]",
        className,
      )}
      style={style}
    >
      {visibleText}
    </h1>
  );
}
