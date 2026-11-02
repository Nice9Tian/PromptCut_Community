/** Second read-only sample (test fixture, not in card library): pattern undetectable by source check: writes to top-level object via an intermediate variable; throws immediately on write once loaded. */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
const COUNTER = { frames: 0 };
const SEEN = [0];
function C({ params, t = 0 }: CardProps<Params>) {
  const counter = COUNTER;
  const seen = SEEN;
  if (params.text === "write-object") counter.frames += 1;
  if (params.text === "write-array") seen.push(t);
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{counter.frames}{seen.length}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-alias-write", name: "Indirect write to the top level", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
