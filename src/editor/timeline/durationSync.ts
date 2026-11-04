/**
 * The sync point for "the playback range follows the visible content": when the content end changes (moved,
 * lengthened, last clip deleted), align the total duration
 * (`effectiveDuration`; the upper limit of a manual truncation stays as before). It only runs while the
 * timeline is mounted, same as the effect that used to live in the timeline.
 *
 * # Why we no longer rely only on the post-render effect (tiers-probe T4, docs/archive/agent-reports/AGENT-perf-t4.md)
 *
 * Before, `TimelineInner` called `syncDuration` in an effect after rendering: move the last clip → the whole
 * editor renders once with the new clips → the effect finds the duration is wrong → edits the project
 * again → **the whole editor renders again in the same task**. One edit caused two full re-renders, and on
 * a laptop, with background transcoding and uploading competing for CPU, this task went past 50 ms.
 *
 * Now a listener is attached to the store: as soon as the project changes, a microtask is queued to align
 * the duration. The listener is attached at module load, ahead of the subscriptions of all React
 * components, so this microtask is queued before the microtask where React flushes rendering: the duration
 * is aligned first and then rendered, so one edit renders only once.
 * It is done in a microtask rather than changed on the spot in the listener: when someone else's change is
 * written into the store via docsync, the listener is inside its call stack, and committing again on the
 * spot would re-enter docsync's own callback; moving it to a microtask puts it outside the stack, like the
 * old effect.
 * When the order does not hold (something else queued a render first in the same task), it falls back to the
 * old behavior: render once, align the duration, render again, which is no worse.
 * The effect in `TimelineInner` stays as a fallback: if it is still wrong after rendering, patch it as before.
 */
import { useEffect } from "react";
import { actions, getState, subscribe } from "../../store/project";
import { contentEndOf, effectiveDuration } from "../../kernel/duration";
import type { Track } from "../../kernel/project";
import { isRecoveringAssociation } from "../sync/recoveryAssociation";
import { memberReadOnlyNow } from "../readOnlyCore";

let mounted = 0;
let queued = false;
/** The three things aligned last time: if none of the objects changed, no need to align again */
let seen: { tracks: Track[]; duration: number; manual: number | null } | null = null;

/** If the total duration for the current content end differs from the one recorded in the project, fix it (not pushed onto the undo stack, same as before) */
export function syncDurationNow(): void {
  queued = false;
  // Read-only project (guest): the total duration is a project field, so this would be a write and the server would reject it; also do not edit it yourself when viewing someone else's project
  if (mounted === 0 || isRecoveringAssociation() || memberReadOnlyNow()) return;
  const s = getState();
  const tracks = s.project.tracks;
  const duration = s.project.duration;
  const manual = s.durationManual;
  if (seen && seen.tracks === tracks && seen.duration === duration && seen.manual === manual) return;
  seen = { tracks, duration, manual };
  const target = effectiveDuration(contentEndOf(tracks), duration, manual);
  if (Math.abs(target - duration) > 1e-6) actions.syncDuration(target);
}

subscribe(() => {
  if (mounted === 0 || queued) return;
  queued = true;
  queueMicrotask(syncDurationNow);
});

/** Start following (can be stacked); returns the function that stops it */
export function mountDurationSync(): () => void {
  mounted++;
  seen = null;
  syncDurationNow();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    mounted--;
  };
}

/** Make the total duration follow the content while the timeline is mounted */
export function useDurationFollowsContent(): void {
  useEffect(() => mountDurationSync(), []);
}

/** For tests */
export function resetDurationSync(): void {
  mounted = 0;
  queued = false;
  seen = null;
}
