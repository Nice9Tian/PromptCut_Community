import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  value: number;
  label: string;
}

function RingMetricCard({ params }: CardProps<Params>) {
  const v = useMotionValue(0);
  // 数字直接同步写进 DOM,不走 React state:导出时每帧截图前 React 的异步提交会和截图抢跑,
  // 实测 10~15% 的帧数字停在上一帧的值,导两遍不一样。同步写就落在 Motion 的同一次 rAF 里。
  // 写法照 magicui/vendor/number-ticker.tsx;初值写死在 JSX 里,免得重挂载后首帧空一下。
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

  const size = 480;
  const strokeWidth = 32;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const targetOffset = circumference * (1 - Math.min(100, Math.max(0, params.value)) / 100);

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass flex flex-col items-center gap-6">
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
            <span className="text-[100px] font-bold" style={{ fontFamily: "var(--pc-font-mono, ui-monospace, monospace)" }}>
              <span ref={numRef}>0</span>
              <span className="text-5xl ml-2">%</span>
            </span>
          </div>
        </div>
        <div className="text-4xl opacity-80 mt-4">{params.label}</div>
      </div>
    </div>
  );
}

export const ringMetric: CardDef<Params> = {
  id: "ring-metric",
  name: "环形指标",
  description: "环形进度与数字同步增加",
  useWhen: "单个百分比或完成度指标,用环形进度加中心数字表现。",
  tags: ["百分比","环形","进度","指标"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    value: 75,
    label: "完播率",
  },
  controls: [
    ...hudControls,
    { key: "value", label: "数值(0-100)", type: "number" },
    { key: "label", label: "说明", type: "text" },
  ],
  parts: [
    { id: "metric", label: "指标", role: "group", params: ["value"], enterMs: 0, settleMs: 1500 },
    { id: "label", label: "说明", role: "text", params: ["label"], enterMs: 0, settleMs: 0 },
  ],
  lifecycle: { settleMs: 1500, after: "hold", exit: ["fade"] },
  Component: RingMetricCard,
};
