// Used as a type only: written as import type, node's type stripping erases the whole line, so the
// unit tests do not have to resolve that path without an extension (otherwise node --test fails
// right away with ERR_MODULE_NOT_FOUND)
import type { Project, Track } from "../../kernel/project";
// With the .ts suffix: unit tests run the source directly with node --test, which cannot resolve it
// without the suffix (the repo already does this elsewhere)
import { atFrameGrid } from "../../render/frameGrid.ts";

/** Track row height config */
export type RowSize = "small" | "medium" | "large";
export const ROW_SIZE_H: Record<RowSize, number> = {
  small: 28,
  medium: 44,
  large: 72,
};
export const DEFAULT_ROW_SIZE: RowSize = "medium";

/** Left row header column width (px) config */
export const HEADER_W_DEFAULT = 180;
export const HEADER_W_MIN = 120;
export const HEADER_W_MAX = 420;

/** Drag margin to the right of the content layer (px) */
export const TAIL_SLACK_PX = 200;

/**
 * End of the visible content. It is the upper bound of the playback range: an empty area should not
 * be playable, and dragging there would only show a black screen. The rule itself is in
 * kernel/duration.ts.
 */
export { contentEndOf } from "../../kernel/duration.ts";

/**
 * Start of the visible content: the start time of the earliest clip. 0 if there are no clips.
 * Playback starts here: the playback range is "earliest card ~ latest card".
 */
export function contentStartOf(tracks: Track[]): number {
  let start = Infinity;
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.start < start) start = clip.start;
    }
  }
  return Number.isFinite(start) ? Math.max(0, start) : 0;
}

/**
 * A small gap before 0 seconds (px, independent of zoom). Pure padding, it does not represent
 * time: time has no negative values.
 * With it, a clip at 0 seconds and the playhead do not stick right against the row header.
 */
export const GUTTER_PX = 24;

/** Time ↔ content layer pixels. All conversions go through these two functions, do not multiply by pxPerSec directly again. */
export function xOfTime(t: number, pxPerSec: number): number {
  return GUTTER_PX + t * pxPerSec;
}

export function timeOfX(x: number, pxPerSec: number): number {
  return (x - GUTTER_PX) / pxPerSec;
}

export function isOccupied(track: Track, clipId: string, start: number, end: number) {
  return track.clips.some(
    (c) => c.id !== clipId && Math.max(start, c.start) < Math.min(end, c.end)
  );
}

export function getGap(track: Track, clipId: string, projectDuration: number) {
  const others = track.clips.filter((c) => c.id !== clipId);
  const currentClip = track.clips.find(c => c.id === clipId);
  if (!currentClip) return { start: 0, end: projectDuration };
  
  let gapStart = 0;
  let gapEnd = projectDuration;
  
  for (const c of others) {
    if (c.end <= currentClip.start) gapStart = Math.max(gapStart, c.end);
    if (c.start >= currentClip.end) gapEnd = Math.min(gapEnd, c.start);
  }
  return { start: gapStart, end: gapEnd };
}

export function snapTime(
  time: number,
  altKey: boolean,
  project: Project,
  t: number,
  ignoreClipId?: string,
  pxPerSec: number = 100
) {
  /*
   * **Always snap to the frame grid**, alt included.
   *
   * What alt means is "do not snap to other clips and whole seconds", not "may stop at a moment that
   * does not exist in the final video": the final video is rendered frame by frame, so a clip that
   * starts at 4.041s actually starts at frame 122 (4.0667s) in the final video.
   *
   * This is not just ugly: the 3D view's prerender moments are laid out by **clip start**, while
   * export renders on the **global frame grid**. If the start is not on the frame grid, the two grids
   * do not line up, and not one-to-one either. Measured with start 4.041, playhead frames
   * 121 / 122 / 123 get prerender frames 121 / 121 / 122, so 3D is a full frame slower than 2D,
   * with no error reported.
   */
  const grid = (v: number) => atFrameGrid(v, project.fps || 30);
  if (altKey) return grid(time);
  const threshold = 10 / pxPerSec; // snap within 10 pixels
  const snapPoints = [0, t];
  const maxSec = Math.max(project.duration, time + 10);
  for (let i = 1; i <= Math.ceil(maxSec); i++) snapPoints.push(i);
  for (const track of project.tracks) {
    if (track.hidden) continue;
    for (const c of track.clips) {
      if (c.id === ignoreClipId) continue;
      snapPoints.push(c.start, c.end);
    }
  }
  let best = time;
  let minDiff = threshold;
  for (const p of snapPoints) {
    const diff = Math.abs(p - time);
    if (diff < minDiff) {
      best = p;
      minDiff = diff;
    }
  }
  return grid(best);
}

export function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}
