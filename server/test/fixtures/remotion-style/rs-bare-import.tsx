/**
 * Compliant example (test fixture, not added to the card library): a card that does not need
 * framework tools and only uses t for arithmetic, with a single bare import. The top level is
 * still locked as read-only on load.
 */
import "../../kernel/remotionStyle";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
const COUNTER = { frames: 0 };
function C({ params, t = 0 }: CardProps<Params>) {
  const counter = COUNTER;
  if (params.text === "write-object") counter.frames += 1;
  return <div style={{ position: "absolute", inset: 0, opacity: Math.min(1, t / 0.4) }}>{params.text}{counter.frames}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bare-import", name: "Bare import only", description: "Example card for the remotion-style framework", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
