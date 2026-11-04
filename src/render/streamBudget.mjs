/**
 * On-screen track stream budget: **single source of truth**. The stream partitioning side
 * (`planStreams` in prerender process `server/frame-stream.mjs`, online page
 * `src/online/pageStreamPlan.ts`) uses it to decide when to merge adjacent standalone heavy cards
 * into a group stream; the stream pasting side (parent page `src/editor/snapshotFeed.ts`, stage
 * `src/render/streamPlayer.ts`) uses it to decide on this tick which layers paste streams and
 * which layers exceed budget and display placeholders. Both sides share the same criteria and
 * the same numbers.
 *
 * # Criteria: count pixels, not stream count
 *
 * The cost of a stream = its **encoded aspect ratio** (width × height after top-and-bottom
 * splicing, computed by the rectangular upper bound of this stream) × frame rate, in units of
 * "pixels to decode per second". Three rules, identical across page and server:
 *
 *   1. No more than `STREAM_FREE_COUNT` (6) streams on-screen: **pass regardless of pixel count**.
 *      The original budget was simply "6 streams on-screen" without checking pixels, so whatever
 *      passed previously continues to pass as-is: in 4K and high-frame-rate projects, a stream's
 *      pixels are several times those of 1080p, and checking only pixels would cause two or three
 *      on-screen streams to exceed budget;
 *   2. More than 6 streams: the combined cost of all streams must not exceed
 *      `STREAM_PIXEL_RATE_BUDGET`;
 *   3. Hard limit on stream count: `STREAM_COUNT_BUDGET` (32).
 *
 * Why not count stream count (`docs/reports/AGENT-rr-merged-eval.md` Sections 1.3 and 4, measured
 * on an RTX 3080 PC): opening 64 hardware decoders simultaneously outputs frames normally, 30 small
 * cards with one decoder each at 60 fps painted 240 / 240 on time; what stalls is the total
 * hardware decoding throughput per second (approx. 1.78 billion pixels): 12 full-screen cards at
 * 60 fps (3 billion) only painted 6 / 240 on time, while at 30 fps (1.5 billion) painted
 * 118-120 / 120.
 *
 * # How these numbers were derived (tier-3 numbers, documented only here)
 *
 *   - `STREAM_FREE_COUNT` = 6: original stream count budget. Up to 6 streams follow the old approach
 *     without checking pixels (Rule 1 above).
 *   - `STREAM_PIXEL_RATE_BUDGET` = 6 × 1920 × 2176 × 60 ≈ 1.504 billion pixels per second: checked
 *     only from the 7th stream onward. This equals the volume allowed by the original "6 streams
 *     on-screen" on 1080p 60 fps full-screen cards, which is 84% of that PC's measured throughput
 *     (approx. 1.78 billion). Broken down (1080p): 6 full-screen cards at 60 fps, 12 at 30 fps;
 *     41 small cards of 704×864 at 60 fps, 82 at 30 fps (hitting the stream count cap first). In
 *     projects larger than 1080p or higher than 60 fps, 6 full-screen streams already exceed this
 *     number; they pass per Rule 1 (same as before), but not a single stream can be added from the
 *     7th onward. Throughput on other machines (integrated graphics, mobile phones) has not been
 *     measured and should be adjusted per machine periodically.
 *   - `STREAM_BUDGET_MIN_FPS` = 30: projects with frame rate below 30 are calculated at 30. Without
 *     this, a 24 fps project could accommodate 15 full-screen cards, but each stream must retain a
 *     floor of 3 decoded frames (`MIN_FRAMES_PER_STREAM` in `streamPlayer.ts`), causing VRAM to
 *     rise; with this set, floor decoded frames reach at most 12 full-screen cards × 3 frames ≈
 *     225 MB (previously 6 cards × 3 frames ≈ 113 MB).
 *   - `STREAM_COUNT_BUDGET` = 32: after stream planes share a single WebGL context, stream count
 *     leaves only decoder count and floor decoded frames per stream to manage. Measured: 64 decoders
 *     ran normally, 30 playing one stream each painted fully on time; take half of the measured
 *     normal value. Floor decoded frames for 32 small-card streams take approx. 87 MB. When pasting
 *     sparse versions only, another much smaller set of numbers applies; see the next section.
 *
 * # Budget when only one stage is present (lite mode and lowest tier, when online browser performance is insufficient): `sparseStreamBudget()`
 *
 * In this tier, each stream **decodes only the first frame per segment** (`presentFirst` in
 * `streamPlayer.ts`; (user decision, 2026-10-13) "paste sparse version only when performance is
 * insufficient, keeping fewer concurrently alive decoders", assigned from 2026-10-22 to pages with
 * only one stage (lite mode and lowest tier), "Three gates" [ruling] in `mechanism/platforms.md`).
 * In a 30 fps project, a stream decodes two frames per second; what is spent is not "pixels decoded
 * per second", but the number of concurrently open decoders and retained frames. Therefore, cost in
 * this tier is not multiplied by project frame rate, but calculated uniformly as "encoded aspect
 * ratio × `STREAM_BUDGET_MIN_FPS`" (caller passes frame rate as `STREAM_BUDGET_MIN_FPS`), so the
 * pixel budget equals the cap on the sum of encoded aspect ratios across on-screen streams. Not
 * measured on a real phone; all three numbers are conservative starting points (see "What to measure
 * on real phones" in `docs/reports/AGENT-rr-lowmem-streams.md`):
 *
 *   - `SPARSE_STREAM_COUNT` = 4: no more than 4 concurrently open decoders. How many concurrent
 *     channels mobile hardware H.264 decoders can open varies across vendors, with no guaranteed
 *     lower bound; user-provided example is 2 channels, and 4 is a value that "common entry-level
 *     phones can also open, and if not, the browser can fall back to software decoding".
 *   - `SPARSE_STREAM_PIXELS` = 2 × 1920 × 2176: sum of encoded aspect ratios of all on-screen
 *     streams does not exceed two 1080p full-screen cards. In steady state, each stream retains
 *     only that one decoded frame on canvas (two at the moment of switching segments); at 1.5 bytes
 *     per pixel for NV12: steady state approx. 12.5 MB, instantaneous peak approx. 25 MB (decoded
 *     frame budget for dual stage is 80 MB). Streams are clipped to the entity box, and small cards
 *     are far smaller than full screen: four 704×864 small cards total approx. 5 MB.
 *   - `SPARSE_STREAM_FREE` = 1: first stream does not check pixels. Without this, in projects larger
 *     than 1080p, a single full-screen card would exceed budget and not a single one could be
 *     pasted.
 *
 * Layers exceeding budget follow the approach of other tiers: parent page marks `over`, stage
 * creates no decoders, and placeholders are displayed (`snapshotFeed.ts`). This set of numbers is
 * only used on the stream pasting side (stream generation and partitioning follow their respective
 * rules).
 *
 * Pure function; shared between server and page (having `server/` import `.mjs` under `src/render/`
 * is established practice).
 */
