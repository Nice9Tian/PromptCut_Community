import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";
import { fitOr } from "../fit";

/**
 * Step timeline: a horizontally stretching timeline and sequentially illuminated step circles.
 * Extracted from step-timeline, without shell glass board.
 * Entrance: while lines expand, circles light up in sequence, and the last circle has a looping
 * breathing animation.
 */
interface Params {
  steps: string;
  stepMs: number;
  accent: string;
  size: number;
}

function ListStepsPart({ params, width, height }: PartProps<Params>) {
  const steps = params.steps.split("|").filter(Boolean);
  const numSteps = steps.length;
  if (numSteps === 0) return null;

  const lineDuration = (numSteps - 1) * (params.stepMs / 1000);
  const padding = 120;
  const innerWidth = width - padding * 2;

  const size = fitOr(params.size, { width: (innerWidth / Math.max(1, numSteps)) * 0.5, height, text: params.steps, splitter: "|", lines: 1, max: 120 });
  const circleSize = size * 1.43;

  return (
    <div style={{ position: "absolute", inset: 0, width, height, display: "flex", alignItems: "center" }}>
      <div className="relative w-full h-48">
        <div className="absolute top-8 h-4 bg-current opacity-20 rounded" style={{ left: padding, width: innerWidth }} />
        <motion.div
          className="absolute top-8 h-4 origin-left rounded"
          style={{ left: padding, width: innerWidth, backgroundColor: accentOf(params) }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: lineDuration, ease: "linear" }}
        />

        {steps.map((step, i) => {
          const isLast = i === numSteps - 1;
          const nodeDelay = i * (params.stepMs / 1000);
          const left = padding + (numSteps > 1 ? i * (innerWidth / (numSteps - 1)) : innerWidth / 2);

          return (
            <div
              key={i}
              className="absolute flex flex-col items-center"
              style={{ left, transform: "translateX(-50%)", top: "-12px" }}
            >
              <div className="relative">
                {isLast && (
                  <motion.div
                    className="absolute inset-0"
                    style={{ borderRadius: "50%", backgroundColor: accentOf(params) }}
                    initial={{ scale: 1, opacity: 0 }}
                    animate={{ scale: [1, 2.5], opacity: [0.5, 0] }}
                    transition={{ duration: 1.5, repeat: Infinity, delay: nodeDelay + 0.3 }}
                  />
                )}
                <motion.div
                  className="rounded-full border-8 relative z-10 flex items-center justify-center"
                  style={{ width: circleSize, height: circleSize }}
                  initial={{ borderColor: "var(--pc-glass-border)", backgroundColor: "transparent", scale: 0.8 }}
                  animate={{ borderColor: accentOf(params), backgroundColor: accentOf(params), scale: 1 }}
                  transition={{ duration: 0.4, delay: nodeDelay, ease: easeExpoOut }}
                >
                  <span className="font-bold" style={{ color: "var(--pc-on-accent, #0b1220)", fontSize: size * 0.54 }}>{i + 1}</span>
                </motion.div>
              </div>
              <motion.div
                className="mt-8 font-bold whitespace-nowrap text-center"
                style={{ fontSize: size }}
                initial={{ opacity: 0.4 }}
                animate={{ opacity: 1, color: accentOf(params) }}
                transition={{ duration: 0.4, delay: nodeDelay }}
              >
                {step}
              </motion.div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const listSteps: PartDef<Params> = {
  id: "list-steps",
  name: "Step timeline",
  description: "Horizontal timeline that lights up step by step",
  useWhen: "Use for steps or processes with a sequence. At most 5 steps, and each step name at most 4 characters, otherwise text overlaps. This is an entrance animation that plays on mount and does not follow the timeline; use list-chapters for chapter progress across the whole video, and list-pins for parallel key points with no order.",
  tags: ["steps", "process", "timeline", "sequence"],
  role: "list",
  from: "step-timeline",
  defaults: {
    steps: "选题|脚本|拍摄|剪辑|发布",
    stepMs: 250,
    accent: "",
    size: 0,
  },
  controls: [
    { key: "steps", label: "Steps (separated by |)", type: "text" },
    { key: "stepMs", label: "Step interval (ms)", type: "number", min: 100, max: 2000, step: 50 },
    { key: "accent", label: "Color", type: "color" },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 120, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
  ],
  defaultFrame: { x: 960, y: 540, w: 1500, h: 300, anchor: [0.5, 0.5] },
  settleMs: (p) => (Math.max(1, p.steps.split("|").filter(Boolean).length) - 1) * p.stepMs + 400,
  after: "loop",
  Component: ListStepsPart,
};
