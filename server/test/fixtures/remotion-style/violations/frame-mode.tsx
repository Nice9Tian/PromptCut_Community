/** 违规样例（测试夹具，不进卡片库）：frameMode 读不出字面量。建卡时应当被拒绝并指出行号。 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
const MODES = ["direct", "stateful"] as const;
function C({ params, t = 0 }: CardProps<Params>) {
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-frame-mode", name: "frameMode cannot be read", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: MODES[0],
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
