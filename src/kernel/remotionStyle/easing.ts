/**
 * remotion-style framework: easing curves.
 *
 * An easing is a pure function that maps a progress p (0~1) to another progress. Each one here looks
 * only at the p passed in and remembers nothing, so the same p always gives the same result.
 */

/** Easing function: progress 0~1 → eased progress (rebounding ones may go slightly past 0 or 1) */
export type EasingFn = (p: number) => number;

const linear: EasingFn = (p) => p;
const quad: EasingFn = (p) => p * p;
const cubic: EasingFn = (p) => p * p * p;
const quart: EasingFn = (p) => p * p * p * p;
const sin: EasingFn = (p) => 1 - Math.cos((p * Math.PI) / 2);
const circ: EasingFn = (p) => 1 - Math.sqrt(1 - Math.min(1, p * p));
const expo: EasingFn = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, 10 * (p - 1)));

/** Bounces a few times after landing (start 0, end 1; combinations other than `Easing.out` also work) */
const bounce: EasingFn = (p) => {
  if (p < 1 / 2.75) return 7.5625 * p * p;
  if (p < 2 / 2.75) { const q = p - 1.5 / 2.75; return 7.5625 * q * q + 0.75; }
  if (p < 2.5 / 2.75) { const q = p - 2.25 / 2.75; return 7.5625 * q * q + 0.9375; }
  const q = p - 2.625 / 2.75;
  return 7.5625 * q * q + 0.984375;
};

/** Pulls back a little first, then goes out; the larger `overshoot` is, the more it pulls back */
const back = (overshoot = 1.70158): EasingFn => (p) => p * p * ((overshoot + 1) * p - overshoot);

/** Settles into place swinging back and forth like a rubber band; larger `bounciness` swings more */
const elastic = (bounciness = 1): EasingFn => {
  const k = bounciness * Math.PI;
  return (p) => 1 - Math.pow(Math.cos((p * Math.PI) / 2), 3) * Math.cos(p * k);
};

/** Use a "slow start" curve as is (slow start, fast finish) */
const easeInOf = (e: EasingFn): EasingFn => e;
/** Use a "slow start" curve reversed (fast start, slow finish) */
const easeOutOf = (e: EasingFn): EasingFn => (p) => 1 - e(1 - p);
/** Slow start in the first half, slow finish in the second half */
const easeInOutOf = (e: EasingFn): EasingFn => (p) => (p < 0.5 ? e(p * 2) / 2 : 1 - e((1 - p) * 2) / 2);

/**
 * Cubic Bezier curve; the four numbers mean the same as in CSS `cubic-bezier(x1, y1, x2, y2)` and in
 * Motion's `ease: [x1, y1, x2, y2]`.
 * x1 and x2 must be between 0 and 1.
 */
function bezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw new Error(`Invalid arguments for Easing.bezier: x1 and x2 must be between 0 and 1, got (${x1}, ${y1}, ${x2}, ${y2})`);
  }
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  /**
   * Solve for the curve parameter u from x: Newton's method first, then bisection if that does not
   * converge. The number of steps is fixed, so the result depends on x alone
   */
  const solve = (x: number) => {
    let u = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(u) - x;
      if (Math.abs(dx) < 1e-7) return u;
      const d = slopeX(u);
      if (Math.abs(d) < 1e-6) break;
      u -= dx / d;
    }
    let lo = 0, hi = 1;
    u = x;
    for (let i = 0; i < 40; i++) {
      const dx = sampleX(u) - x;
      if (Math.abs(dx) < 1e-7) break;
      if (dx > 0) hi = u; else lo = u;
      u = (lo + hi) / 2;
    }
    return u;
  };
  return (p) => (p <= 0 ? 0 : p >= 1 ? 1 : sampleY(solve(p)));
}

/**
 * Moves in `count` jumping steps; when `atEnd` is true each step jumps only at the end of its
 * interval (same as CSS `steps(n, end)`)
 */
function steps(count: number, atEnd = true): EasingFn {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Easing.steps count must be a positive integer, got ${count}`);
  return (p) => {
    const q = Math.min(1, Math.max(0, p));
    const n = atEnd ? Math.floor(q * count) : Math.ceil(q * count);
    return Math.min(1, n / count);
  };
}

/** `p` to the power `n` (`poly(2)` is `quad`, `poly(4)` is `quart`) */
function poly(n: number): EasingFn {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`Easing.poly exponent must be a number, got ${describe(n)}. Usage: \`Easing.poly(4)\`, which equals \`Easing.quart\`.`);
  }
  return (p) => Math.pow(p, n);
}

/** Render the received value in a human-readable form in error messages */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || value == null || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? "array" : typeof value === "function" ? "function" : "object";
}

/**
 * The full set of easing curves. The base curves (`quad`, `cubic`, ...) all have a "slow start" shape;
 * use `Easing.out(...)` and `Easing.inOut(...)` to change direction; the three most common ones also
 * have ready-made names `easeIn`, `easeOut`, `easeInOut` (cubic curves).
 *
 * There are also four aliases named after Remotion: `circle` is `circ`, `exp` is `expo` (the same
 * function); `ease` is the cubic Bezier `(0.42, 0, 1, 1)`, with a slow start, and is not the same
 * thing as the three cubic curves above; `poly(n)` is `p` to the power `n`.
 */
export const Easing = Object.freeze({
  linear,
  quad,
  cubic,
  quart,
  sin,
  circ,
  expo,
  bounce,
  back,
  elastic,
  in: easeInOf,
  out: easeOutOf,
  inOut: easeInOutOf,
  bezier,
  steps,
  easeIn: cubic,
  easeOut: easeOutOf(cubic),
  easeInOut: easeInOutOf(cubic),
  circle: circ,
  exp: expo,
  ease: bezier(0.42, 0, 1, 1),
  poly,
});
