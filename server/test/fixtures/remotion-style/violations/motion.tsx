/**
 * Violation example (test fixture, not added to the card library): Motion animations and springs.
 * Should be rejected during card creation, pointing to the line number.
 */
import "../../kernel/remotionStyle";
import { motion, useSpring } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  const x = useSpring(0, { stiffness: 120, damping: 14 });
  return (
    <motion.div style={{ position: "absolute", inset: 0, x }} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      {params.text}
    </motion.div>
  );
}
export const card: CardDef<Params> = {
  id: "rs-bad-motion", name: "Motion animations and springs", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
