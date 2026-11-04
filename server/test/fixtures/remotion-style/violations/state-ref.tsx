/**
 * Violation example (test fixture, not added to the card library): state accumulated across frames
 * (accumulated in ref). Should be rejected during card creation, pointing to the line number.
 */
import { useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  const frames = useRef(0);
  frames.current += 1;
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{frames.current}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-state-ref", name: "State accumulated across frames", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
