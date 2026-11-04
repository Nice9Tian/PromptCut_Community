import type { PartDef, PartProps } from "../../kernel/partTypes";
import { ParticlesView } from "../../cards/native/particles";
import { assetOptions } from "../../cards/catalogAssets";

/**
 * Particle background.
 * Media part extracted from particles card, covering the entire frame.
 * Entrance: randomly generated, floating in real time.
 */
interface Params {
  config: string;
  color: string;
  quantity: number;
  speed: number;
  size: number;
  links: string;
  seed: number;
}

function simpleOptions(params: Params): Record<string, any> {
  return {
    fpsLimit: 60,
    particles: {
      number: { value: Math.max(0, params.quantity | 0), density: { enable: false } },
      color: { value: params.color },
      opacity: { value: 0.8 },
      size: { value: Math.max(0.5, params.size) },
      move: { enable: true, speed: Math.max(0, params.speed), outModes: { default: "out" } },
      links: { enable: params.links === "yes", color: params.color, distance: 160, opacity: 0.45, width: 1.5 },
    },
  };
}

async function resolveOptions(params: Params): Promise<Record<string, any>> {
  const c = params.config.trim();
  if (!c) return simpleOptions(params);
  if (c.startsWith("{")) return JSON.parse(c);
  const r = await fetch(c);
  if (!r.ok) throw new Error(`拉取粒子配置失败 ${r.status}: ${c}`);
  return r.json();
}

function MediaParticlesPart({ params, width, height, t }: PartProps<Params>) {
  const depsKey = [params.config, params.color, params.quantity, params.speed, params.size, params.links].join("\u0000");

  return (
    <div style={{ position: "absolute", inset: 0, width, height }}>
      <ParticlesView resolve={() => resolveOptions(params)} seed={params.seed} depsKey={depsKey} t={t} />
    </div>
  );
}

export const mediaParticles: PartDef<Params> = {
  id: "media-particles",
  name: "Particle background",
  description: "Floating particles, optionally linked by lines, filling the whole frame",
  useWhen: "Use when the whole frame needs a dynamic tech / starry-sky texture layer, usually on the bottom layer. Leave config empty to use the simple parameters; for ready-made effects like snowflakes / starry sky / bubbles, put a URL under /catalog/particles/ in config (the simple parameters then have no effect). The particle layout is determined by seed, and the same seed gives the same result on every export. It is a background, not the main subject; to emphasize numbers or text, overlay other parts on top.",
  tags: ["particles", "background", "tech", "starry sky", "snowflake", "canvas"],
  role: "media",
  from: "particles",
  defaults: {
    config: "",
    color: "#8ab4ff",
    quantity: 80,
    speed: 1.2,
    size: 3,
    links: "yes",
    seed: 1,
  },
  controls: [
    { key: "config", label: "Preset config", type: "asset", kind: "particles", options: assetOptions("particles"), hint: "Pick one from the media catalog (a URL in options), or enter another URL / inline JSON; when set, it is used and the color/count/speed below have no effect" },
    { key: "color", label: "Color", type: "color" },
    { key: "quantity", label: "Count", type: "number", min: 0, max: 400, step: 10 },
    { key: "speed", label: "Speed", type: "number", min: 0, max: 10, step: 0.2 },
    { key: "size", label: "Size (px)", type: "number", min: 0.5, max: 20, step: 0.5 },
    { key: "links", label: "Links", type: "select", options: [{ value: "yes", label: "present" }, { value: "no", label: "none" }] },
    { key: "seed", label: "Random seed", type: "number", min: 1, max: 99999, step: 1, hint: "Change the number to get a different layout" },
  ],
  defaultFrame: { x: 960, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5] },
  settleMs: () => 0,
  after: "evolve",
  Component: MediaParticlesPart,
};
