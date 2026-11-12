/**
 * "Which segments of the timeline are already prerendered": computed for that green bar (like the
 * one at the top of AE).
 *
 * # A prerendered moment covers a short segment, not a point
 *
 * Prerendering renders by **moment** (which moments is decided by sampleTimesFor in bakeTime.ts), and
 * when the playhead falls between two moments, what is shown is the one **taken backwards** (pickBakeT
 * uses floor). So having t_i rendered means the whole segment `[t_i, t_{i+1})` has an image to show:
 * the last moment covers up to the end of the card.
 *
 * This is also the only honest way to draw the green bar: where it is green, dragging there always
 * has a picture immediately, and where it is not green, you always have to wait. A percentage progress
 * bar of "how many are rendered / how many in total" cannot do this: such a bar can show 90%, while
 * the user happens to drag into the remaining 10% and still waits five seconds, yet the bar is green.
 *
 * # Why not compute per whole clip
 *
 * A card has a dozen or so moments, and when it is half rendered **its first half can be seen and its
 * second half cannot**. Painting the whole clip green would lie, and leaving it all blank would bury
 * the part already rendered. So split into segments by moment and paint them one by one.
 */

import { stripOuterFrameExpr } from "../../kernel/frameExpr.mjs";

export interface CoverageSegment {
  start: number;
  end: number;
}

/** Tolerance for floating-point comparison: moments are accumulated in steps of 0.25 seconds, so the last digit can have error */
const EPS = 1e-6;

/**
 * Moment identifier: `<clipId>@<t>`.
 *
 * **Use it to decide "is it rendered", not the server's cache key.** The foreground on-demand
 * render and the idle prerender take two different paths. The foreground only has (clipId, t) and
 * no server-computed hash; if each path used its own key, the coverage table would not recognize
 * a moment even after the foreground rendered it. The symptom: "the picture is already showing,
 * but the bar on the timeline has not changed".
 */
export const momentId = (clipId: string, t: number) => `${clipId}@${t}`;

export interface CoverageInput {
  clipId: string;
  /** Identifier of this moment (momentId). The coverage table records "is it rendered" by it */
  id?: string;
  /** Cache key of this moment. Deciding "is it rendered" needs it, so it is carried here too */
  key?: string;
  /** Which tier it belongs to (low frame rate / original frame rate). Drawn as separate yellow and green bars */
  tier?: "coarse" | "full";
  /** Whether it falls on a cell of the original frame rate */
  fine?: boolean;
  /** Which instant the image prerendered for this moment represents (absolute timeline seconds) */
  t: number;
  /** The range of this card: the last moment must cover all the way to end */
  start: number;
  end: number;
}

/**
 * Which spans on the timeline are covered by the moments that are already rendered.
 *
 * `isBaked` is supplied by the caller: the prerender side knows which keys are already on disk.
 * The returned spans are sorted by time and **adjacent ones are merged**. Without merging, one card
 * would draw a dozen small green blocks side by side with a gap between each, which looks like
 * "rendered in fits and starts" when it is actually continuous.
 */
export function coverageSegments(
  moments: CoverageInput[],
  isBaked: (m: CoverageInput) => boolean,
): CoverageSegment[] {
  // Group by card: how far a moment reaches depends on the next moment **in the same card**; never look across cards
  const byClip = new Map<string, CoverageInput[]>();
  for (const m of moments) {
    const list = byClip.get(m.clipId);
    if (list) list.push(m);
    else byClip.set(m.clipId, [m]);
  }

  const raw: CoverageSegment[] = [];
  for (const list of byClip.values()) {
    const sorted = [...list].sort((a, b) => a.t - b.t);
    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[i];
      if (!isBaked(m)) continue;
      const next = sorted[i + 1];
      // It reaches up to the next moment; if it is the last one of this card, it reaches to the end of the card
      const end = next ? Math.min(next.t, m.end) : m.end;
      const start = Math.max(m.start, m.t);
      if (end > start + EPS) raw.push({ start, end });
    }
  }

  return mergeSegments(raw);
}

/**
 * Merge spans that touch or overlap. Without merging, one card would draw a dozen small blocks
 * side by side with a gap between each, which looks like "rendered in fits and starts" when it is
 * actually continuous.
 *
 * Exported on its own because **drawing needs to merge once more**: coverage is stored per card
 * (see ClipCoverage), while the spans of two cards that meet end to end should join into one bar.
 */
