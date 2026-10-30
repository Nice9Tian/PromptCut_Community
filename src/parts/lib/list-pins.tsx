import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { fitOr } from "../fit";

/**
 * 钉板要点:一列黑底圆角条,逐条「钉」上来(缩小弹入)。从 pin-board 的要点列表拆出来。
 * 每条的进场间隔由 stepMs 决定,所以落定时刻随条数变。
 */
interface Params {
  items: string;
  stepMs: number;
  size: number;
}

function PinsPart({ params, width, height }: PartProps<Params>) {
  const items = params.items.split("|").filter(Boolean);
  // size 0 = 按框算:每条一行,行高算上内边距(12px×2)和条间距(16px)
  const size = fitOr(params.size, { width: width - 32 - 56, height: height - 16 * Math.max(0, items.length - 1), text: params.items, splitter: "|", lineHeight: 1.25 + 24 / 36, max: 120 });
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start", justifyContent: "center", padding: "0 16px" }}>
      {items.map((item, i) => (
        <motion.div
          key={i}
          style={{ background: "#111", color: "#fff", padding: "12px 28px", borderRadius: 14, fontSize: size, fontWeight: 500, boxShadow: "0 12px 30px rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.1)" }}
          initial={{ opacity: 0, scale: 1.15, y: -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ delay: (i * params.stepMs) / 1000, type: "spring", stiffness: 400, damping: 20 }}
        >
          {item}
        </motion.div>
      ))}
    </div>
  );
}

export const listPins: PartDef<Params> = {
  id: "list-pins",
  name: "钉板要点",
  description: "一列黑底圆角条,逐条弹入钉上",
  useWhen: "3 到 5 条并列要点、总结、清单时用;有勾选感的用 list-check,带数值的用 metric 类。",
  tags: ["要点", "列表", "钉板"],
  role: "list",
  from: "pin-board",
  defaults: { items: "第一点核心优势|第二点不可替代|第三点极速交付", stepMs: 200, size: 0 },
  controls: [
    { key: "items", label: "要点(用|分隔)", type: "text", required: true },
    { key: "stepMs", label: "间隔(ms)", type: "number", min: 0, max: 2000, step: 20 },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 120, step: 2, hint: "0 表示按框和条数自动算字号;想固定就填具体像素" },
  ],
  defaultFrame: { x: 120, y: 320, w: 900, h: 420 },
  settleMs: (p) => (Math.max(1, p.items.split("|").filter(Boolean).length) - 1) * p.stepMs + 400,
  after: "hold",
  Component: PinsPart,
};
