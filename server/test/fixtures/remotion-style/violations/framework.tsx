/**
 * Violation example (test fixture, not added to the card library): declared as remotion-style but
 * does not import framework. Should be rejected during card creation, pointing to the frameMode line.
 */
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  return <div style={{ position: "absolute", inset: 0, opacity: Math.min(1, t / 0.4) }}>{params.text}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-framework", name: "Framework not referenced", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
