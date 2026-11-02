/**
 * Violation example (test fixture, not added to the card library): frameMode cannot read a literal.
 * Should be rejected during card creation, pointing to the line number.
 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
const MODES = ["direct", "stateful"] as const;
function C({ params, t = 0 }: CardProps<Params>) {
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-frame-mode", name: "frameMode cannot be read", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: MODES[0],
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
