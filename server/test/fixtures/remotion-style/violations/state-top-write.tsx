/**
 * Violation example (test fixture, not added to the card library): state accumulated across frames
 * (writing into top-level object). Should be rejected during card creation, pointing to the line
 * number.
 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
const COUNTER = { frames: 0 };
const TRAIL: number[] = [];
function C({ params, t = 0 }: CardProps<Params>) {
  COUNTER.frames += 1;
  TRAIL.push(t);
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{COUNTER.frames}{TRAIL.length}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-state-top-write", name: "State accumulated across frames", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
