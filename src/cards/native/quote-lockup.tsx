import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  quote: string;
  author: string;
  side: "left" | "right";
}

function QuoteLockupCard({ params }: CardProps<Params>) {
  const lines = params.quote.split("|").filter(Boolean);
  const accent = accentOf(params);
  const staggerMs = 180;
  
  return (
    <div 
      className={`hud-wrapper ${getPositionClass(params.position)}`}
      style={
        params.side === "left" 
          ? { justifyContent: "flex-start", paddingLeft: "120px" } 
          : params.side === "right" 
            ? { justifyContent: "flex-end", paddingRight: "120px" } 
            : {}
      }
    >
      <div className="flex gap-6 p-12">
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
              className="text-[64px] font-bold leading-tight text-white"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: (i * staggerMs) / 1000, duration: 0.6, ease: easeExpoOut }}
            >
              {line}
            </motion.div>
          ))}
          {params.author && (
            <motion.div
              className="text-[32px] text-white/60 mt-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: (lines.length * staggerMs + 200) / 1000, duration: 0.6 }}
            >
              {params.author}
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}

export const quoteLockup: CardDef<Params> = {
  id: "quote-lockup",
  name: "Quote lockup",
  description: "Punchline quote revealed line by line",
  useWhen: "When the narration contains exact words in quotation marks or a famous quote, lock it into a quote layout with a primary-color vertical bar on the left and an author credit. Split the body into 2 to 3 short lines with `|`. For very short slogans use punch-pill; for emphasis sentences use blur-text.",
  tags: ["quotable line","quote","quotation marks","lockup"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    position: "center",
    quote: "设计不只是|它的外观和感觉。|设计是怎么工作的。",
    author: "— 史蒂夫·乔布斯",
    side: "left",
  },
  controls: [
    ...hudControls,
    { key: "quote", label: "Quote (separate lines with |)", type: "text" },
    { key: "author", label: "Attribution", type: "text" },
    { key: "side", label: "Side", type: "select", options: [{ value: "left", label: "Align left" }, { value: "right", label: "Align right" }] },
  ],
  parts: [
    { id: "quote", label: "quotable line", role: "list", params: ["quote", "side"], enterMs: 0, settleMs: 960 },
    { id: "author", label: "Attribution", role: "text", params: ["author"], enterMs: 740, settleMs: 1340 },
  ],
  lifecycle: { settleMs: 1340, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const lines = Math.max(1, p.quote.split("|").filter(Boolean).length);
    const quote = (lines - 1) * 180 + 600;
    const authorEnter = lines * 180 + 200;
    const hasAuthor = !!(p.author || "").trim();
    return {
      settleMs: hasAuthor ? authorEnter + 600 : quote,
      parts: { quote: { settleMs: quote }, author: { enterMs: authorEnter, settleMs: hasAuthor ? authorEnter + 600 : authorEnter } },
    };
  },
  Component: QuoteLockupCard,
};