export function mergeSegments(segs: CoverageSegment[]): CoverageSegment[] {
  const raw = [...segs].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: CoverageSegment[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && seg.start <= last.end + EPS) last.end = Math.max(last.end, seg.end);
    else merged.push({ ...seg });
  }
  return merged;
}

/**
 * The spans of the timeline where **there is nothing to prerender at all**.
 *
 * # Why these spans should also be green
 *
 * The bar's contract is "anywhere green can be scrubbed to with an immediate picture, anywhere not
 * green must wait". The blank seconds, or those with only media clips (video / image, which are
 * already bitmaps and need no rendering), or only scene-3d (real geometry in the 3D view, needing
 * no texture), look exactly as they should **immediately** when scrubbed to, with no waiting at
 * all. By the contract they should be green.
 *
 * They used to be white forever, and the consequence was more than ugliness: users could not tell
 * "this span is not rendered yet" from "this span has nothing in it", so the bar was always one
 * piece short and **looked like the prerender was stuck** when everything had long been rendered.
 *
 * `spans` is passed the spans that "have something to render" (computed by the caller from the
 * project's current state); this returns their complement within `[0, duration]`.
 */
export function idleSpans(spans: CoverageSegment[], duration: number): CoverageSegment[] {
  if (!(duration > 0)) return [];
  const busy = mergeSegments(spans.filter((s) => s.end > s.start));
  const out: CoverageSegment[] = [];
  let at = 0;
  for (const s of busy) {
    if (s.start > at + EPS) out.push({ start: at, end: Math.min(s.start, duration) });
    at = Math.max(at, s.end);
    if (at >= duration) break;
  }
  if (at < duration - EPS) out.push({ start: at, end: duration });
  return out.filter((s) => s.end > s.start + EPS);
}

/**
 * Everything the progress bar needs to show. **The two tiers are kept apart**:
 *
 * coarse (yellow): the low frame rate tier. Scrubbing there gives an immediate picture, but the
 * moment you see is off from the playhead by at most 0.25 seconds.
 * full (green): the original frame rate tier. That span is frame-accurate.
 *
 * The two tiers are drawn separately instead of being merged into one percentage because they mean
 * completely different things to the user: yellow is "viewable but inexact", green is "exactly this
 * frame". Merging them into one bar wipes out that difference.
 */
/**
 * Coverage of one card. **It carries the content fingerprint the card had at the time.**
 *
 * Storing per card with a fingerprint is so that "change A and A's span turns white at once" works
 * **without depending on anything asynchronous**: when drawing the bar, check against the current
 * project's fingerprints and simply do not draw those that do not match. As soon as the user
 * changes a parameter, the project in the store is replaced and the bar wipes A in that very
 * frame, with no waiting for an inventory scan, no waiting for the prerender, and no race.
 *
 * Before, all cards were merged into one whole span and stored, so **only the prerender loop could
 * update it**, and that loop only gets to publish after the current batch finishes rendering and
 * another inventory scan runs. The result was "after editing a card, the bar does not budge".
 */
export interface ClipCoverage {
  clipId: string;
  /** What this card looked like at the time (clipFingerprint). A mismatch with the current project means it is stale */
  fp: string;
  /**
   * The start of this card on the timeline when this coverage was published.
   *
   * **Without it, the bar keeps painting green in the old place after the card is moved away.** The
   * fingerprint deliberately excludes the timeline position (moving it changes not one pixel, and the
   * prerendered image is still the same one, see bakeTarget), so the fingerprint alone cannot tell
   * whether the card moved; and the `t / start / end` recorded for each moment are all **absolute
   * seconds**, so after the card moves away they stay at the old place. Measured: move a [20,24] card
   * to second 27, and the bar still paints green over [20,24], which is already empty, while `stale`
   * still reports 0. That is exactly "green although it is not actually rendered".
   *
   * Once the start is recorded, drawing shifts everything by the difference (see visibleCoverage):
   * the images are still those images and the ledger is still that ledger, they are just drawn where
   * the card now sits.
   */
  start: number;
  /** All the moments this card needs prerendered */
  moments: CoverageInput[];
}

