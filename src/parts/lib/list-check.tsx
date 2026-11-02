import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { accentOf, easeExpoOut } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * Checklist with item-by-item checkmarks: extracted from checklist card.
 * Each item has a circle and checkmark animation; line interval determines entrance and checkmark timing.
 */
interface Params {
  items: string;
  size: number;
  stepMs: number;
  accent: string;
}

function CheckItem({ text, i, stepMs, accent, size }: { text: string; i: number; stepMs: number; accent: string; size: number }) {
  const rowDelay = i * (stepMs / 1000);
  const tickDelay = rowDelay + 0.15;

  return (
    <motion.div
      className="flex items-center gap-6"
      initial={{ opacity: 0, x: -40 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.6, delay: rowDelay, ease: easeExpoOut }}
    >
      <div className="relative w-20 h-20 flex items-center justify-center flex-shrink-0">
        <div className="absolute inset-0 rounded-full border-4 border-current opacity-30" />
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: accent }}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.4, delay: tickDelay, ease: easeExpoOut }}
        />
        <svg
          viewBox="0 0 24 24"
          className="w-12 h-12 relative z-10"
          style={{ color: "var(--pc-on-accent, #0b1220)" }}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <motion.path
            d="M5 13l4 4L19 7"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.4, delay: tickDelay + 0.1, ease: easeExpoOut }}
          />
        </svg>
      </div>
      <div className="font-bold text-white" style={{ fontSize: size }}>{text}</div>
    </motion.div>
  );
}

function ChecklistPart({ params, width, height }: PartProps<Params>) {
  const size = fitOr(params.size, { width: width - 96 - 80 - 24, height: height - 96, text: params.items, splitter: "|", lineHeight: 1.25 + 32 / 72, max: 160 });
  const items = params.items.split("|").filter(Boolean);
  return (
    <div
      className="hud-glass"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 32,
        boxSizing: "border-box",
      }}
    >
      {items.map((item, i) => (
        <CheckItem key={i} text={item} i={i} stepMs={params.stepMs} accent={accentOf(params)} size={size} />
      ))}
    </div>
  );
}

export const listCheck: PartDef<Params> = {
  id: "list-check",
  name: "Checklist ticks",
  description: "Checklist items that wipe in one by one and get ticked",
  useWhen: "Use when the narration lists parallel key points, to-do items or a checklist; each item gets a circle tick animation. If the items need no tick ceremony and just a simple bar display, use list-pins.",
  tags: ["Checklist", "tick", "List", "Key points", "list"],
  role: "list",
  from: "checklist",
  defaults: {
    items: "选题定方向|脚本写钩子|镜头列清单|剪辑控节奏",
    size: 0,
    stepMs: 260,
    accent: "",
  },
  controls: [
    { key: "items", label: "Items (separated by vertical bars)", type: "text", required: true },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 160, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
    { key: "stepMs", label: "Row interval (ms)", type: "number", min: 0, max: 2000, step: 20 },
    { key: "accent", label: "Main color (leave empty to use theme color)", type: "color" },
  ],
  defaultFrame: { x: 460, y: 220, w: 1000, h: 640 },
  settleMs: (p) => (Math.max(1, p.items.split("|").filter(Boolean).length) - 1) * p.stepMs + 650,
  after: "hold",
  Component: ChecklistPart,
};
