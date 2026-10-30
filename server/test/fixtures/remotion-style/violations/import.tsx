/** 违规样例（测试夹具，不进卡片库）：引用了名单之外的模块。建卡时应当被拒绝并指出行号。 */
import lottie from "lottie-web";
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{typeof lottie}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-import", name: "名单之外的模块", description: "remotion 式的规矩的违规样例", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
