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
  name: "环形进度",
  description: "环形进度条动画",
  useWhen: "全屏居中的大环形进度(环 + 中心百分比 + 下方说明文字),没有底板。要毛玻璃底板、或要摆在角落/底部而不是正中,用 ring-metric;要中英引导字和数据来源注脚用 stat-proof。",
  tags: ["百分比","环形","进度"],
  source: "magicui",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: { value: 75, label: "加载中", accent: "" },
  controls: [
    { key: "value", label: "目标值", type: "number" },
    { key: "label", label: "说明文字", type: "text" },
    { key: "accent", label: "主色(留空用主题色)", type: "color" },
  ],
  parts: [
    { id: "ring", label: "进度环", role: "media", params: ["value", "accent"], enterMs: 0, settleMs: 1200 },
    { id: "label", label: "说明", role: "text", params: ["label"], enterMs: 0, settleMs: 0 },
  ],
  lifecycle: { settleMs: 1200, after: "hold", exit: ["fade"] },
  Component: AnimatedCircularProgressBarCard,
};
