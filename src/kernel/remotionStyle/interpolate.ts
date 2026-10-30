/**
 * remotion 式的框架：按时间插值、带缓动的过渡、循环。
 *
 * 全是「时间 t 和参数 → 值」的纯函数：不读时钟、不记上一次的结果。t 的单位是秒（卡片组件收到的那个 `t`）。
 */
import { Easing, type EasingFn } from "./easing.ts";

/** 范围之外怎么办：`clamp` 停在端点的值上；`extend` 顺着最边上那一段的斜率接着走 */
export type Extrapolate = "clamp" | "extend";

export interface InterpolateOptions {
  /** 每一段里用的缓动；缺省是匀速。给数组时一段一条（长度 = 区间个数） */
  easing?: EasingFn | readonly EasingFn[];
  /** t 比第一个时间点还早时怎么办，缺省 `clamp` */
  extrapolateLeft?: Extrapolate;
  /** t 比最后一个时间点还晚时怎么办，缺省 `clamp` */
  extrapolateRight?: Extrapolate;
}

/** 把 x 夹在 [lo, hi] 里（缺省 0～1） */
export function clamp(x: number, lo = 0, hi = 1): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** 在 a、b 之间按进度 p 取值（p 不夹，0 是 a、1 是 b） */
export function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

function checkRanges(name: string, input: readonly number[], outputLength: number): void {
  if (!Array.isArray(input) || input.length < 2) throw new Error(`${name} 的时间点至少要两个`);
  if (input.length !== outputLength) throw new Error(`${name} 的时间点和取值个数要一样多（${input.length} 对 ${outputLength}）`);
  for (let i = 0; i < input.length; i++) {
    if (!Number.isFinite(input[i])) throw new Error(`${name} 的时间点要是有限的数，第 ${i + 1} 个是 ${input[i]}`);
    if (i > 0 && !(input[i] > input[i - 1])) throw new Error(`${name} 的时间点要一个比一个大，第 ${i + 1} 个（${input[i]}）不比前一个（${input[i - 1]}）大`);
  }
}

/** t 落在哪一段（0 起），以及在这一段里走到了多少（没有缓动、没有夹） */
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

/** 这一段里缓动之后的进度；范围之外按选项夹住或延伸 */
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
 * 按时间插值：`input` 是一串从小到大的时间点（秒），`output` 是每个时间点上的值，中间按段线性过渡（可以配缓动）。
 * 范围之外缺省停在端点的值上。
 *
 * 例：`interpolate(t, [0, 0.4], [0, 1])` —— 0.4 秒内从 0 到 1，之后保持 1。
 */
export function interpolate(t: number, input: readonly number[], output: readonly number[], options?: InterpolateOptions): number {
  checkRanges("interpolate", input, output.length);
  const { segment, p } = progressAt(t, input, options);
  return lerp(output[segment], output[segment + 1], p);
}

export interface TweenOptions {
  /** 起点的值，缺省 0 */
  from?: number;
  /** 终点的值，缺省 1 */
  to?: number;
  /** 从第几秒开始，缺省 0 */
  delay?: number;
  /** 走多少秒 */
  duration: number;
  /** 缓动，缺省 `Easing.easeOut` */
  easing?: EasingFn;
}

/**
 * 带缓动的过渡：从 `from` 到 `to`，`delay` 秒后开始、走 `duration` 秒。开始之前是 `from`，走完之后是 `to`。
 *
 * 例：`tween(t, { from: 40, to: 0, delay: 0.2, duration: 0.5 })` —— 0.2 秒时起步，0.7 秒时落到 0。
 */
export function tween(t: number, options: TweenOptions): number {
  const { from = 0, to = 1, delay = 0, duration, easing = Easing.easeOut } = options;
  if (!(duration > 0)) return t >= delay ? to : from;
  const p = (t - delay) / duration;
  if (p <= 0) return from;
  if (p >= 1) return to;
  return lerp(from, to, easing(p));
}

/** 循环：把 t 折回 [0, period)。例：`loop(t, 2)` 每 2 秒从头走一遍 */
export function loop(t: number, period: number): number {
  if (!(period > 0)) return 0;
  const r = t % period;
  return r < 0 ? r + period : r;
}

/** 来回走：0 → period → 0 → period……例：`pingPong(t, 1)` 一秒去、一秒回 */
export function pingPong(t: number, period: number): number {
  if (!(period > 0)) return 0;
  const r = loop(t, period * 2);
  return r <= period ? r : period * 2 - r;
}

/* ------------------------------------------------------------------ 颜色 */

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
  throw new Error(`interpolateColors 认不出这个颜色：${String(color).slice(0, 40)}（只认 #rgb、#rrggbb、#rrggbbaa、rgb()、rgba()）`);
}

/**
 * 按时间在几个颜色之间过渡，返回 `rgba(r, g, b, a)` 字符串。颜色只认十六进制和 `rgb()` / `rgba()`。
 *
 * 例：`interpolateColors(t, [0, 1], ["#ff0000", "#0000ff"])` —— 一秒内从红到蓝。
 */
export function interpolateColors(t: number, input: readonly number[], colors: readonly string[], options?: InterpolateOptions): string {
  checkRanges("interpolateColors", input, colors.length);
  const { segment, p } = progressAt(t, input, options);
  const a = parseColor(colors[segment]), b = parseColor(colors[segment + 1]);
  const channel = (i: number) => Math.round(clamp(lerp(a[i], b[i], p), 0, 255));
  const alpha = Math.round(clamp(lerp(a[3], b[3], p), 0, 1) * 1000) / 1000;
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${alpha})`;
}
