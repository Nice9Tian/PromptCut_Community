import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useId, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  kicker: string;
  kickerZh: string;
  points: string;
  unit: string;
  drawMs: number;
  caption: string;
}

function NumberTicker({ value, duration }: { value: number; duration: number }) {
  const v = useMotionValue(0);
  // The number is written into the DOM synchronously, not through React state: during export React's
  // asynchronous commit races with the screenshot before each frame, and in testing 10~15% of frames
  // had the number stuck at the previous frame's value, so two exports differed. Writing synchronously
  // lands it in the same rAF as Motion's.
  // The approach follows magicui/vendor/number-ticker.tsx; the initial value is hardcoded in the JSX,
  // so the first frame after a remount is not blank for a moment.
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const controls = animate(v, value, {
      duration: duration,
      ease: easeExpoOut,
    });
    const unsub = v.on("change", (latest) => {
      if (ref.current) ref.current.textContent = String(Math.round(latest));
    });
    return () => {
      controls.stop();
      unsub();
    };
  }, [value, v, duration]);

  return <span ref={ref}>0</span>;
}

// Simple Catmull-Rom to Cubic Bezier conversion
function catmullRom2bezier(pts: [number, number][]) {
  let result = "";
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = i === 0 ? pts[0] : pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = i + 2 < pts.length ? pts[i + 2] : p2;
    
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    
    result += `C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]} `;
  }
  return result;
}

function GrowthCurveCard({ params }: CardProps<Params>) {
  const width = 1100;
  const height = 420;
  const paddingX = 40;
  const paddingY = 40;
  const innerWidth = width - paddingX * 2;
  const innerHeight = height - paddingY * 2;

  const data = params.points.split("|").map((p) => {
    const parts = p.trim().split(" ");
    return {
      label: parts.slice(0, -1).join(" "),
      value: parseFloat(parts[parts.length - 1]) || 0,
    };
  });

  const maxVal = Math.max(...data.map((d) => d.value));
  const minVal = Math.min(...data.map((d) => d.value), 0);
  const range = maxVal - minVal || 1;
  const maxIdx = data.findIndex(d => d.value === maxVal);

  const pts: [number, number][] = data.map((d, i) => {
    const x = paddingX + (i / Math.max(1, data.length - 1)) * innerWidth;
    const y = paddingY + innerHeight - ((d.value - minVal) / range) * innerHeight;
    return [x, y];
  });

  const pathD = pts.length > 0 ? `M ${pts[0][0]},${pts[0][1]} ` + catmullRom2bezier(pts) : "";
  const areaD = pathD ? `${pathD} L ${pts[pts.length - 1][0]},${paddingY + innerHeight} L ${pts[0][0]},${paddingY + innerHeight} Z` : "";
  
  const drawSec = params.drawMs > 0 ? params.drawMs / 1000 : 1.0;
  const gradId = useId();
  const accent = accentOf(params);

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass flex flex-col gap-6" style={{ width: width + 100 }}>
        <div className="flex flex-col gap-1 px-4">
          <div className="text-2xl tracking-[0.2em] font-mono uppercase font-bold opacity-80">{params.kicker}</div>
          <div className="text-2xl tracking-widest opacity-80">{params.kickerZh}</div>
        </div>

        <div className="relative" style={{ width: width, height: height }}>
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="absolute inset-0">
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity="0.4" />
                <stop offset="100%" stopColor={accent} stopOpacity="0.0" />
              </linearGradient>
            </defs>
            <motion.path
              d={areaD}
              fill={`url(#${gradId})`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: drawSec, ease: "linear" }}
            />
            <motion.path
              d={pathD}
              fill="none"
              stroke={accent}
              strokeWidth="6"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: drawSec, ease: "linear" }}
            />
            {pts.map((pt, i) => (
              <circle
                key={i}
                cx={pt[0]}
                cy={pt[1]}
                r={6}
                fill={accent}
                className="opacity-50"
              />
            ))}
          </svg>

          {pts.map((pt, i) => (
            <div
              key={i}
              className="absolute text-xl opacity-70 text-center transform -translate-x-1/2 mt-2"
              style={{ left: pt[0], top: paddingY + innerHeight }}
            >
              {data[i].label}
            </div>
          ))}

          {maxIdx >= 0 && (
            <motion.div
              className="absolute flex items-center gap-2 transform -translate-x-1/2 -translate-y-full pb-4"
              style={{ left: pts[maxIdx][0], top: pts[maxIdx][1] }}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, delay: drawSec * 0.85, ease: easeExpoOut }}
            >
              <div className="w-4 h-4 rounded-full" style={{ backgroundColor: accent, border: "3px solid white" }}></div>
              <div className="text-5xl font-bold font-mono whitespace-nowrap" style={{ color: accent, fontVariantNumeric: "tabular-nums" }}>
                <NumberTicker value={maxVal} duration={0.6} />
                {params.unit && <span className="text-xl ml-1 text-white opacity-80">{params.unit}</span>}
              </div>
            </motion.div>
          )}
        </div>

        {params.caption && (
          <div className="text-right text-lg opacity-50 px-4 mt-[-10px]">{params.caption}</div>
        )}
      </div>
    </div>
  );
}

export const growthCurve: CardDef<Params> = {
  id: "growth-curve",
  name: "Growth curve",
  description: "Smooth animated line chart",
  useWhen: "Use a line chart when you have a series of values over time to draw as a trend. The base is fixed at landscape width; **only the highest point is labeled with its value**, the other points show only their label names. For a single number use odometer or stat-proof; to compare several items by size use rank-bars.",
  tags: ["line chart","trend","growth","chart"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    kicker: "GROWTH TREND",
    kickerZh: "增长趋势",
    points: "Q1 120|Q2 150|Q3 140|Q4 280",
    unit: "W",
    drawMs: 1000,
    caption: "* 数据截止至本季度末",
  },
  controls: [
    ...hudControls,
    { key: "kicker", label: "Small English text", type: "text" },
    { key: "kickerZh", label: "Small Chinese text", type: "text" },
    { key: "points", label: "Data points (label value|...)", type: "text" },
    { key: "unit", label: "Unit", type: "text" },
    { key: "drawMs", label: "Draw duration (ms)", type: "number", min: 500, max: 2000, step: 100 },
    { key: "caption", label: "Bottom-right note", type: "text" },
  ],
  parts: [
    { id: "title", label: "Title", role: "group", params: ["kicker", "kickerZh"], enterMs: 0, settleMs: 0 },
    { id: "curve", label: "Curve", role: "media", params: ["points", "drawMs"], enterMs: 0, settleMs: 1000 },
    { id: "value", label: "Peak value", role: "text", params: ["unit"], enterMs: 850, settleMs: 1250 },
    { id: "caption", label: "Note", role: "text", params: ["caption"], enterMs: 0, settleMs: 0 },
  ],
  lifecycle: { settleMs: 1250, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const draw = p.drawMs > 0 ? p.drawMs : 1000;
    return { settleMs: draw * 0.85 + 400, parts: { curve: { settleMs: draw }, value: { enterMs: draw * 0.85, settleMs: draw * 0.85 + 400 } } };
  },
  Component: GrowthCurveCard,
};
