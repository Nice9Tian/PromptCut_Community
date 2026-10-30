/** 探针的对照卡（测试夹具，不进卡片库）：每渲染一次就往 ref 里加一，画面取决于前面渲染过几次——顺着播和直接跳必然不同。它过不了建卡检查。 */
import { useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  const renders = useRef(0);
  renders.current += 1;
  return <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "sans-serif", fontSize: 160, color: "#fff" }}>{params.text}{renders.current}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-stateful-control", name: "有状态的对照", description: "remotion 式的规矩的违规样例", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
