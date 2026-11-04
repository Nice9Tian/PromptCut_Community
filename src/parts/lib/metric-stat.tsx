import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useRef } from "react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * Stat proof.
 * Text part extracted from stat-proof, containing giant rolling numbers and Chinese/English footnotes.
 * Entrance: lead-in text fades in and shifts down, numbers roll, footnotes fade in shortly after.
 */
interface Params {
  kicker: string;
  kickerZh: string;
  value: number;
  prefix: string;
  suffix: string;
  footEn: string;
  footZh: string;
  countMs: number;
  accent: string;
  size: number;
}

function MetricStatPart({ params, width, height }: PartProps<Params>) {
  const v = useMotionValue(0);
  const numRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const durationSec = params.countMs > 0 ? params.countMs / 1000 : 1.4;
    const controls = animate(v, params.value, {
      duration: durationSec,
      ease: easeExpoOut,
    });
    const unsub = v.on("change", (latest: number) => {
      if (numRef.current) numRef.current.textContent = String(Math.round(latest));
    });
    return () => {
      controls.stop();
      unsub();
    };
  }, [params.value, v, params.countMs]);

  const size = fitOr(params.size, { width: width - 96, height: height - 80, text: (params.prefix || "") + String(params.value) + (params.suffix || ""), lines: 1.5, max: 400 });

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center", alignItems: "center", width, height }}>
      <div className="hud-glass flex flex-col items-center justify-center gap-2 px-12 py-10 w-full h-full">
        <motion.div
          className="flex flex-col items-center gap-1 opacity-80"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: easeExpoOut }}
        >
          <div className="tracking-[0.2em] font-mono uppercase font-bold" style={{ fontSize: size * 0.125 }}>{params.kicker}</div>
          <div className="tracking-widest" style={{ fontSize: size * 0.1125 }}>{params.kickerZh}</div>
        </motion.div>

        <div className="flex items-baseline my-4">
          {params.prefix && <span className="font-bold mr-2 opacity-90" style={{ fontSize: size * 0.375 }}>{params.prefix}</span>}
          <span
            className="font-bold leading-none"
            style={{ color: accentOf(params), fontVariantNumeric: "tabular-nums", fontSize: size }}
          >
            <span ref={numRef}>0</span>
          </span>
          {params.suffix && <span className="font-bold ml-2 opacity-90" style={{ fontSize: size * 0.375 }}>{params.suffix}</span>}
        </div>

        <motion.div
          className="flex flex-col items-center gap-1 opacity-60"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.4, ease: easeExpoOut }}
        >
          <div className="tracking-widest uppercase" style={{ fontSize: size * 0.0875 }}>{params.footEn}</div>
          <div style={{ fontSize: size * 0.1 }}>{params.footZh}</div>
        </motion.div>
      </div>
    </div>
  );
}

export const metricStat: PartDef<Params> = {
  id: "metric-stat",
  name: "Stat proof",
  description: "Giant number roll-up with bilingual footnotes",
  useWhen: "Use for a key number that serves as evidence (+80%, 3x, 20,000), with prefix and suffix, Chinese and English lead-in words and Chinese and English source footnotes; values are shown rounded. For a large integer with a mechanical odometer feel use metric-odometer, and for a percentage progress ring use metric-ring.",
  tags: ["number","evidence","data","footnote"],
  role: "text",
  from: "stat-proof",
  defaults: {
    kicker: "PERFORMANCE",
    kickerZh: "性能表现",
    value: 99,
    prefix: "+",
    suffix: "%",
    footEn: "DATA SOURCED FROM INTERNAL TESTING",
    footZh: "数据来自内部测试",
    countMs: 1200,
    accent: "",
    size: 0,
  },
  controls: [
    { key: "kicker", label: "English lead-in text", type: "text" },
    { key: "kickerZh", label: "Chinese lead-in text", type: "text" },
    { key: "value", label: "Target value", type: "number" },
    { key: "prefix", label: "Prefix", type: "text" },
    { key: "suffix", label: "Suffix", type: "text" },
    { key: "footEn", label: "English footnote", type: "text" },
    { key: "footZh", label: "Chinese footnote", type: "text" },
    { key: "countMs", label: "Animation duration (ms)", type: "number", min: 100, max: 1800, step: 100 },
    { key: "accent", label: "Theme color", type: "color" },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 400, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
  ],
  defaultFrame: { x: 960, y: 540, w: 600, h: 460, anchor: [0.5, 0.5] },
  settleMs: (p: Params) => (p.countMs > 0 ? p.countMs : 1400),
  after: "hold",
  Component: MetricStatPart,
};
