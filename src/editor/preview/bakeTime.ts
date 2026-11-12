/**
 * "Which moment of this card should be prerendered": which moment the 3D view shows and which
 * moments get queued for prerender are both decided here.
 *
 * # Why this file exists
 *
 * This question used to have one hardcoded answer: the **clip midpoint**
 * (`t: (c.start + c.end) / 2`). The reasoning was "the two ends of a clip often sit on the
 * entrance or exit animation, and the prerendered image would be a semi-transparent in-between
 * state". Avoiding semi-transparency was right in itself; the mistake was turning "avoid" into
 * "only ever look at that one moment". The cost is that **any card with animation shows in 3D a
 * moment other than the current one**:
 *
 *     mu-number-ticker (rolls for 1.6 s), clip [0,2], playhead at 0.23 s
 *       2D preview / final video:  81%
 *       3D view (renders the midpoint): 100%
 *
 * This view is for people to **place things**. If what they see while placing is another
 * moment's image, their judgment is wrong, and it raises no error: it just makes people tune
 * parameters against an image that does not exist. Number rollers, typewriters, progress rings,
 * checklist ticks and step timelines are all hit.
 *
 * # Why not "render frame by frame following the playhead"
 *
 * One prerender needs to launch a Chrome, measured at 4.7~6.5 seconds. Frame by frame is
 * impossible. So the playhead is **snapped to a grid cell**: the moment you see differs from the
 * playhead by at most one cell, and the same cell always hits the same cache entry (the cache
 * key already contains t).
 *
 * # The grid is not laid out uniformly, because the card itself says when it is still moving
 *
 * `CardLifecycle.after` already spells this out (see kernel/types.ts):
 *   - `hold`   stays still after it settles: after the settle point **the whole rest needs only
 *              one image**, denser sampling is the same frame;
 *   - `loop` / `evolve` keep changing: the whole span has to be sampled by grid.
 * Of the 31 cards in the library, 22 are hold, 8 are evolve and 1 is loop. So for most cards the
 * cost is "a few densely sampled images over the one or two seconds of entrance + one image
 * after settling", not dense sampling of the whole span.
 *
 * `timing(params)` is more accurate than `lifecycle` (the settle moment changes when the number
 * of items or characters changes), so use it when present.
 *
 * # One definition, two uses
 *
 * Foreground display asks `pickBakeT` and prerender queueing asks `sampleTimesFor`; the moments
 * they produce **land on the same grid cell**. If they were computed separately in two places,
 * you would get "clearly prerendered but still rendered on the spot", and with no error, just
 * mysterious slowness. This is the same reason `bakeTarget` exists in only one place.
 */

/** Queueing and display need only these few things about a clip */
export interface TimedClip {
  id: string;
  cardId: string;
  start: number;
  end: number;
  params?: Record<string, unknown>;
  frame?: { w?: number; h?: number } | null;
}

/** A card's self-description of "when am I still moving". A small piece extracted from CardDef's lifecycle / timing */
export interface CardMotion {
  /** How long the entrance animation takes to settle (milliseconds) */
  settleMs?: number;
  /** After settling: stay still / loop / keep changing */
  after?: "hold" | "loop" | "evolve";
}

export interface SampleOpts {
  /** Snap grid (seconds). The moment you see differs from the playhead by at most this much */
  stepSec?: number;
  /**
   * The maximum number of moments queued for prerender per clip. **It only affects prerender
   * coverage, not the correctness of `pickBakeT`**: if the playhead rests on a cell that was not
   * prerendered, that cell is still rendered on the spot, it just takes a few seconds to wait.
   */
  maxPerClip?: number;
}

/** Snap grid. 0.25 s = 7~8 frames per cell, enough for the eye, and does not make a two-second card produce dozens of images */
export const DEFAULT_STEP_SEC = 0.25;
/** The maximum number of images queued for prerender per clip. At 5 seconds each, 12 images is a minute; any more and other clips should get queued first */
export const DEFAULT_MAX_PER_CLIP = 12;
/**
 * The settle moment assumed when a card does not write a lifecycle.
 *
 * Those that are written in the library fall between 250 and 1900 ms; we take the upper side:
 * **better to sample a few extra images than to let a card that is still moving show an old
 * frame**. The cost of sampling too little is a misleading picture, and the cost of sampling too
 * much is only a few more seconds of prerendering; the two are not equal.
 * (Only 2 of the 31 cards do not write one, so this default is rarely actually used.)
 */
