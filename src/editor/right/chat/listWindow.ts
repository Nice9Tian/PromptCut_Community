/**
 * Windowing of the chat history list (used by MessageList): only render the few items near the visible area, and use placeholder height to hold up the scrollbar for the rest.
 *
 * Only pure functions here, no DOM; unit tests are in listWindow.test.mjs.
 *
 * Coordinate convention: "content coordinates" are counted from the top edge of the first item (excluding the top padding of the scroll area). Item i occupies [off[i], off[i] + h[i]),
 * with a gap between items (the scroll area is a flex column, `gap: 12px`), so off[i + 1] = off[i] + h[i] + gap.
 * Message heights are not fixed: measured ones use the actual measurement (ResizeObserver), unmeasured ones use an estimate.
 */

/** The gap and top/bottom padding of the scroll area .ai-messages (chat.css); the two places must match */
export const LIST_GAP = 12;
export const LIST_PAD = 12;
/** Within this many px of the bottom counts as "at the bottom", and new content keeps sticking to the bottom */
export const BOTTOM_SLACK = 40;
/**
 * Render every entry when the count is at most this [ruling]: a chat of ordinary length behaves
 * exactly as before windowing, and the browser's in-page find (Ctrl+F) still finds every entry.
 * Only very long histories are windowed, which is where full rendering really lags (with 2000
 * entries, every scroll had a 50-109 ms long task in measurements).
 * It was originally 40; the lead session's review raised it to 150: the three-level mechanism
 * change should not let users notice a difference in chats of ordinary length.
 */
export const WINDOW_MIN_ENTRIES = 150;

/** Whether this many entries should be windowed */
export function shouldWindow(n: number, min: number = WINDOW_MIN_ENTRIES): boolean {
  return n > min;
}
/** Max entries in the window (not counting forced renders): keeps the node count down even when small bubbles are dense */
export const WINDOW_MAX_ENTRIES = 44;

/**
 * Prefix offset of every entry: length n + 1, off[i] is the top edge of entry i;
 * off[n] - gap is the total content height (0 when n = 0)
 */
export function prefixOffsets(heights: readonly number[], gap: number = LIST_GAP): number[] {
  const off = new Array<number>(heights.length + 1);
  off[0] = 0;
  for (let i = 0; i < heights.length; i++) off[i + 1] = off[i] + Math.max(0, heights[i]) + gap;
  return off;
}

/** Total content height */
export function contentHeight(off: readonly number[], gap: number = LIST_GAP): number {
  const n = off.length - 1;
  return n <= 0 ? 0 : off[n] - gap;
}

/** Index of the first entry satisfying pred (pred is monotonic: false first, then true); returns n if none does */
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

/**
 * Entries intersecting the content coordinate range [top, bottom): [first, last).
 * Returns an empty range when the range falls in the gap between two entries
 */
export function rangeInView(off: readonly number[], top: number, bottom: number, gap: number = LIST_GAP): { first: number; last: number } {
  const n = off.length - 1;
  // First entry whose bottom edge (off[i + 1] - gap) is below top
  const first = lowerBound(n, (i) => off[i + 1] - gap > top);
  // First entry whose top edge is at or below bottom
  const last = Math.max(first, lowerBound(n, (i) => off[i] >= bottom));
  return { first, last };
}

export interface ViewState {
  /** scrollTop of the scroll area (including top padding) */
  scrollTop: number;
  /** Visible height of the scroll area */
  clientHeight: number;
  /** Currently stuck to the bottom: compute the window as if scrolled to the bottom, so the window follows the end while streaming grows */
  stick: boolean;
}

/**
 * The window to render [first, last): the entries in the visible area, extended above and below by
 * overscan px each, with at most maxEntries entries in total (the entries in the visible area are
 * not bound by this limit; the margins above and below grow alternately, below first).
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
  // When stuck to the bottom, compute as if scrolled to the bottom: scrollTop = pad + total + pad - clientHeight
  const scrollTop = view.stick ? Math.max(0, total + 2 * pad - h) : Math.max(0, view.scrollTop);
  const top = scrollTop - pad;
  const bottom = top + h;
  const vis = rangeInView(off, top, bottom, gap);
  let first = vis.first;
  let last = vis.last;
  // The visible area falls exactly in a gap (or the content is shorter than the visible area): keep at least one entry and grow the margins from it to both sides
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
  /**
   * Spacer: stands for entries [from, to); height = their heights plus the gaps between them
   * (the gap between the spacer itself and the next entry is provided by flex)
   */
  | { kind: "spacer"; from: number; to: number; height: number };

/**
 * Render plan: the entries in the window plus the force-rendered entries (the one streaming, the
 * focused ones, the ones the user touched) in order, with each run of consecutive unrendered
 * entries held up by one spacer.
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

/** Whether the scroll area currently counts as at the bottom */
export function isAtBottom(scrollHeight: number, scrollTop: number, clientHeight: number, slack: number = BOTTOM_SLACK): boolean {
  return scrollHeight - scrollTop - clientHeight <= slack;
}

/**
 * The few most recently touched entries (clicked, key pressed): kept rendered, so a bubble's own
 * state, such as which page it is expanded to or whether a confirmation layer is open, is not lost
 * when scrolling far away unmounts it.
 * The newest goes last, and the oldest is dropped beyond cap. Returns a new array (the original is unchanged).
 */
export function touchRecent(list: readonly string[], key: string, cap: number): string[] {
  const next = list.filter((k) => k !== key);
  next.push(key);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Height bookkeeping: measured heights are recorded by entry key, and unmeasured entries use an estimate.
 *
 * The estimate is fixed once per kind: when freezeAfter entries of a kind have been measured, it
 * takes their average and never changes afterwards (the default value is used before that).
 * A continuously moving average is not used: there are often thousands of unmeasured entries, so
 * every small change in the average moves their total height by thousands of pixels, the scrollbar
 * grows and shrinks, and the distance from the bottom jumps too. Once fixed, the total height
 * changes only by the small amount of an entry that was actually measured.
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

  /** Record one measurement; returns true if the height changed (by more than half a pixel) */
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

  /** Drop records not in keep (chat switched, messages rolled back): otherwise it keeps growing as you switch back and forth */
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
