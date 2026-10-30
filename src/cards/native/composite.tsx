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
  name: "组合卡",
  description: "由部件库里的部件自由搭出来的卡:每个部件有自己的位置、参数和进场时机",
  useWhen: "现成的卡都不合适、要按内容自己搭一张(标题 + 要点 + 指标随意组合)时用。先 add_composite 建一张空的,再 list_parts 挑部件 add_part 进去,或者一次把 parts 传给 add_composite。",
  tags: ["组合", "部件", "自定义"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {},
  controls: [],
  lifecycle: { after: "hold", exit: ["fade"] },
  Component: CompositePlaceholder,
};
