/**
 * 云端对话的附件发送时放进素材库(`docs/semantics/workflow/materials.md`,2026-10-18 用户定)。
 *
 * 走的是用户自己的上传,和左侧「导入媒体」同一条路(`importAssets.ts` / `io.importVideoFiles`),
 * 只是视频不放到时间轴。放好以后把素材库里那一条(mediaId、卡片引用地址)交回去,随消息告诉 Agent,
 * 它就直接用这一条,不用自己导入(云端这一版 Agent 自己导入用不了)。
 */
import type { ChatAttachment } from "../../ai/types";
import { mediaCardUrl } from "../../ai/mediaRef";
import { getState } from "../../store/project";
import { importVideoFiles } from "../io";
import { classifyFile, registerAsset } from "../left/importAssets";
import { tr } from "../../i18n/index.ts";

export type LibraryOutcome = { inLibrary: { mediaId: string; url: string } } | { libraryError: string };

/** 只放图片、视频、音频;别的附件照旧只交给 Agent */
export const LIBRARY_KINDS: ReadonlyArray<ChatAttachment["kind"]> = ["image", "video", "audio"];

/** 把一个文件放进素材库;成功回那一条,失败回给人看的原因(一行,不超过 200 字) */
export async function putInLibrary(file: File): Promise<LibraryOutcome> {
  try {
    const kind = classifyFile(file);
    if (!kind) return { libraryError: tr("Unrecognized file type") };
    const mediaId = kind === "video" ? (await importVideoFiles([file], { place: false }))[0] : await registerAsset(file, kind);
    const media = getState().project.media.find((m) => m.id === mediaId);
    const url = media ? mediaCardUrl(media) : "";
    if (!mediaId || !url) return { libraryError: tr("Upload to the asset service failed") };
    return { inLibrary: { mediaId, url } };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return { libraryError: (text || tr("Error adding to the media library")).replace(/[\r\n\0]+/g, " ").slice(0, 200) };
  }
}
