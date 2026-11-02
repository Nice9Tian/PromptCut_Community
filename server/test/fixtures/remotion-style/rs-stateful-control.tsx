/**
 * Control card for probes (test fixture, not added to the card library): increments a ref on each
 * render; visuals depend on how many times it previously rendered: sequential playback and jumping
 * directly inevitably differ. It cannot pass the card creation check.
 */
import { useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  const renders = useRef(0);
  renders.current += 1;
  return <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "sans-serif", fontSize: 160, color: "#fff" }}>{params.text}{renders.current}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-stateful-control", name: "Stateful control sample", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
