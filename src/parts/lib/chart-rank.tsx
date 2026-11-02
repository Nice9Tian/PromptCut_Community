import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useRef } from "react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";
import { fitOr } from "../fit";

/**
 * Bar ranking bars: multiple ranking data items displayed as horizontal bar charts with animated numbers.
 * Extracted from rank-bars, without titles and shell.
 * Entrance: bars grow from left to right, and the maximum bar is highlighted in the theme color.
 */
interface Params {
  rows: string;
  suffix: string;
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

function ChartRankPart({ params, width, height }: PartProps<Params>) {
  const rowData = params.rows.split("|").map((r) => {
    const [name, val] = r.split(",");
    return { name: name?.trim() || "", value: parseFloat(val) || 0 };
  });

  const maxVal = Math.max(...rowData.map((r) => r.value));
  const validMaxVal = maxVal > 0 ? maxVal : 1;
  const numRows = rowData.length;
  const size = fitOr(params.size, { width: width * 0.2, height: height - 24 * Math.max(0, numRows - 1), text: params.rows, splitter: "|", lines: numRows, max: 80 });

  return (
    <div style={{ position: "absolute", inset: 0, width, height, display: "flex", flexDirection: "column", justifyContent: "center", gap: 24 }}>
      {rowData.map((row, i) => {
        const isFirst = row.value === maxVal && maxVal > 0;
        const widthPct = (row.value / validMaxVal) * 100;
        return (
          <motion.div
            key={i}
            className="flex items-center gap-4"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: i * 0.12, ease: easeExpoOut }}
          >
            <div className="text-right opacity-90 truncate" style={{ width: size * 4.9, fontSize: size * 0.83 }}>{row.name}</div>
            <div className="flex-1 bg-black/20 rounded-full overflow-hidden relative" style={{ height: size * 1.1 }}>
              <motion.div
                className="absolute left-0 top-0 bottom-0 rounded-full"
                style={{
                  backgroundColor: isFirst ? accentOf(params) : "rgba(255, 255, 255, 0.4)",
                }}
                initial={{ width: "0%" }}
                animate={{ width: `${widthPct}%` }}
                transition={{ duration: 0.9, delay: i * 0.12, ease: easeExpoOut }}
              />
            </div>
            <div
              className="font-bold font-mono"
              style={{
                width: size * 3.6,
                fontSize: size,
                color: isFirst ? accentOf(params) : "var(--pc-fg, #f3f4f6)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <NumberTicker value={row.value} duration={0.9 + i * 0.12} />
              {params.suffix && <span className="ml-1" style={{ fontSize: size * 0.56 }}>{params.suffix}</span>}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

export const chartRank: PartDef<Params> = {
  id: "chart-rank",
  name: "Rank bars",
  description: "Bar chart ranking with rolling values",
  useWhen: "Use a bar chart to compare 3 to 5 items or build a ranking. **The part does not sort automatically**: pass rows in descending order by value; item names must be at most 5 characters, longer ones are truncated. Use group-versus for a two-way showdown and chart-growth for trends over time.",
  tags: ["ranking", "bar chart", "comparison", "leaderboard"],
  role: "list",
  from: "rank-bars",
  defaults: {
    rows: "微信,85|抖音,62|小红书,45|快手,30",
    suffix: "%",
    accent: "",
    size: 0,
  },
  controls: [
    { key: "rows", label: "Data rows (name,value|name,value)", type: "text" },
    { key: "suffix", label: "Value suffix", type: "text" },
    { key: "accent", label: "Color", type: "color" },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 80, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
  ],
  defaultFrame: { x: 960, y: 540, w: 1000, h: 600, anchor: [0.5, 0.5] },
  settleMs: (p) => (Math.max(1, p.rows.split("|").filter(Boolean).length) - 1) * 120 + 900,
  after: "hold",
  Component: ChartRankPart,
};

