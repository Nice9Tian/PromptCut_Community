/** 违规样例（测试夹具，不进卡片库）：不带种子的随机。建卡时应当被拒绝并指出行号。 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  const jitter = Math.random() * 20;
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }), transform: `translateX(${jitter}px)` }}>{params.text}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-random", name: "不带种子的随机", description: "remotion 式的规矩的违规样例", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
