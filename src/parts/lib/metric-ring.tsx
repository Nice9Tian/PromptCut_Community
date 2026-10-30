import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useRef } from "react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";

/**
 * 环形指标:一个 SVG 进度圆环和中心大数字。
 * 从 ring-metric 拆出,不含小字和玻璃板外壳。
 * 进场:圆环 strokeDashoffset 动画展开,数字从 0 滚动到目标值。
 */
interface Params {
  value: number;
  ringSize: number;
  accent: string;
}

function MetricRingPart({ params, width, height }: PartProps<Params>) {
  const v = useMotionValue(0);
  const numRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const controls = animate(v, params.value, {
      duration: 1.5,
      ease: easeExpoOut,
    });
    const unsub = v.on("change", (latest) => {
      if (numRef.current) numRef.current.textContent = String(Math.round(latest));
    });
    return () => {
      controls.stop();
      unsub();
    };
  }, [params.value, v]);

  const size = params.ringSize > 0 ? params.ringSize : Math.min(width, height) * 0.9;
  const strokeWidth = 32 * (size / 480);
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const targetOffset = circumference * (1 - Math.min(100, Math.max(0, params.value)) / 100);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center", alignItems: "center", width, height }}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="transform -rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            className="opacity-10"
          />
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke={accentOf(params)}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: targetOffset }}
            transition={{ duration: 1.5, ease: easeExpoOut }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span style={{ fontSize: 100 * (size / 480), fontWeight: "bold", fontFamily: "var(--pc-font-mono, ui-monospace, monospace)" }}>
            <span ref={numRef}>0</span>
            <span style={{ fontSize: 48 * (size / 480), marginLeft: 8 * (size / 480) }}>%</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export const metricRing: PartDef<Params> = {
  id: "metric-ring",
  name: "环形指标",
  description: "环形进度与中心数字同步增加",
  useWhen: "单个百分比或完成度指标时使用,用环形进度加中心数字表现;和 metric-odometer(大整数翻牌)、metric-stat(带前后缀和注脚的大数字)、chart-rank(多项比大小)区分。",
  tags: ["百分比", "环形", "进度", "指标"],
  role: "media",
  from: "ring-metric",
  defaults: {
    value: 75,
    ringSize: 0,
    accent: "",
  },
  controls: [
    { key: "value", label: "数值(0-100)", type: "number" },
    { key: "ringSize", label: "环形尺寸(0 = 按框自适应)", type: "number", min: 0, max: 1000, step: 2, hint: "0 表示按部件的框自动算尺寸;想固定就填具体像素" },
    { key: "accent", label: "颜色", type: "color" },
  ],
  defaultFrame: { x: 960, y: 540, w: 480, h: 480, anchor: [0.5, 0.5] },
  settleMs: () => 1500,
  after: "hold",
  Component: MetricRingPart,
};
