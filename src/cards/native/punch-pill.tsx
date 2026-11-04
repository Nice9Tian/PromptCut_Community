import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  text: string;
}

function PunchPillCard({ params }: CardProps<Params>) {
  const accent = accentOf(params);
  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="relative">
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: accent, filter: "blur(32px)" }}
          initial={{ opacity: 0.8, scale: 0.8 }}
          animate={{ opacity: 0, scale: 1.5 }}
          transition={{ duration: 1.2, ease: "easeOut" }}
        />
        <motion.div
          className="relative px-12 py-6 rounded-full flex items-center justify-center text-white text-[64px] font-bold"
          style={{ backgroundColor: accent }}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ 
            type: "spring",
            stiffness: 300,
            damping: 15,
            mass: 0.8
          }}
        >
          {params.text}
        </motion.div>
      </div>
    </div>
  );
}

export const punchPill: CardDef<Params> = {
  id: "punch-pill",
  name: "Punchline pill",
  description: "Capsule design that emphasizes key messages",
  useWhen: "Very short key words, selling-point tags or slogans (2 to 8 characters, exclamation mark not required) shown as a glowing capsule that pops in. The font is very large and stays on a single line without wrapping, so text that is too long will overflow the rounded corners. For a full emphasis sentence use blur-text; for quoting exact words use quote-lockup.",
  tags: ["quotable line","Slogan","short phrase","exclamation"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    position: "center",
    text: "核心卖点",
  },
  controls: [
    ...hudControls,
    { key: "text", label: "short phrase", type: "text" },
  ],
  parts: [
    { id: "text", label: "short phrase", role: "text", params: ["text"], enterMs: 0, settleMs: 1200 },
  ],
  lifecycle: { settleMs: 1200, after: "hold", exit: ["fade"] },
  Component: PunchPillCard,
};
