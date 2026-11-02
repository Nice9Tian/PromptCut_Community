/**
 * remotion-style framework: interpolation over time, eased transitions, loops.
 *
 * All pure functions of "time t and parameters → value": they read no clock and remember no previous
 * result. The unit of t is seconds (the `t` the card component receives).
 */
import { Easing, type EasingFn } from "./easing.ts";

/**
 * What to do outside the range: `clamp` stays at the value of the endpoint; `extend` keeps going along
 * the slope of the outermost segment
 */
export type Extrapolate = "clamp" | "extend";

export interface InterpolateOptions {
  /**
   * Easing used within each segment; the default is constant speed. When an array is given, one per
   * segment (length = number of intervals)
   */
  easing?: EasingFn | readonly EasingFn[];
  /** What to do when t is earlier than the first time point, default `clamp` */
  extrapolateLeft?: Extrapolate;
  /** What to do when t is later than the last time point, default `clamp` */
  extrapolateRight?: Extrapolate;
}

/** Clamp x into [lo, hi] (default 0~1) */
export function clamp(x: number, lo = 0, hi = 1): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Take a value between a and b at progress p (p is not clamped; 0 is a, 1 is b) */
export function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

function checkRanges(name: string, input: readonly number[], outputLength: number): void {
  if (!Array.isArray(input) || input.length < 2) throw new Error(`${name} needs at least two time points`);
  if (input.length !== outputLength) throw new Error(`${name} needs the same number of time points and values (${input.length} vs ${outputLength})`);
  for (let i = 0; i < input.length; i++) {
    if (!Number.isFinite(input[i])) throw new Error(`${name} time points must be finite numbers, number ${i + 1} is ${input[i]}`);
    if (i > 0 && !(input[i] > input[i - 1])) throw new Error(`${name} time points must be strictly increasing, number ${i + 1} (${input[i]}) is not greater than the previous one (${input[i - 1]})`);
  }
}

/**
 * Which segment t falls in (0-based), and how far along it is within that segment (no easing, no
 * clamping)
 */
function locate(t: number, input: readonly number[]): { segment: number; raw: number } {
  let segment = 0;
  for (let i = 1; i < input.length - 1; i++) if (t >= input[i]) segment = i;
  return { segment, raw: (t - input[segment]) / (input[segment + 1] - input[segment]) };
}

function easingOf(options: InterpolateOptions | undefined, segment: number): EasingFn {
  const e = options?.easing;
  if (!e) return Easing.linear;
  if (typeof e === "function") return e;
  return e[segment] ?? Easing.linear;
}

/**
 * Progress within this segment after easing; outside the range it is clamped or extended according
 * to the options
 */
function progressAt(t: number, input: readonly number[], options: InterpolateOptions | undefined): { segment: number; p: number } {
  const first = input[0], last = input[input.length - 1];
  if (t <= first) {
    if ((options?.extrapolateLeft ?? "clamp") === "clamp" || t === first) return { segment: 0, p: 0 };
    return { segment: 0, p: (t - first) / (input[1] - first) };
  }
  if (t >= last) {
    const segment = input.length - 2;
    if ((options?.extrapolateRight ?? "clamp") === "clamp" || t === last) return { segment, p: 1 };
    return { segment, p: (t - input[segment]) / (last - input[segment]) };
  }
  const { segment, raw } = locate(t, input);
  return { segment, p: easingOf(options, segment)(raw) };
}

/**
 * Interpolate over time: `input` is a list of time points in ascending order (seconds), `output` is
 * the value at each time point, with a linear transition per segment in between (easing optional).
 * Outside the range it stays at the endpoint value by default.
 *
 * Example: `interpolate(t, [0, 0.4], [0, 1])` goes from 0 to 1 within 0.4 seconds, then stays at 1.
 */
export function interpolate(t: number, input: readonly number[], output: readonly number[], options?: InterpolateOptions): number {
  checkRanges("interpolate", input, output.length);
  const { segment, p } = progressAt(t, input, options);
  return lerp(output[segment], output[segment + 1], p);
}

export interface TweenOptions {
  /** Value at the start, default 0 */
  from?: number;
  /** Value at the end, default 1 */
  to?: number;
  /** Second at which it starts, default 0 */
  delay?: number;
  /** How many seconds it takes */
  duration: number;
  /** Easing, default `Easing.easeOut` */
  easing?: EasingFn;
}

/**
 * Eased transition: from `from` to `to`, starting after `delay` seconds and taking `duration` seconds.
 * Before it starts the value is `from`, and after it finishes it is `to`.
 *
 * Example: `tween(t, { from: 40, to: 0, delay: 0.2, duration: 0.5 })` starts at 0.2 seconds and lands
 * on 0 at 0.7 seconds.
 */
export function tween(t: number, options: TweenOptions): number {
  const { from = 0, to = 1, delay = 0, duration, easing = Easing.easeOut } = options;
  if (!(duration > 0)) return t >= delay ? to : from;
  const p = (t - delay) / duration;
  if (p <= 0) return from;
  if (p >= 1) return to;
  return lerp(from, to, easing(p));
}

/** Loop: fold t back into [0, period). Example: `loop(t, 2)` runs from the start every 2 seconds */
export function loop(t: number, period: number): number {
  if (!(period > 0)) return 0;
  const r = t % period;
  return r < 0 ? r + period : r;
}

/**
 * Back and forth: 0 → period → 0 → period ... Example: `pingPong(t, 1)` goes out for one second and
 * back for one second
 */
export function pingPong(t: number, period: number): number {
  if (!(period > 0)) return 0;
  const r = loop(t, period * 2);
  return r <= period ? r : period * 2 - r;
}

/* ------------------------------------------------------------------ Colors */

type Rgba = readonly [number, number, number, number];

function parseColor(color: string): Rgba {
  const s = String(color).trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)?.[1];
  if (hex && (hex.length === 3 || hex.length === 4)) {
    const v = [...hex].map((c) => parseInt(c + c, 16));
    return [v[0], v[1], v[2], hex.length === 4 ? v[3] / 255 : 1];
  }
  if (hex && (hex.length === 6 || hex.length === 8)) {
    const v = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return [v[0], v[1], v[2], hex.length === 8 ? v[3] / 255 : 1];
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(s)?.[1];
  if (fn) {
    const parts = fn.split(/[\s,/]+/).filter(Boolean);
    if (parts.length === 3 || parts.length === 4) {
      const channel = (p: string) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p));
      const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      const out: Rgba = [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha];
      if (out.every(Number.isFinite)) return out;
    }
  }
  throw new Error(`interpolateColors does not recognize this color: ${String(color).slice(0, 40)} (only #rgb, #rrggbb, #rrggbbaa, rgb(), rgba() are supported)`);
}

/**
 * Transition over time between several colors, returning an `rgba(r, g, b, a)` string. Colors are
 * only recognized as hexadecimal and `rgb()` / `rgba()`.
 *
 * Example: `interpolateColors(t, [0, 1], ["#ff0000", "#0000ff"])` goes from red to blue in one second.
 */
export function interpolateColors(t: number, input: readonly number[], colors: readonly string[], options?: InterpolateOptions): string {
  checkRanges("interpolateColors", input, colors.length);
  const { segment, p } = progressAt(t, input, options);
  const a = parseColor(colors[segment]), b = parseColor(colors[segment + 1]);
  const channel = (i: number) => Math.round(clamp(lerp(a[i], b[i], p), 0, 255));
  const alpha = Math.round(clamp(lerp(a[3], b[3], p), 0, 1) * 1000) / 1000;
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${alpha})`;
}
