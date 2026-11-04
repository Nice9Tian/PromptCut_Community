import type { CardDef, CardProps } from "../../kernel/types";

/**
 * Composite card: its content is not one whole block of JSX, but a **part instance tree** on
 * clip.parts (see src/kernel/partTypes.ts).
 *
 * When the stage (render/Stage.tsx) sees that cardId is composite, it does not use this Component but
 * renders level by level through PartTree instead; the Component here only appears in the hover
 * preview in the card library, or when the clip has no part at all, and draws a hint line.
 * It has no controls: the parameters all live on the individual part instances and are changed by
 * add_part / set_part / remove_part or the parameters panel.
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
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {},
  controls: [],
  lifecycle: { after: "hold", exit: ["fade"] },
  Component: CompositePlaceholder,
};
