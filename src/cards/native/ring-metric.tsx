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
  // The number is written into the DOM synchronously, not through React state: during export React's
  // asynchronous commit races with the screenshot before each frame, and in testing 10~15% of frames
  // had the number stuck at the previous frame's value, so two exports differed. Writing synchronously
  // lands it in the same rAF as Motion's.
  // The approach follows magicui/vendor/number-ticker.tsx; the initial value is hardcoded in the JSX,
  // so the first frame after a remount is not blank for a moment.
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
  name: "Ring metric",
  description: "Ring progress and number increase in sync",
  useWhen: "A single percentage or completion metric, shown as ring progress with a number in the center.",
  tags: ["percentage","circular","progress","metric"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    value: 75,
    label: "完播率",
  },
  controls: [
    ...hudControls,
    { key: "value", label: "Value (0-100)", type: "number" },
    { key: "label", label: "notes", type: "text" },
  ],
  parts: [
    { id: "metric", label: "metric", role: "group", params: ["value"], enterMs: 0, settleMs: 1500 },
    { id: "label", label: "notes", role: "text", params: ["label"], enterMs: 0, settleMs: 0 },
  ],
  lifecycle: { settleMs: 1500, after: "hold", exit: ["fade"] },
  Component: RingMetricCard,
};
