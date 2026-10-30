/** remotion 式的框架的示例卡（测试夹具，不进卡片库）：标题逐字弹入，下划线随后展开。 */
import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, interpolate, interpolateColors, spring, springDuration, stagger, staggerDuration, tween } from "../../kernel/remotionStyle";

interface Params { text: string; accent: string; size: number; each: number }

const POP = { stiffness: 180, damping: 14 };
const LINE_EASE = Easing.bezier(0.16, 1, 0.3, 1);

function TitleReveal({ params, t = 0 }: CardProps<Params>) {
  const chars = [...params.text];
  const lineStart = staggerDuration(chars.length, { each: params.each }, 0.2);
  const line = interpolate(t, [lineStart, lineStart + 0.6], [0, 1], { easing: LINE_EASE });
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", fontSize: params.size, fontWeight: 800 }}>
        {chars.map((ch, i) => {
          const local = stagger(t, i, { each: params.each });
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                whiteSpace: "pre",
                opacity: tween(local, { duration: 0.25 }),
                transform: `translateY(${spring(local, { ...POP, from: 80, to: 0 })}px) scale(${spring(local, { ...POP, from: 0.6, to: 1 })})`,
                color: interpolateColors(local, [0, 0.5], [params.accent, "#ffffff"]),
              }}
            >
              {ch}
            </span>
          );
        })}
      </div>
      <div style={{ marginTop: 24, height: 8, width: 720 * line, borderRadius: 4, background: params.accent, opacity: line }} />
    </div>
  );
}

export const titleReveal: CardDef<Params> = {
  id: "rs-title-reveal",
  name: "逐字弹入标题",
  description: "标题一个字一个字弹上来，随后一条下划线从左展开",
  source: "user",
  useWhen: "框架示例：要一行大标题逐字出现时用。",
  tags: ["标题", "示例"],
  frameMode: "direct",
  defaults: { text: "由 t 直接算", accent: "#ffd166", size: 132, each: 0.07 },
  controls: [
    { key: "text", label: "文字", type: "text" },
    { key: "accent", label: "主色", type: "color" },
    { key: "size", label: "字号", type: "number", min: 24, max: 240, step: 4 },
    { key: "each", label: "每个字相隔(秒)", type: "number", min: 0, max: 0.5, step: 0.01 },
  ],
  Component: TitleReveal,
  timing: (p) => ({ settleMs: Math.round((staggerDuration([...p.text].length, { each: p.each }, springDuration(POP)) + 0.8) * 1000) }),
  lifecycle: { settleMs: 2000, after: "hold", exit: ["fade"] },
};
