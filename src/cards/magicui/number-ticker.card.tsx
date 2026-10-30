import type { CardDef, CardProps } from "../../kernel/types";
import { NumberTicker } from "./vendor/number-ticker";
import { accentOf } from "../native/hud";

interface Params {
  value: number;
  label: string;
  unit: string;
  accent: string;
}

function NumberTickerCard({ params }: CardProps<Params>) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-transparent" style={{ fontFamily: "var(--pc-font, system-ui, sans-serif)" }}>
      <div className="flex items-baseline gap-4" style={{ color: accentOf(params) }}>
        <NumberTicker
          value={params.value}
          className="font-bold leading-none"
          style={{ fontSize: 200, fontFamily: "var(--pc-font-mono, ui-monospace, monospace)", textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))" }}
          startImmediately={true}
        />
        <span className="font-bold" style={{ fontSize: 60, textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))" }}>{params.unit}</span>
      </div>
      <p className="mt-8" style={{ fontSize: 60, color: "var(--pc-fg, #f3f4f6)", textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))" }}>{params.label}</p>
    </div>
  );
}

export const numberTickerCard: CardDef<Params> = {
  id: "mu-number-ticker",
  name: "数字滚动",
  description: "数字从0滚动到目标值",
  useWhen: "全屏居中的单个大数字弹簧滚动,自带单位和一行说明,数字带千位逗号(12,480)。要机械翻牌滚轮手感用 odometer;要中英引导字加数据来源注脚的实证版式用 stat-proof。",
  tags: ["数字","滚动"],
  source: "magicui",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: { value: 100, label: "已完成目标", unit: "%", accent: "" },
  controls: [
    { key: "value", label: "目标值", type: "number" },
    { key: "label", label: "说明文字", type: "text" },
    { key: "unit", label: "单位", type: "text" },
    { key: "accent", label: "主色(留空用主题色)", type: "color" },
  ],
  parts: [
    { id: "number", label: "数值", role: "text", params: ["value", "unit", "accent"], enterMs: 0, settleMs: 1600 },
    { id: "label", label: "说明", role: "text", params: ["label"], enterMs: 0, settleMs: 0 },
  ],
  lifecycle: { settleMs: 1600, after: "hold", exit: ["fade"] },
  Component: NumberTickerCard,
};
