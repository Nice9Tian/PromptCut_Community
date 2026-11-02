/**
 * Track stream segment calculation: **sole source of truth**. Both the stream producer side
 * (prerender process, render service, task queue splitting and claiming, browser nodes, local page
 * stream generation) and the stream consumer side (stage playback, parent page selecting stream planes,
 * online page fetching manifests and bytes) calculate "which segment and which sample this frame
 * is in" from here, without computing separately.
 *
 * # Rules (user decision, 2026-10-13: `docs/plan/html-snapshot-removal-dryrun.md` Section 10.5)
 *
 * Segments start from **the stream's own first frame** (`originFrame`, project frame number),
 * with one segment every `STREAM_SEGMENT_FRAMES` frames, no longer starting from project frame 0:
 *
 *   - Single-card stream: first frame is the clip's first frame on the timeline (card local frame 0);
 *   - Group stream: first frame is the earliest first frame among its members;
 *   - Below-dependent stream: first frame is the target card's first frame.
 *
 * A clip starting at frame 100: segment 0 is frames 100-114, segment 1 is frames 115-129...
 * segment numbers always start from 0.
 * The last segment extends to **the stream's own last frame** (not the project's last frame),
 * and may contain fewer than 15 frames.
 * Frames earlier than the first frame have no segment (`streamSegmentOf` returns negative,
 * excluded from the ready range).
 *
 * Therefore, "segment number and frames per segment" depend only on how many frames this stream has,
 * independent of where it sits on the timeline; its position on the timeline is reduced to just
 * `originFrame`, provided by the planning side according to the current project (stream planning →
 * ready message / layer table row → consumer side).
 *
 * Pure function, does not depend on other modules; shared between server and page.
 */

/**
 * Number of frames per segment (G2); matches `STREAM_SEGMENT_FRAMES` in `server/bakery/ffmpeg.mjs`
 * (checked by gatekeeper unit tests).
 */
export const STREAM_SEGMENT_FRAMES = 15;

/** Whether it can serve as the first frame of a stream: non-negative integer */
export function isStreamOrigin(value) {
  return Number.isInteger(value) && value >= 0;
}

/** Project frame number → segment number of this stream; returns negative for frames before the first frame */
export function streamSegmentOf(frame, originFrame) {
  return Math.floor((frame - originFrame) / STREAM_SEGMENT_FRAMES);
}

/** First frame of this segment (project frame number) */
export function streamSegmentFirstFrame(segment, originFrame) {
  return originFrame + segment * STREAM_SEGMENT_FRAMES;
}

/**
 * Last frame of this segment (project frame number), clamped to the stream's own `lastFrame`;
 * full segment if `lastFrame` is omitted.
 */
export function streamSegmentLastFrame(segment, originFrame, lastFrame = Infinity) {
  return Math.min(streamSegmentFirstFrame(segment, originFrame) + STREAM_SEGMENT_FRAMES - 1, lastFrame);
}

/**
 * Number of frames in this segment (i.e. its sample count); returns 0 if the entire segment is
 * after the stream's last frame.
 */
export function streamSegmentFrameCount(segment, originFrame, lastFrame = Infinity) {
  return Math.max(0, streamSegmentLastFrame(segment, originFrame, lastFrame) - streamSegmentFirstFrame(segment, originFrame) + 1);
}

/**
 * First frame of the segment containing this frame (project frame number). The sparse version
 * captures only this frame for each segment and repeats it for the rest; the lowest tier,
 * whether that segment is sparse or full density, only decodes and pastes this frame
 * (`streamPlayer.ts`'s `presentFirst`). Frames earlier than the stream's first frame also return
 * earlier than the first frame.
 */
export function streamFirstFrameOf(frame, originFrame) {
  return streamSegmentFirstFrame(streamSegmentOf(frame, originFrame), originFrame);
}

/** 0-based sample index of this frame within its segment */
export function streamSampleOf(frame, originFrame) {
  return frame - streamSegmentFirstFrame(streamSegmentOf(frame, originFrame), originFrame);
}

/**
 * How to segment a stream covering project frames `firstFrame .. lastFrame`:
 * `{ originFrame, firstSegment, lastSegment }`. `firstSegment` is always 0 (this field is kept
 * because stream planning, splitting, and pushing follow "from firstSegment to lastSegment").
 */
export function streamSegmentSpan(firstFrame, lastFrame) {
  const originFrame = Math.max(0, Math.floor(Number(firstFrame) || 0));
  return { originFrame, firstSegment: 0, lastSegment: Math.max(0, streamSegmentOf(Math.max(originFrame, lastFrame), originFrame)) };
}
