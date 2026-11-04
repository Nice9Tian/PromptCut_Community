/**
 * The prerender queueing algorithm: **render textures ahead of time when idle**, instead of
 * rendering on demand once the playhead arrives.
 *
 * The problem with on-demand rendering is plain: each render launches a Chrome and takes four or
 * five seconds, and those seconds happen exactly when the user has just scrubbed to that span and
 * most wants to see it clearly. The prerender moves that cost to a time when nobody is waiting.
 *
 * # What is queued is "moments", not "cards"
 *
 * A card moves during its few seconds, so what needs prerendering is not one image but **several
 * moments** (which moments is decided by `sampleTimesFor` in `bakeTime.ts`, and the keys are given
 * by its `texKeyOf`). This module only handles two things: **which to render first** and **how
 * much to keep**.
 *
 * Keys are brought in by the caller and not computed here: if two places each compute their own
 * keys, sooner or later there will be "clearly prerendered but treated as not rendered" or
 * "deleted what is in use", and neither reports an error; things are just inexplicably slow.
 *
 * # Order: what is in front first, then both sides, finally from the start
 *
 *   1. **For each card on screen right now, the moment closest to the current time**: those are
 *      what the user is looking at, and not a single frame can wait.
 *   2. **Expand to both sides by "how far from the playhead"**. Both forward and backward: the
 *      user scrubs forward as well as looking back. At equal distance, prefer forward (the
 *      playback direction).
 *   3. **From 0**, fill in the rest. Jumping back to the start to rewatch is one of the most
 *      common actions, and the whole video needs them sooner or later, so it is better to lay
 *      them down steadily in time order.
 *
 * # The budget governs **the PNGs on disk**, and counts only real bytes
 *
 * What the prerender accumulates is PNGs, one by one (formerly landed as `bake-*.png` in
 * `out/media`; now stored into `px` through the asset service, with this machine recording
 * "which key maps to which chunk", see server/bake-store.mjs. Read "files on disk" and "delete"
 * below accordingly: usage is the bytes of the snapshots this machine has recorded, and delete
 * means forgetting the record). Measured: 80 files at 4.04MB, individual ones from 2.4KB to
 * 95KB, a difference of dozens of times (a card with a full background cannot be compressed, while
 * an almost blank card compresses to just over two thousand bytes). So **it cannot be counted by
 * number of images**; it must be counted by how big each file really is, and this is also the only
 * honest measure for this whole setup.
 *
 * There is **no estimation at all** here: a file that was never prerendered does not exist on
 * disk and takes not a single byte, so only **what is already rendered** counts toward usage.
 * Those to render are sent one by one by priority, each coming back with its own real size, and
 * usage is the measured sum. Once full, nothing more is sent: at most it overshoots by one file's
 * size (a few dozen KB), in exchange for never having to guess.
 *
 * # "Files this project does not use" go last, but **are not deleted on sight**
 *
 * The cache key is a hash of the card content and the moment, so each parameter change adds a
 * batch of files and the old ones are never hit again; one session can accumulate dozens
 * (measured: grew from 45 to 105 within one day, while the project had only a dozen cards).
 * These files are indeed dead for the current project, but `out/media` is **shared by all
 * projects**: "does not belong to the current project" and "is useless" are two different things.
 * Deleting by the former means that when the user switches to another project and comes back, the
 * cache of the previous project is entirely gone, with no notice whatsoever, showing up only as
 * "why is it a five second wait again".
 *
 * So they are only **put last**: if there is enough space they are all kept (that is how a cache
 * should behave), and if there is not enough, they are the first to be squeezed out. Whether to
 * delete is decided by the budget, not by "is it this project's".
 *
 * # GPU memory is not handled here
 *
 * A measured note for the record, so nobody later applies this budget to GPU memory: the same
 * batch of textures is 2.22MB on disk, but **decoded into textures in GPU memory it is 135MB**,
 * 61 times, and the compression ratio varies from 25× to 114×, so it cannot be derived. But that
 * account is not decided by the prerender: Scene3DView builds materials only for the cards at
 * **the current moment**, and disposes of all of them when the scene is rebuilt. A prerendered file
 * takes no GPU memory at all before it is used.
 */

