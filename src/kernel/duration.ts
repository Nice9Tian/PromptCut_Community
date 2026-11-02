/**
 * Rules for project total duration (`docs/semantics/product/project-model.md` "Total duration"):
 * defaults to end of content, tracking content; can be manually shortened (truncated), but cannot
 * be extended past end of content; an empty project retains its original value.
 *
 * Manual values are not persisted to disk, only living in editor state (`durationManual`), and
 * are cleared when switching projects or cuts.
 */
import type { Track } from "./project.ts";

/** End of visible content: end time of the last clip. 0 if there are no clips. */
export function contentEndOf(tracks: Track[]): number {
  let end = 0;
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.end > end) end = clip.end;
    }
  }
  return end;
}

/**
 * What the project total duration should be at this moment.
 * `manual` is the seconds manually truncated to; `null` = not truncated, tracks content.
 */
export function effectiveDuration(contentEnd: number, current: number, manual: number | null): number {
  // Empty projects have no content to follow, so retain the value in the document; otherwise
  // the timeline collapses to 0 width and nothing can be dragged into it.
  if (contentEnd <= 0) return current;
  return manual === null ? contentEnd : Math.min(manual, contentEnd);
}

/**
 * The manual value to record when someone (user or Agent) wants to set total duration to
 * `requested` seconds. Counts as truncation only when shorter than end of content; if equal to
 * or longer than end of content, reverts to tracking content (cannot be extended, and should not
 * leave an upper bound that blocks new content later). Same for empty projects: set to original
 * value, and tracks content normally as content is added later.
 */
export function manualDurationFor(requested: number, contentEnd: number): number | null {
  return contentEnd > 0 && requested < contentEnd ? requested : null;
}
