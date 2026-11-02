import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  text: string;
  staggerMs: number;
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

function BlurTextCard({ params }: CardProps<Params>) {
  const chunks = params.text.split("|");
  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass">
        <div className="text-[80px] font-bold leading-tight flex flex-wrap gap-x-4">
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
    </div>
  );
}

export const blurText: CardDef<Params> = {
  id: "blur-text",
  name: "Blur fade",
  description: "Word chunks fade in from blur one by one",
  useWhen: "When the narration contains emphasis phrases such as \"Remember\", \"The key is\", \"Essentially\", \"The core is\", turn the whole sentence into word chunks that fade in from blur one by one. **You must split word chunks manually with `|`**; without splits the whole sentence appears at once. Words wrapped in `*asterisks*` are highlighted in the primary color. The font is very large, so keep it within 15 characters.",
  tags: ["emphasis","quotable line","fade-in","key point"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    text: "走心的句子|从虚焦里|*慢慢浮现*",
    staggerMs: 220,
  },
  controls: [
    ...hudControls,
    { key: "text", label: "Text", type: "text" },
    { key: "staggerMs", label: "Stagger (ms)", type: "number" },
  ],
  parts: [
    { id: "text", label: "Text", role: "list", params: ["text", "staggerMs"], enterMs: 0, settleMs: 2 * 220 + 800 },
  ],
  lifecycle: { settleMs: 1240, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const chunks = Math.max(1, p.text.split("|").length);
    const settle = (chunks - 1) * p.staggerMs + 800;
    return { settleMs: settle, parts: { text: { settleMs: settle } } };
  },
  Component: BlurTextCard,
};
