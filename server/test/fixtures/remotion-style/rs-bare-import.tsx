/** 合规样例（测试夹具，不进卡片库）：用不到框架的工具、只用 t 做算术的卡，写一行裸导入。载入时顶层照样锁成只读。 */
import "../../kernel/remotionStyle";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
const COUNTER = { frames: 0 };
function C({ params, t = 0 }: CardProps<Params>) {
  const counter = COUNTER;
  if (params.text === "write-object") counter.frames += 1;
  return <div style={{ position: "absolute", inset: 0, opacity: Math.min(1, t / 0.4) }}>{params.text}{counter.frames}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bare-import", name: "只有裸导入", description: "remotion 式的框架的示例卡", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
