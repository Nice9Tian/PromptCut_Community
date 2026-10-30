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
  name: "金句药丸",
  description: "强调核心信息的胶囊设计",
  useWhen: "极短的重点词、卖点标签或口号(2 到 8 字,不要求感叹号)做成发光胶囊弹入。字号很大且单行不折行,太长会撑破圆角。完整的强调句用 blur-text,引述原话用 quote-lockup。",
  tags: ["金句","标语","短句","感叹"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    position: "center",
    text: "核心卖点",
  },
  controls: [
    ...hudControls,
    { key: "text", label: "短句", type: "text" },
  ],
  parts: [
    { id: "text", label: "短句", role: "text", params: ["text"], enterMs: 0, settleMs: 1200 },
  ],
  lifecycle: { settleMs: 1200, after: "hold", exit: ["fade"] },
  Component: PunchPillCard,
};