export const DEFAULT_SETTLE_MS = 2000;

/** For float comparison. Time is in seconds and the grid is 0.25, so this magnitude is enough */
const EPS = 1e-6;

/**
 * At which moment the `i`-th grid cell falls (seconds relative to the clip start).
 *
 * **This is the only place that can work out a cell's position**: `pickBakeT` and
 * `sampleTimesFor` both go through it. We once computed them separately, and the cost was this:
 * `sampleTimesFor` then **accumulated** (`rel += step`), while `pickBakeT` did **floor, then
 * multiply** (`Math.floor(rel / step) * step`). With step = 0.25 the two are bit-identical (0.25
 * is exactly representable in binary), **1/30 is not**: at 30fps, 39 of 60 sample points did not
 * match, differing by 2.8e-17.
 *
 * And the cache key is formatted from this float, so the consequence is not "off by a tiny bit",
 * it is that **the display side finds none of the prerendered images, and no error is raised**,
 * showing up only as "clearly prerendered but still rendered on the spot".
 * Multiplying by index makes both sides bit-identical: `floor(i * step / step)` rounds back to
 * `i`, then multiplies by the same `step`.
 *
 * (A side note: we tried "quantize to a fixed number of decimals" to cover this, and it was
 * worse: 1/30 truncated to 0.033333 is slightly below the frame boundary, and floor falls
 * straight back a whole frame. Do not go down that road again.)
 */
const gridAt = (i: number, step: number): number => i * step;

/**
 * Read "when it is still moving" from the card definition. `timing(params)` takes priority: it
 * is computed from **this** card's actual parameters, while the one in lifecycle is a static
 * value under default parameters.
 *
 * `timing` is an arbitrary function written by the card author and may throw on parameters it
 * has not seen. If it throws, fall back to lifecycle: one card's broken timing function should
 * not black out the whole 3D view.
 */
export function motionOf(
  def:
    | {
      lifecycle?: { settleMs?: number; after?: "hold" | "loop" | "evolve" };
      timing?: (p: any) => { settleMs?: number; after?: "hold" | "loop" | "evolve" } | undefined;
      defaults?: Record<string, unknown>;
    }
    | undefined
    | null,
  params?: Record<string, unknown>,
): CardMotion {
  if (!def) return {};
  let timed: { settleMs?: number; after?: "hold" | "loop" | "evolve" } | undefined;
  if (typeof def.timing === "function") {
    try {
      timed = def.timing({ ...(def.defaults ?? {}), ...(params ?? {}) });
    } catch {
      // A broken timing function is treated as not written; below we fall back to lifecycle
    }
  }
  return {
    settleMs: timed?.settleMs ?? def.lifecycle?.settleMs,
    after: timed?.after ?? def.lifecycle?.after,
  };
}

/** How long the "still moving" stretch of this card is within this clip (seconds, relative to the clip start) */
function liveSpan(clip: TimedClip, motion: CardMotion): { len: number; settle: number; alwaysMoving: boolean } {
  const len = Math.max(0, clip.end - clip.start);
  const settleMs = Number.isFinite(motion.settleMs as number) ? Math.max(0, motion.settleMs as number) : DEFAULT_SETTLE_MS;
  const settle = Math.min(len, settleMs / 1000);
  // A missing after is handled as hold, consistent with "missing = has an entrance animation, then stays still" in kernel/types.ts
  const alwaysMoving = motion.after === "loop" || motion.after === "evolve";
  return { len, settle, alwaysMoving };
}

/**
 * With the playhead at moment `t`, which moment's prerendered image this board should show.
 * Returns absolute timeline seconds.
 *
 * Two invariants:
 *
 *   1. **Only look back, never forward** (`Math.floor`). What you see is always a moment that
 *      **has already happened**: looking forward would show a frame that has not been reached
 *      yet, which misleads people more than being one cell behind.
 *   2. **After a hold card settles, always return the settle moment**. Every frame after
 *      settling is identical, and splitting into more cells would just render the same image many
 *      times. A 10-second static card therefore needs only 1 image, not 40.
 */
