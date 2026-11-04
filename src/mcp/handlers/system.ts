import { EditorApi } from "../../ai/mcpExecutor";
import { getState } from "../../store/project";
import { importVideoFiles } from "../../editor/io";
import { classifyFileDetailed, KIND_LABEL, registerAsset } from "../../editor/left/importAssets";
import { mediaCardUrl } from "../../ai/mediaRef";

import { sttJobs, collectInstallJobs, trackInstallJobs, subjectInstallJobs } from "../common";

export const systemHandlers = {

  // ── Speech-to-text ────────────────────────────────────────────
  backgroundJobStatus: ({ jobId }) => {
    // Speech-to-text, motion tracking, and subject detection each have a job table. If only the first
    // is queried, passing the jobId returned by track_install / subject_install will always result in
    // "not found", and that message will lead people to wonder "did it restart?".
    const job = sttJobs.get(jobId) ?? trackInstallJobs.get(jobId) ?? subjectInstallJobs.get(jobId)
      ?? collectInstallJobs.get(jobId);
    if (!job) throw new Error('Background job not found, it may have restarted.');
    return { jobId, ...job };
  },

  importMedia: async (args) => {
    const url = args.url;
    if (!url) throw new Error("Pass the on-site address of the attachment (url, like /@pcwork/<session id>/<file name>). It is in the attachment manifest at the end of the user message.");
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(`Failed to fetch attachment: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new Error(`Failed to fetch attachment (HTTP ${res.status}), the address may be wrong or the attachment expired: ${url}`);
    const blob = await res.blob();
    let name = args.name || decodeURIComponent(url.split("?")[0].split("/").pop() || "attachment");
    // Direct links to web images often lack extensions (images.unsplash.com/photo-123…): append one
    // based on MIME so that /@media can return the correct Content-Type after writing to disk, and the
    // media library can distinguish what it is
    const MIME_EXT: Record<string, string> = {
      "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
      "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav",
    };
    const mimeExt = MIME_EXT[blob.type.split(";")[0].trim().toLowerCase()];
    if (mimeExt && !/\.[a-z0-9]{2,5}$/i.test(name)) name += `.${mimeExt}`;
    const file = new File([blob], name, { type: blob.type || "" });
    const detected = classifyFileDetailed(file);
    if (!detected.kind) {
      throw new Error(detected.reason || `Cannot identify the type of file "${name}", please use a video, audio or image file.`);
    }
    const kind = detected.kind;
    if (kind !== "video") {
      const id = await registerAsset(file, kind);
      const media = getState().project.media.find((m) => m.id === id);
      return {
        mediaId: id,
        name,
        kind,
        kindLabel: KIND_LABEL[kind],
        ...(kind === "image" ? { width: media?.width, height: media?.height } : { duration: media?.duration }),
        cardUrl: media ? mediaCardUrl(media) : "",
        hint: kind === "image"
          ? "The image went into the \"Images\" media library (not placed on the timeline). To use this image in card params, fill in cardUrl; to see what it looks like use see_frames({ source: \"media\", mediaId })."
          : "The audio went into the media library (not placed on the timeline).",
      };
    }
    const ids = await importVideoFiles([file]);
    if (ids.length === 0) throw new Error("Import failed, nothing was registered as media.");
    const media = getState().project.media.find((m) => m.id === ids[0]);
    return {
      mediaId: ids[0],
      name,
      kind,
      kindLabel: KIND_LABEL[kind],
      duration: media?.duration,
      width: media?.width,
      height: media?.height,
      cardUrl: media ? mediaCardUrl(media) : "",
      hint: "Added to the media library and placed on the video track. To make captions, first transcribe_media, then add_clip to create a caption-track and fill it with fill_captions.",
    };
  },
} satisfies Partial<EditorApi>;
