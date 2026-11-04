import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useRef } from "react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";

/**
 * Ring metric: an SVG progress ring and large center number.
 * Extracted from ring-metric, without small text and glass board shell.
 * Entrance: ring strokeDashoffset animates and unfolds, numbers scroll from 0 to target value.
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
  name: "Ring metric",
  description: "Ring progress and center number increase in sync",
  useWhen: "Use for a single percentage or completion metric, shown as ring progress plus a center number. Distinguish it from metric-odometer (large-integer odometer), metric-stat (large number with prefix, suffix and footnote) and chart-rank (compare multiple items).",
  tags: ["percentage", "circular", "progress", "metric"],
  role: "media",
  from: "ring-metric",
  defaults: {
    value: 75,
    ringSize: 0,
    accent: "",
  },
  controls: [
    { key: "value", label: "Value (0-100)", type: "number" },
    { key: "ringSize", label: "Ring size (0 = fit to box)", type: "number", min: 0, max: 1000, step: 2, hint: "0 means the size is computed automatically from the part's box; enter a specific pixel value to fix it" },
    { key: "accent", label: "Color", type: "color" },
  ],
  defaultFrame: { x: 960, y: 540, w: 480, h: 480, anchor: [0.5, 0.5] },
  settleMs: () => 1500,
  after: "hold",
  Component: MetricRingPart,
};
