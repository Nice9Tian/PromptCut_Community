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
  name: "金句定格",
  description: "逐行揭示的金句引言",
  useWhen: "口播里出现引号包起来的原话、名人名言时,定格成引言版式,带左侧主色竖线和 author 署名。正文用 `|` 分成 2 到 3 行短句。极短口号用 punch-pill,强调句用 blur-text。",
  tags: ["金句","引言","引号","定格"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
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
    { key: "quote", label: "金句(用|分行)", type: "text" },
    { key: "author", label: "署名", type: "text" },
    { key: "side", label: "靠侧", type: "select", options: [{ value: "left", label: "靠左" }, { value: "right", label: "靠右" }] },
  ],
  parts: [
    { id: "quote", label: "金句", role: "list", params: ["quote", "side"], enterMs: 0, settleMs: 960 },
    { id: "author", label: "署名", role: "text", params: ["author"], enterMs: 740, settleMs: 1340 },
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
