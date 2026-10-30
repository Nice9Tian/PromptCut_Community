import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { fitOr } from "../fit";

/**
 * 引文署名:从 quote-lockup 拆出。
 * 单行署名，没有延迟，纯淡入，通常放置于 text-quote 之下。
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
  name: "引文署名",
  description: "金句引语下方的署名出处",
  useWhen: "用于展示金句、名言、引文出处或作者署名，通常与 text-quote 配合放在其下方；普通标题上方的小字眼建议用 text-title 的 kicker。",
  tags: ["署名", "作者", "引言", "出处"],
  role: "text",
  from: "quote-lockup",
  defaults: {
    author: "— 史蒂夫·乔布斯",
    size: 0,
  },
  controls: [
    { key: "author", label: "署名", type: "text", required: true },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 120, step: 2, hint: "0 表示按部件的框自动算;想固定就填具体像素" },
  ],
  defaultFrame: { x: 232, y: 720, w: 600, h: 60 },
  settleMs: () => 600,
  after: "hold",
  Component: AuthorPart,
};
