/**
 * remotion-style framework: staggered entrances.
 *
 * When a group of elements comes out one after another, every element uses the same animation, just
 * starting a little later each. `stagger` converts the time t of the whole card into "the time of
 * the index-th element itself", then hands it to `tween` / `spring` / `interpolate` to compute.
 */

export interface StaggerOptions {
  /** How many seconds apart two adjacent elements are */
  each: number;
  /** Second at which the first element starts, default 0 */
  delay?: number;
  /**
   * Which element comes out first: `first` from the head (default), `last` from the tail, `center` from
   * the middle outward to both sides, or give an index (outward from it to both sides).
   * `last` and `center` require `count` to be given as well.
   */
  from?: "first" | "last" | "center" | number;
  /** Total number of elements (required when `from` is `last` / `center`) */
  count?: number;
}

/**
 * The time (seconds) of the index-th element itself: negative before its turn, and 0 at the moment
 * its turn arrives.
 *
 * Example: `tween(stagger(t, i, { each: 0.08 }), { duration: 0.4 })` makes every element start fading
 * in 0.08 seconds later than the previous one.
 */
export function stagger(t: number, index: number, options: StaggerOptions): number {
  const { each, delay = 0, from = "first", count } = options;
  let order: number;
  if (from === "first") order = index;
  else if (typeof from === "number") order = Math.abs(index - from);
  else {
    if (!(typeof count === "number" && count > 0)) throw new Error(`stagger needs count (total number of elements) when from is "${from}"`);
    order = from === "last" ? count - 1 - index : Math.abs(index - (count - 1) / 2);
  }
  return t - delay - order * each;
}

/**
 * How many seconds a group of staggered elements takes to finish entirely: the start time of the last
 * element plus the duration of a single element.
 *
 * Example: `staggerDuration(5, { each: 0.08 }, 0.4)` = 0.72.
 */
export function staggerDuration(count: number, options: StaggerOptions, itemDuration = 0): number {
  if (!(count > 0)) return options.delay ?? 0;
  const from = options.from ?? "first";
  const farthest = from === "first" || from === "last" ? count - 1
    : from === "center" ? (count - 1) / 2
      : Math.max(from, count - 1 - from);
  return (options.delay ?? 0) + Math.max(0, farthest) * options.each + itemDuration;
}
