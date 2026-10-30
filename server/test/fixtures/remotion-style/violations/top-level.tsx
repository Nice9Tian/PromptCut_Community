/** 违规样例（测试夹具，不进卡片库）：文件顶层写了不是常量的东西。建卡时应当被拒绝并指出行号。 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
let frames = 0;
const cache = new Map<string, number>();
function C({ params, t = 0 }: CardProps<Params>) {
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{frames}{cache.size}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-top-level", name: "顶层不是常量", description: "remotion 式的规矩的违规样例", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