import { resolveFrameSize } from '../kernel/frameSize.mjs';

/** Number of black padding lines padded under each of the upper and lower halves; same value as `STREAM_HALF_PAD` in `streamEncode.ts` and `pad=iw:ih+8` in ffmpeg filters (verified by gatekeeper unit tests) */
export const STREAM_BUDGET_HALF_PAD = 8;
/** Number of pixels by which the rectangular upper bound of a single-card stream exceeds the box; same value as `LOCAL_OVERFLOW_PX` in `server/frame-stream.mjs` (verified by gatekeeper unit tests) */
export const STREAM_BUDGET_OVERFLOW_PX = 32;

/** Cap on the sum of pixels to decode per second across on-screen streams (see file header) */
export const STREAM_PIXEL_RATE_BUDGET = 6 * 1920 * 2176 * 60;
/** Hard cap on the number of on-screen streams (see file header) */
export const STREAM_COUNT_BUDGET = 32;
/** Pixels are not checked when on-screen streams do not exceed this count (original stream count budget; see file header) */
export const STREAM_FREE_COUNT = 6;
/** Lower bound on frame rate when calculating cost (see file header) */
export const STREAM_BUDGET_MIN_FPS = 30;
/** Streams with unknown encoded aspect ratio (legacy messages omitting this item) are calculated as one 1920×1080 full-screen card */
export const STREAM_DEFAULT_PIXELS = 1920 * 2176;

