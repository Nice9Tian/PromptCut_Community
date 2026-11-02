import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  en: string;
  term: string;
  def: string;
}

function TermCard({ params }: CardProps<Params>) {
  const chars = params.def.split("");
  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass flex flex-col items-center justify-center text-center max-w-4xl">
        {params.en && (
          <motion.div
            className="text-2xl opacity-60 mb-2 uppercase tracking-widest"
            style={{ fontFamily: "var(--pc-font-mono, ui-monospace, monospace)" }}
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.25, duration: 0.6, ease: easeExpoOut }}
          >
            {params.en}
          </motion.div>
        )}
        <motion.div
          className="text-[80px] font-bold text-white mb-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, ease: easeExpoOut }}
        >
          {params.term}
        </motion.div>
        <div className="text-[40px] text-gray-400 leading-snug">
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
    </div>
  );
}

export const termCard: CardDef<Params> = {
  id: "term-card",
  name: "Term explainer card",
  description: "Term explanation with a small pinyin or English note",
  useWhen: "When the narration gives a definition or explains a term (\"so-called\", \"is called\", \"refers to\", \"means\"), turn the term and its explanation into a card. **The en note is forced to uppercase**, so it only suits English, not pinyin.",
  tags: ["term","definition","noun","explanation"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    position: "center",
    en: "Terminology",
    term: "术语解释",
    def: "用一句人话来解释复杂的概念",
  },
  controls: [
    ...hudControls,
    { key: "en", label: "English/pinyin", type: "text" },
    { key: "term", label: "term", type: "text" },
    { key: "def", label: "definition", type: "text" },
  ],
  parts: [
    { id: "en", label: "Note", role: "text", params: ["en"], enterMs: 250, settleMs: 850 },
    { id: "term", label: "term", role: "text", params: ["term"], enterMs: 0, settleMs: 800 },
    { id: "def", label: "definition", role: "text", params: ["def"], enterMs: 0, settleMs: 14 * 30 + 100 },
  ],
  lifecycle: { settleMs: 850, after: "hold", exit: ["fade"] },
  Component: TermCard,
};
