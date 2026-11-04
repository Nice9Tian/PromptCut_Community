import { createElement } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { lottieAssets, particleAssets, type CatalogAsset } from "../catalogAssets";
import { LottieView } from "../native/lottie";
import { ParticlesView } from "../native/particles";
import { translateParticlesConfig } from "./particlesKnobs";

/**
 * Media wrapper cards: motion graphics assets → function translation → card contract.
 *
 * Every Lottie animation and every particle config in the asset catalog (server/catalog) becomes a
 * CardDef of its own here:
 *   - The original files stay in the catalog and the card records only the URL; the components reuse
 *     the two "functions" LottieView / ParticlesView;
 *   - Only the translated knobs are exposed (Lottie: speed / after the end / fit; particles: the
 *     count / speed / size / color / opacity / links that the config really has), with parts and
 *     lifecycle declared as well;
 *   - These cards are what the Agent and the left rail see: add_clip({ cardId: "lottie-adrock" }) is
 *     enough, with no need to know the URL, let alone read the asset file.
 *
 * Generated at build time (the catalog's index.json and the particle configs are both imported in),
 * so what is packed into the bundle is the same as on the dev machine.
 * The id prefixes lottie- / particles- are a reserved namespace that create_card may not occupy.
 */

const particleConfigs = import.meta.glob<Record<string, any>>("../../../server/catalog/particles/*.json", { eager: true, import: "default" });

function configOf(name: string): Record<string, any> | null {
  for (const [file, cfg] of Object.entries(particleConfigs)) {
    if (file.endsWith(`/${name}.json`)) return cfg;
  }
  return null;
}

const describe = (a: CatalogAsset) => a.note || a.description;
const whenToUse = (a: CatalogAsset) => a.use || "";

function lottieCardOf(a: CatalogAsset): CardDef<any> {
  const settleMs = a.seconds ? Math.round(a.seconds * 1000) : undefined;
  const Component = ({ params, t = 0 }: CardProps<any>) =>
    createElement(LottieView, { json: "", src: a.url, speed: Number(params.speed) || 1, loop: String(params.loop), fit: String(params.fit), t });
  return {
    id: `lottie-${a.name}`,
    name: `Lottie · ${a.name}`,
    description: describe(a),
    useWhen: `${whenToUse(a)}The animation itself runs ${a.seconds ?? "?"}s (${a.w}×${a.h}); if the clip is given this duration it plays through once in full, and if longer it holds on the last frame or loops.`,
    tags: ["lottie", "media", ...a.tags],
    source: "asset",
    // Frame mode: remotion-style (render refactor "Gui"). LottieView does not let the player run by
    // itself; each frame it converts t into a frame number and jumps straight there;
    // the places involving random numbers and stale property values are pinned in loadLottie (see the
    // header of native/lottie.tsx), so it is direct under any parameters.
    // The source version of the media wrapper cards in this file takes only a few items of the
    // declaration: only when this line was changed did the keys of the 5 Lottie wrapper cards change.
    frameMode: "direct",
    defaults: { speed: 1, loop: "no", fit: "contain" },
    controls: [
      { key: "speed", label: "Speed multiplier", type: "number", min: 0.1, max: 8, step: 0.1 },
      { key: "loop", label: "At the end", type: "select", options: [{ value: "no", label: "Hold last frame" }, { value: "yes", label: "Loop" }] },
      { key: "fit", label: "Fit", type: "select", options: [{ value: "contain", label: "Show in full" }, { value: "cover", label: "Fill and crop" }] },
    ],
    parts: [{ id: "animation", label: a.name, role: "media", params: ["speed", "loop", "fit"], enterMs: 0, ...(settleMs ? { settleMs } : {}) }],
    lifecycle: { ...(settleMs ? { settleMs } : {}), after: "hold", exit: ["fade"] },
    // The animation's own length is fixed, but raising speed makes it settle earlier; with loop on it
    // is not "stopped" but "looping"
    timing: (p) => {
      const speed = Number(p.speed) > 0 ? Number(p.speed) : 1;
      const settle = settleMs ? settleMs / speed : undefined;
      return { ...(settle ? { settleMs: settle, parts: { animation: { settleMs: settle } } } : {}), after: String(p.loop) === "yes" ? "loop" : "hold" };
    },
    Component,
  };
}

function particlesCardOf(a: CatalogAsset): CardDef<any> | null {
  const config = configOf(a.name);
  if (!config) return null;
  const knobs = translateParticlesConfig(config);
  const Component = ({ params, t = 0 }: CardProps<any>) => {
    const depsKey = JSON.stringify(knobs.controls.map((c) => params[c.key]));
    return createElement(ParticlesView, {
      resolve: async () => knobs.apply(config, params),
      seed: Number(params.seed) || 1,
      depsKey,
      t,
    });
  };
  return {
    id: `particles-${a.name}`,
    name: `Particles · ${a.name}`,
    description: describe(a),
    useWhen: `${whenToUse(a)}It is a background, usually placed on the bottom track and covering the whole duration; particle positions are determined by seed, and the same seed gives the same result on every export.`,
    tags: ["particles", "background", "media", ...a.tags],
    source: "asset",
    // Frame mode: fixed by the audit (A0.1). tsParticles integrates positions frame by frame, so it is
    // stateful under any parameters.
    frameMode: "stateful",
    defaults: { ...knobs.defaults, seed: 1 },
    controls: [
      ...knobs.controls,
      { key: "seed", label: "Random seed", type: "number", min: 1, max: 99999, step: 1, hint: "A different number gives a different layout; the same number gives the same result on every export" },
    ],
    parts: [{ id: "particles", label: a.name, role: "media", params: [...knobs.controls.map((c) => c.key), "seed"] }],
    lifecycle: { after: "evolve", exit: ["fade"] },
    Component,
  };
}

export const assetCards: CardDef<any>[] = [
  ...lottieAssets.map(lottieCardOf),
  ...particleAssets.map(particlesCardOf).filter((c): c is CardDef<any> => !!c),
];

/** For left rail grouping: media cards are separated by kind */
export function assetCardKind(card: CardDef<any>): "lottie" | "particles" | null {
  if (card.source !== "asset") return null;
  return card.id.startsWith("lottie-") ? "lottie" : "particles";
}

/**
 * The particle assets the catalog marks as featured: the left rail shows only these by default, so
 * that 50-odd cards do not fill up the list
 */
export const featuredParticleIds = new Set(particleAssets.filter((a) => a.featured).map((a) => `particles-${a.name}`));
