/** 违规样例（测试夹具，不进卡片库）：读真实时间。建卡时应当被拒绝并指出行号。 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  const started = performance.now();
  const second = new Date().getSeconds();
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{started}{second}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-real-time", name: "读真实时间", description: "remotion 式的规矩的违规样例", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
