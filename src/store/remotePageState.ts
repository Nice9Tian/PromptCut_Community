/**
 * The places where this page's own page state must adjust after changes from others (another page,
 * Agent server) land on this page.
 *
 * c65-integ2 ruling: writes of `set_project_meta`, `switch_cut`, `add_cut`, `remove_cut` are moved
 * to execute on Agent server (D1 criterion); page state is requested read-only once via page channel
 * (playhead). The page state "writes" they previously performed along the way: updating playhead
 * after switching cuts, clearing selection, pausing playback, recording manual value after
 * truncating total duration: are now inferred by the page itself upon seeing remote changes.
 * This works the same between two local pages or between members: whoever switches cuts or truncates
 * total duration, other pages follow along rather than being reverted by timeline to end of content.
 *
 * Pure function, does not touch store (`bindStore` calls it then `set`), easy to test in node.
 */
import type { Project } from "../kernel/project";
import { contentEndOf, manualDurationFor } from "../kernel/duration";

export interface RemotePageStateInput {
  t: number;
  selection: string[];
  durationManual: number | null;
  playToken: number;
}

export interface RemotePageStatePatch {
  t?: number;
  playing?: boolean;
  selection?: string[];
  playToken?: number;
  durationManual?: number | null;
}

function clipIds(p: Project): Set<string> {
  const ids = new Set<string>();
  for (const tr of p.tracks ?? []) for (const c of tr.clips ?? []) ids.add(c.id);
  return ids;
}

/**
 * `prev` is this page's project before applying remote changes, `next` is after. Return page state
 * to write into store, or null if no change is needed.
 *
 * - Active cut changed (someone else switched cut): same as this page switching cut itself: update
 *   playhead to target cut's last parked position (`t` on target cut entry in `prev`, which
 *   disappears from the entry after switching), pause playback, clear selection, clear manual
 *   total duration value.
 * - Otherwise total duration changed (someone set total duration, or someone's timeline synced to
 *   end of content): infer manual value from new total duration: shorter than end of content means
 *   truncation (record it), otherwise follow content (clear it). Same rule as `setDurationManual`.
 * - Remove clips in selection that have already been deleted.
 */
export function pageStateAfterRemote(prev: Project, next: Project, st: RemotePageStateInput): RemotePageStatePatch | null {
  if (prev === next) return null;
  const prevCut = prev.activeCutId ?? null;
  const nextCut = next.activeCutId ?? null;
  if (prevCut !== nextCut && nextCut !== null) {
    const parked = prev.cuts?.find((c) => c.id === nextCut)?.t;
    return {
      t: typeof parked === "number" && Number.isFinite(parked) ? parked : 0,
      playing: false,
      selection: [],
      playToken: st.playToken + 1,
      durationManual: null,
    };
  }
  const patch: RemotePageStatePatch = {};
  if (prev.duration !== next.duration) {
    const manual = manualDurationFor(next.duration, contentEndOf(next.tracks ?? []));
    if (manual !== st.durationManual) patch.durationManual = manual;
  }
  if (st.selection.length && prev.tracks !== next.tracks) {
    const alive = clipIds(next);
    const kept = st.selection.filter((id) => alive.has(id));
    if (kept.length !== st.selection.length) patch.selection = kept;
  }
  return Object.keys(patch).length ? patch : null;
}
