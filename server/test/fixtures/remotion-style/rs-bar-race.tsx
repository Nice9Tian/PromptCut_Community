/** Example card for the remotion-style framework (test fixture, not in the card library): a row of bars grows from the middle out to both sides, then gently undulates. */
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
  name: "Random fluctuating bars",
  description: "A row of bars with random heights grows outward from the middle, then sways gently once fully grown",
  source: "user",
  useWhen: "Framework example: use when you need a set of seeded random bars.",
  tags: ["bars", "random", "example"],
  frameMode: "direct",
  defaults: { count: 14, seed: 7, accent: "#ffffff" },
  controls: [
    { key: "count", label: "Number of bars", type: "number", min: 1, max: 24, step: 1 },
    { key: "seed", label: "Random seed", type: "number", min: 0, max: 9999, step: 1 },
    { key: "accent", label: "Emphasis color", type: "color" },
  ],
  Component: BarRace,
  // The number of bars is adjustable and the moment the last bar finishes growing changes with it: compute the settle time from the count with staggerDuration (each bar takes 0.7 seconds to grow, plus 0.3 seconds for the sway to fade in)
  timing: (p) => ({ settleMs: Math.round(staggerDuration(Math.max(1, Math.min(24, Math.round(p.count))), { each: 0.06, from: "center" }, 1.0) * 1000) }),
  lifecycle: { settleMs: 1400, after: "evolve", exit: ["fade"] },
};