/**
 * The coverage table stores **facts** (which moments exist, which are already rendered); spans are
 * computed on the fly when drawing.
 *
 * It is arranged this way because "rendered" has two sources: the idle prerender, and the
 * foreground on-demand render while the user is watching. If the computed spans were stored, only
 * the prerender path could update them: the foreground finishes, the picture appears, and the bar
 * still has to wait for the next inventory scan to change. Storing facts avoids that: whichever
 * path finishes only adds an id to `baked`, and the bar recomputes in that very frame.
 */
export interface BakeCoverage {
  /** Stored per card, filtered by fingerprint when drawing */
  clips: ClipCoverage[];
  /** The moments that are already rendered (momentId). Both render paths share this one set */
  baked: Set<string>;
  /** The moment being rendered (absolute timeline seconds); null when nothing is rendering */
  bakingAt: number | null;
  /** How much disk is already used (bytes, measured value) */
  bytes: number;
}

const EMPTY: BakeCoverage = { clips: [], baked: new Set(), bakingAt: null, bytes: 0 };

/**
 * Fingerprint of what a card "looks like": it carries only the things that **determine pixels**.
 *
 * This is the **only** algorithm: Scene3DView uses it to decide whether to rebuild the scene, and
 * the progress bar uses it to decide whether the coverage of a span is stale. If each place had
 * its own copy, there would be mismatched states like "the bar thinks it is still valid but the
 * picture has already changed", and no error would be reported.
 *
 * Position and 3D transform are not part of the fingerprint: when the server prerenders it strips
 * the whole frame (see bakeTarget), so rotating the card or pushing its depth changes not one
 * pixel.
 */
export function clipFingerprint(c: {
  id: string; cardId: string; params?: unknown; frame?: { w?: number; h?: number } | null;
  start?: number; end?: number;
}): string {
  /*
   * **A blacklist, not a whitelist.**
   *
   * The server's cache key is a hash of "the whole clip minus frame" (see bakeTarget), so whenever
   * a field on the clip changes, the prerender may produce a different image. This used to pick
   * only id / cardId / params / frame, so after `emphasis` (outline), `motion` (motion path),
   * `fadeIn/fadeOut`, `opacity` or `parts` (the part tree of a composite card) changed, **the
   * fingerprint did not budge**: the bar stayed green while those images were actually stale.
   * A whitelist has another flaw: whoever adds a field to Clip later will not think of adding it
   * here, and the omission reports no error.
   *
   * So it is reversed: apart from the ones stripped by `bakeTarget`, **everything else goes into the fingerprint**.
   *   - `start` is excluded on its own: moving does not change pixels (bakeTarget moves the clip to
   *     a fixed starting line before rendering), so a move should not invalidate coverage. The
   *     position change is absorbed by the ClipCoverage.start shift.
   *   - `end` does not go in directly either, but **the length does**: trimming shorter or longer
   *     changes the key (the key carries the frame count within the clip), so it must invalidate.
   *   - `frame` takes only w×h: that is the layout size, which changes pixels; x/y/rotation/scale do
   *     not (the whole frame is stripped during prerender).
   *   - `opacity` / `fadeIn` / `fadeOut` are stripped during prerender and applied on the 3D board
   *     material at display time, so tuning fades or opacity does not invalidate prerendered textures.
   */
  const {
    start: _start,
    end: _end,
    frame: _frame,
    frameExpr: rawFrameExpr,
    opacity: _opacity,
    fadeIn: _fadeIn,
    fadeOut: _fadeOut,
    ...restBase
  } = c as Record<string, unknown> & typeof c;
  const sizeExpr = stripOuterFrameExpr(rawFrameExpr as any);
  const rest = sizeExpr ? { ...restBase, frameExpr: sizeExpr } : restBase;
  const dur = Math.max(0, (Number(c.end) || 0) - (Number(c.start) || 0));
  return [
    JSON.stringify(rest),
    `${c.frame?.w ?? "-"}x${c.frame?.h ?? "-"}`,
    dur.toFixed(6),
  ].join("|");
}

/*
 * A small module-level store: the prerender side writes, the timeline side reads.
 *
 * It goes through the module level instead of a React context because the two places are far
 * apart in the component tree (the prerender is mounted in the 3D tab of the preview panel, the
 * green bar sits on top of the timeline), and not one component along the whole chain between them
 * needs this value. Passing it through would only give every component on the way an unused prop
 * or an extra re-render.
 *
 * Keeping the value in the module has another benefit: when switching from the 3D tab back to the
 * 2D tab, the prerender stops, but **the information on how far it has rendered is still there**,
 * and the green bar is not cleared entirely just because a tab was switched.
 */
