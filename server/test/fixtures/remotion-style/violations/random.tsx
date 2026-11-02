/**
 * Violation example (test fixture, not added to the card library): unseeded random. Should be
 * rejected during card creation, pointing to the line number.
 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  const jitter = Math.random() * 20;
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }), transform: `translateX(${jitter}px)` }}>{params.text}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-random", name: "Unseeded random", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
