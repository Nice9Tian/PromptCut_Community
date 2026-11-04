import { actions, getState } from "../../store/project";
import { useTimelineContext } from "./TimelineContext";
import { snapTime, timeOfX } from "./utils";

/**
 * Dragging the playhead (scrub). The ruler and the playhead itself share this one implementation:
 * - Ruler: pressing moves the playhead to the pointer, and holding on keeps dragging (jumpToPointer)
 * - Playhead itself: pressing does not jump, and keeps the offset from when it was grabbed
 * Both seek in real time during the drag, so the picture follows along instead of jumping only on release.
 *
 * The time origin is always the left edge of the track area (trackArea): the ruler and the playhead are
 * both inside it, and the left edge of each element is not second 0.
 */
export interface ScrubOptions {
  /** Jump to the pointer on press (used by the ruler); false means keep the grab offset (used when dragging the playhead itself) */
  jumpToPointer: boolean;
}

/**
 * External signal for "a hand is pressing on the playhead".
 *
 * # Why the prerender side needs to know this
 *
 * When the 3D view sees that the board lacks the texture for this moment, it immediately fires a foreground
 * render. During a drag, every time the playhead crosses a cell (0.25 s) the moment changes, so **dragging
 * across while holding yields a stream of render requests**: each one occupies a Chrome for several seconds,
 * yet they render positions the user flashes past and never stops to look at. The next one arrives before
 * the previous one finishes, the pool is filled with these jobs that are bound to be discarded, and when the
 * user finally releases and stops somewhere, that render has to queue behind them.
 *
 * So: **render nothing while pressed, and render at the moment of release**. This is more accurate than
 * "debounce N ms": release is a definite event, with no need to guess how long counts as stopped; and a
 * click on the ruler that jumps there (press and release at once) doesn't wait longer either, because the
 * release happens immediately.
 *
 * It goes through a module-level store + useSyncExternalStore, for the same reason as the small store of
 * bakeCoverage: the timeline and the preview panel are far apart in the component tree, and no component in
 * the whole chain between them needs this value.
 *
 * # What is recorded is "which fingers are pressing", not a count
 *
 * A counter has a fatal failure mode: **miss one release and prerender stalls permanently**. And misses do
 * happen: the pointer taken over by another element, the element unmounted halfway through a drag, the
 * browser delivering pointerup elsewhere. Then the UI looks completely normal, but it never renders again,
 * and reports no error.
 *
 * So pointerIds are stored in a Set (repeated add / repeated delete are idempotent), and the cleanup happens
 * **on window**: a release counts no matter which element it lands on, and when the window loses focus
 * everything is cleared directly. Even if one release really was missed, the pointerup of the next click
 * anywhere clears it, so it won't rot there.
 */
const scrubbers = new Set<number>();
const scrubListeners = new Set<() => void>();
export function isScrubbing(): boolean { return scrubbers.size > 0; }
export function subscribeScrub(fn: () => void): () => void {
  scrubListeners.add(fn);
  return () => { scrubListeners.delete(fn); };
}
function notifyScrub() { for (const fn of scrubListeners) fn(); }
function beginScrub(id: number) {
  if (scrubbers.has(id)) return;
  scrubbers.add(id);
  notifyScrub();
}
function endScrub(id: number) {
  if (!scrubbers.delete(id)) return;
  notifyScrub();
}
if (typeof window !== "undefined") {
  // Cleanup is always attached to window: a release counts no matter which element it lands on, so none can be missed
  window.addEventListener("pointerup", (e) => endScrub(e.pointerId), true);
  window.addEventListener("pointercancel", (e) => endScrub(e.pointerId), true);
  // If the window is switched away mid-drag, pointerup may never come: treat losing focus as everything released
  window.addEventListener("blur", () => {
    if (!scrubbers.size) return;
    scrubbers.clear();
    notifyScrub();
  });
}

export function useScrub() {
  const { pxPerSec, trackAreaRef } = useTimelineContext();

  return (e: React.PointerEvent, opts: ScrubOptions) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const el = e.currentTarget as HTMLElement;
    const secAt = (clientX: number) => {
      const left = trackAreaRef.current?.getBoundingClientRect().left ?? 0;
      return Math.max(0, timeOfX(clientX - left, pxPerSec));
    };
    // Dragging the playhead during playback gets pulled back by the playback loop, so stop first
    if (getState().playing) actions.pause();

    // -1: don't treat the playhead itself as a snap point, or it would stick in place while dragging
    const snap = (raw: number, altKey: boolean) =>
      Math.max(0, snapTime(raw, altKey, getState().project, -1, undefined, pxPerSec));

    const offset = opts.jumpToPointer ? 0 : getState().t - secAt(e.clientX);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (e.g. a synthetic event, or the mouse is already released); dragging still works, just without capture
    }
    actions.seek(snap(secAt(e.clientX) + offset, e.altKey));

    /*
     * pointermove only records "where to go" and hands it to the store at most once per animation frame.
     *
     * Every hand-off makes the whole timeline, stage and media layer re-render, and the video has to seek; when
     * mouse events are denser than the screen refresh (high polling rate mice, events piling up on the main
     * thread), several hand-offs happen in one frame, and the earlier ones are invalidated before they are drawn.
     * The card layer still follows every frame; the video is throttled again by the media layer itself
     * (SCRUB_SEEK_MIN_MS in mediaSync), allowed to lag the playhead by a frame or two while dragging, and
     * caught up on release.
     */
    let pending: number | null = null;
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (pending === null) return;
      actions.seek(pending);
      pending = null;
    };
    const onMove = (ev: PointerEvent) => {
      pending = snap(secAt(ev.clientX) + offset, ev.altKey);
      if (!raf) raf = requestAnimationFrame(flush);
    };
    // Pointer pressed: from this moment foreground rendering yields until release. Cleanup is hooked
    // on window (see isScrubbing above)
    beginScrub(e.pointerId);
    const onUp = (ev: PointerEvent) => {
      /*
       * Release lands on the exact position: submit one last time with the pointer at the release point;
       * any frame that has not been submitted yet is dropped (overridden by it).
       * The pointercancel coordinates cannot be trusted (may be 0), so in that case only submit what has
       * already been recorded.
       * Do not submit if it already equals the store: every submit re-renders the whole editor, so one
       * extra submit on release means one extra wait.
       * Video does not rely on this: when isScrubbing goes back to false, the media layer aligns itself
       * exactly once at 0.03s.
       */
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      const final = ev.type === "pointerup" ? snap(secAt(ev.clientX) + offset, ev.altKey) : pending;
      pending = null;
      if (final !== null && final !== getState().t) actions.seek(final);
      endScrub(ev.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        // The pointer has been taken over elsewhere, ignore
      }
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };
}
