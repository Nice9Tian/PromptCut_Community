import type { PartDef, PartProps } from "../../kernel/partTypes";
import { NumberTicker } from "../../cards/magicui/vendor/number-ticker";
import { accentOf } from "../../cards/native/hud";
import { fitOr } from "../fit";

/**
 * Number ticker: extracted from mu-number-ticker.
 * Number rolling animation, with built-in units and bottom description.
 */
interface Params {
  value: number;
  label: string;
  unit: string;
  accent: string;
  size: number;
}

function MetricTickerPart({ params, width, height }: PartProps<Params>) {
  const text1 = String(params.value) + params.unit;
  const text2 = params.label || "";
  const longestText = text1.length > text2.length ? text1 : text2;
  const size = fitOr(params.size, { width, height, text: longestText, lines: 1.6, max: 400 });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        fontFamily: "var(--pc-font, system-ui, sans-serif)",
        width,
        height,
      }}
    >
      <div className="flex items-baseline gap-4" style={{ color: accentOf(params) }}>
        <NumberTicker
          value={params.value}
          className="font-bold leading-none"
          style={{
            fontSize: size,
            fontFamily: "var(--pc-font-mono, ui-monospace, monospace)",
            textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))",
          }}
          startImmediately={true}
        />
        <span
          className="font-bold"
          style={{
            fontSize: size * 0.3,
            textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))",
          }}
        >
          {params.unit}
        </span>
      </div>
      <p
        className="mt-8"
        style={{
          fontSize: size * 0.3,
          color: "var(--pc-fg, #f3f4f6)",
          textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))",
          margin: "32px 0 0 0",
        }}
      >
        {params.label}
      </p>
    </div>
  );
}

export const metricTicker: PartDef<Params> = {
  id: "metric-ticker",
  name: "Number ticker",
  description: "Number counts up from 0 to the target value",
  useWhen: "Use to show a single key data metric, including a large spring-rolling number, a unit and a caption below; the number comes with thousands-separator commas.",
  tags: ["number", "scroll", "metric", "data"],
  role: "text",
  from: "mu-number-ticker",
  defaults: {
    value: 100,
    label: "已完成目标",
    unit: "%",
    accent: "",
    size: 0,
  },
  controls: [
    { key: "value", label: "Target value", type: "number" },
    { key: "label", label: "Caption", type: "text" },
    { key: "unit", label: "Unit", type: "text" },
    { key: "accent", label: "Main color (leave empty to use theme color)", type: "color" },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 400, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
  ],
  defaultFrame: { x: 460, y: 300, w: 1000, h: 480 },
  settleMs: () => 1600,
  after: "hold",
  Component: MetricTickerPart,
};
