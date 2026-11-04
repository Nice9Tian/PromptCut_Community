/**
 * Dedicated color for the Agent in the UI (Agent avatar on the rail, etc.): **same lightness and
 * chroma** as the skin accent color (OKLCH L and C unchanged), switching only hue to yellow: easily
 * distinguished from ordinary icons and selection accent colors, while staying just as bright and
 * vivid as the entire skin.
 *
 * Two exceptions:
 *   - When the accent color is already in the yellow-orange range (Amber skin), switch to purple,
 *     otherwise the Agent and accent color clash;
 *   - When the new hue falls outside the sRGB gamut, keep lightness and hue while reducing chroma
 *     step by step to pull it back into the gamut.
 * Pure function, called when skins.ts generates the skin variable --ui-agent.
 */

export interface Oklch {
  l: number;
  c: number;
  /** 0 ~ 360 */
  h: number;
}

/** Yellow hue used for Agent */
export const AGENT_HUE = 95;
/** Alternative hue (purple) used when the accent color is already yellow-orange */
export const AGENT_FALLBACK_HUE = 300;
/** Accent color counts as clashing when this close to yellow hue */
const CLASH_DEG = 40;
/**
 * Minimum yellow chroma when accent color is nearly achromatic (gray), otherwise yellow is
 * indistinguishable
 */
const MIN_CHROMA = 0.09;
/** Fallback when accent color cannot be parsed */
const FALLBACK = "#d6b13c";

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** #rrggbb → OKLCH; returns null on invalid format */
export function oklchOf(hex: string): Oklch | null {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255));
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

/** OKLCH → sRGB (0~1, unclipped, may be out of bounds) */
function rgbOf({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    toGamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    toGamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    toGamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** Angle between two hues (0 ~ 180) */
export function hueGap(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

function toHex(rgb: number[]): string {
  return "#" + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
}

/** Derives Agent color (#rrggbb) from accent color */
export function agentColorFor(accent: string): string {
  const base = oklchOf(accent);
  if (!base) return FALLBACK;
  const hue = base.c > 0.03 && hueGap(base.h, AGENT_HUE) < CLASH_DEG ? AGENT_FALLBACK_HUE : AGENT_HUE;
  const color: Oklch = { l: base.l, c: Math.max(MIN_CHROMA, base.c), h: hue };
  // If out of gamut, binary-search maximum fitting chroma (keeping lightness and hue fixed)
  if (!inGamut(rgbOf(color))) {
    let lo = 0;
    let hi = color.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(rgbOf({ ...color, c: mid }))) lo = mid;
      else hi = mid;
    }
    color.c = lo;
  }
  return toHex(rgbOf(color));
}
