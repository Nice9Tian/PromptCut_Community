import { CARD_MOUNT_LEAD, mountFrameOf } from './frameWindow.mjs';
import { normalizeFrameMode } from '../kernel/frameMode.mjs';

/**
 * Measured per-frame costs on 1080p30 export (`acc-demo`, `server/bakery/bake.mjs`):
 *   - Pure timeline advance step (`beginFrame({ noDisplayUpdates: true })`, no screenshot): ~3.0 ms/frame.
 *   - Full-frame capture step (render + PNG screenshot): ~25.0 ms/frame.
 * Ratio `ADVANCE_STEP_MS / CAPTURE_SHOT_MS = 0.12` weights how many precedent frames each shard
 * must advance from frame 0 relative to each frame it captures.
 */
const ADVANCE_STEP_MS = 3.0;
const CAPTURE_SHOT_MS = 25.0;
export const DEFAULT_PUSH_WEIGHT = ADVANCE_STEP_MS / CAPTURE_SHOT_MS;

/**
 * Extra 1-frame rounding margin above `Math.ceil(CARD_MOUNT_LEAD * fps)`: `mountFrameOf` mounts at
 * the first frame `n` with `n / fps >= clip.start - CARD_MOUNT_LEAD`, and a fractional `clip.start * fps`
 * can straddle an integer frame boundary by one frame before the card becomes visible.
 */
const MOUNT_LEAD_MARGIN_FRAMES = 1;

/**
 * Number of stepped frames before a stateful card's `mountFrameOf` that must draw a discarded tick
 * (`drawDiscarded` in `server/bakery/bake.mjs`): after non-screenshot `beginFrame` ticks cause
 * `requestAnimationFrame` to stop firing (`scripts/probes/push-draw-probe.mjs`), drawing two ticks
 * ahead of the mount frame (the first with `prime: true`) restores main-thread `rAF` headroom so
 * Motion builds the card's entrance animation at the exact mount frame.
 */
const PUSH_DRAW_WAKE_FRAMES = 2;

/**
 * Minimum shard duration in seconds (`minFrames = Math.round(MIN_SHARD_SECONDS * fps)`): spawning
 * an extra Chrome and loading the export bundle costs ~1-2 s, comparable to capturing 1 s of frames,
 * so shards shorter than one second cost more than they save.
 */
const MIN_SHARD_SECONDS = 1;

export function defaultMaxLeadFrames(fps) {
  return Math.max(1, Math.ceil(CARD_MOUNT_LEAD * fps) + MOUNT_LEAD_MARGIN_FRAMES);
}

/** Frames during which Stage keeps a clip mounted, as [first, last], or null.
 * Same comparisons as planFrameWindow and cardMountedAt, including the mount
 * lead and floating-point boundaries such as 10.05 - 0.05.
 */
export function clipFrameSpan(clip, fps) {
  const first = mountFrameOf(clip, fps);
  let last = Math.ceil(clip.end * fps);
  while (last >= 0 && last / fps >= clip.end) last--;
  while ((last + 1) / fps < clip.end) last++;
  return last >= first ? [first, last] : null;
}

/** Frames at which a shard may start, strictly after startFrame.
 *
 * Every shard advances the timeline from frame 0, but which ticks carry a
 * screenshot still moves Motion/WAAPI anchors (Tokyo project: step-timeline at
 * frame 1962 differed by a frame depending on whether 1961 was captured). A cut
 * inside a stateful card's active life therefore changes pixels; cutting within
 * `maxLeadFrames` of its pre-mount lead is safe when paired with `shardPushDrawFrom`
 * catch-up drawing over those lead frames. Direct cards, media and media effect
 * cards are evaluated at their time and may be cut anywhere. An unknown mode is
 * treated as stateful.
 */
export function shardCutCandidates(clips, startFrame, endFrame, fps, options = {}) {
  const size = endFrame - startFrame;
  if (size <= 0) return [];
  const lead = options.maxLeadFrames === undefined
    ? defaultMaxLeadFrames(fps)
    : Math.max(0, Math.floor(Number(options.maxLeadFrames) || 0));
  const diff = new Int32Array(size + 1);
  for (const clip of clips || []) {
    if (normalizeFrameMode(clip.mode) === 'direct') continue;
    const span = clipFrameSpan(clip, fps);
    if (!span) continue;
    // A boundary before frame c splits this clip when first + lead < c <= last (when lead = 0: first < c <= last).
    const lo = Math.max(span[0] + lead + 1, startFrame + 1), hi = Math.min(span[1], endFrame);
    if (lo > hi) continue;
    diff[lo - startFrame - 1]++;
    diff[hi - startFrame]--;
  }
  const candidates = [];
  for (let i = 0, blocked = 0; i < size; i++) {
    blocked += diff[i];
    if (!blocked) candidates.push(startFrame + 1 + i);
  }
  return candidates;
}

/** Earliest frame before `cutFrame` that must push-draw so any stateful card
 * already mounted at `cutFrame` builds its Motion/WAAPI animations on time, or
 * null when no stateful card spans across `cutFrame`. */