/**
 * The two prerender tiers.
 *
 * coarse: the **low frame rate** tier (one cell per 0.25 seconds). Fill the whole video with it
 *   first: the cost is only a fraction of the original frame rate, and anywhere scrubbed to has an
 *   immediate picture, just off by at most 0.25 seconds.
 * full: the **original frame rate** tier (project fps). It starts only after coarse is all
 *   laid down, and once prerendered, that span is frame-accurate.
 *
 * The order is hard-wired as "coarse all done → only then start full", not mixed by distance:
 * letting the whole video be viewable first (even if off by 0.25 seconds) is far more useful than
 * making the first few seconds exact and leaving everything after blank.
 */
export type BakeTier = "coarse" | "full";

/** A moment to prerender. `key` is given by the caller (see texKeyOf in bakeTime.ts); not computed here */
export interface BakeMoment {
  clipId: string;
  /** Which tier it belongs to. If omitted, it counts as coarse */
  tier?: BakeTier;
  /** Whether it falls on a cell of the original frame rate. Queueing ignores it; drawing the progress bar needs it (see bakeCoverage) */
  fine?: boolean;
  /** Which moment to prerender (absolute timeline seconds) */
  t: number;
  /** The range of this card on the timeline, used to decide "is playback right at it now" */
  start: number;
  end: number;
  key: string;
}

/** spare = files that do not match the current project (old version / other project / old format), placed after all moments */
export type BakePhase = "current" | "near" | "rest" | "spare";

export interface BakeJob {
  clipId: string;
  t: number;
  key: string;
  phase: BakePhase;
  tier: BakeTier;
}

export interface KeptFile {
  key: string;
  clipId: string;
  /** How big this file really is on disk (measured, not estimated) */
  bytes: number;
  phase: BakePhase;
}

export interface PlanInput {
  /** All the moments of the whole video that need prerendering */
  moments: BakeMoment[];
  /** Current playhead (seconds) */
  t: number;
  /** Disk budget (bytes) */
  budgetBytes: number;
  /** Already prerendered: key → real byte size of the file */
  known: Map<string, number>;
  /** How wide the "nearby" window is (seconds). Beyond this range goes to phase three (laid down from 0) */
  nearWindowSec?: number;
}

export interface BakePlan {
  /** Not yet prerendered, already sorted by priority. The scheduler sends from the top down and stops when `footprintBytes` reaches the budget */
  jobs: BakeJob[];
  /** Files within the budget that should be kept (including those that do not belong to the current project) */
  keep: KeptFile[];
  /** Keys to delete: **only those squeezed out by the budget**. When there is enough space this is always empty */
  evict: string[];
  /** How much disk keep takes in total (all measured values) */
  footprintBytes: number;
  /** Number of files squeezed out */
  dropped: number;
}

