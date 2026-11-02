import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  title: string;
  subtitle: string;
  items: string;
  stepMs: number;
}

function PinBoardCard({ params }: CardProps<Params>) {
  const accent = accentOf(params);
  const items = params.items.split("|").filter(Boolean);
  
  return (
    <div className={`hud-wrapper ${params.position === "left" ? "hud-corner-bl" : getPositionClass(params.position)}`}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2 mb-4">
          <motion.div 
            className="text-[32px] font-light tracking-widest text-white uppercase"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: easeExpoOut }}
          >
            {params.title}
          </motion.div>
          <motion.div 
            className="text-[48px] font-bold"
            style={{ color: accent }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.6, ease: easeExpoOut }}
          >
            {params.subtitle}
          </motion.div>
        </div>
        <div className="flex flex-col gap-4 items-start">
          {items.map((item, i) => (
            <motion.div
              key={i}
              className="bg-[#111] text-white px-8 py-4 rounded-xl text-[36px] font-medium shadow-2xl border border-white/10"
              initial={{ opacity: 0, scale: 1.15, y: -10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ 
                delay: 0.3 + (i * params.stepMs) / 1000, 
                type: "spring",
                stiffness: 400,
                damping: 20
              }}
            >
              {item}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const pinBoard: CardDef<Params> = {
  id: "pin-board",
  name: "Key points pin board",
  description: "Key points board that appears one by one",
  useWhen: "A small board with a title and subtitle (Chinese and English) that lists 3 to 5 parallel key points, pinning them to the board one by one. Good for summarizing a section of content, not for a scattered list. Setting position to left places it at the bottom left.",
  tags: ["Key points","pin board","list"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    position: "left",
    title: "SUMMARY",
    subtitle: "核心要点总结",
    items: "第一点核心优势|第二点不可替代|第三点极速交付",
    stepMs: 200,
  },
  controls: [
    ...hudControls,
    { key: "title", label: "Heading", type: "text" },
    { key: "subtitle", label: "Subtitle", type: "text" },
    { key: "items", label: "Key points (separated by |)", type: "text" },
    { key: "stepMs", label: "Interval (ms)", type: "number" },
  ],
  parts: [
    { id: "title", label: "Heading", role: "text", params: ["title"], enterMs: 0, settleMs: 600 },
    { id: "subtitle", label: "Subtitle", role: "text", params: ["subtitle", "accent"], enterMs: 100, settleMs: 700 },
    { id: "items", label: "Key points", role: "list", params: ["items", "stepMs"], enterMs: 300, settleMs: 300 + 2 * 200 + 400 },
  ],
  lifecycle: { settleMs: 1100, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const count = Math.max(1, p.items.split("|").filter(Boolean).length);
    const items = 300 + (count - 1) * p.stepMs + 400;
    return { settleMs: Math.max(700, items), parts: { items: { settleMs: items } } };
  },
  Component: PinBoardCard,
};
