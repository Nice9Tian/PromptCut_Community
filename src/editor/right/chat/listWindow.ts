/**
 * 聊天记录列表的窗口化(MessageList 用):只渲染可视区附近的几条,其余用占位高度撑住滚动条。
 *
 * 这里只放纯函数,不碰 DOM,单测在 listWindow.test.mjs。
 *
 * 坐标约定:「内容坐标」从第一条的顶边算起(不含滚动区的上内边距)。第 i 条占 [off[i], off[i] + h[i]),
 * 条与条之间隔 gap(滚动区是 flex 列、`gap: 12px`),所以 off[i + 1] = off[i] + h[i] + gap。
 * 消息高度不固定:量过的按实测(ResizeObserver),没量过的按估计。
 */

/** 滚动区 .ai-messages 的 gap 与上下内边距(chat.css),两处要一致 */
export const LIST_GAP = 12;
export const LIST_PAD = 12;
/** 离底部不超过这么多 px 就算「在底部」,来了新内容接着贴底 */
export const BOTTOM_SLACK = 40;
/**
 * 条数不超过这么多就全渲染〔裁〕:平常长度的对话和窗口化之前一模一样,浏览器的页内查找(Ctrl+F)也照旧找得到每一条。
 * 只有很长的历史才窗口化,那正是全渲染真卡的地方(2000 条实测每次滚动都有 50～109 ms 的长任务)。
 * 原来定 40,主会话审查时提到 150:三级机制的改动不该让用户在平常长度的对话里看出区别。
 */
export const WINDOW_MIN_ENTRIES = 150;

/** 这么多条要不要窗口化 */
export function shouldWindow(n: number, min: number = WINDOW_MIN_ENTRIES): boolean {
  return n > min;
}
/** 窗口里最多这么多条(不算强制渲染的):小气泡很密时余量也不会把节点数撑上去 */
export const WINDOW_MAX_ENTRIES = 44;

/** 每一条的前缀偏移:长度 n + 1,off[i] 是第 i 条的顶边;off[n] - gap 是内容总高(n = 0 时为 0) */
export function prefixOffsets(heights: readonly number[], gap: number = LIST_GAP): number[] {
  const off = new Array<number>(heights.length + 1);
  off[0] = 0;
  for (let i = 0; i < heights.length; i++) off[i + 1] = off[i] + Math.max(0, heights[i]) + gap;
  return off;
}

/** 内容总高 */
export function contentHeight(off: readonly number[], gap: number = LIST_GAP): number {
  const n = off.length - 1;
  return n <= 0 ? 0 : off[n] - gap;
}

