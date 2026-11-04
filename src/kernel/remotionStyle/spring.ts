/**
 * remotion-style framework: springs.
 *
 * Motion's springs are integrated step by step, so the position at frame N depends on every frame
 * before it. Here the closed-form solution of the damped oscillator is used: given the time t it
 * computes the position directly, with no need to step from the start, and jumping to any frame uses
 * the same formula.
 *
 * Model: a spring with mass m, stiffness k and damping c starts from `from` (initial velocity
 * `velocity`) and comes to rest at `to`.
 *   ω0 = √(k/m), ζ = c / (2√(km))
 *   ζ < 1 (underdamped, overshoots)
 *     x(t) = to + e^(−ζω0·t) · [ d·cos(ωd·t) + ((v + ζω0·d)/ωd)·sin(ωd·t) ], ωd = ω0·√(1−ζ²)
 *   ζ = 1 (critically damped)
 *     x(t) = to + e^(−ω0·t) · [ d + (v + ω0·d)·t ]
 *   ζ > 1 (overdamped, no overshoot)
 *     x(t) = to + A·e^(r1·t) + B·e^(r2·t), r1,2 = −ω0·(ζ ∓ √(ζ²−1))
 * where d = from − to and v is the initial velocity.
 */

export interface SpringConfig {
  /** Stiffness; the larger it is, the faster it settles into place. Default 100 */
  stiffness?: number;
  /** Damping; the larger it is, the less it swings. Default 10 */
  damping?: number;
  /** Mass; the larger it is, the more sluggish. Default 1 */
  mass?: number;
  /** Value at the start, default 0 */
  from?: number;
  /** Value at the end, default 1 */
  to?: number;
  /** Second at which it starts, default 0 */
  delay?: number;
  /** Initial velocity (how far it travels per second), default 0 */
  velocity?: number;
  /** Disallow going past the end point (the overshooting part is clipped flat), default false */
  clamp?: boolean;
}

interface Resolved { k: number; c: number; m: number; from: number; to: number; delay: number; v0: number; clampOvershoot: boolean }

/**
 * The three keys in Remotion's `spring({ frame, fps, config })`: if they show up in the second
 * argument here, it was certainly written the way Remotion writes it
 */
const REMOTION_KEYS = ["frame", "fps", "config"];

/** Render the type of the received first argument in a human-readable form in error messages */
function typeName(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return "NaN";
  if (Array.isArray(value)) return "array";
  return ({ undefined: "undefined", string: "string", object: "object", boolean: "boolean", function: "function", bigint: "bigint", symbol: "symbol" } as Record<string, string>)[typeof value];
}

function resolve(config: SpringConfig | undefined): Resolved {
  if (config !== null && typeof config === "object") {
    const key = REMOTION_KEYS.find((name) => Object.hasOwn(config, name));
    if (key) {
      throw new Error(`spring arguments contain ${key}: this is Remotion syntax. Here time is in seconds and passed as the first argument, not frame number and frame rate; write \`stiffness\`, \`damping\`, \`mass\` directly in the second argument, without wrapping them in \`config\`. Usage: \`spring(t, { stiffness: 100, damping: 10, mass: 1 })\`.`);
    }
  }
  const k = config?.stiffness ?? 100, c = config?.damping ?? 10, m = config?.mass ?? 1;
  if (!(k > 0) || !(m > 0) || !(c >= 0)) throw new Error(`Invalid spring arguments: stiffness and mass must be greater than 0, damping must not be negative (got ${k}, ${m}, ${c})`);
  return { k, c, m, from: config?.from ?? 0, to: config?.to ?? 1, delay: config?.delay ?? 0, v0: config?.velocity ?? 0, clampOvershoot: config?.clamp === true };
}

/** How far from the end point it is s seconds after starting (signed) */
function displacement(s: number, r: Resolved): number {
  const d = r.from - r.to;
  const w0 = Math.sqrt(r.k / r.m);
  const zeta = r.c / (2 * Math.sqrt(r.k * r.m));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return Math.exp(-zeta * w0 * s) * (d * Math.cos(wd * s) + ((r.v0 + zeta * w0 * d) / wd) * Math.sin(wd * s));
  }
  if (zeta === 1) return Math.exp(-w0 * s) * (d + (r.v0 + w0 * d) * s);
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - root), r2 = -w0 * (zeta + root);
  const a = (r.v0 - r2 * d) / (r1 - r2);
  return a * Math.exp(r1 * s) + (d - a) * Math.exp(r2 * s);
}

/**
 * Position of the spring at second t, computed directly without depending on the previous frame.
 * Before it starts (t earlier than `delay`) it is `from`.
 *
 * Example: `spring(t, { from: 0.6, to: 1, stiffness: 180, damping: 12 })` springs from 0.6 to 1,
 * overshooting slightly.
 *
 * If the first argument is not a number (which is what happens when written the Remotion way,
 * `spring({ frame, fps, config })`), it errors directly;
 * if `frame`, `fps` or `config` appear in the second argument, it also errors directly (same for
 * `springDuration`).
 */
export function spring(t: number, config?: SpringConfig): number {
  if (typeof t !== "number" || Number.isNaN(t)) {
    throw new Error(`The first argument of spring must be a time (in seconds), got ${typeName(t)}. The syntax here is \`spring(t, { stiffness, damping, mass, from, to, delay })\`, where \`t\` is clip-local seconds; it is not Remotion's \`spring({ frame, fps, config })\`. Change it to: \`spring(t, { stiffness: 100, damping: 10 })\`.`);
  }
  const r = resolve(config);
  const s = t - r.delay;
  if (!(s > 0)) return r.from;
  const x = r.to + displacement(s, r);
  if (!r.clampOvershoot) return x;
  return r.from <= r.to ? Math.min(x, r.to) : Math.max(x, r.to);
}

/**
 * How many seconds this spring takes from the start to settle (including `delay`): after that its
 * distance from the end point does not exceed `restRatio` of the whole travel (default one thousandth).
 * For use in places like `lifecycle.settleMs` and the total duration of staggered entrances.
 *
 * Example: `springDuration({ stiffness: 180, damping: 12 })` ≈ 1.17.
 */
export function springDuration(config?: SpringConfig, restRatio = 0.001): number {
  const r = resolve(config);
  const d = r.from - r.to;
  const span = Math.abs(d);
  if (span === 0 && r.v0 === 0) return r.delay;
  const threshold = Math.max(span, Math.abs(r.v0) / Math.sqrt(r.k / r.m)) * (restRatio > 0 ? restRatio : 0.001);
  const w0 = Math.sqrt(r.k / r.m);
  const zeta = r.c / (2 * Math.sqrt(r.k * r.m));
  if (zeta > 0 && zeta < 1) {
    // Underdamped: the amplitude envelope is C·e^(−ζω0·t), the moment the envelope drops to the threshold
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const amplitude = Math.hypot(d, (r.v0 + zeta * w0 * d) / wd);
    return r.delay + Math.max(0, Math.log(amplitude / threshold) / (zeta * w0));
  }
  if (zeta === 0) return Infinity; // No damping, it never stops
  // Critically damped and overdamped: scan forward in 1/240-second steps for the last moment it exceeds
  // the threshold (upper limit 60 seconds)
  const step = 1 / 240;
  let last = 0;
  for (let i = 1; i <= 240 * 60; i++) if (Math.abs(displacement(i * step, r)) > threshold) last = i;
  return r.delay + (last + 1) * step;
}
