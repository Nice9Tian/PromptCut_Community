import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { accentOf, easeExpoOut } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * 逐条打勾的清单:从 checklist 卡片拆出。
 * 每条带圆圈和打勾动画，行间隔决定进场和打勾时机。
 */
interface Params {
  items: string;
  size: number;
  stepMs: number;
  accent: string;
}

function CheckItem({ text, i, stepMs, accent, size }: { text: string; i: number; stepMs: number; accent: string; size: number }) {
  const rowDelay = i * (stepMs / 1000);
  const tickDelay = rowDelay + 0.15;

  return (
    <motion.div
      className="flex items-center gap-6"
      initial={{ opacity: 0, x: -40 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.6, delay: rowDelay, ease: easeExpoOut }}
    >
      <div className="relative w-20 h-20 flex items-center justify-center flex-shrink-0">
        <div className="absolute inset-0 rounded-full border-4 border-current opacity-30" />
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: accent }}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.4, delay: tickDelay, ease: easeExpoOut }}
        />
        <svg
          viewBox="0 0 24 24"
          className="w-12 h-12 relative z-10"
          style={{ color: "var(--pc-on-accent, #0b1220)" }}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <motion.path
            d="M5 13l4 4L19 7"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.4, delay: tickDelay + 0.1, ease: easeExpoOut }}
          />
        </svg>
      </div>
      <div className="font-bold text-white" style={{ fontSize: size }}>{text}</div>
    </motion.div>
  );
}

function ChecklistPart({ params, width, height }: PartProps<Params>) {
  const size = fitOr(params.size, { width: width - 96 - 80 - 24, height: height - 96, text: params.items, splitter: "|", lineHeight: 1.25 + 32 / 72, max: 160 });
  const items = params.items.split("|").filter(Boolean);
  return (
    <div
      className="hud-glass"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 32,
        boxSizing: "border-box",
      }}
    >
      {items.map((item, i) => (
        <CheckItem key={i} text={item} i={i} stepMs={params.stepMs} accent={accentOf(params)} size={size} />
      ))}
    </div>
  );
}

export const listCheck: PartDef<Params> = {
  id: "list-check",
  name: "清单打勾",
  description: "逐条划入并打勾的清单项",
  useWhen: "口播在罗列并列要点、事项清单或检查清单时使用，每项带圆圈打勾动效；条目之间若无打勾仪式感、仅需简洁条形展示时用 list-pins。",
  tags: ["清单", "打勾", "列表", "要点", "罗列"],
  role: "list",
  from: "checklist",
  defaults: {
    items: "选题定方向|脚本写钩子|镜头列清单|剪辑控节奏",
    size: 0,
    stepMs: 260,
    accent: "",
  },
  controls: [
    { key: "items", label: "条目(竖线分隔)", type: "text", required: true },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 160, step: 2, hint: "0 表示按部件的框自动算;想固定就填具体像素" },
    { key: "stepMs", label: "行间隔(ms)", type: "number", min: 0, max: 2000, step: 20 },
    { key: "accent", label: "主色(留空用主题色)", type: "color" },
  ],
  defaultFrame: { x: 460, y: 220, w: 1000, h: 640 },
  settleMs: (p) => (Math.max(1, p.items.split("|").filter(Boolean).length) - 1) * p.stepMs + 650,
  after: "hold",
  Component: ChecklistPart,
};