/**
 * Snap a moment **to a frame number**: `start + i / fps`, where i is an integer frame number.
 *
 * # What it solves now: "the two grids do not line up"
 *
 * Prerender has two tiers: low frame rate (one cell per 0.25 s) and original frame rate (one cell
 * per 1/fps). These two grids **never lined up in the first place**: at 30fps, 0.25 s = 7.5
 * frames, so points like 0.25 / 0.75 / 1.25 / 1.75 do not land on the frame grid at all
 * (measured: 4 of 8 low-frame-rate points miss). The mismatch has two consequences, neither of
 * which raises an error:
 *
 *   - The same instant is treated as two different keys and **rendered twice**;
 *   - A low-frame-rate image is rendered but does not count toward the "original frame rate"
 *     coverage, so the green bar is missing a piece every half second.
 *
 * After snapping, the low frame rate becomes a **subset** of the original frame rate, and both
 * problems go away together.
 *
 * # A historical problem it also covers (root cause already fixed in bakeTime.ts)
 *
 * `sampleTimesFor` used to **accumulate** the step while `pickBakeT` did **floor, then multiply**.
 * On a step like 1/30, which is not exactly representable in binary, the two differ by 2.8e-17
 * (at 30fps, 39 of 60 samples did not match), and the cache key is a hash of that float. So the
 * images prerendered for the per-frame tier were never found by the display side. Now `gridAt` in
 * `bakeTime.ts` is unified as "multiply by index" and the root cause is gone. Snapping by frame
 * number here is still an extra line of defense: if a moment comes from elsewhere, or uses a
 * different step, it can still be mapped back to the same value.
 *
 * **Do not change this to quantizing to a fixed number of decimals.** Tried it, and it is worse:
 * 1/30 gets truncated to 0.033333, slightly below the frame boundary, and `floor` falls straight
 * back a whole frame (20 wrong out of 60). That approach does not hold for steps with a
 * non-terminating decimal expansion.
 *
 * It uses round rather than floor: the incoming value should already sit on some frame and only
 * carries representation error, and round restores the original frame number. "Do not show a
 * frame that has not been reached yet" is already guaranteed by the floor in `pickBakeT` when it
 * is called.
 */
export function canonFrameT(t: number, start: number, fps: number): number {
  const f = Math.max(1, fps);
  return start + Math.round((t - start) * f) / f;
}

const DEFAULT_NEAR_WINDOW_SEC = 20;

/** Whether the playhead is currently on this card */
export function isLive(m: { start: number; end: number }, t: number): boolean {
  return t >= m.start && t < m.end;
}

/**
 * How far this moment is from the playhead. **Computed from the moment's own time**, not per
 * card: a card has several moments, and even the card that is playing has "about to be seen"
 * moments and "still far off" ones.
 */
export function distanceFrom(m: { t: number }, t: number): number {
  return Math.abs(m.t - t);
}

/** How to order within a tier: in front of the playhead → both sides → laid out from 0 */
function orderWithinTier(
  moments: BakeMoment[],
  t: number,
  nearWindowSec: number,
): { m: BakeMoment; phase: BakePhase }[] {
  /*
   * "For each card playing right now, the moment closest to the current time": these are what is
   * on screen right now. Take the single closest one per clip, rather than counting every moment
   * of the playing card as current: the look of that card a few seconds later also needs to be
   * prerendered, but it has no business competing with "this very frame" for the same priority.
   */
  const liveBest = new Map<string, BakeMoment>();
  for (const m of moments) {
    if (!isLive(m, t)) continue;
    const cur = liveBest.get(m.clipId);
    if (!cur || distanceFrom(m, t) < distanceFrom(cur, t)) liveBest.set(m.clipId, m);
  }
  const currentKeys = new Set([...liveBest.values()].map((m) => m.key));

  const current = [...liveBest.values()].sort((a, b) => distanceFrom(a, t) - distanceFrom(b, t));
  const others = moments.filter((m) => !currentKeys.has(m.key));
  /*
   * "Nearby" is ordered by distance only: before and after alternate naturally, with no need for
   * hand-written "one before, one after" interleaving logic. On a tie, prefer later: users drag
   * forward far more often than backward.
   */
  const near = others
    .filter((m) => distanceFrom(m, t) <= nearWindowSec)
    .sort((a, b) => distanceFrom(a, t) - distanceFrom(b, t) || (a.t >= t ? -1 : 1) - (b.t >= t ? -1 : 1) || a.t - b.t);
  // The rest are laid out in time order starting from 0
  const rest = others.filter((m) => distanceFrom(m, t) > nearWindowSec).sort((a, b) => a.t - b.t);

  return [
    ...current.map((m) => ({ m, phase: "current" as const })),
    ...near.map((m) => ({ m, phase: "near" as const })),
    ...rest.map((m) => ({ m, phase: "rest" as const })),
  ];
}

