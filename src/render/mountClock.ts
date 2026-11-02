import { typingMountClockMs } from "../kernel/typingEvents";

/**
 * Accounting for the mount clock (`CardProps.mountClockMs`), extracted from `Stage` for unit
 * testing.
 *
 * The export page with a flattened timeline (the `Stage` in `ExportView` that does not go through
 * `FrameScene`) mounts cards `CARD_MOUNT_LEAD` early. Old "play on mount" typing cards timed from the
 * page clock of the frame where they mounted, so on this path they ran ahead of the clip start by
 * this duration (one frame at 30 fps), which is how the export pixel baseline (default demo project)
 * was rendered. New cards retrieving characters by `t` must be frame-accurate, so they need to know
 * how early they were mounted.
 *
 * `mountedAt`: stage time (seconds) at the first render of this mount (`clip id:generation`, same as
 * the wrapper layer key).
 * Return value: for cards mounted before the clip start → elapsed milliseconds since mount (same
 * formula as the old implementation); for cards mounted at or after the start (exporting from the
 * middle of a clip, remounting) → `undefined`, and the card uses `t` as usual, preventing "continue
 * typing from the middle" from reverting to "type from the start".
 */
export function mountClockMsAt(mountedAt: Map<string, number>, key: string, clipStart: number, now: number): number | undefined {
  let at = mountedAt.get(key);
  if (at === undefined) mountedAt.set(key, at = now);
  return at < clipStart ? typingMountClockMs(now, at) : undefined;
}

/**
 * Clear cards not mounted in this render: re-entering is a new mount, and the clock restarts from
 * then (consistent with old cards replaying upon remount).
 */
export function forgetUnmounted(mountedAt: Map<string, number>, live: ReadonlySet<string>): void {
  for (const key of [...mountedAt.keys()]) if (!live.has(key)) mountedAt.delete(key);
}
