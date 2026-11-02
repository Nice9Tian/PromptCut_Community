/** 违规样例（测试夹具，不进卡片库）：跨帧累加的状态（记状态的 hook）。建卡时应当被拒绝并指出行号。 */
import { useEffect, useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  const [frames, setFrames] = useState(0);
  useEffect(() => { setFrames((n) => n + 1); }, [t]);
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{frames}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-state", name: "State accumulated across frames", description: "Violation example of the remotion-style rules", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
