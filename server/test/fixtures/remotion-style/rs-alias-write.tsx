/** 第二道只读的样例（测试夹具，不进卡片库）：源码检查看不出的写法——绕一道变量再往顶层的对象里写。载入后一写就当场报错。 */
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
interface Params { text: string }
const COUNTER = { frames: 0 };
const SEEN = [0];
function C({ params, t = 0 }: CardProps<Params>) {
  const counter = COUNTER;
  const seen = SEEN;
  if (params.text === "write-object") counter.frames += 1;
  if (params.text === "write-array") seen.push(t);
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{counter.frames}{seen.length}</div>;
}
export const card: CardDef<Params> = {
  id: "rs-alias-write", name: "绕一道往顶层写", description: "remotion 式的规矩的违规样例", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
