import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useId, useRef } from "react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";
import { fitOr } from "../fit";

/**
 * 增长折线图:一条动态画出的平滑渐变折线,并在最高点标注数字。
 * 从 growth-curve 拆出,去除了外壳及所有标题和脚注。
 * 进场:曲线 pathLength 从 0 到 1,渐变面积淡入,之后最高点弹出数值。
 */
interface Params {
  points: string;
  unit: string;
  drawMs: number;
  accent: string;
  size: number;
}

function NumberTicker({ value, duration }: { value: number; duration: number }) {
  const v = useMotionValue(0);
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

function ChartGrowthPart({ params, width, height }: PartProps<Params>) {
  const paddingX = width * 0.04;
  const paddingY = height * 0.1;
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

  const size = fitOr(params.size, { width: innerWidth / data.length, height: height * 0.18, text: String(maxVal) + params.unit, lines: 1, max: 120 });

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
    <div style={{ position: "absolute", inset: 0, width, height }}>
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
          className="absolute opacity-70 text-center transform -translate-x-1/2 mt-2"
          style={{ left: pt[0], top: paddingY + innerHeight, fontSize: size * 0.42 }}
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
          <div className="font-bold font-mono whitespace-nowrap" style={{ color: accent, fontVariantNumeric: "tabular-nums", fontSize: size }}>
            <NumberTicker value={maxVal} duration={0.6} />
            {params.unit && <span className="ml-1 text-white opacity-80" style={{ fontSize: size * 0.42 }}>{params.unit}</span>}
          </div>
        </motion.div>
      )}
    </div>
  );
}

export const chartGrowth: PartDef<Params> = {
  id: "chart-growth",
  name: "增长曲线",
  description: "平滑增长折线图,仅标出最高值",
  useWhen: "一串随时间变化的数值画走势时使用。**只有最高点会标出数值**,其余点只显示标签名;单个数字用 metric-odometer 或 metric-stat,多项比大小用 chart-rank。",
  tags: ["折线", "走势", "增长", "图表"],
  role: "media",
  from: "growth-curve",
  defaults: {
    points: "Q1 120|Q2 150|Q3 140|Q4 280",
    unit: "W",
    drawMs: 1000,
    accent: "",
    size: 0,
  },
  controls: [
    { key: "points", label: "数据点(标签 数值|...)", type: "text" },
    { key: "unit", label: "单位", type: "text" },
    { key: "drawMs", label: "绘制时长(ms)", type: "number", min: 500, max: 2000, step: 100 },
    { key: "accent", label: "颜色", type: "color" },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 120, step: 2, hint: "0 表示按部件的框自动算;想固定就填具体像素" },
  ],
  defaultFrame: { x: 960, y: 540, w: 1100, h: 420, anchor: [0.5, 0.5] },
  settleMs: (p) => (p.drawMs > 0 ? p.drawMs : 1000) * 0.85 + 400,
  after: "hold",
  Component: ChartGrowthPart,
};

