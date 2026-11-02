/**
 * When a cloud chat's attachments are sent, they are put into the media library
 * (`docs/semantics/workflow/materials.md`, user decision, 2026-10-18).
 *
 * It goes through the user's own upload, the same path as "Import media" on the left
 * (`importAssets.ts` / `io.importVideoFiles`), except that videos are not placed on the timeline. Once
 * stored, the media library entry (mediaId, card reference address) is handed back and sent along with the
 * message to tell the Agent, which then uses that entry directly instead of importing on its own (in this
 * cloud version the Agent cannot import by itself).
 */
import type { ChatAttachment } from "../../ai/types";
import { mediaCardUrl } from "../../ai/mediaRef";
import { getState } from "../../store/project";
import { importVideoFiles } from "../io";
import { classifyFile, registerAsset } from "../left/importAssets";
import { tr } from "../../i18n/index.ts";

export type LibraryOutcome = { inLibrary: { mediaId: string; url: string } } | { libraryError: string };

/** Only images, videos and audio are stored; other attachments are still only handed to the Agent as before */
export const LIBRARY_KINDS: ReadonlyArray<ChatAttachment["kind"]> = ["image", "video", "audio"];

/**
 * Put one file into the media library; on success return that entry, on failure return a human-readable
 * reason (one line, at most 200 characters)
 */
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
