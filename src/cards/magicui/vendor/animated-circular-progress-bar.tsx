/**
 * 来源: 复刻自 Magic UI (https://magicui.design/docs/components/animated-circular-progress-bar)
 * MIT License
 * 
 * 本地改动:
 * - 使用本地 cn。
 * - 将 css 变量提取成内联 style。
 * - 去除了 transition-all duration-1000 ease-in-out 类，以便逐帧驱动动画不冲突。
 * - 去除了 size-40 text-2xl 默认样式，避免与外界传入尺寸冲突。
 */
import { cn } from "./cn";

interface AnimatedCircularProgressBarProps {
  max: number;
  value: number;
  min: number;
  gaugePrimaryColor: string;
  gaugeSecondaryColor: string;
  className?: string;
  style?: React.CSSProperties;
}

export function AnimatedCircularProgressBar({
  max = 100,
  min = 0,
  value = 0,
  gaugePrimaryColor,
  gaugeSecondaryColor,
  className,
  style,
}: AnimatedCircularProgressBarProps) {
  const circumference = 2 * Math.PI * 45;
  const percentPx = circumference * ((value - min) / (max - min));
  const currentPercent = ((value - min) / (max - min)) * 100;

  return (
    <div
      className={cn("relative font-semibold", className)}
      style={{
        ...style,
        ["--stroke-percent" as any]: percentPx,
        ["--bg-shape" as any]: circumference,
      }}
    >
      <svg
        fill="none"
        className="size-full"
        strokeWidth="2"
        viewBox="0 0 100 100"
      >
        <circle
          cx="50"
          cy="50"
          r="45"
          strokeWidth="10"
          strokeDashoffset="0"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="opacity-100"
          style={{ stroke: gaugeSecondaryColor, strokeDasharray: circumference }}
        />
        <circle
          cx="50"
          cy="50"
          r="45"
          strokeWidth="10"
          strokeDashoffset={circumference - percentPx}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="opacity-100"
          style={{
            stroke: gaugePrimaryColor,
            strokeDasharray: circumference,
          }}
        />
      </svg>
      <span className="absolute inset-0 m-auto flex items-center justify-center">
        {Math.round(currentPercent)}%
      </span>
    </div>
  );
}
