/** 违规样例（测试夹具，不进卡片库）：CSS 动画与过渡。建卡时应当被拒绝并指出行号。 */
import "../../kernel/remotionStyle";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params, t = 0 }: CardProps<Params>) {
  return (
    <div style={{ position: "absolute", inset: 0, opacity: t > 0.5 ? 1 : 0, transition: "opacity 0.3s ease" }}>
      <span className="animate-pulse">{params.text}</span>
      <style>{`.rs-bad-blink { animation: rs-bad-blink 1s infinite; } @keyframes rs-bad-blink { 50% { opacity: 0; } }`}</style>
    </div>
  );
}
export const card: CardDef<Params> = {
  id: "rs-bad-css-animation", name: "CSS 动画与过渡", description: "remotion 式的规矩的违规样例", source: "user",
  frameMode: "direct",
  defaults: { text: "" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
