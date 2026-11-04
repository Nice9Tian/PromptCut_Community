import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { accentOf, easeExpoOut } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * Punchline quote: multi-line punchline revealed line by line alongside a left vertical bar in
 * primary color. Extracted from quote-lockup.
 * Does not include attribution; attribution is separate as the text-author part.
 */
interface Params {
  quote: string;
  size: number;
  accent: string;
}

function QuotePart({ params, width, height }: PartProps<Params>) {
  const size = fitOr(params.size, { width: width - 48 - 28, height, text: params.quote, splitter: "|", lineHeight: 1.25 + 16 / 64, max: 200 });
  const lines = params.quote.split("|").filter(Boolean);
  const accent = accentOf(params);
  const staggerMs = 180;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        padding: "0 24px",
        boxSizing: "border-box",
      }}
    >
      <div className="flex gap-6 items-stretch">
        <motion.div
          className="w-1 flex-shrink-0"
          style={{ backgroundColor: accent, transformOrigin: "top" }}
          initial={{ scaleY: 0 }}
          animate={{ scaleY: 1 }}
          transition={{ duration: (lines.length * staggerMs) / 1000, ease: easeExpoOut }}
        />
        <div className="flex flex-col gap-4">
          {lines.map((line, i) => (
            <motion.div
              key={i}
              className="font-bold leading-tight text-white"
              style={{ fontSize: size }}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: (i * staggerMs) / 1000, duration: 0.6, ease: easeExpoOut }}
            >
              {line}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const textQuote: PartDef<Params> = {
  id: "text-quote",
  name: "Quote lockup",
  description: "Multi-line punchy quote revealed line by line",
  useWhen: "Use when the narration contains a verbatim quote in quotation marks or a famous saying; lines slide in one by one with an accent-colored rule on the left; pair with text-author to show the attribution; use text-pill for very short slogans and text-blur for emphasis sentences.",
  tags: ["quotable line", "quote", "quotation marks", "lockup", "famous saying"],
  role: "list",
  from: "quote-lockup",
  defaults: {
    quote: "设计不只是|它的外观和感觉。|设计是怎么工作的。",
    size: 0,
    accent: "",
  },
  controls: [
    { key: "quote", label: "Quote (separate lines with |)", type: "text", required: true },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 200, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
    { key: "accent", label: "Rule color (leave empty to use theme color)", type: "color" },
  ],
  defaultFrame: { x: 200, y: 340, w: 1000, h: 360 },
  settleMs: (p) => (Math.max(1, p.quote.split("|").filter(Boolean).length) - 1) * 180 + 600,
  after: "hold",
  Component: QuotePart,
};
