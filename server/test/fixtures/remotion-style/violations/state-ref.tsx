/** 违规样例（测试夹具，不进卡片库）：跨帧累加的状态（ref 里累加）。建卡时应当被拒绝并指出行号。 */
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
  id: "rs-bad-state-ref", name: "跨帧累加的状态", description: "remotion 式的规矩的违规样例", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
