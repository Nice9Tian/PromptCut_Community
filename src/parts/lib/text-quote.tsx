import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { accentOf, easeExpoOut } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * 金句引言:多行金句伴随左侧主色竖线逐行揭示。从 quote-lockup 拆出。
 * 不含署名，署名单独作为 text-author 部件。
 */
interface Params {
  quote: string;
  size: number;
  accent: string;
}

function QuotePart({ params, width, height }: PartProps<Params>) {
  const size = fitOr(params.size, { width: width - 48 - 28, height, text: params.quote, splitter: "|", lineHeight: 1.25 + 16 / 64, max: 200 });
  const lines = params.quote.split("|").filter(Boolean);
  const accent = accentOf(params);
  const staggerMs = 180;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        padding: "0 24px",
        boxSizing: "border-box",
      }}
    >
      <div className="flex gap-6 items-stretch">
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
              className="font-bold leading-tight text-white"
              style={{ fontSize: size }}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: (i * staggerMs) / 1000, duration: 0.6, ease: easeExpoOut }}
            >
              {line}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const textQuote: PartDef<Params> = {
  id: "text-quote",
  name: "金句定格",
  description: "逐行揭示的多行金句引言",
  useWhen: "口播里出现引号包起来的原话、名人名言时使用，带左侧主色标线逐行滑入；搭配 text-author 使用以展示署名；极短口号用 text-pill，强调句用 text-blur。",
  tags: ["金句", "引言", "引号", "定格", "名言"],
  role: "list",
  from: "quote-lockup",
  defaults: {
    quote: "设计不只是|它的外观和感觉。|设计是怎么工作的。",
    size: 0,
    accent: "",
  },
  controls: [
    { key: "quote", label: "金句(用|分行)", type: "text", required: true },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 200, step: 2, hint: "0 表示按部件的框自动算;想固定就填具体像素" },
    { key: "accent", label: "竖线颜色(留空用主题色)", type: "color" },
  ],
  defaultFrame: { x: 200, y: 340, w: 1000, h: 360 },
  settleMs: (p) => (Math.max(1, p.quote.split("|").filter(Boolean).length) - 1) * 180 + 600,
  after: "hold",
  Component: QuotePart,
};
