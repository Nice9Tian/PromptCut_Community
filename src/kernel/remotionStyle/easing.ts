/**
 * remotion 式的框架：缓动曲线。
 *
 * 一条缓动就是一个把进度 p（0～1）映射成另一个进度的纯函数。这里的每一个都只看传进来的 p，
 * 不记任何东西，同一个 p 永远得同一个结果。
 */

/** 缓动函数：进度 0～1 → 缓动后的进度（回弹类的可以略微越过 0 或 1） */
export type EasingFn = (p: number) => number;

const linear: EasingFn = (p) => p;
const quad: EasingFn = (p) => p * p;
const cubic: EasingFn = (p) => p * p * p;
const quart: EasingFn = (p) => p * p * p * p;
const sin: EasingFn = (p) => 1 - Math.cos((p * Math.PI) / 2);
const circ: EasingFn = (p) => 1 - Math.sqrt(1 - Math.min(1, p * p));
const expo: EasingFn = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, 10 * (p - 1)));

/** 落地后弹几下（起点 0、终点 1；配 `Easing.out` 以外的组合也可以） */
const bounce: EasingFn = (p) => {
  if (p < 1 / 2.75) return 7.5625 * p * p;
  if (p < 2 / 2.75) { const q = p - 1.5 / 2.75; return 7.5625 * q * q + 0.75; }
  if (p < 2.5 / 2.75) { const q = p - 2.25 / 2.75; return 7.5625 * q * q + 0.9375; }
  const q = p - 2.625 / 2.75;
  return 7.5625 * q * q + 0.984375;
};

/** 先往回收一点再出去；`overshoot` 越大收得越多 */
const back = (overshoot = 1.70158): EasingFn => (p) => p * p * ((overshoot + 1) * p - overshoot);

/** 像橡皮筋一样来回晃着到位；`bounciness` 越大晃得越多 */
const elastic = (bounciness = 1): EasingFn => {
  const k = bounciness * Math.PI;
  return (p) => 1 - Math.pow(Math.cos((p * Math.PI) / 2), 3) * Math.cos(p * k);
};

/** 把一条「起步慢」的曲线原样用（起步慢、收尾快） */
const easeInOf = (e: EasingFn): EasingFn => e;
/** 把一条「起步慢」的曲线倒过来用（起步快、收尾慢） */
const easeOutOf = (e: EasingFn): EasingFn => (p) => 1 - e(1 - p);
/** 前半段起步慢、后半段收尾慢 */
const easeInOutOf = (e: EasingFn): EasingFn => (p) => (p < 0.5 ? e(p * 2) / 2 : 1 - e((1 - p) * 2) / 2);

/**
 * 三次贝塞尔曲线，四个数与 CSS 的 `cubic-bezier(x1, y1, x2, y2)`、Motion 的 `ease: [x1, y1, x2, y2]` 是同一个意思。
 * x1、x2 要在 0～1 之间。
 */
function bezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    throw new Error(`Easing.bezier 的参数不对：x1、x2 要在 0～1 之间，收到 (${x1}, ${y1}, ${x2}, ${y2})`);
  }
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  /** 由 x 反解曲线参数 u：先牛顿法，不收敛再二分。步数固定，结果只由 x 决定 */
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

/** 分成 `count` 级台阶跳着走；`atEnd` 为真时每一级在这一段的末尾才跳（同 CSS 的 `steps(n, end)`） */
function steps(count: number, atEnd = true): EasingFn {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Easing.steps 的级数要是正整数，收到 ${count}`);
  return (p) => {
    const q = Math.min(1, Math.max(0, p));
    const n = atEnd ? Math.floor(q * count) : Math.ceil(q * count);
    return Math.min(1, n / count);
  };
}

/** `p` 的 `n` 次方（`poly(2)` 就是 `quad`，`poly(4)` 就是 `quart`） */
function poly(n: number): EasingFn {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`Easing.poly 的次数要是一个数，收到 ${describe(n)}。写法：\`Easing.poly(4)\`，等于 \`Easing.quart\`。`);
  }
  return (p) => Math.pow(p, n);
}

/** 报错里把收到的值写成人看得懂的样子 */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || value == null || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? "数组" : typeof value === "function" ? "函数" : "对象";
}

/**
 * 缓动曲线的全集。基础曲线（`quad`、`cubic`……）都是「起步慢」的形状，用 `Easing.out(...)`、`Easing.inOut(...)` 换方向；
 * 最常用的三条另有现成的名字 `easeIn`、`easeOut`、`easeInOut`（三次曲线）。
 *
 * 另有四个照 Remotion 的名字起的别名：`circle` 就是 `circ`，`exp` 就是 `expo`（同一个函数）；
 * `ease` 是三次贝塞尔 `(0.42, 0, 1, 1)`，起步慢，和上面三条三次曲线不是一回事；`poly(n)` 是 `p` 的 `n` 次方。
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
