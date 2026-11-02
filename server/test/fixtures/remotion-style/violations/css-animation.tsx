/**
 * Violation example (test fixture, not added to the card library): CSS animations and transitions.
 * Should be rejected during card creation, pointing to the line number.
 */
import "../../kernel/remotionStyle";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  return (
    <div style={{ position: "absolute", inset: 0, opacity: t > 0.5 ? 1 : 0, transition: "opacity 0.3s ease" }}>
      <span className="animate-pulse">{params.text}</span>
      <style>{`.rs-bad-blink { animation: rs-bad-blink 1s infinite; } @keyframes rs-bad-blink { 50% { opacity: 0; } }`}</style>
    </div>
  );
}
export const card: CardDef<Params> = {
  id: "rs-bad-css-animation", name: "CSS animations and transitions", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
