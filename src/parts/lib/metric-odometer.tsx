import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";
import { fitOr } from "../fit";

/**
 * Odometer numbers: large mechanical roller numbers plus units.
 * Extracted from odometer, stripped of explanatory small text and glass board shell.
 * Entrance: number wheels scroll down into place.
 */
interface Params {
  value: number;
  unit: string;
  size: number;
  accent: string;
}

function OdometerWheel({ digit, index }: { digit: string; index: number }) {
  const d = parseInt(digit, 10);
  if (isNaN(d)) return <span className="inline-block">{digit}</span>;

  const numbers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const targetIndex = 10 + d;

  return (
    <span className="inline-flex relative overflow-hidden" style={{ height: "1em", verticalAlign: "bottom" }}>
      <span className="invisible leading-none">0</span>
      <motion.span
        className="absolute inset-x-0 top-0 flex flex-col"
        initial={{ y: "0em" }}
        animate={{ y: `-${targetIndex}em` }}
        transition={{ duration: 0.8 + index * 0.12, ease: easeExpoOut }}
      >
        {numbers.map((n, i) => (
          <span key={i} className="leading-none text-center h-[1em] block">
            {n}
          </span>
        ))}
      </motion.span>
    </span>
  );
}

function MetricOdometerPart({ params, width, height }: PartProps<Params>) {
  const strValue = String(Math.floor(params.value));
  const size = fitOr(params.size, { width, height, text: strValue + params.unit, lines: 1, max: 400 });

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", width, height }}>
      <div className="flex items-baseline gap-4" style={{ color: accentOf(params) }}>
        <div style={{ fontSize: size, fontWeight: "bold", display: "flex", fontFamily: "var(--pc-font-mono, ui-monospace, monospace)" }}>
          {strValue.split("").map((c, i) => (
            <OdometerWheel key={i} digit={c} index={i} />
          ))}
        </div>
        {params.unit && <div style={{ fontSize: size * (48/120), fontWeight: 600, opacity: 0.8 }}>{params.unit}</div>}
      </div>
    </div>
  );
}

export const metricOdometer: PartDef<Params> = {
  id: "metric-odometer",
  name: "Odometer number",
  description: "Big-number flip effect",
  useWhen: "Use when a large cumulative integer (views, user count) should be shown as a mechanical rolling odometer. Only non-negative integers are supported, decimals are truncated, and there are no rise/fall signs. Use metric-stat for signs or footnotes and metric-ring for percentage progress.",
  tags: ["number", "growth", "flip", "change"],
  role: "text",
  from: "odometer",
  defaults: {
    value: 12480,
    unit: "次",
    size: 0,
    accent: "",
  },
  controls: [
    { key: "value", label: "Value", type: "number" },
    { key: "unit", label: "Unit", type: "text" },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 400, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
    { key: "accent", label: "Color", type: "color" },
  ],
  defaultFrame: { x: 960, y: 540, w: 800, h: 200, anchor: [0.5, 0.5] },
  settleMs: (p) => 800 + (String(Math.floor(Number(p.value) || 0)).length - 1) * 120,
  after: "hold",
  Component: MetricOdometerPart,
};
