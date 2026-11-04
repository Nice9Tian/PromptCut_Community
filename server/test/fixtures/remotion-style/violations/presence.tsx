/**
 * Violation example (test fixture, not added to the card library): entrance and exit components.
 * Should be rejected during card creation, pointing to the line number.
 */
import { AnimatePresence } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  return (
    <AnimatePresence>
      {t < 2 && <div key="a" style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}</div>}
    </AnimatePresence>
  );
}
export const card: CardDef<Params> = {
  id: "rs-bad-presence", name: "Entrance and exit components", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
