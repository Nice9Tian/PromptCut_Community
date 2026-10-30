/** 违规样例（测试夹具，不进卡片库）：跨帧累加的状态（全局对象）。建卡时应当被拒绝并指出行号。 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  const w = window as unknown as { __frames?: number };
  w.__frames = (w.__frames ?? 0) + 1;
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{w.__frames}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-state-global", name: "跨帧累加的状态", description: "remotion 式的规矩的违规样例", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