export function pickBakeT(clip: TimedClip, motion: CardMotion, t: number, opts: SampleOpts = {}): number {
  const step = Math.max(1e-3, opts.stepSec ?? DEFAULT_STEP_SEC);
  const { len, settle, alwaysMoving } = liveSpan(clip, motion);
  if (len <= 0) return clip.start;
  // Playhead outside the clip (prerender asks about clips not yet reached): compute from the clip start
  const rel = Math.min(Math.max(0, (Number.isFinite(t) ? t : clip.start) - clip.start), Math.max(0, len - EPS));
  if (!alwaysMoving && rel >= settle - EPS) return clip.start + settle;
  const snapped = gridAt(Math.floor(rel / step + EPS), step);
  return clip.start + Math.min(snapped, Math.max(0, len - EPS));
}

/**
 * Which moments of this clip are worth prerendering, in ascending time order. **Every value
 * produced is a value `pickBakeT` may return**, so a cell that has been prerendered always hits
 * the cache in the foreground.
 *
 * Beyond `maxPerClip` it thins out evenly, but **the first and last are always kept**: the clip
 * start is the first frame of the entrance (the most often seen), and the end, for a hold card,
 * is the settle frame (which takes up the longest time in the clip). Thinning only makes
 * prerender coverage sparser; cells that are not covered can still be rendered on the spot.
 */
export function sampleTimesFor(clip: TimedClip, motion: CardMotion, opts: SampleOpts = {}): number[] {
  const step = Math.max(1e-3, opts.stepSec ?? DEFAULT_STEP_SEC);
  const cap = Math.max(1, Math.floor(opts.maxPerClip ?? DEFAULT_MAX_PER_CLIP));
  const { len, settle, alwaysMoving } = liveSpan(clip, motion);
  if (len <= 0) return [clip.start];

  const out: number[] = [];
  const live = alwaysMoving ? len : settle;
  // Take cells by **index**, do not accumulate with `rel += step`: accumulated values cannot be snapped back by pickBakeT (see gridAt)
  for (let i = 0; ; i++) {
    const rel = gridAt(i, step);
    if (rel >= live - EPS) break;
    out.push(clip.start + rel);
  }
  // After settling the whole rest is the same frame, so use the settle moment as its representative
  if (!alwaysMoving) out.push(clip.start + settle);
  if (!out.length) out.push(clip.start);

  if (out.length <= cap) return out;
  // Thin out evenly, always keep the first and last
  const thinned: number[] = [];
  for (let i = 0; i < cap; i++) thinned.push(out[Math.round((i * (out.length - 1)) / (cap - 1))]);
  return [...new Set(thinned)];
}

/**
 * The texture cache key. **It must include which moment**: the old key had only "which card,
 * what parameters, how big the canvas", so different moments of the same card computed the same
 * key, and changing the moment would not fetch the image again, leaving the picture stuck on
 * the first frame rendered.
 *
 * Position and the 3D transform **are not in the key**: when the server prerenders it strips the
 * whole frame (see bakeTarget), so rotating the card or nudging the depth map does not change a
 * single pixel. Putting them in the key would mean that dragging a slider in the "3D" panel
 * makes every step a cache miss, and so sends one prerender request per step.
 */
export function texKeyOf(clip: TimedClip, bakeT: number): string {
  const cutTracks = (clip as { cut?: { project?: { tracks?: unknown } } }).cut?.project?.tracks;
  return [
    clip.id,
    clip.cardId,
    JSON.stringify(cutTracks !== undefined ? { params: clip.params ?? {}, cutTracks } : (clip.params ?? {})),
    `${clip.frame?.w ?? "-"}x${clip.frame?.h ?? "-"}`,
    `@${bakeT.toFixed(3)}`,
  ].join("|");
}

/**
 * How far the displayed moment is from the playhead (seconds). For the UI: when it is off by
 * more than one cell, it should say which second it is, so people do not think the board shows
 * the current frame. Silently showing another moment is exactly the original bug.
 */
export function staleBy(bakeT: number, t: number): number {
  return Math.abs((Number.isFinite(t) ? t : bakeT) - bakeT);
}
