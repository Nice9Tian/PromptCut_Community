/**
 * remotion-style framework: seeded randomness.
 *
 * The stage pins `Math.random` to a seeded one (`../pinEntropy.ts`), but it advances one step on every
 * call: which number frame N gets depends on how many calls were made before. Playing from the start
 * and jumping straight to frame N make different numbers of calls, so they get different numbers.
 *
 * The randomness here has no "next one": each number is computed directly from "seed + index",
 * independent of call order and of how many calls were made. The same seed and the same set of
 * indexes give the same number on whichever frame and whichever machine it is computed. The algorithm
 * uses only 32-bit integer operations (`Math.imul`, shifts, xor).
 */

/** A seed or an index: an integer, any finite number, or a string will do */
export type RandomKey = number | string;

/** 32-bit mixing (the finalizer of MurmurHash3) */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}

/** String → 32 bits (FNV-1a, then mixed once more) */
function hashString(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return fmix32(h);
}

function hashKey(key: RandomKey, what: string): number {
  if (typeof key === "number") {
    if (!Number.isFinite(key)) throw new Error(`${what} must be a finite number or a string, got ${key}`);
    // 32-bit integers are mixed directly; other numbers (fractions, large numbers) are mixed as a string
    // of their decimal notation, which the language specification determines uniquely
    return Number.isInteger(key) && key >= -0x80000000 && key <= 0x7fffffff ? fmix32(key | 0) : hashString(`n:${key}`);
  }
  if (typeof key === "string") return hashString(`s:${key}`);
  throw new Error(`${what} must be a number or a string, got ${key === null ? "null" : typeof key}`);
}

function hashOf(seed: RandomKey, keys: readonly RandomKey[]): number {
  let h = hashKey(seed, "random seed");
  for (let i = 0; i < keys.length; i++) h = fmix32(Math.imul(h ^ 0x9e3779b9, 0x01000193) ^ hashKey(keys[i], "random index"));
  return h;
}

/**
 * A number in [0, 1), computed directly from the seed and the indexes after it. Without a seed it
 * gives no number.
 *
 * Example: `random(params.seed, i)` is the random number of the i-th element; to get another one that
 * is unrelated, add one more index: `random(params.seed, i, "hue")`.
 */
export function random(seed: RandomKey, ...keys: RandomKey[]): number {
  return (fmix32(hashOf(seed, keys) ^ 0x2545f491) >>> 0) / 4294967296;
}

/** A number in [min, max). Example: `randomRange(-20, 20, params.seed, i)` */
export function randomRange(min: number, max: number, seed: RandomKey, ...keys: RandomKey[]): number {
  return min + (max - min) * random(seed, ...keys);
}

/** An integer between min and max (both ends inclusive). Example: `randomInt(1, 6, params.seed, i)` */
export function randomInt(min: number, max: number, seed: RandomKey, ...keys: RandomKey[]): number {
  const lo = Math.ceil(Math.min(min, max)), hi = Math.floor(Math.max(min, max));
  return lo + Math.floor((hi - lo + 1) * random(seed, ...keys));
}

/** Pick one from an array. Example: `randomPick(["#f43", "#3af", "#fc3"], params.seed, i)` */
export function randomPick<T>(items: readonly T[], seed: RandomKey, ...keys: RandomKey[]): T {
  if (!items.length) throw new Error("randomPick array is empty");
  return items[Math.floor(items.length * random(seed, ...keys))];
}

/**
 * A random value that rises and falls smoothly with x, in the range −1~1: at integer values of x the
 * numbers are unrelated random numbers, with smooth transitions in between.
 * For effects like "keeps swaying gently"; x is usually `t * speed`; it is a function of x, not
 * accumulated step by step.
 *
 * Example: `noise(t * 2, params.seed, i) * 12` makes the i-th element sway left and right about twice
 * a second, with an amplitude of 12 pixels.
 */
export function noise(x: number, seed: RandomKey, ...keys: RandomKey[]): number {
  if (!Number.isFinite(x)) throw new Error(`noise x must be a finite number, got ${x}`);
  const base = Math.floor(x);
  const f = x - base;
  const a = random(seed, ...keys, base) * 2 - 1;
  const b = random(seed, ...keys, base + 1) * 2 - 1;
  const s = f * f * f * (f * (f * 6 - 15) + 10); // Quintic smoothing: velocity and acceleration are both 0 at the two ends
  return a + (b - a) * s;
}
