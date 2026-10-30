import type { PartDef, PartProps } from "../../kernel/partTypes";
import { TypingAnimation } from "../../cards/magicui/vendor/typing-animation";
import { fitOr } from "../fit";

/**
 * 打字机文字:从 mu-typing 拆出。
 * 逐字打印的动画效果。
 */
interface Params {
  text: string;
  size: number;
  duration: number;
}

function TypingPart({ params, width, height }: PartProps<Params>) {
  const size = fitOr(params.size, { width: width - 64, height, text: params.text, lineHeight: 1.2, max: 240 });
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        padding: "0 32px",
        fontFamily: "var(--pc-font, system-ui, sans-serif)",
      }}
    >
      <TypingAnimation
        text={params.text}
        duration={params.duration}
        className="font-bold"
        style={{
          fontSize: size,
          lineHeight: "1.2",
          color: "var(--pc-fg, #f3f4f6)",
          textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))",
        }}
      />
    </div>
  );
}

export const textTyping: PartDef<Params> = {
  id: "text-typing",
  name: "打字机",
  description: "逐字打印动画的单行或多行文字",
  useWhen: "需要逐字打印效果的普通文字时使用，播放时长严格等于字数乘以每字时长(duration)；如果是复杂多级排版建议用 text-typeshift。",
  tags: ["打字机", "逐字", "文字"],
  role: "text",
  from: "mu-typing",
  defaults: {
    text: "这是一段打字机测试文字",
    size: 0,
    duration: 120,
  },
  controls: [
    { key: "text", label: "文本", type: "text", required: true },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 240, step: 2, hint: "0 表示按部件的框自动算;想固定就填具体像素" },
    { key: "duration", label: "每字毫秒", type: "number", min: 10, max: 1000, step: 10 },
  ],
  defaultFrame: { x: 200, y: 440, w: 1520, h: 200 },
  settleMs: (p) => p.text.length * p.duration,
  after: "hold",
  Component: TypingPart,
};
