import type { PartDef, PartProps } from "../../kernel/partTypes";
import { NumberTicker } from "../../cards/magicui/vendor/number-ticker";
import { accentOf } from "../../cards/native/hud";
import { fitOr } from "../fit";

/**
 * 数字滚动:从 mu-number-ticker 拆出。
 * 数字翻牌滚动动画，自带单位和底部说明。
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
  name: "数字滚动",
  description: "数字从0滚动到目标值",
  useWhen: "展示单个核心数据指标时使用，包含弹簧滚动的大数字、单位及下方说明文字，数字自带千分位逗号。",
  tags: ["数字", "滚动", "指标", "数据"],
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
    { key: "value", label: "目标值", type: "number" },
    { key: "label", label: "说明文字", type: "text" },
    { key: "unit", label: "单位", type: "text" },
    { key: "accent", label: "主色(留空用主题色)", type: "color" },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 400, step: 2, hint: "0 表示按部件的框自动算;想固定就填具体像素" },
  ],
  defaultFrame: { x: 460, y: 300, w: 1000, h: 480 },
  settleMs: () => 1600,
  after: "hold",
  Component: MetricTickerPart,
};
