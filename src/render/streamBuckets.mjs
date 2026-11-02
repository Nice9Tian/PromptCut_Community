/**
 * Rules for partitioning track stream manifests in the content store as "8 segments per bucket":
 * **single source of truth**. Both the manifest writing side (`writeManifest` in render node
 * `server/artifact-transfer.mjs`, `putStreamManifest` in browser node
 * `src/editor/browserNodeHost.ts`, and in-memory artifact store for testing) and the manifest
 * query side (deduplicating lookup in `createAssetSink`) compute bucket ranges from here,
 * rather than calculating independently.
 *
 * # Rules
 *
 * The stream reading side (`streamSpansInWindow` in `src/render/snapshotSource.ts`) fetches one
 * manifest every 8 segments starting from segment 0 according to `segmentsPerTask` (8) in that row
 * of the layer table, with the last manifest extending up to **the last segment of the entire
 * stream**: `0-7`, `8-15`, …, `56-63`, …, `120-124`. Stream task ranges do not necessarily align
 * with buckets (a motion card at full density has at least 60 segments per task, and a sparse
 * stream has one task for the entire stream), so in addition to the task's own key, the writing
 * side writes each bucket according to this rule:
 *
 *   - Bucket start points occur once every `STREAM_BUCKET_SEGMENTS` segments starting from 0;
 *   - Bucket end point = min(start point + 7, last segment of the entire stream). **The last
 *     segment of the entire stream** is converted from this stream's `originFrame` / `lastFrame`
 *     (`streamSegmentOf` in `streamSegments.mjs`) and cannot be substituted with the task's own
 *     `range.to`: when task `[0, 59]` is not the end of the stream, its last bucket is `56-63`
 *     (the same key written by task `[60, 124]`, merged on both sides), not `56-59`.
 *   - When the last segment of the entire stream is unknown (stream manifests written to disk by
 *     older nodes, or older tasks without it), fall back to using the task's `range.to`, same as
 *     before the change.
 *
 * Pure function, does not depend on other modules (only imports segment conversion); shared
 * between server and page.
 */
import { isStreamOrigin, streamSegmentOf } from "./streamSegments.mjs";

/**
 * Number of segments per bucket. Same value as `QUEUE_DEFAULTS.STREAM_SEGMENTS` in
 * `server/render-queue/constants.mjs`, `PAGE_STREAM_SEGMENTS_PER_TASK` in
 * `src/online/pageStreamPlan.ts`, and `segmentsPerTask` in the stream row of the layer table
 */
export const STREAM_BUCKET_SEGMENTS = 8;

const isInt = (v) => Number.isInteger(v);

/**
 * The last segment of the entire stream: converted from the stream's own first frame `originFrame`
 * and last frame `lastFrame` (project frame number). `span` can be the task's `input.stream`, the
 * manifest's `header`, or `stream.json` in the stream store. If any item is missing or shape is
 * incorrect, return null (do not guess).
 */
export function streamLastSegmentOf(span) {
  const originFrame = span?.originFrame, lastFrame = span?.lastFrame;
  if (!isStreamOrigin(originFrame) || !isInt(lastFrame) || lastFrame < originFrame) return null;
  return streamSegmentOf(lastFrame, originFrame);
}

/**
 * Buckets intersected by range `[from, to]`: `[{ from, to }]`, sorted ascending by start point.
 * `lastSegment` is the last segment of the entire stream (`streamLastSegmentOf`); when null or
 * smaller than `to` (mismatched), clamp to `to`. The writing side writes a separate copy for each
 * bucket whose range differs from the task's own range (the identical one is the task's own key).
 */
export function streamBucketRanges(from, to, lastSegment = null) {
  if (!isInt(from) || !isInt(to) || from < 0 || to < from) return [];
  const last = isInt(lastSegment) && lastSegment >= to ? lastSegment : to;
  const out = [];
  for (let b = Math.floor(from / STREAM_BUCKET_SEGMENTS) * STREAM_BUCKET_SEGMENTS; b <= to; b += STREAM_BUCKET_SEGMENTS) {
    out.push({ from: b, to: Math.min(last, b + STREAM_BUCKET_SEGMENTS - 1) });
  }
  return out;
}

/**
 * Slices the segments falling within bucket `bucket` from a stream manifest (`StreamResult`):
 * remaining fields are copied as-is, `range` is replaced with the bucket range, `segments` retains
 * only segments within the bucket, and `inits` retains only head files used by these segments.
 */
export function streamBucketManifest(manifest, bucket) {
  const segments = {}, inits = {};
  const segMap = manifest?.segments ?? {}, initMap = manifest?.inits ?? {};
  for (let n = bucket.from; n <= bucket.to; n++) {
    const seg = segMap[n] ?? segMap[String(n)];
    if (!seg) continue;
    segments[n] = seg;
    if (seg.init && initMap[seg.init]) inits[seg.init] = initMap[seg.init];
  }
  return { ...manifest, range: { from: bucket.from, to: bucket.to }, inits, segments };
}