/** When pasting sparse version only: cap on concurrently open decoder count (see file header "Budget when pasting sparse version only") */
export const SPARSE_STREAM_COUNT = 4;
/** When pasting sparse version only: cap on the sum of encoded aspect ratios across on-screen streams (see file header) */
export const SPARSE_STREAM_PIXELS = 2 * STREAM_DEFAULT_PIXELS;
/** When pasting sparse version only: the first this many streams do not check pixels (see file header) */
export const SPARSE_STREAM_FREE = 1;

/**
 * Budget when only pasting the sparse version, with the same shape as the argument to
 * `streamBudgetOf`. Its matching cost must be calculated with
 * `streamCost(pixels, STREAM_BUDGET_MIN_FPS)` (not multiplied by the project frame rate; see the
 * file header).
 */
export function sparseStreamBudget() {
  return { count: SPARSE_STREAM_COUNT, pixelRate: SPARSE_STREAM_PIXELS * STREAM_BUDGET_MIN_FPS, free: SPARSE_STREAM_FREE };
}

/** Pixel count of the encoded aspect ratio: rect width × (2 × rect height + two black borders) */
export function streamCodedPixels(w, h) {
  if (!(w > 0) || !(h > 0)) return 0;
  return Math.ceil(w) * (2 * Math.ceil(h) + 2 * STREAM_BUDGET_HALF_PAD);
}

const even = (n) => (n % 2 ? n + 1 : n);

/**
 * Encoded aspect ratio of streams produced in stage coordinates (group streams, below-dependent
 * streams): the rect upper bound is the full frame
 */
export function stageStreamPixels(stage) {
  const w = Math.max(2, Math.ceil(Number(stage?.width) || 0)), h = Math.max(2, Math.ceil(Number(stage?.height) || 0));
  return streamCodedPixels(even(w), even(h));
}

/**
 * Width and height of the single-card stream rectangle upper bound: the wrapper layer box is
 * expanded by `STREAM_BUDGET_OVERFLOW_PX`, clamped within the frame, and width and height are
 * expanded to even numbers. Same formula as `localPlacement(...).bound` in
 * `server/frame-stream.mjs` (verified size by size in gatekeeper unit tests).
 */
export function localStreamBoundSize(frame, stage) {
  const size = resolveFrameSize(frame, stage);
  const w = Math.max(2, Math.ceil(size.w)), h = Math.max(2, Math.ceil(size.h));
  const side = (len, full) => {
    // The box is centered in the isolated project: in plane coordinates, the frame covers
    // [-o, full - o]; after expanding the box, it is [-pad, len + pad]
    const o = Math.max(0, Math.floor((full - len) / 2));
    const lo = -o, hi = full - o;
    let a = Math.max(lo, -STREAM_BUDGET_OVERFLOW_PX), b = Math.min(hi, len + STREAM_BUDGET_OVERFLOW_PX);
    if (b - a < 2) { b = Math.min(hi, a + 2); a = b - 2; }
    if ((b - a) % 2) { if (b < hi) b++; else a--; }
    return Math.max(0, b - a);
  };
  return { w: side(w, Number(stage?.width) || 0), h: side(h, Number(stage?.height) || 0) };
}

/** Encoded aspect ratio of a single-card stream */
export function localStreamPixels(frame, stage) {
  const { w, h } = localStreamBoundSize(frame, stage);
  return streamCodedPixels(w, h);
}

/**
 * Cost of a stream: pixels to decode per second. If `pixels` is not positive (unknown),
 * calculate as `STREAM_DEFAULT_PIXELS`.
 */
export function streamCost(pixels, fps) {
  const px = pixels > 0 ? pixels : STREAM_DEFAULT_PIXELS;
  return px * Math.max(STREAM_BUDGET_MIN_FPS, Number(fps) || 0);
}

/**
 * Budget `{ count, pixelRate, free }`: hard count limit, pixel budget, and stream count that
 * ignores pixels. If omitted, uses the production numbers; passing a single number changes only
 * the count limit (`PROMPTCUT_STREAM_DECODERS`, used by probes to squeeze the budget to 1 to force
 * group streams); passing an object can change all three (unit tests). `free` will not be larger
 * than the count limit.
 */
