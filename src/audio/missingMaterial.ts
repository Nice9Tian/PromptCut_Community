import missingMaterialWavUrl from "./assets/missing-material.wav?url";
import type { TrackClip } from "../kernel/project";

/** The built-in, software-shipped clip is 1.37 seconds; it is never a project asset. */
export const MISSING_MATERIAL_WAV_URL = missingMaterialWavUrl;
export const MISSING_MATERIAL_WAV_SECONDS = 1.37;

export { confirmedMissing, confirmedMissingAudio, confirmedMissingVisual, missingMaterialLabel } from "./missingMaterialRecord";

export function missingMaterialSourceTime(clip: Pick<TrackClip, "start" | "end">, timelineTime: number): number {
  return Math.min(MISSING_MATERIAL_WAV_SECONDS, Math.max(0, timelineTime - clip.start));
}

export function missingMaterialAudibleDuration(clip: Pick<TrackClip, "start" | "end">): number {
  return Math.max(0, Math.min(MISSING_MATERIAL_WAV_SECONDS, clip.end - clip.start));
}