let current: BakeCoverage = EMPTY;
const listeners = new Set<() => void>();

export function publishCoverage(next: BakeCoverage): void {
  current = next;
  for (const fn of listeners) fn();
}

/** The two that useSyncExternalStore needs: subscribe + get snapshot */
export function subscribeCoverage(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Get the current value. **It must return the same reference** (unless it really changed):
 * useSyncExternalStore calls it on every render and compares the reference with the last one; if
 * a new object were created each time here, React would decide "it changed" and re-render forever.
 */
export function getCoverage(): BakeCoverage {
  return current;
}


/** What the progress bar really draws: spans merged across cards and counts, after filtering out stale cards */
export interface VisibleCoverage {
  coarse: CoverageSegment[];
  full: CoverageSegment[];
  coarseBaked: number;
  coarseTotal: number;
  fullBaked: number;
  fullTotal: number;
  /** How many cards have stale coverage (parameters just changed, not yet re-rendered) */
  stale: number;
}

/**
 * Run the coverage through the fingerprints of the **current project**, keep only what still
 * counts, then merge across cards.
 *
 * This is the whole mechanism behind "change A and A's span turns white in that very frame": if
 * the fingerprint does not match, it is not drawn. It is a pure function, so this behavior can be
 * unit tested, and if it were wrong, the UI would show "the bar is green, but scrubbing there
 * waits five seconds". That is the kind that lies, so it must be pinned down.
 */
export function visibleCoverage(
  cov: BakeCoverage,
  /** Cards still alive in the current project: fingerprint → its start on the timeline **now** (the fingerprint carries clip.id, so there are no collisions) */
  liveClips: Map<string, number>,
): VisibleCoverage {
  const isBaked = (m: CoverageInput) => !!m.id && cov.baked.has(m.id);
  const coarseM: CoverageInput[] = [];
  const fineM: CoverageInput[] = [];
  let dropped = 0;
  for (const c of cov.clips) {
    const liveStart = liveClips.get(c.fp);
    // Fingerprint mismatch = this card was changed or is gone, so all its coverage is stale
    if (liveStart === undefined) { dropped++; continue; }
    /*
     * **When a card is moved away, move the coverage with it.**
     *
     * Moments record absolute seconds, so once the card moves they point at the old place; but moving
     * does not invalidate the prerendered images (bakeTarget moves the clip to a fixed starting line
     * before rendering; measured, after the move 34/34 images still hit the same file). So the
     * correct approach is to shift, not to invalidate: invalidating makes the bar flash white while
     * the cache is clearly still there. The shift only moves where it is drawn, and `m.id` does not
     * change by a single character, so the ledger of "rendered or not" still matches.
     */
    const shift = liveStart - (c.start ?? 0);
    for (const m of c.moments) {
      const at = Math.abs(shift) < EPS
        ? m
        : { ...m, t: m.t + shift, start: m.start + shift, end: m.end + shift };
      if ((m.tier ?? "coarse") === "coarse") coarseM.push(at);
      // Green uses fine rather than tier: points like 0.5 seconds fall on both tiers and count as low
      // frame rate when queued, but they are equally a cell of the per-frame tier. Missing them would
      // leave a gap in the green bar every half second
      if (m.fine) fineM.push(at);
    }
  }
  return {
    coarse: coverageSegments(coarseM, isBaked),
    full: coverageSegments(fineM, isBaked),
    coarseBaked: coarseM.filter(isBaked).length,
    coarseTotal: coarseM.length,
    fullBaked: fineM.filter(isBaked).length,
    fullTotal: fineM.length,
    stale: dropped,
  };
}

/**
 * Record that "this moment is rendered". **The foreground on-demand render must call this too**:
 * if it does not, the picture has already become the real image while that span on the timeline
 * is still empty until the next inventory scan fills it in, which looks like the bar lagging a
 * beat.
 *
 * It only adds and does not compute spans: spans are computed on the fly when drawing, so O(1) is
 * enough here, and calling it once per rendered image costs nothing.
 */
export function markBaked(ids: string[]): void {
  const add = ids.filter((id) => !current.baked.has(id));
  if (!add.length) return;
  const baked = new Set(current.baked);
  for (const id of add) baked.add(id);
  publishCoverage({ ...current, baked });
}
