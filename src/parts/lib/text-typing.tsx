import type { PartDef, PartProps } from "../../kernel/partTypes";
import { TypingAnimation } from "../../cards/magicui/vendor/typing-animation";
import { fitOr } from "../fit";

/**
 * Typewriter text: extracted from mu-typing.
 * Character-by-character typing animation effect.
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
  name: "Typewriter",
  description: "Single-line or multi-line text with a character-by-character typing animation",
  useWhen: "Use for ordinary text that needs a character-by-character typing effect; playback duration is strictly equal to the character count times the per-character duration (duration); for complex multi-level typography, text-typeshift is recommended.",
  tags: ["Typewriter", "character by character", "Text"],
  role: "text",
  from: "mu-typing",
  defaults: {
    text: "这是一段打字机测试文字",
    size: 0,
    duration: 120,
  },
  controls: [
    { key: "text", label: "Text", type: "text", required: true },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 240, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
    { key: "duration", label: "Milliseconds per character", type: "number", min: 10, max: 1000, step: 10 },
  ],
  defaultFrame: { x: 200, y: 440, w: 1520, h: 200 },
  settleMs: (p) => p.text.length * p.duration,
  after: "hold",
  Component: TypingPart,
};
