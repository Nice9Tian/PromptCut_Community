import type { CardDef, CardProps } from "../../kernel/types";

/**
 * 组合卡:内容不是一整块 JSX,而是 clip.parts 上的一棵**部件实例树**(见 src/kernel/partTypes.ts)。
 *
 * 舞台(render/Stage.tsx)看到 cardId 是 composite 就不走这个 Component,改走 PartTree 逐级渲染;
 * 这里的 Component 只在卡片库悬停预览、或者 clip 上一个部件都没有时出现,画一句提示。
 * 它没有 controls:参数都在各个部件实例上,由 add_part / set_part / remove_part 或参数面板改。
 */
export const COMPOSITE_CARD_ID = "composite";

function CompositePlaceholder(_: CardProps<Record<string, never>>) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.55)", font: "500 40px system-ui", letterSpacing: "0.05em" }}>
      组合卡:从部件库加部件
    </div>
  );
}

export const compositeCard: CardDef<Record<string, never>> = {
  id: COMPOSITE_CARD_ID,
  name: "Composite card",
  description: "A card freely assembled from parts in the parts library: each part has its own position, parameters and entrance timing",
  useWhen: "Use when none of the ready-made cards fit and you need to build one from the content (any mix of title + key points + metrics). First create an empty one with add_composite, then pick parts with list_parts and add them with add_part, or pass parts to add_composite all at once.",
  tags: ["composite", "part", "custom"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {},
  controls: [],
  lifecycle: { after: "hold", exit: ["fade"] },
  Component: CompositePlaceholder,
};
