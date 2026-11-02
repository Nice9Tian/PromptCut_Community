/**
 * Violation example (test fixture, not added to the card library): timers. Should be rejected
 * during card creation, pointing to the line number.
 */
import { useEffect } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  useEffect(() => {
    const id = setTimeout(() => {}, 300);
    return () => clearTimeout(id);
  }, []);
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-timer", name: "Timer", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
