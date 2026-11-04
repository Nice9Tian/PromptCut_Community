import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  chips: string;
  note: string;
  stepMs: number;
}

function EntityChipsCard({ params }: CardProps<Params>) {
  const accent = accentOf(params);
  const chipLines = params.chips.split("\n").filter(Boolean);
  const noteLines = (params.note || "").split("|").filter(Boolean);
  
  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="flex items-center gap-12">
        <div className="flex flex-col gap-4">
          {chipLines.map((line, i) => {
            const [style, name, title] = line.split("|");
            const isDark = style === "dark";
            return (
              <motion.div
                key={i}
                className="h-[56px] rounded-[28px] px-8 flex items-center gap-4 shadow-lg overflow-hidden whitespace-nowrap"
                style={{ 
                  backgroundColor: isDark ? "#111" : "#fff",
                  color: isDark ? "#fff" : "#111",
                }}
                initial={{ opacity: 0, x: -60 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: (i * params.stepMs) / 1000, duration: 0.6, ease: easeExpoOut }}
              >
                <div className="text-[28px] font-bold">{name}</div>
                {title && (
                  <>
                    <div className="w-[2px] h-[24px] bg-current opacity-20" />
                    <div className="text-[24px] opacity-80">{title}</div>
                  </>
                )}
              </motion.div>
            );
          })}
        </div>
        {noteLines.length > 0 && (
          <motion.div 
            className="flex flex-col gap-1 border-l-2 pl-6"
            style={{ borderColor: accent }}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: (chipLines.length * params.stepMs + 200) / 1000, duration: 0.6, ease: easeExpoOut }}
          >
            {noteLines.map((nl, i) => (
              <div key={i} className="text-gray-400 text-[24px]">{nl}</div>
            ))}
          </motion.div>
        )}
      </div>
    </div>
  );
}

export const entityChips: CardDef<Params> = {
  id: "entity-chips",
  name: "Entity name tags",
  description: "Name tags showing people or organizations",
  useWhen: "When introducing team members, guests or partner organizations, turn 2 to 5 entities into **vertical** pill-shaped name tags that slide in one by one. chips splits entries by newline (not vertical bar), each in the format `dark or light|name|title`; a note can be added on the right as a category side note. Use focus-card for a single person presenting on camera.",
  tags: ["person","organization","name tag","entity"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    position: "left",
    chips: "dark|张三|创始人\nlight|李四|技术总监",
    note: "核心团队|Core Team",
    stepMs: 150,
  },
  controls: [
    ...hudControls,
    { key: "chips", label: "Name tags (style|name|title, newline-separated)", type: "text" },
    { key: "note", label: "Side note (top line|bottom line)", type: "text" },
    { key: "stepMs", label: "Interval (ms)", type: "number" },
  ],
  parts: [
    { id: "chips", label: "name tag", role: "list", params: ["chips", "stepMs"], enterMs: 0, settleMs: 1 * 150 + 600 },
    { id: "note", label: "Side note", role: "text", params: ["note"], enterMs: 2 * 150 + 200, settleMs: 2 * 150 + 200 + 600 },
  ],
  lifecycle: { settleMs: 1100, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const count = Math.max(1, p.chips.split("\n").filter(Boolean).length);
    const chips = (count - 1) * p.stepMs + 600;
    const hasNote = (p.note || "").split("|").filter(Boolean).length > 0;
    const noteEnter = count * p.stepMs + 200;
    return {
      settleMs: hasNote ? noteEnter + 600 : chips,
      parts: { chips: { settleMs: chips }, note: { enterMs: noteEnter, settleMs: hasNote ? noteEnter + 600 : noteEnter } },
    };
  },
  Component: EntityChipsCard,
};
