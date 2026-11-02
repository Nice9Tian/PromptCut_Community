import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * Term card: noun explanation with pinyin or English annotations. Extracted from term-card.
 * English annotations are forced uppercase, and definition text fades in character by character.
 */
interface Params {
  en: string;
  term: string;
  def: string;
  size: number;
}

function TermPart({ params, width, height }: PartProps<Params>) {
  const size = fitOr(params.size, { width: (width - 96) * 2, height: height - 96, text: params.def, lines: 4, max: 200 });
  const chars = params.def.split("");
  return (
    <div
      className="hud-glass"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        boxSizing: "border-box",
      }}
    >
      {params.en && (
        <motion.div
          className="opacity-60 mb-2 uppercase tracking-widest"
          style={{ fontSize: size * 0.3, fontFamily: "var(--pc-font-mono, ui-monospace, monospace)" }}
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.25, duration: 0.6, ease: easeExpoOut }}
        >
          {params.en}
        </motion.div>
      )}
      <motion.div
        className="font-bold text-white mb-6"
        style={{ fontSize: size }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, ease: easeExpoOut }}
      >
        {params.term}
      </motion.div>
      <div className="text-gray-400 leading-snug" style={{ fontSize: size * 0.5 }}>
        {chars.map((char, i) => (
          <motion.span
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: (i * 30) / 1000, duration: 0.1 }}
          >
            {char}
          </motion.span>
        ))}
      </div>
    </div>
  );
}

export const textTerm: PartDef<Params> = {
  id: "text-term",
  name: "Term explainer card",
  description: "Large term with a small English note and character-by-character explanation",
  useWhen: "Use when the narration gives a definition or explains a technical concept or noun; includes a small uppercase English note at the top, an oversized term name, and explanation text that fades in with a typing effect, character by character; use text-title for a plain large title and text-body for paragraph text.",
  tags: ["term", "definition", "noun", "explanation", "concept"],
  role: "text",
  from: "term-card",
  defaults: {
    en: "Terminology",
    term: "术语解释",
    def: "用一句人话来解释复杂的概念",
    size: 0,
  },
  controls: [
    { key: "en", label: "English note", type: "text" },
    { key: "term", label: "term", type: "text", required: true },
    { key: "def", label: "definition", type: "text", required: true },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 200, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
  ],
  defaultFrame: { x: 360, y: 240, w: 1200, h: 560 },
  settleMs: (p) => Math.max(850, p.def.length * 30 + 100),
  after: "hold",
  Component: TermPart,
};
