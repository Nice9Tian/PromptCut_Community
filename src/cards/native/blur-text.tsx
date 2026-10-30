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
  name: "模糊浮现",
  description: "词块逐个模糊浮现",
  useWhen: "口播里出现「记住」「关键在于」「本质上」「核心是」这类强调句时,把整句做成词块逐个模糊浮现。**必须用 `|` 手动切词块**,不切就是整句一次性浮现;`*星号*` 包住的词用主色高亮。字号很大,控制在 15 字以内。",
  tags: ["强调","金句","浮现","重点"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    text: "走心的句子|从虚焦里|*慢慢浮现*",
    staggerMs: 220,
  },
  controls: [
    ...hudControls,
    { key: "text", label: "文字", type: "text" },
    { key: "staggerMs", label: "字间距(ms)", type: "number" },
  ],
  parts: [
    { id: "text", label: "文字", role: "list", params: ["text", "staggerMs"], enterMs: 0, settleMs: 2 * 220 + 800 },
  ],
  lifecycle: { settleMs: 1240, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const chunks = Math.max(1, p.text.split("|").length);
    const settle = (chunks - 1) * p.staggerMs + 800;
    return { settleMs: settle, parts: { text: { settleMs: settle } } };
  },
  Component: BlurTextCard,
};
