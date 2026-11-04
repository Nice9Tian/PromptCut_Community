import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { accentOf } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * Punchline pill: pill design emphasizing core information. Extracted from punch-pill.
 * Glows, diffuses, and springs into view.
 */
interface Params {
  text: string;
  size: number;
  accent: string;
}

function PunchPillPart({ params, width, height }: PartProps<Params>) {
  const size = fitOr(params.size, { width: width - 96, height: height - 48, text: params.text, max: 200 });
  const accent = accentOf(params);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
      }}
    >
      <div className="relative">
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: accent, filter: "blur(32px)" }}
          initial={{ opacity: 0.8, scale: 0.8 }}
          animate={{ opacity: 0, scale: 1.5 }}
          transition={{ duration: 1.2, ease: "easeOut" }}
        />
        <motion.div
          className="relative px-12 py-6 rounded-full flex items-center justify-center text-white font-bold whitespace-nowrap"
          style={{ backgroundColor: accent, fontSize: size }}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{
            type: "spring",
            stiffness: 300,
            damping: 15,
            mass: 0.8,
          }}
        >
          {params.text}
        </motion.div>
      </div>
    </div>
  );
}

export const textPill: PartDef<Params> = {
  id: "text-pill",
  name: "Punchline pill",
  description: "Glowing pill that emphasizes key information",
  useWhen: "Use for very short key words, core selling points, labels or slogans (2 to 8 characters) that need strong visual impact; use text-blur for long sentences and text-quote for quotations and famous sayings.",
  tags: ["quotable line", "Slogan", "short phrase", "exclamation", "pill"],
  role: "text",
  from: "punch-pill",
  defaults: {
    text: "核心卖点",
    size: 0,
    accent: "",
  },
  controls: [
    { key: "text", label: "short phrase", type: "text", required: true },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 200, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
    { key: "accent", label: "Main color (leave empty to use theme color)", type: "color" },
  ],
  defaultFrame: { x: 660, y: 460, w: 600, h: 160 },
  settleMs: () => 1200,
  after: "hold",
  Component: PunchPillPart,
};
