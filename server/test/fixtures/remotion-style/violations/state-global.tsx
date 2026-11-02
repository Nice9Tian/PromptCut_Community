/**
 * Violation example (test fixture, not added to the card library): state accumulated across frames
 * (global object). Should be rejected during card creation, pointing to the line number.
 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  const w = window as unknown as { __frames?: number };
  w.__frames = (w.__frames ?? 0) + 1;
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{w.__frames}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-state-global", name: "State accumulated across frames", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
