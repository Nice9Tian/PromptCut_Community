import type { MediaAsset, Project, TrackClip } from "../../kernel/project";
import { confirmedMissing } from "../../audio/missingMaterial";
export { confirmedMissing, confirmedMissingAudio, confirmedMissingVisual, missingMaterialLabel } from "../../audio/missingMaterial";

export function missingMediaForClip(project: Project, clip: TrackClip): MediaAsset | undefined {
  if (!clip.mediaId) return undefined;
  const media = project.media.find((item) => item.id === clip.mediaId);
  return confirmedMissing(media) ? media : undefined;
}