/** 第一个满足 pred 的下标(pred 单调:前面 false 后面 true);都不满足回 n */
function lowerBound(n: number, pred: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 和内容坐标区间 [top, bottom) 有交集的条:[first, last)。区间落在两条之间的空隙里时回一个空区间 */
export function rangeInView(off: readonly number[], top: number, bottom: number, gap: number = LIST_GAP): { first: number; last: number } {
  const n = off.length - 1;
  // 底边(off[i + 1] - gap)在 top 以下的第一条
  const first = lowerBound(n, (i) => off[i + 1] - gap > top);
  // 顶边在 bottom 以下(含)的第一条
  const last = Math.max(first, lowerBound(n, (i) => off[i] >= bottom));
  return { first, last };
}

export interface ViewState {
  /** 滚动区的 scrollTop(含上内边距) */
  scrollTop: number;
  /** 滚动区的可视高度 */
  clientHeight: number;
  /** 此刻贴着底:按「滚到底」来算窗口,流式变长时窗口跟着末尾走 */
  stick: boolean;
}

/**
 * 要渲染的窗口 [first, last):可视区里的几条,再往上下各扩到 overscan px,但总条数不超过 maxEntries
 * (可视区本身的条数不受这个上限约束,上下余量交替扩,先扩下面)。
 */
export function windowRange(
  off: readonly number[],
  view: ViewState,
  opts: { overscan: number; maxEntries?: number; gap?: number; pad?: number },
): { first: number; last: number } {
  const gap = opts.gap ?? LIST_GAP;
  const pad = opts.pad ?? LIST_PAD;
  const maxEntries = opts.maxEntries ?? WINDOW_MAX_ENTRIES;
  const n = off.length - 1;
  if (n <= 0) return { first: 0, last: 0 };
  const total = contentHeight(off, gap);
  const h = Math.max(0, view.clientHeight);
  // 贴底时按「滚到底」算:scrollTop = pad + total + pad - clientHeight
  const scrollTop = view.stick ? Math.max(0, total + 2 * pad - h) : Math.max(0, view.scrollTop);
  const top = scrollTop - pad;
  const bottom = top + h;
  const vis = rangeInView(off, top, bottom, gap);
  let first = vis.first;
  let last = vis.last;
  // 可视区正好落在空隙里(或内容比可视区矮):至少留一条,余量从它往两边扩
  if (first >= last) {
    first = Math.min(first, n - 1);
    last = first + 1;
  }
  const upLimit = top - opts.overscan;
  const downLimit = bottom + opts.overscan;
  let turnDown = true;
  for (;;) {
    const canDown = last < n && off[last] < downLimit && last - first < maxEntries;
    const canUp = first > 0 && off[first] - gap > upLimit && last - first < maxEntries;
    if (!canDown && !canUp) break;
    if ((turnDown && canDown) || !canUp) last += 1;
    else first -= 1;
    turnDown = !turnDown;
  }
  return { first, last };
}

export type Segment =
  | { kind: "item"; index: number }
  /** 占位:代表 [from, to) 这几条;高度 = 它们的高度加上它们之间的 gap(占位自己和下一条之间的 gap 由 flex 给) */
  | { kind: "spacer"; from: number; to: number; height: number };

/**
 * 渲染计划:窗口里的条 + 强制渲染的条(流式中的那条、有焦点的、用户动过的)按顺序排好,
 * 中间没渲染的连续几条各用一个占位顶住。
 */
export function planSegments(off: readonly number[], first: number, last: number, forced: Iterable<number>, gap: number = LIST_GAP): Segment[] {
  const n = off.length - 1;
  const show = new Set<number>();
  for (let i = Math.max(0, first); i < Math.min(n, last); i++) show.add(i);
  for (const i of forced) if (i >= 0 && i < n) show.add(i);
  const idx = [...show].sort((a, b) => a - b);
  const out: Segment[] = [];
  let cur = 0;
  const gapTo = (to: number) => {
    if (to > cur) out.push({ kind: "spacer", from: cur, to, height: Math.max(0, off[to] - off[cur] - gap) });
  };
  for (const i of idx) {
    gapTo(i);
    out.push({ kind: "item", index: i });
    cur = i + 1;
  }
  gapTo(n);
  return out;
}

/** 滚动区此刻算不算在底部 */
export function isAtBottom(scrollHeight: number, scrollTop: number, clientHeight: number, slack: number = BOTTOM_SLACK): boolean {
  return scrollHeight - scrollTop - clientHeight <= slack;
}

/**
 * 最近动过的几条(点过、按过键):保持渲染,展开到哪一页、确认层开没开这类气泡自己的状态不因滚远了被卸载而丢。
 * 新的放最后,超过 cap 丢最早的。返回新数组(原数组不变)。
 */
export function touchRecent(list: readonly string[], key: string, cap: number): string[] {
  const next = list.filter((k) => k !== key);
  next.push(key);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * 高度记账:按条的 key 记实测高度,没量过的按估计值。
 *
 * 估计值每类只定一次:同类量满 freezeAfter 条时取它们的平均值,之后不再变(之前用缺省值)。
 * 不用一直跟着变的平均值:没量过的往往有上千条,平均值每动一点,它们的总高就跟着动几千像素,
 * 滚动条忽长忽短,离底部的距离也跟着跳。定下来之后总高只在某条真的量到时变它自己那一点。
 */
export class HeightBook {
  private readonly heights = new Map<string, number>();
  private readonly sums = new Map<string, { sum: number; count: number }>();
  private readonly kinds = new Map<string, string>();
  private readonly defaults: Record<string, number>;
  private readonly frozen = new Map<string, number>();
  private readonly freezeAfter: number;

  constructor(defaults: Record<string, number>, freezeAfter = 3) {
    this.defaults = defaults;
    this.freezeAfter = freezeAfter;
  }

  /** 记一次实测;高度变了(差超过半个像素)回 true */
  set(key: string, kind: string, h: number): boolean {
    if (!(h >= 0) || !Number.isFinite(h)) return false;
    const old = this.heights.get(key);
    if (old !== undefined && Math.abs(old - h) <= 0.5) return false;
    const oldKind = this.kinds.get(key);
    if (old !== undefined && oldKind !== undefined) {
      const s = this.sums.get(oldKind);
      if (s) {
        s.sum -= old;
        s.count -= 1;
      }
    }
    const s = this.sums.get(kind) ?? { sum: 0, count: 0 };
    s.sum += h;
    s.count += 1;
    this.sums.set(kind, s);
    this.heights.set(key, h);
    this.kinds.set(key, kind);
    return true;
  }

  measured(key: string): number | undefined {
    return this.heights.get(key);
  }

  estimate(kind: string): number {
    const f = this.frozen.get(kind);
    if (f !== undefined) return f;
    const s = this.sums.get(kind);
    if (s && s.count >= this.freezeAfter) {
      const avg = s.sum / s.count;
      this.frozen.set(kind, avg);
      return avg;
    }
    return this.defaults[kind] ?? 100;
  }

  get(key: string, kind: string): number {
    return this.heights.get(key) ?? this.estimate(kind);
  }

  /** 丢掉不在 keep 里的记录(对话换了、消息被回退掉):不然切来切去一直涨 */
  prune(keep: ReadonlySet<string>): void {
    for (const k of [...this.heights.keys()]) {
      if (keep.has(k)) continue;
      const h = this.heights.get(k)!;
      const kind = this.kinds.get(k);
      if (kind !== undefined) {
        const s = this.sums.get(kind);
        if (s) {
          s.sum -= h;
          s.count -= 1;
        }
      }
      this.heights.delete(k);
      this.kinds.delete(k);
    }
  }

  get size(): number {
    return this.heights.size;
  }
}
