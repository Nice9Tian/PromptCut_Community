import { mountFrameOf } from './frameWindow.mjs';
import { normalizeFrameMode } from '../kernel/frameMode.mjs';

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
 * inside a stateful card's mounted life therefore changes pixels. Direct cards,
 * media and 素材效果卡 are evaluated at their time and may be cut anywhere.
 * An unknown mode is treated as stateful.
 */
export function shardCutCandidates(clips, startFrame, endFrame, fps) {
  const size = endFrame - startFrame;
  if (size <= 0) return [];
  const diff = new Int32Array(size + 1);
  for (const clip of clips || []) {
    if (normalizeFrameMode(clip.mode) === 'direct') continue;
    const span = clipFrameSpan(clip, fps);
    if (!span) continue;
    // A boundary before frame c splits this clip when first < c <= last.
    const lo = Math.max(span[0] + 1, startFrame + 1), hi = Math.min(span[1], endFrame);
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

/** Exactly `segments` ranges over boundary points: minimise the longest range,
 * then put each boundary as close to an even split of the remainder as that
 * limit allows. `points` starts with startFrame and ends with endFrame + 1. */
function planExactly(points, segments) {
  const lastIdx = points.length - 1;
  const total = points[lastIdx] - points[0];
  // Greedy farthest reach under a length limit is optimal for "fewest ranges".
  const fewestRanges = (limit) => {
    let count = 0;
    for (let i = 0, j = 0; i < lastIdx; count++) {
      if (points[i + 1] - points[i] > limit) return Infinity;
      if (j < i) j = i;
      while (j + 1 <= lastIdx && points[j + 1] - points[i] <= limit) j++;
      i = j;
    }
    return count;
  };
  let maxGap = 0;
  for (let i = 0; i < lastIdx; i++) maxGap = Math.max(maxGap, points[i + 1] - points[i]);
  let lo = Math.max(maxGap, Math.ceil(total / segments)), hi = total;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fewestRanges(mid) <= segments) hi = mid; else lo = mid + 1;
  }
  const limit = lo;

  // need[i]: fewest ranges covering points[i]..end under the limit.
  const far = new Int32Array(points.length);
  for (let i = 0, j = 0; i <= lastIdx; i++) {
    if (j < i) j = i;
    while (j + 1 <= lastIdx && points[j + 1] - points[i] <= limit) j++;
    far[i] = j;
  }
  const need = new Int32Array(points.length);
  for (let i = lastIdx - 1; i >= 0; i--) need[i] = 1 + need[far[i]];

  const boundaries = [0];
  let cur = 0;
  for (let k = 1; k < segments; k++) {
    const remaining = segments - k + 1;
    const ideal = points[cur] + (points[lastIdx] - points[cur]) / remaining;
    let best = -1;
    for (let j = cur + 1; j < lastIdx && points[j] - points[cur] <= limit; j++) {
      // The rest must still fit in remaining - 1 ranges and have enough points.
      if (need[j] > remaining - 1 || lastIdx - j < remaining - 1) continue;
      if (best < 0 || Math.abs(points[j] - ideal) < Math.abs(points[best] - ideal)) best = j;
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
 * boundaries are all allowed cut points, sized as evenly as those points allow.
 *
 * Every shard pays for a Chrome and for advancing from frame 0, so a shard
 * shorter than one second of frames costs more than it saves: when the best
 * plan contains one, try one shard fewer.
 */
export function planShardRanges(clips, startFrame, endFrame, fps, workers) {
  const total = endFrame - startFrame + 1;
  const wanted = Math.max(1, Math.min(Math.floor(Number(workers)) || 1, total));
  if (wanted === 1) return [[startFrame, endFrame]];
  const points = [startFrame, ...shardCutCandidates(clips, startFrame, endFrame, fps), endFrame + 1];
  const minFrames = Math.max(1, Math.round(fps));
  for (let segments = Math.min(wanted, points.length - 1); segments > 1; segments--) {
    const ranges = planExactly(points, segments);
    if (ranges.every(([a, b]) => b - a + 1 >= minFrames)) return ranges;
  }
  return [[startFrame, endFrame]];
}
