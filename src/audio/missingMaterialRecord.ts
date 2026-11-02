import type { MediaAsset, Project } from "../kernel/project";

/**
 * 「确认缺失」记录的判定与显示名(纯函数,不引随软件分发的那段人声文件,Node 单测与 `src/editor/io` 的后台检查直接用)。
 * 带人声地址与时长的那一半在 `missingMaterial.ts`,它把这里的几个函数原样再导出。
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
 * 导出前「素材原尺寸到齐没有」那道拦截用的项目视图:去掉认定过「确认缺失」的素材。
 * 这些素材不会再到齐,导出时它们的片段照原位置出占位,不该把整次导出拦在「等待上传方」。
 */
export function withoutConfirmedMissing<T extends { media: MediaAsset[] }>(project: T): T {
  if (!Array.isArray(project?.media)) return project;
  const media = project.media.filter((m) => !confirmedMissing(m));
  return media.length === project.media.length ? project : { ...project, media };
}
