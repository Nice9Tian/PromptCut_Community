/**
 * Violation example (test fixture, not added to the card library): reading real time. Should be
 * rejected during card creation, pointing to the line number.
 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  const started = performance.now();
  const second = new Date().getSeconds();
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{started}{second}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-real-time", name: "Reading real time", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
