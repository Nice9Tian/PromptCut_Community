import { mountFrameOf } from './frameWindow.mjs';
import { clipFrameSpan } from './shardPlan.mjs';

/**
 * C4 frame picking rules as a pure function: shared between the browser (parent page picking
 * snapshots by layer) and Node (prerender process prioritizing, end-to-end probes); both sides are
 * guaranteed to pick the exact same frame.
 *
 * The three rules:
 *
 * 1. **Backtrack independently per layer**: each layer (clip × tier) looks up its own interval
 *    table and selects the maximum ready frame ≤ target local frame;
 * 2. **Backtrack within the same interval, never cross intervals**: an "interval" here is a
 *    **segment cut out by anchor frames** (C1 final sentence: anchor frame set = each clip's
 *    `mountFrameOf`, `clipFrameSpan`'s `last + 1`, frame 0), not a closed interval in the ready
 *    table. Crossing an anchor frame to fetch an earlier snapshot causes the visual to suddenly
 *    revert to the previous segment's state: better for this layer to be transparent;
 * 3. **Never wait**: if no frame can be picked, return null; that layer is transparent for this
 *    tick, and the playhead does not stop (general rule).
 *
 * Cold cache behavior is determined by rule 2: C2 produces anchor frames first, so when scrubbing
 * to frame 1000, often only the segment start frame is ready for that layer: what gets selected is
 * precisely the **interval start snapshot**, rather than an earlier snapshot from the previous
 * segment, nor a blank.
 */

/** Max ready frame ≤ frame in the ready table (closed intervals, merged and sorted); null if none. Binary search. */
export function latestReadyAtOrBefore(ranges, frame) {
  if (!Array.isArray(ranges) || !ranges.length || !Number.isInteger(frame) || frame < 0) return null;
  let lo = 0, hi = ranges.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = ranges[mid];
    if (from > frame) { hi = mid - 1; continue; }
    // If it falls within this segment, it's itself; if the whole segment is to the left,
    // record the segment end and continue searching right for a closer one
    found = frame <= to ? frame : to;
    lo = mid + 1;
  }
  return found;
}

/**
 * Set of anchor frames (global frame numbers, sorted ascending and deduplicated). Three items from
 * C1 final sentence: each clip's `mountFrameOf`, `clipFrameSpan`'s `last + 1`, and frame 0.
 *
 * `clips` contains **all** clips (not just the card for this layer): other clips mounting /
 * exiting also cause visuals of below-dependent cards to switch segments, so segment boundaries
 * are global.
 */
export function anchorFrames(clips, fps) {
  if (!(fps > 0)) return [0];
  const anchors = new Set([0]);
  for (const clip of clips ?? []) {
    if (!Number.isFinite(clip?.start) || !Number.isFinite(clip?.end)) continue;
    anchors.add(mountFrameOf(clip, fps));
    const span = clipFrameSpan(clip, fps);
    if (span) anchors.add(span[1] + 1);
  }
  return [...anchors].filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
}

/** Start of the segment cut by anchor frames containing `frame` (max anchor frame ≤ frame; 0 if none). */
export function segmentStartOf(anchors, frame) {
  let start = 0;
  for (const anchor of anchors ?? []) {
    if (anchor > frame) break;
    start = anchor;
  }
  return start;
}

/**
 * Frame picking for a single layer. All in terms of **local frames**
 * (`localFrame = globalFrame - firstFrame`); `segmentStart` is also a local frame, converted by
 * the caller from the global segment start and clamped to 0.
 *
 * Returns the selected local frame, or null (this layer is transparent for this tick).
 */
export function pickSnapshotFrame({ ranges, localFrame, segmentStart = 0 }) {
  if (!Number.isInteger(localFrame) || localFrame < 0) return null;
  const hit = latestReadyAtOrBefore(ranges, localFrame);
  if (hit === null) return null;
  // Do not cross intervals: snapshots before segment start belong to previous segment; prefer transparency
  return hit >= Math.max(0, segmentStart) ? hit : null;
}

/**
 * Converts a global frame to a local frame for a layer, and calculates the layer's segment start
 * (in local frames). `firstFrame` = `control.sampling.firstFrame` (existing formula from
 * `card-cache.mjs:109`).
 */
export function localWindowOf({ globalFrame, firstFrame = 0, count = Infinity, anchors = [] }) {
  const localFrame = globalFrame - firstFrame;
  if (!Number.isInteger(localFrame) || localFrame < 0 || localFrame >= count) return null;
  const segmentStart = Math.max(0, segmentStartOf(anchors, globalFrame) - firstFrame);
  return { localFrame, segmentStart };
}

/**
 * Full query by parent page for a layer on each frame: `{ key, ranges }` for this layer in the
 * index + sampling info for the layer → `{ kind, key, localFrame }` or null. C4's "throttled DOM
 * replacement" and "delivery baseline" belong to the consumer (R5); this only answers "which
 * frame to apply right now".
 */
export function pickLayerSnapshot({ layer, globalFrame, firstFrame = 0, count = Infinity, anchors = [] }) {
  if (!layer?.key) return null;
  const window = localWindowOf({ globalFrame, firstFrame, count, anchors });
  if (!window) return null;
  const localFrame = pickSnapshotFrame({ ranges: layer.ranges, localFrame: window.localFrame, segmentStart: window.segmentStart });
  return localFrame === null ? null : { kind: layer.kind, key: layer.key, localFrame };
}