export function streamBudgetOf(budget) {
  const pick = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);
  const of = (count, pixelRate, free) => ({ count, pixelRate, free: Math.min(count, Number.isFinite(free) && free >= 0 ? Math.floor(free) : STREAM_FREE_COUNT) });
  if (typeof budget === 'number') return of(pick(Math.floor(budget), STREAM_COUNT_BUDGET), STREAM_PIXEL_RATE_BUDGET, undefined);
  return of(pick(Math.floor(budget?.count), STREAM_COUNT_BUDGET), pick(budget?.pixelRate, STREAM_PIXEL_RATE_BUDGET), budget?.free);
}

/**
 * Which streams fit into the budget on this tick. `costs`: costs of each stream (`streamCost`)
 * sorted by priority. Returns indices of streams allowed through.
 * The first `free` streams do not check pixels (streams that passed before continue to pass);
 * after that, if a stream's pixels cannot fit, skip it and keep checking subsequent ones (smaller
 * ones later may still fit); stop once the stream count reaches the hard limit.
 */
export function withinStreamBudget(costs, budget) {
  const { count, pixelRate, free } = streamBudgetOf(budget);
  const out = [];
  let used = 0;
  for (let i = 0; i < costs.length; i++) {
    if (out.length >= count) break;
    const cost = costs[i] > 0 ? costs[i] : 0;
    if (out.length >= free && used + cost > pixelRate) continue;
    used += cost;
    out.push(i);
  }
  return out;
}

/**
 * Maximum overlap count of an interval set on the same frame, and which frame the peak occurs
 * on. If `skip` (a set of frame numbers) is provided, these frames are not considered candidates:
 * returns the frame with the most overlap among the remaining frames.
 */
