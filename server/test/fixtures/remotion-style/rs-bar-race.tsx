/** remotion 式的框架的示例卡（测试夹具，不进卡片库）：一排柱子从中间往两边长出来，长好后轻轻起伏。 */
import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, noise, randomPick, randomRange, stagger, staggerDuration, tween } from "../../kernel/remotionStyle";

interface Params { count: number; seed: number; accent: string }

const PALETTE = ["#ef476f", "#ffd166", "#06d6a0", "#118ab2"];
const GROW = Easing.out(Easing.back(1.4));

function BarRace({ params, t = 0 }: CardProps<Params>) {
  const count = Math.max(1, Math.min(24, Math.round(params.count)));
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 18, paddingBottom: 160, fontFamily: "sans-serif" }}>
      {Array.from({ length: count }, (_, i) => {
        const local = stagger(t, i, { each: 0.06, from: "center", count });
        const target = randomRange(180, 620, params.seed, i);
        const grown = tween(local, { duration: 0.7, easing: GROW });
        const sway = 1 + noise(t * 1.5, params.seed, i, "sway") * 0.04 * tween(local, { delay: 0.7, duration: 0.3 });
        const height = target * grown * sway;
        return (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <div style={{ color: "#ffffff", fontSize: 26, fontWeight: 700, opacity: tween(local, { delay: 0.3, duration: 0.3 }) }}>{Math.round(target * grown)}</div>
            <div style={{ width: 44, height, borderRadius: 8, background: i % 5 === 0 ? params.accent : randomPick(PALETTE, params.seed, i, "color") }} />
          </div>
        );
      })}
    </div>
  );
}

export const barRace: CardDef<Params> = {
  id: "rs-bar-race",
  name: "随机柱状起伏",
  description: "一排高度随机的柱子从中间往两边长出来，长好后轻轻起伏",
  source: "user",
  useWhen: "框架示例：要一组带种子的随机柱子时用。",
  tags: ["柱状", "随机", "示例"],
  frameMode: "direct",
  defaults: { count: 14, seed: 7, accent: "#ffffff" },
  controls: [
    { key: "count", label: "柱子个数", type: "number", min: 1, max: 24, step: 1 },
    { key: "seed", label: "随机种子", type: "number", min: 0, max: 9999, step: 1 },
    { key: "accent", label: "强调色", type: "color" },
  ],
  Component: BarRace,
  // 柱子个数可调，最后一根长好的时刻跟着变：落定时刻用 staggerDuration 按个数算（每根 0.7 秒长高再加 0.3 秒起伏淡入）
  timing: (p) => ({ settleMs: Math.round(staggerDuration(Math.max(1, Math.min(24, Math.round(p.count))), { each: 0.06, from: "center" }, 1.0) * 1000) }),
  lifecycle: { settleMs: 1400, after: "evolve", exit: ["fade"] },
};
