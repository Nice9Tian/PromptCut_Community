import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  steps: string;
  stepMs: number;
}

function StepTimelineCard({ params }: CardProps<Params>) {
  const steps = params.steps.split("|").filter(Boolean);
  const numSteps = steps.length;
  if (numSteps === 0) return null;

  const width = 1500;
  const lineDuration = (numSteps - 1) * (params.stepMs / 1000);

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass" style={{ width: width + 240, padding: "80px 120px" }}>
        <div className="relative h-48" style={{ width }}>
          <div className="absolute top-8 left-0 right-0 h-4 bg-current opacity-20 rounded" />
          <motion.div
            className="absolute top-8 left-0 right-0 h-4 origin-left rounded"
            style={{ backgroundColor: accentOf(params) }}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: lineDuration, ease: "linear" }}
          />

          {steps.map((step, i) => {
            const isLast = i === numSteps - 1;
            const nodeDelay = i * (params.stepMs / 1000);
            const left = numSteps > 1 ? i * (width / (numSteps - 1)) : width / 2;

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
                    className="w-20 h-20 rounded-full border-8 relative z-10 flex items-center justify-center"
                    initial={{ borderColor: "var(--pc-glass-border)", backgroundColor: "transparent", scale: 0.8 }}
                    animate={{ borderColor: accentOf(params), backgroundColor: accentOf(params), scale: 1 }}
                    transition={{ duration: 0.4, delay: nodeDelay, ease: easeExpoOut }}
                  >
                    <span className="text-3xl font-bold" style={{ color: "var(--pc-on-accent, #0b1220)" }}>{i + 1}</span>
                  </motion.div>
                </div>
                <motion.div
                  className="mt-8 text-[56px] font-bold whitespace-nowrap text-center"
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
    </div>
  );
}

export const stepTimeline: CardDef<Params> = {
  id: "step-timeline",
  name: "步骤时间线",
  description: "横向时间线依次点亮",
  useWhen: "口播在讲有先后顺序的步骤或流程(「第一」「首先」「然后」「最后」「步骤」)时,用横向时间线依次点亮。底板固定横屏宽度,**最多 5 步、每步步名不超过 4 字**,超了会横向叠字。这是挂载即播的入场动画,不跟时间轴走,做不了贯穿全片的进度条(那个用 chapter-bar)。没有先后关系的并列要点用 checklist。",
  tags: ["步骤","流程","时间线","顺序"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    steps: "选题|脚本|拍摄|剪辑|发布",
    stepMs: 250,
  },
  controls: [
    ...hudControls,
    { key: "steps", label: "步骤(竖线分隔)", type: "text" },
    { key: "stepMs", label: "步进时间(ms)", type: "number" },
  ],
  parts: [
    { id: "steps", label: "步骤", role: "list", params: ["steps", "stepMs"], enterMs: 0, settleMs: 4 * 250 + 400 },
  ],
  lifecycle: { settleMs: 1400, after: "evolve", exit: ["fade"] },
  timing: (p) => {
    const steps = Math.max(1, p.steps.split("|").filter(Boolean).length);
    const settle = (steps - 1) * p.stepMs + 400;
    return { settleMs: settle, parts: { steps: { settleMs: settle } } };
  },
  Component: StepTimelineCard,
};
