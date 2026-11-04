import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { accentOf, easeExpoOut } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * Blur-reveal text: text revealed with blur block by block, supporting asterisks to highlight
 * key words. Extracted from blur-text card.
 * Word blocks enter in sequence based on staggerMs; settling duration is determined by word block
 * count and interval.
 */
interface Params {
  text: string;
  size: number;
  staggerMs: number;
  accent: string;
}

function parseText(chunk: string, accent: string) {
  const parts = chunk.split(/(\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("*") && part.endsWith("*")) {
      return (
        <span key={i} style={{ color: accent }}>
          {part.slice(1, -1)}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function BlurTextPart({ params, width, height }: PartProps<Params>) {
  const size = fitOr(params.size, { width: width - 96, height: height - 96, text: params.text.replace(/[|*]/g, ""), max: 200 });
  const chunks = params.text.split("|");
  return (
    <div
      className="hud-glass"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
      }}
    >
      <div className="font-bold leading-tight flex flex-wrap gap-x-4 justify-center" style={{ fontSize: size }}>
        {chunks.map((chunk, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, filter: "blur(12px)", y: 12 }}
            animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
            transition={{
              duration: 0.8,
              delay: i * (params.staggerMs / 1000),
              ease: easeExpoOut,
            }}
          >
            {parseText(chunk, accentOf(params))}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

export const textBlur: PartDef<Params> = {
  id: "text-blur",
  name: "Blur fade",
  description: "Text emerges from a blurred focus chunk by chunk, and key words can be highlighted in the main color",
  useWhen: "Use when the narration emphasizes a core idea, conclusion or pull quote. You must split chunks with \"|\" and wrap highlighted words in \"*asterisks*\". For very short chunks (a single phrase) use text-pill, and for quotes with an author attribution use text-quote.",
  tags: ["Text", "blur", "fade-in", "emphasis", "key point"],
  role: "list",
  from: "blur-text",
  defaults: {
    text: "走心的句子|从虚焦里|*慢慢浮现*",
    size: 0,
    staggerMs: 220,
    accent: "",
  },
  controls: [
    { key: "text", label: "Text", type: "text", required: true },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 200, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
    { key: "staggerMs", label: "Stagger (ms)", type: "number", min: 0, max: 2000, step: 20 },
    { key: "accent", label: "Main color (leave empty to use theme color)", type: "color" },
  ],
  defaultFrame: { x: 260, y: 400, w: 1400, h: 280 },
  settleMs: (p) => (Math.max(1, p.text.split("|").length) - 1) * p.staggerMs + 800,
  after: "hold",
  Component: BlurTextPart,
};
