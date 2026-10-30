import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { accentOf, easeExpoOut } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * 排版流文字:草稿感多行文字自动重排定型。从 type-shift 拆出。
 * 支持首行主标题、星号次重点、横线署名层级。
 */
interface Params {
  lines: string;
  size: number;
  shiftAtMs: number;
  accent: string;
}

function TypeShiftPart({ params, width, height }: PartProps<Params>) {
  const accent = accentOf(params);
  const rawLines = params.lines.split("|").filter(Boolean);
  const unitLines = rawLines.reduce((s, l, i) => s + (i === 0 ? 1 : l.startsWith("*") ? 2 / 3 : l.startsWith("—") ? 1 / 3 : 0.5), 0);
  const size = fitOr(params.size, { width: width - 48, height, text: params.lines, splitter: "|", lines: unitLines * 1.28, max: 200 });
  const shiftDelay = params.shiftAtMs / 1000;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "0 24px",
        boxSizing: "border-box",
      }}
    >
      <motion.div
        className="flex flex-col justify-center items-start"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
      >
        {rawLines.map((rawLine, i) => {
          const isHero = i === 0;
          const isSub = rawLine.startsWith("*");
          const isAuthor = rawLine.startsWith("—");

          let text = rawLine;
          if (isSub) text = text.slice(1).trim();
          else if (isAuthor) text = text.slice(1).trim();

          let targetSize = size * 0.5;
          let targetColor = "rgba(255, 255, 255, 0.8)";
          if (isHero) {
            targetSize = size;
            targetColor = accent;
          } else if (isSub) {
            targetSize = size * (2 / 3);
            targetColor = "rgba(255, 255, 255, 1)";
          } else if (isAuthor) {
            targetSize = size / 3;
            targetColor = "rgba(156, 163, 175, 1)";
          }

          const initialX = 40 + (i * 37) % 120;

          return (
            <motion.div
              key={i}
              className="font-bold leading-tight"
              initial={{
                x: initialX,
                fontSize: size * 0.5,
                color: "rgba(156, 163, 175, 1)",
                marginTop: "0px",
              }}
              animate={{
                x: 0,
                fontSize: targetSize,
                color: targetColor,
                marginTop: isAuthor ? "24px" : "8px",
              }}
              transition={{ delay: shiftDelay, duration: 0.4, ease: easeExpoOut }}
            >
              {isAuthor ? `— ${text}` : text}
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
}

export const textTypeshift: PartDef<Params> = {
  id: "text-typeshift",
  name: "排版流",
  description: "多行草稿感文字在指定延时后自动重排定型",
  useWhen: "段落转场、展现多层级内容重排的视觉冲击时使用；内容必须多行：首行为大字主标题、*开头为次重点、—开头为署名；单行或普通要点直接用 text-title 或 list-pins。",
  tags: ["排版", "转场", "标题", "重排", "草稿"],
  role: "list",
  from: "type-shift",
  defaults: {
    lines: "标题排版流|*次重信息|辅助说明文字|—署名信息",
    size: 0,
    shiftAtMs: 900,
    accent: "",
  },
  controls: [
    { key: "lines", label: "多行内容(|分行,*次重,—署名)", type: "text", required: true },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 200, step: 2, hint: "0 表示按部件的框自动算;想固定就填具体像素" },
    { key: "shiftAtMs", label: "重排时间(ms)", type: "number", min: 100, max: 2000, step: 100 },
    { key: "accent", label: "首行高亮色(留空用主题色)", type: "color" },
  ],
  defaultFrame: { x: 200, y: 280, w: 1000, h: 500 },
  settleMs: (p) => p.shiftAtMs + 400,
  after: "hold",
  Component: TypeShiftPart,
};
