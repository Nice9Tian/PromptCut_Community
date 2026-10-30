import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  lines: string;
  shiftAtMs: number;
}

function TypeShiftCard({ params }: CardProps<Params>) {
  const accent = accentOf(params);
  const rawLines = params.lines.split("|").filter(Boolean);
  const shiftDelay = params.shiftAtMs / 1000;

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
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
          
          let targetSize = "48px";
          let targetColor = "rgba(255, 255, 255, 0.8)";
          if (isHero) {
            targetSize = "96px";
            targetColor = accent;
          } else if (isSub) {
            targetSize = "64px";
            targetColor = "rgba(255, 255, 255, 1)";
          } else if (isAuthor) {
            targetSize = "32px";
            targetColor = "rgba(156, 163, 175, 1)";
          }

          const initialX = 40 + (i * 37) % 120;
          
          return (
            <motion.div
              key={i}
              className="font-bold leading-tight"
              initial={{ 
                x: initialX, 
                fontSize: "48px", 
                color: "rgba(156, 163, 175, 1)", 
                marginTop: "0px"
              }}
              animate={{ 
                x: 0,
                fontSize: targetSize,
                color: targetColor,
                marginTop: isAuthor ? "24px" : "8px"
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

export const typeShift: CardDef<Params> = {
  id: "type-shift",
  name: "排版流",
  description: "草稿感自动重排版",
  useWhen: "做标题过渡、想要文字自动重排的草稿感时用。**内容必须多行且有层级**:首行是主标题、`*` 开头是次重点、`—` 开头是署名。单行标题体现不出重排效果。",
  tags: ["排版","转场","标题","重排"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    position: "center",
    lines: "标题排版流|*次重信息|辅助说明文字|—署名信息",
    shiftAtMs: 900,
  },
  controls: [
    ...hudControls,
    { key: "lines", label: "多行内容(|分行,*次重,—署名)", type: "text" },
    { key: "shiftAtMs", label: "重排时间(ms)", type: "number", min: 100, max: 2000, step: 100 },
  ],
  parts: [
    { id: "lines", label: "多行内容", role: "list", params: ["lines", "shiftAtMs"], enterMs: 0, settleMs: 1300 },
  ],
  lifecycle: { settleMs: 1300, after: "hold", exit: ["fade"] },
  Component: TypeShiftCard,
};
