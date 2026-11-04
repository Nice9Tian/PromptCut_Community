import { useEffect, useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { AnimatedCircularProgressBar } from "./vendor/animated-circular-progress-bar";
import { accentOf } from "../native/hud";

interface Params {
  value: number;
  label: string;
  accent: string;
}

function AnimatedCircularProgressBarCard({ params }: CardProps<Params>) {
  const [currentValue, setCurrentValue] = useState(0);

  useEffect(() => {
    let rAF: number;
    const startTime = performance.now();
    const duration = 1200;

    const tick = (now: number) => {
      const elapsed = Math.max(0, now - startTime);
      let p = Math.min(1, elapsed / duration);
      // easeOut cubic
      p = 1 - Math.pow(1 - p, 3);
      setCurrentValue(params.value * p);

      if (p < 1) {
        rAF = requestAnimationFrame(tick);
      } else {
        setCurrentValue(params.value);
      }
    };
    rAF = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rAF);
  }, [params.value]);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-transparent" style={{ fontFamily: "var(--pc-font, system-ui, sans-serif)" }}>
      <AnimatedCircularProgressBar
        max={100}
        min={0}
        value={currentValue}
        gaugePrimaryColor={accentOf(params)}
        gaugeSecondaryColor="var(--pc-fg-faint, rgba(255,255,255,0.3))"
        className=""
        style={{ width: 420, height: 420, fontSize: 96, color: "var(--pc-fg, #f3f4f6)", textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))" }}
      />
      <p className="mt-16 text-6xl font-bold" style={{ color: "var(--pc-fg, #f3f4f6)", textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))" }}>
        {params.label}
      </p>
    </div>
  );
}

export const animatedCircularProgressBarCard: CardDef<Params> = {
  id: "mu-circular-progress",
  name: "Circular progress",
  description: "Circular progress bar animation",
  useWhen: "A large full-screen centered circular progress (ring + center percentage + caption below), with no backing plate. For a frosted-glass plate, or to place it in a corner/at the bottom instead of the center, use ring-metric; for bilingual lead-in text and a data-source footnote, use stat-proof.",
  tags: ["percentage","circular","progress"],
  source: "magicui",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: { value: 75, label: "加载中", accent: "" },
  controls: [
    { key: "value", label: "Target value", type: "number" },
    { key: "label", label: "Caption", type: "text" },
    { key: "accent", label: "Main color (leave empty to use theme color)", type: "color" },
  ],
  parts: [
    { id: "ring", label: "Progress ring", role: "media", params: ["value", "accent"], enterMs: 0, settleMs: 1200 },
    { id: "label", label: "notes", role: "text", params: ["label"], enterMs: 0, settleMs: 0 },
  ],
  lifecycle: { settleMs: 1200, after: "hold", exit: ["fade"] },
  Component: AnimatedCircularProgressBarCard,
};
