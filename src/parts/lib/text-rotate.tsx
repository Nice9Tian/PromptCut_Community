import { useMemo } from "react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { WordRotate } from "../../cards/magicui/vendor/word-rotate";
import { fitOr } from "../fit";

/**
 * Word rotate: extracted from mu-word-rotate.
 * Prefix text plus infinitely rotating suffix words.
 */
interface Params {
  prefix: string;
  words: string;
  size: number;
  holdMs: number;
}

function RotatePart({ params, width, height }: PartProps<Params>) {
  const wordsToPass = useMemo(() => {
    const wordsArray = params.words.split("|").map(w => w.trim()).filter(Boolean);
    return wordsArray.length > 0 ? wordsArray : ["无数据"];
  }, [params.words]);

  const size = fitOr(params.size, { width, height, text: params.prefix + wordsToPass.reduce((a, b) => (b.length > a.length ? b : a), ""), max: 240 });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
        fontFamily: "var(--pc-font, system-ui, sans-serif)",
      }}
    >
      <div
        className="flex items-center gap-8 font-bold"
        style={{
          fontSize: size,
          color: "var(--pc-fg, #f3f4f6)",
          textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))",
        }}
      >
        <span>{params.prefix}</span>
        <WordRotate words={wordsToPass} duration={params.holdMs} className="" />
      </div>
    </div>
  );
}

export const textRotate: PartDef<Params> = {
  id: "text-rotate",
  name: "Word rotate",
  description: "Several words rotate in a loop",
  useWhen: "Use when a fixed prefix is followed by several words of the same level that keep rotating in a loop; suited to parallel phrasing; this part plays in an infinite loop.",
  tags: ["rotate", "parallel phrasing", "words", "Loop"],
  role: "text",
  from: "mu-word-rotate",
  defaults: {
    prefix: "你是",
    words: "优秀|卓越|完美|无瑕",
    size: 0,
    holdMs: 1000,
  },
  controls: [
    { key: "prefix", label: "Prefix", type: "text" },
    { key: "words", label: "Rotating words (separate with |)", type: "text", required: true },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 240, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
    { key: "holdMs", label: "Hold per word (ms)", type: "number", min: 100, max: 5000, step: 100 },
  ],
  defaultFrame: { x: 360, y: 440, w: 1200, h: 200 },
  settleMs: () => 250,
  after: "loop",
  Component: RotatePart,
};
