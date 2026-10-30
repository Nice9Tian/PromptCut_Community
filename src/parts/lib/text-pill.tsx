import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { accentOf } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * 金句药丸:强调核心信息的胶囊设计。从 punch-pill 拆出。
 * 发光扩散并弹簧弹入。
 */
interface Params {
  text: string;
  size: number;
  accent: string;
}

function PunchPillPart({ params, width, height }: PartProps<Params>) {
  const size = fitOr(params.size, { width: width - 96, height: height - 48, text: params.text, max: 200 });
  const accent = accentOf(params);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
      }}
    >
      <div className="relative">
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: accent, filter: "blur(32px)" }}
          initial={{ opacity: 0.8, scale: 0.8 }}
          animate={{ opacity: 0, scale: 1.5 }}
          transition={{ duration: 1.2, ease: "easeOut" }}
        />
        <motion.div
          className="relative px-12 py-6 rounded-full flex items-center justify-center text-white font-bold whitespace-nowrap"
          style={{ backgroundColor: accent, fontSize: size }}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{
            type: "spring",
            stiffness: 300,
            damping: 15,
            mass: 0.8,
          }}
        >
          {params.text}
        </motion.div>
      </div>
    </div>
  );
}

export const textPill: PartDef<Params> = {
  id: "text-pill",
  name: "金句药丸",
  description: "强调核心信息的发光胶囊",
  useWhen: "极短的重点词、核心卖点、标签或口号（2 到 8 字）需要强烈视觉冲击时使用；长句子用 text-blur，引言名言用 text-quote。",
  tags: ["金句", "标语", "短句", "感叹", "药丸"],
  role: "text",
  from: "punch-pill",
  defaults: {
    text: "核心卖点",
    size: 0,
    accent: "",
  },
  controls: [
    { key: "text", label: "短句", type: "text", required: true },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 200, step: 2, hint: "0 表示按部件的框自动算;想固定就填具体像素" },
    { key: "accent", label: "主色(留空用主题色)", type: "color" },
  ],
  defaultFrame: { x: 660, y: 460, w: 600, h: 160 },
  settleMs: () => 1200,
  after: "hold",
  Component: PunchPillPart,
};
