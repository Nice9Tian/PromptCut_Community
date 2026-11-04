import { motion, useMotionValue, animate } from "motion/react";
import { useEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  kicker: string;
  kickerZh: string;
  value: number;
  prefix: string;
  suffix: string;
  footEn: string;
  footZh: string;
  countMs: number;
}

function StatProofCard({ params }: CardProps<Params>) {
  const v = useMotionValue(0);
  // The number is written into the DOM synchronously, not through React state: during export React's
  // asynchronous commit races with the screenshot before each frame, and in testing 10~15% of frames
  // had the number stuck at the previous frame's value, so two exports differed. Writing synchronously
  // lands it in the same rAF as Motion's.
  // The approach follows magicui/vendor/number-ticker.tsx; the initial value is hardcoded in the JSX,
  // so the first frame after a remount is not blank for a moment.
  const numRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const durationSec = params.countMs > 0 ? params.countMs / 1000 : 1.4;
    const controls = animate(v, params.value, {
      duration: durationSec,
      ease: easeExpoOut,
    });
    const unsub = v.on("change", (latest) => {
      if (numRef.current) numRef.current.textContent = String(Math.round(latest));
    });
    return () => {
      controls.stop();
      unsub();
    };
  }, [params.value, v, params.countMs]);

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass flex flex-col items-center gap-2 px-12 py-10 min-w-[500px]">
        <motion.div
          className="flex flex-col items-center gap-1 opacity-80"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: easeExpoOut }}
        >
          <div className="text-xl tracking-[0.2em] font-mono uppercase font-bold">{params.kicker}</div>
          <div className="text-lg tracking-widest">{params.kickerZh}</div>
        </motion.div>

        <div className="flex items-baseline my-4">
          {params.prefix && <span className="text-6xl font-bold mr-2 opacity-90">{params.prefix}</span>}
          <span
            className="text-[160px] font-bold leading-none"
            style={{ color: accentOf(params), fontVariantNumeric: "tabular-nums" }}
          >
            <span ref={numRef}>0</span>
          </span>
          {params.suffix && <span className="text-6xl font-bold ml-2 opacity-90">{params.suffix}</span>}
        </div>

        <motion.div
          className="flex flex-col items-center gap-1 opacity-60"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.4, ease: easeExpoOut }}
        >
          <div className="text-sm tracking-widest uppercase">{params.footEn}</div>
          <div className="text-base">{params.footZh}</div>
        </motion.div>
      </div>
    </div>
  );
}

export const statProof: CardDef<Params> = {
  id: "stat-proof",
  name: "Stat proof",
  description: "Giant number roll-up with bilingual footnotes",
  useWhen: "When the narration cites a key number as evidence (+80%, 3x, 20,000), use a giant number with prefix/suffix, bilingual lead-in text and a bilingual data-source footnote for an evidence layout. Values are shown rounded. For large integer counts that only need a mechanical flip-wheel feel, use odometer.",
  tags: ["number","evidence","data","footnote"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    kicker: "PERFORMANCE",
    kickerZh: "性能表现",
    value: 99,
    prefix: "+",
    suffix: "%",
    footEn: "DATA SOURCED FROM INTERNAL TESTING",
    footZh: "数据来自内部测试",
    countMs: 1200,
  },
  controls: [
    ...hudControls,
    { key: "kicker", label: "English lead-in text", type: "text" },
    { key: "kickerZh", label: "Chinese lead-in text", type: "text" },
    { key: "value", label: "Target value", type: "number" },
    { key: "prefix", label: "Prefix", type: "text" },
    { key: "suffix", label: "Suffix", type: "text" },
    { key: "footEn", label: "English footnote", type: "text" },
    { key: "footZh", label: "Chinese footnote", type: "text" },
    { key: "countMs", label: "Animation duration (ms)", type: "number", min: 100, max: 1800, step: 100 },
  ],
  parts: [
    { id: "title", label: "Lead-in text", role: "group", params: ["kicker", "kickerZh"], enterMs: 0, settleMs: 600 },
    { id: "value", label: "Value", role: "text", params: ["value", "prefix", "suffix", "countMs"], enterMs: 0, settleMs: 1200 },
    { id: "foot", label: "footnote", role: "group", params: ["footEn", "footZh"], enterMs: 400, settleMs: 1200 },
  ],
  lifecycle: { settleMs: 1200, after: "hold", exit: ["fade"] },
  Component: StatProofCard,
};
