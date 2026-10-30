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
  name: "翻牌计数器",
  description: "大数字翻牌效果",
  useWhen: "大整数累计量(播放量、用户数、粉丝数)做成机械滚轮翻牌主视觉,配小字 kicker 和一行说明。只支持非负整数,小数会被截断,也没有涨跌符号。要打出带正负号的涨跌幅(+80%、-30%)或需要中英注脚背书,用 stat-proof;百分比进度用 ring-metric。",
  tags: ["数字","增长","翻牌","变化"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
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
    { key: "value", label: "数值", type: "number" },
    { key: "unit", label: "单位", type: "text" },
    { key: "label", label: "说明", type: "text" },
    { key: "kicker", label: "小字", type: "text" },
  ],
  parts: [
    { id: "kicker", label: "小字", role: "text", params: ["kicker"], enterMs: 0, settleMs: 0 },
    { id: "value", label: "数值", role: "text", params: ["value", "unit"], enterMs: 0, settleMs: 1280 },
    { id: "label", label: "说明", role: "text", params: ["label"], enterMs: 0, settleMs: 0 },
  ],
  lifecycle: { settleMs: 1280, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const digits = String(Math.floor(Number(p.value) || 0)).length;
    const settle = 800 + (digits - 1) * 120;
    return { settleMs: settle, parts: { value: { settleMs: settle } } };
  },
  Component: OdometerCard,
};
