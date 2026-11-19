/**
 * When the timeline's edit tools apply to a clip: one rule each, shared by the store action that
 * does the edit and the toolbar button that offers it, so a button is never enabled for an edit the
 * store would refuse. (Crop and mirror have theirs in kernel/mediaPicture.mjs, next to the data they
 * describe; the ffmpeg export needs that file and cannot import TypeScript.)
 */
import { findClip, type Project, type Track, type TrackClip } from "./project";
import { timingLock } from "./transitions";
import { hasFrameExpr } from "./frameExpr.mjs";

/** Closest a split may come to either end of a clip (seconds): a piece shorter than this is a slip, not an edit */
export const SPLIT_EDGE_SEC = 0.05;

/**
 * Why a clip cannot be split at second `t`, or null when it can:
 *   - "missing": there is no such clip;
 *   - "outside": `t` is not inside the clip, or is within `SPLIT_EDGE_SEC` of either end;
 *   - "transition": a transition locks the clip's timing (splitting would leave the transition's ends
 *     pointing at the wrong pieces; delete the transition first);
 *   - "locked": the clip's track is locked, or so is the track holding a sound effect generated from it
 *     (splitting also splits that sound effect).
 */
export type SplitBlock = "missing" | "outside" | "transition" | "locked";

export function splitBlock(project: Project, clipId: string, t: number): SplitBlock | null {
  const hit = findClip(project, clipId);
  if (!hit) return "missing";
  if (!(t > hit.clip.start + SPLIT_EDGE_SEC && t < hit.clip.end - SPLIT_EDGE_SEC)) return "outside";
  if (timingLock(project, clipId)) return "transition";
  if (hit.track.locked) return "locked";
  if (project.tracks.some((track) => track.locked && track.clips.some((c) => c.soundEffect?.sourceClipId === clipId))) return "locked";
  return null;
}

/**
 * Why a clip cannot be turned by the Rotate button, or null when it can:
 *   - "no-picture": an audio clip, which has nothing on screen to turn;
 *   - "expression": frame expressions drive the clip's box (`frameExpr`); they override the stored
 *     position and angle at render time, so a stored rotation would not show. Change it in the
 *     expressions instead;
 *   - "locked": the clip's track is locked.
 */
export type RotateBlock = "no-picture" | "expression" | "locked";

export function rotateBlock(project: Project, clip: TrackClip, track: Track): RotateBlock | null {
  if (clip.mediaId && project.media.find((m) => m.id === clip.mediaId)?.kind === "audio") return "no-picture";
  if (hasFrameExpr(clip.frameExpr)) return "expression";
  if (track.locked) return "locked";
  return null;
}
