import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { accentOf, easeExpoOut } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * 模糊浮现文字:逐块模糊浮现的文字，支持用星号高亮重点词。从 blur-text 卡片拆出。
 * 词块按 staggerMs 依次进场，落定耗时由词块数和间隔决定。
 */
interface Params {
  text: string;
  size: number;
  staggerMs: number;
  accent: string;
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

function BlurTextPart({ params, width, height }: PartProps<Params>) {
  const size = fitOr(params.size, { width: width - 96, height: height - 96, text: params.text.replace(/[|*]/g, ""), max: 200 });
  const chunks = params.text.split("|");
  return (
    <div
      className="hud-glass"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
      }}
    >
      <div className="font-bold leading-tight flex flex-wrap gap-x-4 justify-center" style={{ fontSize: size }}>
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
  );
}

export const textBlur: PartDef<Params> = {
  id: "text-blur",
  name: "模糊浮现",
  description: "文字按词块逐个从虚焦中模糊浮现，重点词可用主色高亮",
  useWhen: "口播强调核心观点、结论或金句时使用，必须用「|」切分词块，用「*星号*」包裹高亮词；词块极短（单个短语）用 text-pill，带作者署名的名言用 text-quote。",
  tags: ["文字", "模糊", "浮现", "强调", "重点"],
  role: "list",
  from: "blur-text",
  defaults: {
    text: "走心的句子|从虚焦里|*慢慢浮现*",
    size: 0,
    staggerMs: 220,
    accent: "",
  },
  controls: [
    { key: "text", label: "文字", type: "text", required: true },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 200, step: 2, hint: "0 表示按部件的框自动算;想固定就填具体像素" },
    { key: "staggerMs", label: "字间距(ms)", type: "number", min: 0, max: 2000, step: 20 },
    { key: "accent", label: "主色(留空用主题色)", type: "color" },
  ],
  defaultFrame: { x: 260, y: 400, w: 1400, h: 280 },
  settleMs: (p) => (Math.max(1, p.text.split("|").length) - 1) * p.staggerMs + 800,
  after: "hold",
  Component: BlurTextPart,
};
