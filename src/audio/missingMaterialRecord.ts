import type { MediaAsset, Project } from "../kernel/project";

/**
 * The judgment and display name of the "confirmed missing" record (pure functions that do not import
 * the voice recording shipped with the software, used directly by Node unit tests and the background
 * check in `src/editor/io`).
 * The half that carries the voice address and duration is in `missingMaterial.ts`, which re-exports
 * the functions here unchanged.
 */

/** Only a serialized recovery confirmation may activate the proxy; read/decode errors stay ordinary errors. */
export function confirmedMissing(media: MediaAsset | undefined): boolean {
  const state = media?.missingMaterial;
  return !!media && state?.v === 1 && state.reason === "confirmed-missing" && state.mediaId === media.id
    && state.original?.kind === media.kind && state.original.name === media.name
    && state.original.url === media.url && state.original.hash === media.hash
    && typeof state.visual === "boolean" && typeof state.audio === "boolean";
}

export function confirmedMissingVisual(media: MediaAsset | undefined): boolean {
  return confirmedMissing(media) && media!.missingMaterial!.visual === true;
}

export function confirmedMissingAudio(media: MediaAsset | undefined, project?: Project): boolean {
  if (confirmedMissing(media) && media!.missingMaterial!.audio === true && media!.kind !== "image") return true;
  if (!media?.soundOf || !project) return false;
  const source = project.media.find((item) => item.id === media.soundOf);
  return confirmedMissing(source) && source!.kind === "video" && source!.missingMaterial!.audio === true;
}

/**
 * Marker in front of a missing media item's name in the media library (src/editor/io/mediaUpload.ts).
 * It is project data, so it never follows the interface language: new names get the English one,
 * names in older projects still carry the Chinese one, and both are recognised. Placeholders drawn
 * in the picture show only the original name.
 */
export const MISSING_NAME_MARK = "(missing) ";
// i18n-allow: the marker older projects carry
const LEGACY_MISSING_NAME_MARK = "(缺失) ";

export function hasMissingMark(name: string): boolean {
  return name.startsWith(MISSING_NAME_MARK) || name.startsWith(LEGACY_MISSING_NAME_MARK);
}

/** The name without its marker */
export function withoutMissingMark(name: string): string {
  for (const mark of [MISSING_NAME_MARK, LEGACY_MISSING_NAME_MARK]) if (name.startsWith(mark)) return name.slice(mark.length);
  return name;
}

export function missingMaterialLabel(media: MediaAsset): string {
  const original = media.missingMaterial?.original;
  const name = original?.name || original?.hash || media.name || media.id;
  return withoutMissingMark(name) || name;
}

/**
 * The project view used by the pre-export check "have the original-size assets all arrived": with
 * the assets already marked "confirmed missing" removed.
 * These assets will never arrive, and their clips are output as placeholders in their original
 * positions during export, so they should not hold the whole export at "waiting for the uploader".
 */
export function withoutConfirmedMissing<T extends { media: MediaAsset[] }>(project: T): T {
  if (!Array.isArray(project?.media)) return project;
  const media = project.media.filter((m) => !confirmedMissing(m));
  return media.length === project.media.length ? project : { ...project, media };
}
