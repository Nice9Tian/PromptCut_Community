/**
 * remotion 式的框架：错开进场。
 *
 * 一组元素一个接一个出来时，每个元素用的是同一段动画、只是各自晚一点开始。`stagger` 把整张卡的时间 t
 * 换算成「第 index 个元素自己的时间」，再交给 `tween` / `spring` / `interpolate` 去算。
 */

export interface StaggerOptions {
  /** 相邻两个元素相隔多少秒 */
  each: number;
  /** 第一个元素从第几秒开始，缺省 0 */
  delay?: number;
  /**
   * 从哪个元素先出：`first` 从头（缺省）、`last` 从尾、`center` 从中间往两边，或者给一个下标（从它往两边）。
   * `last` 和 `center` 要同时给 `count`。
   */
  from?: "first" | "last" | "center" | number;
  /** 一共多少个元素（`from` 是 `last` / `center` 时必填） */
  count?: number;
}

/**
 * 第 index 个元素自己的时间（秒）：还没轮到它时是负数，轮到的那一刻是 0。
 *
 * 例：`tween(stagger(t, i, { each: 0.08 }), { duration: 0.4 })` —— 每个元素比前一个晚 0.08 秒开始淡入。
 */
export function stagger(t: number, index: number, options: StaggerOptions): number {
  const { each, delay = 0, from = "first", count } = options;
  let order: number;
  if (from === "first") order = index;
  else if (typeof from === "number") order = Math.abs(index - from);
  else {
    if (!(typeof count === "number" && count > 0)) throw new Error(`stagger 的 from 是 "${from}" 时要给 count（一共多少个元素）`);
    order = from === "last" ? count - 1 - index : Math.abs(index - (count - 1) / 2);
  }
  return t - delay - order * each;
}

/**
 * 一组错开进场的元素全部走完要多少秒：最后一个元素开始的时刻加上单个元素的时长。
 *
 * 例：`staggerDuration(5, { each: 0.08 }, 0.4)` = 0.72。
 */
export function staggerDuration(count: number, options: StaggerOptions, itemDuration = 0): number {
  if (!(count > 0)) return options.delay ?? 0;
  const from = options.from ?? "first";
  const farthest = from === "first" || from === "last" ? count - 1
    : from === "center" ? (count - 1) / 2
      : Math.max(from, count - 1 - from);
  return (options.delay ?? 0) + Math.max(0, farthest) * options.each + itemDuration;
}
