import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { accentOf, easeExpoOut } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * Type-shift text: draft-feel multi-line text that automatically reflows and settles. Extracted
 * from type-shift.
 * Supports first-line main title, asterisk sub-emphasis, and dash attribution hierarchy.
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
  name: "Typography flow",
  description: "Multi-line draft-style text that automatically reflows and settles after a given delay",
  useWhen: "Use for section transitions and for the visual impact of multi-level content reflowing; the content must be multi-line: the first line is the large main title, lines starting with * are secondary highlights, lines starting with — are attributions; for a single line or ordinary bullet points, use text-title or list-pins directly.",
  tags: ["typography", "Transition", "Title", "re-flow", "Draft"],
  role: "list",
  from: "type-shift",
  defaults: {
    lines: "标题排版流|*次重信息|辅助说明文字|—署名信息",
    size: 0,
    shiftAtMs: 900,
    accent: "",
  },
  controls: [
    { key: "lines", label: "Multi-line content (| splits lines, * secondary, — credit)", type: "text", required: true },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 200, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
    { key: "shiftAtMs", label: "Reflow time (ms)", type: "number", min: 100, max: 2000, step: 100 },
    { key: "accent", label: "First-line highlight color (leave empty to use theme color)", type: "color" },
  ],
  defaultFrame: { x: 200, y: 280, w: 1000, h: 500 },
  settleMs: (p) => p.shiftAtMs + 400,
  after: "hold",
  Component: TypeShiftPart,
};
