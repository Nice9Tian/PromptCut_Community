import { useMemo } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { WordRotate } from "./vendor/word-rotate";

interface Params {
  words: string;
  prefix: string;
}

function WordRotateCard({ params }: CardProps<Params>) {
  const wordsToPass = useMemo(() => {
    const wordsArray = params.words.split("|").map(w => w.trim()).filter(Boolean);
    return wordsArray.length > 0 ? wordsArray : ["无数据"];
  }, [params.words]);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-transparent" style={{ fontFamily: "var(--pc-font, system-ui, sans-serif)" }}>
      <div className="flex items-center gap-8 text-[96px] font-bold" style={{ color: "var(--pc-fg, #f3f4f6)", textShadow: "var(--pc-text-shadow, 0 4px 24px rgba(0,0,0,0.75))" }}>
        <span>{params.prefix}</span>
        <WordRotate words={wordsToPass} duration={1000} className="" />
      </div>
    </div>
  );
}

export const wordRotateCard: CardDef<Params> = {
  id: "mu-word-rotate",
  name: "Word rotate",
  description: "Cycles through multiple words",
  useWhen: "A fixed prefix followed by several sibling words that rotate in a loop (e.g. \"You are\" + \"excellent|outstanding|perfect\"), suited to parallel phrasing. Each word stays for 1 second, hardcoded and not adjustable, and the loop never stops on the last word. It cannot do progressive sentences like \"Not just A, but B\" where both halves change.",
  tags: ["rotate","parallel phrasing","words"],
  source: "magicui",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: { words: "优秀|卓越|完美|无瑕", prefix: "你是" },
  controls: [
    { key: "words", label: "Rotating words (separate with |)", type: "text" },
    { key: "prefix", label: "Prefix", type: "text" },
  ],
  parts: [
    { id: "words", label: "Rotating words", role: "list", params: ["words", "prefix"], enterMs: 0, settleMs: 250 },
  ],
  lifecycle: { settleMs: 250, after: "loop", exit: ["fade"] },
  Component: WordRotateCard,
};