export function shardPushDrawFrom(clips, cutFrame, fps) {
  let earliest = Infinity;
  for (const clip of clips || []) {
    if (normalizeFrameMode(clip.mode) === 'direct') continue;
    const span = clipFrameSpan(clip, fps);
    if (span && span[0] < cutFrame && cutFrame <= span[1]) {
      earliest = Math.min(earliest, span[0]);
    }
  }
  return Number.isFinite(earliest) ? Math.max(0, earliest - PUSH_DRAW_WAKE_FRAMES) : null;
}

/** Exactly `segments` ranges over boundary points: minimise the highest shard
 * cost `(a - startFrame) * pushWeight + (b - a + 1)`, then put each boundary as
 * close to an equal-cost split of the remainder as that limit allows. `points`
 * starts with startFrame and ends with endFrame + 1. */
function planWeightedRanges(points, segments, pushWeight) {
  const lastIdx = points.length - 1;
  const origin = points[0];
  const cost = (i, j) => (points[i] - origin) * pushWeight + (points[j] - points[i]);
  // Greedy farthest reach under a cost limit is optimal for "fewest ranges".
  const fewestRanges = (limit) => {
    let count = 0;
    for (let i = 0, j = 0; i < lastIdx; count++) {
      if (cost(i, i + 1) > limit) return Infinity;
      if (j < i) j = i;
      while (j + 1 <= lastIdx && cost(i, j + 1) <= limit) j++;
      i = j;
    }
    return count;
  };
  let lo = 0, hi = cost(0, lastIdx);
  for (let i = 0; i < lastIdx; i++) lo = Math.max(lo, cost(i, i + 1));
  for (let iter = 0; iter < 32 && hi - lo > 0.01; iter++) {
    const mid = (lo + hi) / 2;
    if (fewestRanges(mid) <= segments) hi = mid; else lo = mid;
  }
  const limit = hi + 1e-6;

  // need[i]: fewest ranges covering points[i]..end under the limit.
  const far = new Int32Array(points.length);
  for (let i = 0, j = 0; i <= lastIdx; i++) {
    if (j < i) j = i;
    while (j + 1 <= lastIdx && cost(i, j + 1) <= limit) j++;
    far[i] = j;
  }
  const need = new Int32Array(points.length);
  for (let i = lastIdx - 1; i >= 0; i--) need[i] = 1 + need[far[i]];

  const boundaries = [0];
  let cur = 0;
  for (let k = 1; k < segments; k++) {
    const remaining = segments - k + 1;
    let best = -1;
    for (let j = cur + 1; j < lastIdx && cost(cur, j) <= limit; j++) {
      // The rest must still fit in remaining - 1 ranges and have enough points.
      if (need[j] > remaining - 1 || lastIdx - j < remaining - 1) continue;
      const target = (cost(cur, lastIdx) + (remaining - 1) * (points[j] - origin) * pushWeight) / remaining;
      const bestTarget = best < 0 ? 0 : (cost(cur, lastIdx) + (remaining - 1) * (points[best] - origin) * pushWeight) / remaining;
      if (best < 0 || Math.abs(cost(cur, j) - target) < Math.abs(cost(cur, best) - bestTarget)) best = j;
    }
    if (best < 0) break;
    boundaries.push(best);
    cur = best;
  }
  boundaries.push(lastIdx);
  const ranges = [];
  for (let i = 0; i + 1 < boundaries.length; i++) ranges.push([points[boundaries[i]], points[boundaries[i + 1]] - 1]);
  return ranges;
}

/** Split [startFrame, endFrame] into at most `workers` contiguous ranges whose
 * boundaries are all allowed cut points, balanced by advance + capture cost.
 *
 * Every shard pays for a Chrome and for advancing from frame 0, so a shard
 * shorter than one second of frames costs more than it saves: when the best
 * plan contains one, try one shard fewer. `workersOrOpts` accepts either a
 * worker count or `{ workers, pushWeight, maxLeadFrames }`.
 */
export function planShardRanges(clips, startFrame, endFrame, fps, workersOrOpts) {
  const cfg = workersOrOpts && typeof workersOrOpts === 'object'
    ? workersOrOpts
    : { workers: workersOrOpts };
  const total = endFrame - startFrame + 1;
  const wanted = Math.max(1, Math.min(Math.floor(Number(cfg.workers)) || 1, total));
  if (wanted === 1) return [[startFrame, endFrame]];
  const pushWeight = cfg.pushWeight === undefined ? DEFAULT_PUSH_WEIGHT : Math.max(0, Number(cfg.pushWeight) || 0);
  const candidates = shardCutCandidates(clips, startFrame, endFrame, fps, { maxLeadFrames: cfg.maxLeadFrames });
  const points = [startFrame, ...candidates, endFrame + 1];
  const minFrames = Math.max(1, Math.round(MIN_SHARD_SECONDS * fps));
  for (let segments = Math.min(wanted, points.length - 1); segments > 1; segments--) {
    const ranges = planWeightedRanges(points, segments, pushWeight);
    if (ranges.every(([a, b]) => b - a + 1 >= minFrames)) return ranges;
  }
  return [[startFrame, endFrame]];
}
