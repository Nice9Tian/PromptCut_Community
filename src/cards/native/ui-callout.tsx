import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import { HudOffsetParams, hudOffsetControls, hudOffsetDefaults, getOffsetStyle } from "./hud";
import "./hud.css";

interface Params extends HudParams, HudOffsetParams {
  label: string;
  ringW: number;
  ringH: number;
  side: "left" | "right";
}

function UiCalloutCard({ params }: CardProps<Params>) {
  const accent = accentOf(params);
  const isLeft = params.side === "left";

  const ringW = params.ringW || 200;
  const ringH = params.ringH || 100;
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

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="relative" style={getOffsetStyle(params)}>
        <motion.div
          className="absolute"
          style={{ width: ringW, height: ringH, left: -ringW/2, top: -ringH/2 }}
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
          <svg className="absolute inset-0 overflow-visible" width={ringW} height={ringH}>
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
            className="absolute px-8 py-3 bg-black text-white rounded-full font-bold text-3xl whitespace-nowrap"
            style={{
              left: isLeft ? -lineLength - 10 : ringW + lineLength + 10,
              top: endY,
            }}
            initial={{ opacity: 0, x: isLeft ? "-100%" : 0, y: "-50%" }}
            animate={{ opacity: 1, x: isLeft ? "-100%" : 0, y: "-50%" }}
            transition={{ duration: 0.4, delay: 0.9, ease: easeExpoOut }}
          >
            {params.label}
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}

export const uiCallout: CardDef<Params> = {
  id: "ui-callout",
  name: "UI callout",
  description: "Circle a screen region and draw out a label",
  useWhen: "Use when the base layer is a screen recording and you need to circle a region of the interface and draw out a label. Positioning uses position (four anchors: center/bottom/left/right) plus offsetX/offsetY pixel offsets, **there is no absolute coordinate parameter**, and you must also give the ring width and height ringW/ringH and the leader line direction side. If the position can't be described clearly, don't pick this card; by default it circles the exact center of the frame.",
  tags: ["interface","callout","circle","tutorial"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    ...hudOffsetDefaults,
    label: "核心功能入口",
    ringW: 240,
    ringH: 120,
    side: "right",
  },
  controls: [
    ...hudControls,
    ...hudOffsetControls,
    { key: "label", label: "Label text", type: "text" },
    { key: "ringW", label: "Ring width (px)", type: "number" },
    { key: "ringH", label: "Ring height (px)", type: "number" },
    {
      key: "side",
      label: "Leader line direction",
      type: "select",
      options: [
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
      ],
    },
  ],
  parts: [
    { id: "ring", label: "Ring", role: "decor", params: ["ringW", "ringH", "offsetX", "offsetY"], enterMs: 0, settleMs: 600 },
    { id: "line", label: "Leader line", role: "decor", params: ["side"], enterMs: 400, settleMs: 900 },
    { id: "label", label: "Label", role: "text", params: ["label"], enterMs: 900, settleMs: 1300 },
  ],
  lifecycle: { settleMs: 1300, after: "hold", exit: ["fade"] },
  Component: UiCalloutCard,
};
