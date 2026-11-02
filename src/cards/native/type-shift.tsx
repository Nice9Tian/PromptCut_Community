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
  name: "Typography flow",
  description: "Draft-style automatic re-typesetting",
  useWhen: "Use for title transitions when you want a draft-like feel of text re-flowing automatically. **Content must be multi-line with hierarchy**: the first line is the main title, a line starting with `*` is a secondary point, a line starting with `—` is a credit. A single-line title won't show the re-flow effect.",
  tags: ["typography","Transition","Title","re-flow"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    position: "center",
    lines: "标题排版流|*次重信息|辅助说明文字|—署名信息",
    shiftAtMs: 900,
  },
  controls: [
    ...hudControls,
    { key: "lines", label: "Multi-line content (| splits lines, * secondary, — credit)", type: "text" },
    { key: "shiftAtMs", label: "Reflow time (ms)", type: "number", min: 100, max: 2000, step: 100 },
  ],
  parts: [
    { id: "lines", label: "Multi-line content", role: "list", params: ["lines", "shiftAtMs"], enterMs: 0, settleMs: 1300 },
  ],
  lifecycle: { settleMs: 1300, after: "hold", exit: ["fade"] },
  Component: TypeShiftCard,
};
