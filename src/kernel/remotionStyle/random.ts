/**
 * remotion 式的框架：带种子的随机。
 *
 * 舞台把 `Math.random` 钉成了带种子的（`../pinEntropy.ts`），但它每调一次往前走一步：第 N 帧拿到哪个数，
 * 取决于前面一共调过几次。从头顺着播和直接跳到第 N 帧，调用次数不一样，拿到的数就不一样。
 *
 * 这里的随机没有「下一个」：每个数由「种子 + 序号」直接算出来，跟调用的先后、调过几次都无关。
 * 同一个种子、同一组序号，在哪一帧、哪台机器上算都是同一个数。算法只用 32 位整数运算（`Math.imul`、移位、异或）。
 */

/** 种子或序号：整数、任意有限的数、字符串都可以 */
export type RandomKey = number | string;

/** 32 位混合（MurmurHash3 的收尾步骤） */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}

/** 字符串 → 32 位（FNV-1a，再混合一次） */
function hashString(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return fmix32(h);
}

function hashKey(key: RandomKey, what: string): number {
  if (typeof key === "number") {
    if (!Number.isFinite(key)) throw new Error(`${what}要是有限的数或字符串，收到 ${key}`);
    // 32 位整数直接混；别的数（小数、大数）按它的十进制写法当字符串混，写法由语言规范唯一确定
    return Number.isInteger(key) && key >= -0x80000000 && key <= 0x7fffffff ? fmix32(key | 0) : hashString(`n:${key}`);
  }
  if (typeof key === "string") return hashString(`s:${key}`);
  throw new Error(`${what}要是数或字符串，收到 ${key === null ? "null" : typeof key}`);
}

function hashOf(seed: RandomKey, keys: readonly RandomKey[]): number {
  let h = hashKey(seed, "随机的种子");
  for (let i = 0; i < keys.length; i++) h = fmix32(Math.imul(h ^ 0x9e3779b9, 0x01000193) ^ hashKey(keys[i], "随机的序号"));
  return h;
}

/**
 * [0, 1) 里的一个数，由种子和后面的序号直接算出。没有种子不给数。
 *
 * 例：`random(params.seed, i)` —— 第 i 个元素的随机数；再要一个互不相干的就多加一个序号：`random(params.seed, i, "hue")`。
 */
export function random(seed: RandomKey, ...keys: RandomKey[]): number {
  return (fmix32(hashOf(seed, keys) ^ 0x2545f491) >>> 0) / 4294967296;
}

/** [min, max) 里的一个数。例：`randomRange(-20, 20, params.seed, i)` */
export function randomRange(min: number, max: number, seed: RandomKey, ...keys: RandomKey[]): number {
  return min + (max - min) * random(seed, ...keys);
}

/** min 到 max 之间的一个整数（两头都取得到）。例：`randomInt(1, 6, params.seed, i)` */
export function randomInt(min: number, max: number, seed: RandomKey, ...keys: RandomKey[]): number {
  const lo = Math.ceil(Math.min(min, max)), hi = Math.floor(Math.max(min, max));
  return lo + Math.floor((hi - lo + 1) * random(seed, ...keys));
}

/** 从数组里挑一个。例：`randomPick(["#f43", "#3af", "#fc3"], params.seed, i)` */
export function randomPick<T>(items: readonly T[], seed: RandomKey, ...keys: RandomKey[]): T {
  if (!items.length) throw new Error("randomPick 的数组是空的");
  return items[Math.floor(items.length * random(seed, ...keys))];
}

/**
 * 随 x 平滑起伏的随机值，范围 −1～1：x 取整数的地方是互不相干的随机数，中间平滑过渡。
 * 给「一直在轻轻晃」这类效果用，x 通常是 `t * 速度`；它是 x 的函数，不是一步步累加出来的。
 *
 * 例：`noise(t * 2, params.seed, i) * 12` —— 第 i 个元素每秒晃两下左右，幅度 12 像素。
 */
export function noise(x: number, seed: RandomKey, ...keys: RandomKey[]): number {
  if (!Number.isFinite(x)) throw new Error(`noise 的 x 要是有限的数，收到 ${x}`);
  const base = Math.floor(x);
  const f = x - base;
  const a = random(seed, ...keys, base) * 2 - 1;
  const b = random(seed, ...keys, base + 1) * 2 - 1;
  const s = f * f * f * (f * (f * 6 - 15) + 10); // 五次平滑：两端的速度、加速度都是 0
  return a + (b - a) * s;
}
