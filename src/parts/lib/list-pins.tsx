import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { fitOr } from "../fit";

/**
 * Pin board key points: a column of black rounded bars, "pinned" on one by one (scale-down spring-in).
 * Extracted from pin-board's key points list.
 * Entrance interval for each item is determined by stepMs, so settling time varies with the number of items.
 */
interface Params {
  items: string;
  stepMs: number;
  size: number;
}

function PinsPart({ params, width, height }: PartProps<Params>) {
  const items = params.items.split("|").filter(Boolean);
  // size 0 = calculate from box: one line per item, line height includes padding (12px × 2) and bar spacing (16px)
  const size = fitOr(params.size, { width: width - 32 - 56, height: height - 16 * Math.max(0, items.length - 1), text: params.items, splitter: "|", lineHeight: 1.25 + 24 / 36, max: 120 });
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start", justifyContent: "center", padding: "0 16px" }}>
      {items.map((item, i) => (
        <motion.div
          key={i}
          style={{ background: "#111", color: "#fff", padding: "12px 28px", borderRadius: 14, fontSize: size, fontWeight: 500, boxShadow: "0 12px 30px rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.1)" }}
          initial={{ opacity: 0, scale: 1.15, y: -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ delay: (i * params.stepMs) / 1000, type: "spring", stiffness: 400, damping: 20 }}
        >
          {item}
        </motion.div>
      ))}
    </div>
  );
}

export const listPins: PartDef<Params> = {
  id: "list-pins",
  name: "Pinboard key points",
  description: "A column of black rounded bars that pop in and pin one by one",
  useWhen: "Use for 3 to 5 parallel key points, summaries or lists. Use list-check for a checked-off feel and the metric family for items with values.",
  tags: ["Key points", "List", "pin board"],
  role: "list",
  from: "pin-board",
  defaults: { items: "第一点核心优势|第二点不可替代|第三点极速交付", stepMs: 200, size: 0 },
  controls: [
    { key: "items", label: "Key points (separated by |)", type: "text", required: true },
    { key: "stepMs", label: "Interval (ms)", type: "number", min: 0, max: 2000, step: 20 },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 120, step: 2, hint: "0 means the font size is computed automatically from the box and the number of items; enter a specific pixel value to fix it" },
  ],
  defaultFrame: { x: 120, y: 320, w: 900, h: 420 },
  settleMs: (p) => (Math.max(1, p.items.split("|").filter(Boolean).length) - 1) * p.stepMs + 400,
  after: "hold",
  Component: PinsPart,
};
