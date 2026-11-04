import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  value: number;
  unit: string;
  label: string;
  kicker: string;
}

function OdometerWheel({ digit, index }: { digit: string; index: number }) {
  const d = parseInt(digit, 10);
  if (isNaN(d)) return <span className="inline-block">{digit}</span>;

  const numbers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const targetIndex = 10 + d;

  return (
    <span className="inline-flex relative overflow-hidden" style={{ height: "1em", verticalAlign: "bottom" }}>
      <span className="invisible leading-none">0</span>
      <motion.span
        className="absolute inset-x-0 top-0 flex flex-col"
        initial={{ y: "0em" }}
        animate={{ y: `-${targetIndex}em` }}
        transition={{ duration: 0.8 + index * 0.12, ease: easeExpoOut }}
      >
        {numbers.map((n, i) => (
          <span key={i} className="leading-none text-center h-[1em] block">
            {n}
          </span>
        ))}
      </motion.span>
    </span>
  );
}

function OdometerCard({ params }: CardProps<Params>) {
  const strValue = String(Math.floor(params.value));

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="hud-glass flex flex-col gap-2">
        <div className="text-3xl font-bold tracking-widest mb-2" style={{ color: accentOf(params) }}>
          {params.kicker}
        </div>
        <div className="flex items-baseline gap-4">
          <div className="text-[120px] font-bold flex" style={{ fontFamily: "var(--pc-font-mono, ui-monospace, monospace)" }}>
            {strValue.split("").map((c, i) => (
              <OdometerWheel key={i} digit={c} index={i} />
            ))}
          </div>
          {params.unit && <div className="text-5xl font-semibold opacity-80">{params.unit}</div>}
        </div>
        <div className="text-3xl mt-4 opacity-60">{params.label}</div>
      </div>
    </div>
  );
}

export const odometer: CardDef<Params> = {
  id: "odometer",
  name: "Flip counter",
  description: "Big-number flip effect",
  useWhen: "Large cumulative integer counts (views, users, followers) as a mechanical rolling-wheel hero visual, with a small kicker and a one-line caption. Only non-negative integers are supported, decimals are truncated, and there is no up/down sign. For signed changes (+80%, -30%) or Chinese/English footnote endorsements, use stat-proof; for percentage progress, use ring-metric.",
  tags: ["number","growth","flip","change"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    value: 12480,
    unit: "次",
    label: "过去 30 天累计播放",
    kicker: "DATA",
  },
  controls: [
    ...hudControls,
    { key: "value", label: "Value", type: "number" },
    { key: "unit", label: "Unit", type: "text" },
    { key: "label", label: "notes", type: "text" },
    { key: "kicker", label: "Small text", type: "text" },
  ],
  parts: [
    { id: "kicker", label: "Small text", role: "text", params: ["kicker"], enterMs: 0, settleMs: 0 },
    { id: "value", label: "Value", role: "text", params: ["value", "unit"], enterMs: 0, settleMs: 1280 },
    { id: "label", label: "notes", role: "text", params: ["label"], enterMs: 0, settleMs: 0 },
  ],
  lifecycle: { settleMs: 1280, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const digits = String(Math.floor(Number(p.value) || 0)).length;
    const settle = 800 + (digits - 1) * 120;
    return { settleMs: settle, parts: { value: { settleMs: settle } } };
  },
  Component: OdometerCard,
};
