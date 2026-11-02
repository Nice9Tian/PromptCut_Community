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
  name: "Number ticker",
  description: "Number counts up from 0 to the target value",
  useWhen: "A single large full-screen centered number that scrolls with spring motion, with its own unit and a one-line caption, and thousands separators (12,480). For a mechanical flip-wheel feel use odometer; for the evidence-style layout with bilingual lead text and a data-source footnote use stat-proof.",
  tags: ["number","scroll"],
  source: "magicui",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: { value: 100, label: "已完成目标", unit: "%", accent: "" },
  controls: [
    { key: "value", label: "Target value", type: "number" },
    { key: "label", label: "Caption", type: "text" },
    { key: "unit", label: "Unit", type: "text" },
    { key: "accent", label: "Main color (leave empty to use theme color)", type: "color" },
  ],
  parts: [
    { id: "number", label: "Value", role: "text", params: ["value", "unit", "accent"], enterMs: 0, settleMs: 1600 },
    { id: "label", label: "notes", role: "text", params: ["label"], enterMs: 0, settleMs: 0 },
  ],
  lifecycle: { settleMs: 1600, after: "hold", exit: ["fade"] },
  Component: NumberTickerCard,
};
