/** 违规样例（测试夹具，不进卡片库）：声明成 remotion 式，却没有引用框架。建卡时应当被拒绝并指到 frameMode 那一行。 */
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  return <div style={{ position: "absolute", inset: 0, opacity: Math.min(1, t / 0.4) }}>{params.text}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-framework", name: "没引用框架", description: "remotion 式的规矩的违规样例", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
