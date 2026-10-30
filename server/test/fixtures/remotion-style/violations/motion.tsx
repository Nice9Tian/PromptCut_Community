/** 违规样例（测试夹具，不进卡片库）：Motion 的动画与弹簧。建卡时应当被拒绝并指出行号。 */
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
  id: "rs-bad-motion", name: "Motion 的动画与弹簧", description: "remotion 式的规矩的违规样例", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
