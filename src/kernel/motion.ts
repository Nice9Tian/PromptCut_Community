/**
 * Computes the current displacement of a bound trajectory at a given timestamp.
 *
 * Both the stage and export use this single function: export renders offline frame-by-frame while
 * preview is real-time; calculating different positions on each side would cause the exported final
 * video to mismatch preview, and such discrepancies are hard to debug: both sides appear to be
 * "in motion", just differently.
 */
import type { ClipMotion } from "./types";
import { mediaSpanOf, mediaTimeAt, timelineSpanOf } from "./clipTime.mjs";

export interface BuildMotionInput {
  /** Trajectory: frame-by-frame **raw media pixel** coordinates covering the entire media */
  xy: [number, number][];
  visible: boolean[];
  /** Raw dimensions and duration of the media */
  media: { id: string; width: number; height: number; duration: number };
  /** Stage dimensions */
  stage: { width: number; height: number };
  /** Card clip interval on the timeline (seconds) */
  card: { start: number; end: number };
  /** The media clip providing video: start on timeline, playback start second in media, and clip speed (defaults to 1, see kernel/clipTime.mjs) */
  clipOfMedia: { start: number; mediaOffset: number; speed?: number };
  pointIndex: number;
  whenHidden: "hold" | "hide";
}

export interface BuildMotionResult {
  motion: ClipMotion;
  /** Summary for the caller (and AI), not included in project documents */
  summary: {
    frames: number;
    visibleFrames: number;
    /** Displacement range (stage pixels), used to determine whether this binding is a no-op */
    rangeX: number;
    rangeY: number;
  };
}

/**
 * Compute follow data for a card clip from a tracking trajectory.
 *
 * Three things are resolved here in one pass so playback doesn't have to deal with them:
 *
 * 1. **Time alignment**. Card clips and media clips are independent segments on the timeline; a
 *    card might only overlap a short stretch in the middle of the media, and the media itself
 *    might have a mediaOffset. Trajectories are indexed by media frame number; without alignment,
 *    the card follows the target at "another moment": that misalignment looks like mistracking,
 *    making it hard to realize the timing is off.
 * 2. **Coordinate conversion**. Trajectories are in raw media pixels, the stage is in project
 *    pixels, and the video layer fills via cover. By taking only displacement, the center-crop
 *    offsets cancel out, leaving only a max scale factor.
 * 3. **Anchor re-zeroing**. Store displacements instead of absolute positions so the card stays
 *    where it was placed during design. The anchor uses the **first visible frame** in the clip:
 *    if the card happens to start when the target is occluded, using that frame's extrapolated
 *    coordinates as the anchor would shift the entire trajectory.
 */
export function buildClipMotion(input: BuildMotionInput): BuildMotionResult {
  const { xy, visible, media, stage, card, clipOfMedia, pointIndex, whenHidden } = input;
  const total = xy.length;
  if (total === 0) throw new Error("This motion path is empty");
  if (!(media.duration > 0)) throw new Error(`Media ${media.id} has no duration, so the motion path cannot be mapped onto the timeline`);
  if (!(media.width > 0) || !(media.height > 0)) {
    throw new Error(`Media ${media.id} has no resolution, so the motion path cannot be converted to frame coordinates`);
  }

  const frameStep = media.duration / total;
  // At the card start, which second of media is playing (including clip speed, kernel/clipTime.mjs)
  const mediaTimeAtStart = mediaTimeAt(clipOfMedia, card.start);
  const i0 = Math.max(0, Math.min(total - 1, Math.round(mediaTimeAtStart / frameStep)));
  // Media covered by this card duration: speed-changed clips scale by rate (default 1 is × 1 unchanged)
  const need = Math.ceil(mediaSpanOf(clipOfMedia, card.end - card.start) / frameStep) + 1;
  const i1 = Math.min(total, i0 + Math.max(need, 1));

  const sliceXy = xy.slice(i0, i1);
  const sliceVis = visible.slice(i0, i1);
  if (sliceXy.length === 0) throw new Error("The card clip falls outside the range of this motion path");

  const scale = Math.max(stage.width / media.width, stage.height / media.height);
  const anchorIdx = Math.max(0, sliceVis.findIndex(Boolean));
  const [ax, ay] = sliceXy[anchorIdx];

  const r1 = (v: number) => Math.round(v * 10) / 10; // Stored to 0.1 pixel, sufficient and saves half the size
  const offsets = sliceXy.map(([x, y]) => [r1((x - ax) * scale), r1((y - ay) * scale)] as [number, number]);

  const xs = offsets.map((o) => o[0]);
  const ys = offsets.map((o) => o[1]);
  return {
    motion: {
      mediaId: media.id,
      pointIndex,
      offsets,
      visible: sliceVis,
      // Stores seconds between adjacent timeline points (sampled via card local time / frameStep):
      // for speed-changed clips, media step divided by rate
      frameStep: timelineSpanOf(clipOfMedia, frameStep),
      whenHidden,
    },
    summary: {
      frames: offsets.length,
      visibleFrames: sliceVis.filter(Boolean).length,
      rangeX: r1(Math.max(...xs) - Math.min(...xs)),
      rangeY: r1(Math.max(...ys) - Math.min(...ys)),
    },
  };
}

export interface MotionAt {
  dx: number;
  dy: number;
  /** Whether target is visible at this moment. When whenHidden is hide, caller skips rendering */
  visible: boolean;
}

/**
 * @param local seconds within the clip (t - clip.start)
 */
export function motionAt(motion: ClipMotion, local: number): MotionAt {
  const { offsets, visible, frameStep, whenHidden } = motion;
  const n = offsets.length;
  if (n === 0) return { dx: 0, dy: 0, visible: true };

  const pos = local / (frameStep || 1 / 30);
  // Clamp to both ends instead of letting it run off: when clip is longer than the trajectory,
  // the excess stays on the last frame, which is much better than jumping to origin or off-screen.
  const i0 = Math.max(0, Math.min(n - 1, Math.floor(pos)));
  const i1 = Math.max(0, Math.min(n - 1, i0 + 1));
  const f = i0 === i1 ? 0 : Math.max(0, Math.min(1, pos - i0));

  const seen = !!visible[i0];
  if (!seen && whenHidden === "hold") {
    // Stay at the last visible position. Search backwards rather than using the current frame's
    // extrapolated value: extrapolated values are guesses, and if wrong, the card drifts in a
    // direction the target never went, which looks far worse than staying put.
    for (let k = i0; k >= 0; k--) {
      if (visible[k]) return { dx: offsets[k][0], dy: offsets[k][1], visible: false };
    }
    return { dx: 0, dy: 0, visible: false };
  }

  // Linear interpolation between two frames: without it, media at 25fps in a 30fps project stutters
  const a = offsets[i0];
  const b = offsets[i1];
  return {
    dx: a[0] + (b[0] - a[0]) * f,
    dy: a[1] + (b[1] - a[1]) * f,
    visible: seen,
  };
}
