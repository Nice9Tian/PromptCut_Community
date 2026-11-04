import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { accentOf, easeExpoOut } from "../../cards/native/hud";
import { fitOr } from "../fit";

/**
 * Title: one line of large text, with an optional kicker line above. Extracted from "subheading + subtitle" in pin-board.
 * Entrance: kicker first fades in and floats up, title delayed by 100ms.
 */
interface Params {
  kicker: string;
  text: string;
  size: number;
  accent: string;
  align: string;
}

function TitlePart({ params, width, height }: PartProps<Params>) {
  // size 0 = calculate from box: title takes the majority, kicker is 0.55x title; both lines fit into box together
  const size = fitOr(params.size, { width: width - 48, height, text: params.text, lines: params.kicker ? 1.55 : 1, max: 240 });
  const align = params.align === "center" ? "center" : params.align === "right" ? "flex-end" : "flex-start";
  const textAlign = params.align === "center" ? "center" : params.align === "right" ? "right" : "left";
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: align, gap: 8, padding: "0 24px", maxWidth: width }}>
      {params.kicker && (
        <motion.div
          style={{ fontSize: Math.max(14, size * 0.55), letterSpacing: "0.12em", textTransform: "uppercase", color: "#fff", opacity: 0.85, fontWeight: 300, textAlign }}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 0.85, y: 0 }}
          transition={{ duration: 0.6, ease: easeExpoOut }}
        >
          {params.kicker}
        </motion.div>
      )}
      <motion.div
        style={{ fontSize: size, fontWeight: 700, lineHeight: 1.15, color: accentOf(params), textAlign, textShadow: "0 2px 12px rgba(0,0,0,0.35)" }}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: params.kicker ? 0.1 : 0, duration: 0.6, ease: easeExpoOut }}
      >
        {params.text}
      </motion.div>
    </div>
  );
}

export const textTitle: PartDef<Params> = {
  id: "text-title",
  name: "Title",
  description: "A single-line large title, optionally with a line of small text above it; fades in and rises into place",
  useWhen: "Use when a composition needs a eye-catching title or section name; use text-body for body and explanatory text, and metric-type parts for numbers.",
  tags: ["Title", "Text", "kicker"],
  role: "text",
  from: "pin-board",
  defaults: { kicker: "SUMMARY", text: "核心要点总结", size: 0, accent: "", align: "left" },
  controls: [
    { key: "kicker", label: "kicker", type: "text", hint: "Leave empty to hide" },
    { key: "text", label: "Title", type: "text", required: true },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 240, step: 2, hint: "0 means the font size is computed automatically from the part's box, and the text scales with the box; to fix it, enter a specific pixel value" },
    { key: "accent", label: "Color (leave empty to use theme color)", type: "color" },
    { key: "align", label: "Align", type: "select", options: [{ value: "left", label: "Left" }, { value: "center", label: "Medium" }, { value: "right", label: "Right" }] },
  ],
  defaultFrame: { x: 120, y: 120, w: 900, h: 160 },
  settleMs: (p) => (p.kicker ? 700 : 600),
  after: "hold",
  Component: TitlePart,
};
