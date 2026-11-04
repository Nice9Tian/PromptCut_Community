/**
 * Execution surface for aligning media elements (`<video>` / `<audio>`) with the playhead (E7 item 1).
 *
 * "What to do this frame" is a pure function in `mediaSync.ts`; this file only passes element
 * readings, executes the result accordingly, and remembers the **latest** target for each
 * element (used when seek settles or scrub throttling expires).
 *
 * # Why in `src/render/` instead of `src/editor/`
 *
 * Media layers are moving into the stage iframe (E7): `VideoTrack` renders inside the stage,
 * sharing this driver with `MediaLayers` (main document, audio only). Placing it under `render/`
 * allows both sides to import it without pulling editor modules into the stage bundle: not a
 * single `src/editor/**` is imported here.
 *
 * Audio routing (`audio/previewAudio.ts`) is **not here**: it belongs to the editor main document,
 * and the stage is always `muted`.
 */
import { emphasisFilter } from "../kernel/emphasis";
import { clipFilterOpsAt, cssFilter, type FilterDef } from "../kernel/filters.mjs";
import type { TrackClip } from "../kernel/project";
import { mediaTimeAt } from "../kernel/clipTime.mjs";
import { planSync } from "./mediaSync";

/** Timestamp of the last drift-correction seek initiated by us, tracked per element */
export const lastSeekAt = new WeakMap<HTMLMediaElement, number>();

/** Where an element should currently align to */
export interface Want {
  target: number;
  playing: boolean;
  volume: number;
  scrubbing: boolean;
  /** Base playback rate = clip speed (`TrackClip.speed`, default 1); ±10% drift correction floats on top of it */
  rate?: number;
}
/**
 * The **latest** "intended target" for each element. Re-evaluated when seek settles or scrub
 * throttling expires;
 * no entry = this element is currently unmanaged (standby slot, pinch-hitting final frame),
 * so no catch-up seek when settled.
 */
const wants = new WeakMap<HTMLMediaElement, Want>();
const retryTimers = new WeakMap<HTMLMediaElement, number>();
const hooked = new WeakSet<HTMLMediaElement>();

/**
 * True wall clock. In the stage document, `performance.now` is replaced with virtual time by
 * `stageClock` (always equal to stage milliseconds); using it to compute seek cooldown yields
 * "cooldown never expired" or "cooldown always expired": media layers follow the wall clock,
 * not virtual time.
 * Same for `setTimeout`: after E4b it is a fake timer registered on the virtual clock, which
 * never fires in paused state.
 */
const realNow = (): number => (window.__pcRealNow ?? performance.now.bind(performance))();
const realTimeout = (fn: () => void, ms: number): number =>
  (window.__pcRealSetTimeout ?? window.setTimeout.bind(window))(fn, ms);

/** Align a media element to the timeline */
export function syncMediaEl(el: HTMLMediaElement, want: Want) {
  const v = Math.max(0, Math.min(1, want.volume));
  if (el.volume !== v) el.volume = v;

  const plan = planSync({
    elTime: el.currentTime,
    seeking: el.seeking,
    paused: el.paused,
    ended: el.ended,
    target: want.target,
    baseRate: want.rate,
    playing: want.playing,
    scrubbing: want.scrubbing,
    now: realNow(),
    lastSeekAt: lastSeekAt.get(el) ?? 0,
  });

  if (plan.rate !== null && el.playbackRate !== plan.rate) el.playbackRate = plan.rate;
  if (plan.seekTo !== null) {
    el.currentTime = plan.seekTo;
    lastSeekAt.set(el, realNow());
  }
  if (plan.pause) el.pause();
  if (plan.play) el.play().catch(() => {});

  // The seek suppressed by throttling during scrubbing must be caught up: after scrubbing stops, no new renders will trigger sync
  window.clearTimeout(retryTimers.get(el));
  if (plan.retryInMs !== null) {
    retryTimers.set(el, realTimeout(() => {
      const w = wants.get(el);
      if (w) syncMediaEl(el, w);
    }, plan.retryInMs));
  }
}

/** Make an element follow the playhead: record the latest target and evaluate once immediately */
export function driveMedia(el: HTMLMediaElement | null, want: Want) {
  if (!el) return;
  wants.set(el, want);
  if (!hooked.has(el)) {
    hooked.add(el);
    /*
     * Evaluate again with the latest target once seek settles. planSync issues no new commands
     * while seeking (currentTime reads target value then; computing drift with it would overturn
     * the newly issued seek), with the trade-off that new positions arriving during this period
     * are dropped:
     * previously without this step, if the final scrub landed mid-seek, the frame would stay
     * frozen on the old frame forever.
     */
    el.addEventListener("seeked", () => {
      const w = wants.get(el);
      if (w) syncMediaEl(el, w);
    });
    /*
     * When metadata arrives (src changed, reloaded via `load()`, or late metadata), evaluate again
     * with the latest target. currentTime set when readyState is 0 is only the "default playback start
     * position", which may or may not be retained after `load()` depending on the browser; while paused,
     * no further renders may call driveMedia, leaving the element stuck at 0 without this catch-up
     * (`docs/archive/agent-reports/AGENT-tier-reload-seek.md`). If the browser has already sought to the
     * default start position, seeking / already aligned is read here, and nothing is done.
     */
    el.addEventListener("loadedmetadata", () => {
      const w = wants.get(el);
      if (w) syncMediaEl(el, w);
    });
  }
  syncMediaEl(el, want);
}

/** This element is no longer tracking the playhead (standby, pinch-hitting): stop, and do not catch up seek after settling */
export function releaseMedia(el: HTMLMediaElement | null) {
  if (!el) return;
  wants.delete(el);
  window.clearTimeout(retryTimers.get(el));
  if (!el.paused) el.pause();
}

/** Playhead time converted to this media (`kernel/clipTime.mjs`, including clip speed) */
export function targetTimeOf(clip: TrackClip, t: number) {
  return mediaTimeAt(clip, t);
}

/**
 * Filter on media layer elements: filter first (kernel/filters.mjs, same values as export and
 * see_frames), followed by emphasis drop-shadow:
 * the shadow is cast by the color-adjusted image, in the same "filter first, emphasis second"
 * order as the export pipeline. Emphasis uses the same calculation as the stage (kernel/emphasis.ts).
 * The element is inside the clip box with an overall outer transform scale, so blur is written in
 * in-box pixels (multiplied by frame.scale when mapped to canvas, matching blurScale = p.scale on
 * the export side). If neither exists, omit this property.
 */
export function filterOf(clip: TrackClip, filters: FilterDef[] | undefined, t: number): string | undefined {
  const ops = filters?.length ? clipFilterOpsAt({ filters }, clip, t) : null;
  const parts = [ops ? cssFilter(ops) : "", emphasisFilter(clip.emphasis) || ""].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}
