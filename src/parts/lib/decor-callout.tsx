import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";
import { fitOr } from "../fit";

/**
 * UI callout.
 * Decorative part extracted from ui-callout. Contains a glowing circle and an extended label.
 * Entrance: circle scales up to appear, followed by leader line drawing out, and finally label slides in.
 */
interface Params {
  label: string;
  side: string;
  accent: string;
  size: number;
}

function DecorCalloutPart({ params, width, height }: PartProps<Params>) {
  const accent = accentOf(params);
  const isLeft = params.side === "left";

  const ringW = width;
  const ringH = height;
  const lineLength = 200;
  const lineDrop = 80;

  // Polyline points
  const startX = isLeft ? 0 : ringW;
  const startY = ringH / 2;
  const midX = isLeft ? -lineLength / 2 : ringW + lineLength / 2;
  const endX = isLeft ? -lineLength : ringW + lineLength;
  const endY = startY + lineDrop;

  const points = `${startX},${startY} ${midX},${startY} ${endX},${endY}`;
  const pathLen = lineLength + Math.abs(lineDrop);

  const size = fitOr(params.size, { width: Math.max(200, width), height: Math.max(48, height * 0.4), text: params.label, lines: 1, max: 80 });

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "visible" }}>
      <motion.div
        className="absolute inset-0"
        initial={{ opacity: 0, scale: 1.3 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: easeExpoOut }}
      >
        {/* Ring */}
        <div
          className="absolute inset-0 rounded-2xl"
          style={{ border: `3px solid ${accent}`, boxShadow: `0 0 20px ${accent}40` }}
        />

        {/* Leader Line */}
        <svg className="absolute inset-0 overflow-visible" style={{ width: "100%", height: "100%" }}>
          <motion.polyline
            points={points}
            fill="none"
            stroke={accent}
            strokeWidth="4"
            strokeLinejoin="round"
            strokeDasharray={pathLen}
            initial={{ strokeDashoffset: pathLen }}
            animate={{ strokeDashoffset: 0 }}
            transition={{ duration: 0.5, delay: 0.4, ease: "linear" }}
          />
        </svg>

        {/* Label */}
        <motion.div
          className="absolute px-8 py-3 bg-black text-white rounded-full font-bold whitespace-nowrap"
          style={{
            left: isLeft ? -lineLength - 10 : ringW + lineLength + 10,
            top: endY,
            fontSize: size,
          }}
          initial={{ opacity: 0, x: isLeft ? "-100%" : 0, y: "-50%" }}
          animate={{ opacity: 1, x: isLeft ? "-100%" : 0, y: "-50%" }}
          transition={{ duration: 0.4, delay: 0.9, ease: easeExpoOut }}
        >
          {params.label}
        </motion.div>
      </motion.div>
    </div>
  );
}

export const decorCallout: PartDef<Params> = {
  id: "decor-callout",
  name: "UI callout",
  description: "Circle a screen region and draw out a label",
  useWhen: "Use when the underlying layer is a screen recording and you want to circle an area of the interface and lead out a label. The circled area is the part's own box: just drag the box to the position and size you want to circle, then use side to choose whether the leader line goes left or right.",
  tags: ["interface","callout","circle","tutorial"],
  role: "decor",
  from: "ui-callout",
  defaults: {
    label: "核心功能入口",
    side: "right",
    accent: "",
    size: 0,
  },
  controls: [
    { key: "label", label: "Label text", type: "text" },
    {
      key: "side",
      label: "Leader line direction",
      type: "select",
      options: [
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
      ],
    },
    { key: "accent", label: "Theme color", type: "color" },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 120, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
  ],
  defaultFrame: { x: 960, y: 540, w: 240, h: 120, anchor: [0.5, 0.5] },
  settleMs: () => 1300,
  after: "hold",
  Component: DecorCalloutPart,
};