export function peakConcurrency(intervals, skip = null) {
  const events = [];
  for (const it of intervals) { events.push([it.from, 1]); events.push([it.to + 1, -1]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0, at = 0;
  for (const [frame, d] of events) { cur += d; if (cur > peak && !skip?.has(frame)) { peak = cur; at = frame; } }
  return { peak, at };
}

/**
 * Same as above, but sums the cost of each stream (`cost`, defaulting to 0 if omitted): peak
 * sum of costs on the same frame. If `moreThan` is provided, only inspect frames where the
 * on-screen stream count **exceeds** it (frames whose stream count does not exceed it do not
 * check pixels); the returned `count` is the stream count on that peak frame.
 */
export function peakCost(intervals, skip = null, moreThan = 0) {
  const byFrame = new Map();
  const add = (frame, n, c) => { const e = byFrame.get(frame) ?? [0, 0]; e[0] += n; e[1] += c; byFrame.set(frame, e); };
  for (const it of intervals) {
    const c = it.cost > 0 ? it.cost : 0;
    add(it.from, 1, c);
    add(it.to + 1, -1, -c);
  }
  let n = 0, cur = 0, peak = 0, at = 0, count = 0;
  for (const frame of [...byFrame.keys()].sort((a, b) => a - b)) {
    const [dn, dc] = byFrame.get(frame);
    n += dn; cur += dc;
    if (n > moreThan && cur > peak && !skip?.has(frame)) { peak = cur; at = frame; count = n; }
  }
  return { peak, at, count };
}

/**
 * When on-screen streams exceed the budget, merge **adjacent** standalone heavy cards into a
 * group stream (G1: "this is the only merge rule").
 *
 * `streams`: single-card streams sorted in painter's order
 * `[{ clipIds: [id], order, from, to, cost }]`; `layers`: all frame layers; `budget`: see
 * `streamBudgetOf`; `groupCost`: cost of one group stream (group streams are produced for the
 * whole frame, regardless of member count). When `cost` is omitted on all items, only stream count
 * is checked, exactly as before switching to counting pixels.
 *
 * Check the hard count limit first, then pixels:
 *   - Count exceeds the hard limit: on the frame with the most overlap, pick two streams that are
 *     **immediately adjacent** in painter's order (with no other frame layers interposed between
 *     them during their merged time range) and merge them;
 *   - Count does not exceed the hard limit: only check frames with **more than `free` streams** on
 *     screen (those not exceeding it do not check pixels; streams that passed before continue to
 *     pass). If pixels exceed the budget, on the frame with the largest cost, likewise only look
 *     at immediately adjacent streams, picking the pair where "merging reduces this frame's
 *     pixels to decode the most" (if tied, pick the earliest in painter's order). Do not merge if
 *     merging does not reduce pixels: merging two small cards into a full-frame group stream is
 *     actually more expensive. The exception is when this frame has exactly one more stream than
 *     `free`, where merging one stream drops back into the count that ignores pixels, so merge
 *     anyway. If none can be found on this frame, move to the next frame that exceeds the budget.
 * Repeat until none exceed the budget, or no mergeable pair can be found. Returns the merged list
 * (each item's `clipIds` is in painter's order, with the last being the topmost card).
 *
 * `fixed`: streams that do not participate in merging but still consume budget (below-dependent
 * streams, two categories of cards that form streams on their own) `[{ from, to, cost }]`. They
 * only count toward the peak, are not picked for merging, and do not appear in the result. They
 * already have their own layer in `layers`; when sandwiched between two cards, they still block
 * those two cards from merging. When they are present, the peak frame might not have a mergeable
 * pair (streams crowded there are all unmergeable), while other over-budget frames do: if none can
 * be found on this frame, record it into `tried`, switch to the next over-budget frame, and start
 * over from the beginning once a merge succeeds.
 */
export function groupStreams(streams, layers, budget = undefined, fixed = [], groupCost = 0) {
  const { count: maxCount, pixelRate, free } = streamBudgetOf(budget);
  let list = streams.map(s => ({ ...s, clipIds: [...s.clipIds] }));
  const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;
  const tried = new Set();
  for (let guard = 0; guard < 1000; guard++) {
    const all = fixed.length ? [...list, ...fixed] : list;
    let byCost = false, lastFree = false;
    let { peak, at } = fixed.length ? peakConcurrency(all, tried) : peakConcurrency(all);
    if (peak <= maxCount) {
      byCost = true;
      let count = 0;
      ({ peak, at, count } = peakCost(all, tried, free));
      if (peak <= pixelRate) break;
      // This frame has exactly one more stream than the count that ignores pixels: merging any pair
      // is fine
      lastFree = count === free + 1;
    }
    const active = list.map((s, i) => ({ s, i })).filter(({ s }) => s.from <= at && at <= s.to).sort((a, b) => a.s.order - b.s.order);
    // A mergeable pair on this frame: if the count is exceeded, take the earliest in painter's order
    // (the original rule); when merging solely to save pixels, take the one that saves the most (if
    // tied, take the earliest)
    let pick = null;
    for (let k = 0; k + 1 < active.length; k++) {
      const lo = active[k].s, hi = active[k + 1].s;
      const saving = (lo.cost > 0 ? lo.cost : 0) + (hi.cost > 0 ? hi.cost : 0) - groupCost;
      // Merging solely to save pixels: do not merge if this frame does not decrease after merging
      // (merging two small cards into a full-frame group stream is actually more expensive)
      if (byCost && !lastFree && !(saving > 0)) continue;
      if (pick && !(saving > pick.saving)) continue;
      const span = { from: Math.min(lo.from, hi.from), to: Math.max(lo.to, hi.to) };
      const members = new Set([...lo.clipIds, ...hi.clipIds]);
      const minOrder = Math.min(lo.order, lo.minOrder ?? lo.order, hi.minOrder ?? hi.order);
      const maxOrder = Math.max(hi.order, lo.order);
      const blocked = layers.some(l => !members.has(l.clipId) && l.order > minOrder && l.order < maxOrder && overlaps(l, span));
      if (blocked) continue;
      pick = { k, saving, next: { clipIds: [...lo.clipIds, ...hi.clipIds], order: maxOrder, minOrder, from: span.from, to: span.to, ...(groupCost > 0 ? { cost: groupCost } : {}) } };
      if (!byCost) break;
    }
    const merged = !!pick;
    if (pick) {
      const drop = new Set([active[pick.k].i, active[pick.k + 1].i]);
      list = list.filter((_, i) => !drop.has(i));
      list.push(pick.next);
      list.sort((a, b) => a.order - b.order);
    }
    if (!merged && !byCost && !fixed.length) break;
    if (merged) tried.clear(); else tried.add(at);
  }
  return list;
}
