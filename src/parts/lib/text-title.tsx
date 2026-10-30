import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { accentOf, easeExpoOut } from "../../cards/native/hud";
import { fitOr } from "../fit";

/**
 * 标题:一行大字,可选一行小字眼(kicker)在上面。从 pin-board 的「小标题 + 副标题」拆出来。
 * 进场:小字眼先淡入上浮,标题延后 100ms。
 */
interface Params {
  kicker: string;
  text: string;
  size: number;
  accent: string;
  align: string;
}

function TitlePart({ params, width, height }: PartProps<Params>) {
  // size 0 = 按框算:标题占大头,小字眼按标题的 0.55 倍;两行一起装进框
  const size = fitOr(params.size, { width: width - 48, height, text: params.text, lines: params.kicker ? 1.55 : 1, max: 240 });
  const align = params.align === "center" ? "center" : params.align === "right" ? "flex-end" : "flex-start";
  const textAlign = params.align === "center" ? "center" : params.align === "right" ? "right" : "left";
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: align, gap: 8, padding: "0 24px", maxWidth: width }}>
      {params.kicker && (
        <motion.div
          style={{ fontSize: Math.max(14, size * 0.55), letterSpacing: "0.12em", textTransform: "uppercase", color: "#fff", opacity: 0.85, fontWeight: 300, textAlign }}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 0.85, y: 0 }}
          transition={{ duration: 0.6, ease: easeExpoOut }}
        >
          {params.kicker}
        </motion.div>
      )}
      <motion.div
        style={{ fontSize: size, fontWeight: 700, lineHeight: 1.15, color: accentOf(params), textAlign, textShadow: "0 2px 12px rgba(0,0,0,0.35)" }}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: params.kicker ? 0.1 : 0, duration: 0.6, ease: easeExpoOut }}
      >
        {params.text}
      </motion.div>
    </div>
  );
}

export const textTitle: PartDef<Params> = {
  id: "text-title",
  name: "标题",
  description: "一行大标题,上面可带一行小字眼;淡入上浮进场",
  useWhen: "组合里需要一个醒目的标题或段落名时用;正文、说明文字用 text-body,数字用 metric 类部件。",
  tags: ["标题", "文字", "小字眼"],
  role: "text",
  from: "pin-board",
  defaults: { kicker: "SUMMARY", text: "核心要点总结", size: 0, accent: "", align: "left" },
  controls: [
    { key: "kicker", label: "小字眼", type: "text", hint: "留空不显示" },
    { key: "text", label: "标题", type: "text", required: true },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 240, step: 2, hint: "0 表示按部件的框自动算字号,框缩放字随着变;想固定就填具体像素" },
    { key: "accent", label: "颜色(留空用主题色)", type: "color" },
    { key: "align", label: "对齐", type: "select", options: [{ value: "left", label: "左" }, { value: "center", label: "中" }, { value: "right", label: "右" }] },
  ],
  defaultFrame: { x: 120, y: 120, w: 900, h: 160 },
  settleMs: (p) => (p.kicker ? 700 : 600),
  after: "hold",
  Component: TitlePart,
};
