/**
 * Violation example (test fixture, not added to the card library): non-constant written at file
 * top level. Should be rejected during card creation, pointing to the line number.
 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
let frames = 0;
const cache = new Map<string, number>();
function C({ params, t = 0 }: CardProps<Params>) {
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{frames}{cache.size}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-top-level", name: "Top level is not a constant", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
