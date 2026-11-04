import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { fitOr } from "../fit";

/**
 * Quote attribution: extracted from quote-lockup.
 * Single-line attribution, no delay, pure fade-in, usually placed below text-quote.
 */
interface Params {
  author: string;
  size: number;
}

function AuthorPart({ params, width, height }: PartProps<Params>) {
  const size = fitOr(params.size, { width, height, text: params.author, max: 120 });
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        boxSizing: "border-box",
      }}
    >
      <motion.div
        className="text-white/60"
        style={{ fontSize: size }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6 }}
      >
        {params.author}
      </motion.div>
    </div>
  );
}

export const textAuthor: PartDef<Params> = {
  id: "text-author",
  name: "Quote attribution",
  description: "Attribution and source below a pull quote",
  useWhen: "Use to show a pull quote, famous saying, quote source or author attribution, usually placed below text-quote. For small kicker text above an ordinary title, use the kicker of text-title.",
  tags: ["Attribution", "Author", "quote", "Source"],
  role: "text",
  from: "quote-lockup",
  defaults: {
    author: "— 史蒂夫·乔布斯",
    size: 0,
  },
  controls: [
    { key: "author", label: "Attribution", type: "text", required: true },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 120, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
  ],
  defaultFrame: { x: 232, y: 720, w: 600, h: 60 },
  settleMs: () => 600,
  after: "hold",
  Component: AuthorPart,
};
