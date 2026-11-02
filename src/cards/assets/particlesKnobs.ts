import type { Control } from "../../kernel/types";

/**
 * The "function translation" of particle configs: translates a tsParticles config (the original
 * JSON in the asset catalog) into a set of adjustable knobs (controls + defaults), plus a function
 * that writes the knob values back into the config.
 *
 * Why the config is not exposed directly: it is dozens of lines of nested JSON, the Agent can only
 * rewrite the whole thing, and one wrong key blacks out the entire card. After translation the
 * outside sees only the few named, range-bounded parameters count / speed / size / color / opacity /
 * links. This is the "card contract": the original config stays in the asset catalog, and the Agent
 * touches only the knobs.
 *
 * The translation is conservative: a knob is exposed only if the config **has** it (a config
 * without links has no links parameter), and values keep their original shape (a range stays a
 * range, scaled proportionally). A knob value equal to the default is not written back, so with
 * no knob touched the config produced by apply is byte-for-byte identical to the original (an
 * out-of-range original value such as size 0 will not be clamped either).
 */

export interface ParticleKnobs {
  controls: Control[];
  defaults: Record<string, unknown>;
  /** Writes the knob values back into the config (returns a new object, leaving the original config unchanged) */
  apply(config: Record<string, any>, params: Record<string, unknown>): Record<string, any>;
}

type Range = { min: number; max: number };
const isRange = (v: unknown): v is Range => !!v && typeof v === "object" && typeof (v as Range).min === "number" && typeof (v as Range).max === "number";

/** Gets the representative value of a "number or range": the midpoint of a range */
function numOf(v: unknown, fallback: number): number {
  if (typeof v === "number") return v;
  if (isRange(v)) return (v.min + v.max) / 2;
  return fallback;
}

/** Scales a "number or range" proportionally to a new representative value, keeping its shape */
function scaleTo(v: unknown, target: number): unknown {
  if (isRange(v)) {
    const mid = (v.min + v.max) / 2;
    if (mid <= 0) return { min: target, max: target };
    const k = target / mid;
    return { min: v.min * k, max: v.max * k };
  }
  return target;
}

function firstColor(v: unknown): string | null {
  if (typeof v === "string") return v === "random" ? null : v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

const get = (o: any, path: string[]): unknown => path.reduce((x, k) => (x && typeof x === "object" ? x[k] : undefined), o);
function set(o: any, path: string[], value: unknown): void {
  let cur = o;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

const P = ["particles"];

type Writer = { key: string; fn: (cfg: any, params: Record<string, unknown>) => void };

export function translateParticlesConfig(config: Record<string, any>): ParticleKnobs {
  const controls: Control[] = [];
  const defaults: Record<string, unknown> = {};
  const writers: Writer[] = [];

  // Count
  const count = get(config, [...P, "number", "value"]);
  if (typeof count === "number") {
    controls.push({ key: "count", label: "Count", type: "number", min: 0, max: Math.max(400, count * 3), step: 5, hint: "原配置 " + count });
    defaults.count = count;
    writers.push({ key: "count", fn: (cfg, p) => { if (typeof p.count === "number") set(cfg, [...P, "number", "value"], Math.max(0, p.count | 0)); } });
  }

  // Speed
  const speed = get(config, [...P, "move", "speed"]);
  if (typeof speed === "number" || isRange(speed)) {
    const v = numOf(speed, 1);
    controls.push({ key: "speed", label: "Speed", type: "number", min: 0, max: Math.max(10, v * 4), step: 0.1, hint: "原配置 " + v });
    defaults.speed = v;
    writers.push({ key: "speed", fn: (cfg, p) => { if (typeof p.speed === "number") set(cfg, [...P, "move", "speed"], scaleTo(speed, Math.max(0, p.speed))); } });
  }

  // Size
  const size = get(config, [...P, "size", "value"]);
  if (typeof size === "number" || isRange(size)) {
    const v = numOf(size, 3);
    controls.push({ key: "size", label: "Size (px)", type: "number", min: 0.5, max: Math.max(20, v * 4), step: 0.5, hint: "原配置 " + v });
    defaults.size = v;
    writers.push({ key: "size", fn: (cfg, p) => { if (typeof p.size === "number") set(cfg, [...P, "size", "value"], scaleTo(size, Math.max(0.5, p.size))); } });
  }

  // Color: only a single color or a color array is exposed (random and complex animations are left alone)
  const colorRaw = get(config, [...P, "color", "value"]);
  const color = firstColor(colorRaw);
  if (color) {
    controls.push({ key: "color", label: "Color", type: "color", hint: "原配置 " + color + (Array.isArray(colorRaw) ? "(多色时只替换第一种)" : "") });
    defaults.color = color;
    writers.push({ key: "color", fn: (cfg, p) => {
      if (typeof p.color !== "string" || !p.color.trim()) return;
      set(cfg, [...P, "color", "value"], Array.isArray(colorRaw) ? [p.color, ...colorRaw.slice(1)] : p.color);
    } });
  }

  // Opacity
  const opacity = get(config, [...P, "opacity", "value"]);
  if (typeof opacity === "number" || isRange(opacity)) {
    const v = numOf(opacity, 1);
    controls.push({ key: "opacity", label: "Opacity", type: "number", min: 0, max: 1, step: 0.05, hint: "原配置 " + v });
    defaults.opacity = v;
    writers.push({ key: "opacity", fn: (cfg, p) => { if (typeof p.opacity === "number") set(cfg, [...P, "opacity", "value"], scaleTo(opacity, Math.min(1, Math.max(0, p.opacity)))); } });
  }

  // Links: exposed only if the config has a links section
  const links = get(config, [...P, "links"]);
  if (links && typeof links === "object") {
    const on = (links as any).enable !== false;
    controls.push({ key: "links", label: "Links", type: "select", options: [{ value: "yes", label: "present" }, { value: "no", label: "none" }] });
    defaults.links = on ? "yes" : "no";
    writers.push({ key: "links", fn: (cfg, p) => { if (p.links === "yes" || p.links === "no") set(cfg, [...P, "links", "enable"], p.links === "yes"); } });
  }

  return {
    controls,
    defaults,
    apply(cfg, params) {
      // Deep-copy before writing: set modifies in place along the path and must not touch the original config
      const out = JSON.parse(JSON.stringify(cfg));
      for (const w of writers) {
        if (params[w.key] === undefined || params[w.key] === defaults[w.key]) continue;
        w.fn(out, params);
      }
      return out;
    },
  };
}
