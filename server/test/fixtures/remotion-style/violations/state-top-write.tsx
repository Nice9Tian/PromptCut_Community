/** 违规样例（测试夹具，不进卡片库）：跨帧累加的状态（往顶层的对象里写）。建卡时应当被拒绝并指出行号。 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
const COUNTER = { frames: 0 };
const TRAIL: number[] = [];
function C({ params, t = 0 }: CardProps<Params>) {
  COUNTER.frames += 1;
  TRAIL.push(t);
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{COUNTER.frames}{TRAIL.length}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-bad-state-top-write", name: "跨帧累加的状态", description: "remotion 式的规矩的违规样例", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
