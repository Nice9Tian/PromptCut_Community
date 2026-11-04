import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  title: string;
  rows: string;
  suffix: string;
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

function RankBarsCard({ params }: CardProps<Params>) {
  const rowData = params.rows.split("|").map((r) => {
    const [name, val] = r.split(",");
    return { name: name?.trim() || "", value: parseFloat(val) || 0 };
  });

  const maxVal = Math.max(...rowData.map((r) => r.value));
  const validMaxVal = maxVal > 0 ? maxVal : 1;

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass flex flex-col gap-8 min-w-[1000px]">
        {params.title && <div className="text-5xl font-bold">{params.title}</div>}
        <div className="flex flex-col gap-6">
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
                <div className="w-44 text-3xl text-right opacity-90 truncate">{row.name}</div>
                <div className="flex-1 h-10 bg-black/20 rounded-full overflow-hidden relative">
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
                  className="w-32 text-4xl font-bold font-mono"
                  style={{
                    color: isFirst ? accentOf(params) : "var(--pc-fg, #f3f4f6)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <NumberTicker value={row.value} duration={0.9 + i * 0.12} />
                  {params.suffix && <span className="text-xl ml-1">{params.suffix}</span>}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const rankBars: CardDef<Params> = {
  id: "rank-bars",
  name: "Rank bars",
  description: "Bar chart ranking with rolling values",
  useWhen: "Use a bar chart to compare or rank 3 to 5 items: bar length and integer value scroll together, and the bar with the max value is highlighted automatically. **The card does not sort automatically**, so pass rows in descending order of value; item names should be at most 5 characters, longer ones are truncated. Do not use it for a single number; use versus-card for a head-to-head of two items and growth-curve for trends over time.",
  tags: ["ranking","bar chart","comparison","leaderboard"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    title: "TOP 渠道转化率",
    rows: "微信,85|抖音,62|小红书,45|快手,30",
    suffix: "%",
  },
  controls: [
    ...hudControls,
    { key: "title", label: "Title", type: "text" },
    { key: "rows", label: "Data rows (name,value|name,value)", type: "text" },
    { key: "suffix", label: "Value suffix", type: "text" },
  ],
  parts: [
    { id: "title", label: "Title", role: "text", params: ["title"], enterMs: 0, settleMs: 0 },
    { id: "rows", label: "Data rows", role: "list", params: ["rows", "suffix"], enterMs: 0, settleMs: 3 * 120 + 900 },
  ],
  lifecycle: { settleMs: 1260, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const rows = Math.max(1, p.rows.split("|").filter(Boolean).length);
    const settle = (rows - 1) * 120 + 900;
    return { settleMs: settle, parts: { rows: { settleMs: settle } } };
  },
  Component: RankBarsCard,
};