export function planBakes(input: PlanInput): BakePlan {
  const { moments, t, budgetBytes, known, nearWindowSec = DEFAULT_NEAR_WINDOW_SEC } = input;

  /*
   * **Finish laying out the whole low-frame-rate tier first, then start the original-frame-rate
   * tier.**
   *
   * Do not interleave them: interleaving ends up with frame-exact images near the playhead while
   * the second half of the video is still blank. And "there is an image wherever you drag (even if
   * it is off by 0.25 s)" is much more useful than "the first few seconds are especially exact".
   * Each of the two tiers is then ordered by "in front of the playhead → both sides → laid out
   * from 0", so even the low-frame-rate tier looks after what is in front of the playhead first.
   */
  const coarse = moments.filter((m) => (m.tier ?? "coarse") === "coarse");
  const full = moments.filter((m) => m.tier === "full");
  const ordered = [
    ...orderWithinTier(coarse, t, nearWindowSec),
    ...orderWithinTier(full, t, nearWindowSec),
  ];

  const keep: KeptFile[] = [];
  const jobs: BakeJob[] = [];
  const seen = new Set<string>();
  const evict: string[] = [];
  let footprintBytes = 0;
  let dropped = 0;

  for (const { m, phase } of ordered) {
    // A key that appears twice (same card, same moment) maps to only one file
    if (seen.has(m.key)) continue;
    seen.add(m.key);

    const bytes = known.get(m.key);
    if (bytes === undefined) {
      // Not rendered yet: it does not exist on disk and takes no space, so it does not count toward the budget and is only queued for rendering
      jobs.push({ clipId: m.clipId, t: m.t, key: m.key, phase, tier: m.tier ?? "coarse" });
      continue;
    }
    /*
     * The current moment is **not limited by the budget**: however small the budget, the image the
     * user is looking at must not be deleted. If it were deleted, it would have to be rendered on
     * the spot the next second, and all this machinery would have been for nothing.
     */
    if (phase !== "current" && footprintBytes + bytes > budgetBytes) {
      dropped++;
      evict.push(m.key);
      continue;
    }
    keep.push({ key: m.key, clipId: m.clipId, bytes, phase });
    footprintBytes += bytes;
  }

  /*
   * Everything left is a file that **does not match the current project**: old versions with
   * changed parameters, files rendered by other projects, leftovers from an old format. They are
   * ranked after all moments, but are still "keep if it fits": the value of a cache is in keeping
   * things, and out/media is shared by all projects, so deleting by "not from this project" would
   * hit innocent files.
   */
  for (const [key, bytes] of known) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (footprintBytes + bytes > budgetBytes) {
      dropped++;
      evict.push(key);
      continue;
    }
    keep.push({ key, clipId: "", bytes, phase: "spare" });
    footprintBytes += bytes;
  }

  return { jobs, keep, evict, footprintBytes, dropped };
}

/**
 * How big the budget is. It is split by machine memory instead of picking a fixed value: the
 * space an 8GB laptop and a 64GB workstation can spare differ by an order of magnitude.
 *
 * `navigator.deviceMemory` exists only in Chromium, and it is **coarse-grained**
 * (0.25/0.5/1/2/4/8, capped at 8GB, not the real memory). So it is only a tier reference, not an
 * exact value, and if unavailable we assume 4GB.
 *
 * We take 1.5%: about 120MB on an 8GB machine. At a measured average of 55KB per file, that is
 * over two thousand files. A card needs a dozen or so moments prerendered, so "over two thousand
 * files" is roughly **one to two hundred cards**, which is enough for a normal project.
 * But it **really is the only way things get reclaimed**: nothing is deleted except by being
 * squeezed out past this line. So this number must be neither so small that it deletes things
 * still in use, nor so large that out/media grows without bound.
 * To really tune it, first measure how large the directory actually gets, then change it.
 */
export function defaultBudgetBytes(deviceMemoryGB?: number): number {
  const gb = Number.isFinite(deviceMemoryGB) && (deviceMemoryGB as number) > 0 ? (deviceMemoryGB as number) : 4;
  const bytes = gb * 1024 * 1024 * 1024 * 0.015;
  return Math.round(Math.min(512 * 1024 * 1024, Math.max(64 * 1024 * 1024, bytes)));
}
