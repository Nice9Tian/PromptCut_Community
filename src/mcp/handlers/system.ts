import { EditorApi } from "../../ai/mcpExecutor";
import { getState } from "../../store/project";
import { importVideoFiles } from "../../editor/io";
import { classifyFileDetailed, KIND_LABEL, registerAsset } from "../../editor/left/importAssets";
import { mediaCardUrl } from "../../ai/mediaRef";

import { sttJobs, collectInstallJobs, trackInstallJobs, subjectInstallJobs } from "../common";

export const systemHandlers = {

  // ── 语音转文字 ────────────────────────────────────────────────
  backgroundJobStatus: ({ jobId }) => {
    // 听写、运动追踪、主体检测各有一张作业表。只查第一张的话,track_install /
    // subject_install 返回的 jobId 拿过来一定是「找不到」,而那条消息会把人
    // 引向「是不是重启了」。
    const job = sttJobs.get(jobId) ?? trackInstallJobs.get(jobId) ?? subjectInstallJobs.get(jobId)
      ?? collectInstallJobs.get(jobId);
    if (!job) throw new Error('找不到后台任务，可能已重启。');
    return { jobId, ...job };
  },

  importMedia: async (args) => {
    const url = args.url;
    if (!url) throw new Error("要传附件的站内地址(url,形如 /@pcwork/<会话id>/<文件名>)。用户消息末尾的附件清单里有。");
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(`取附件失败:${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new Error(`取附件失败(HTTP ${res.status}),地址可能不对或附件已过期:${url}`);
    const blob = await res.blob();
    let name = args.name || decodeURIComponent(url.split("?")[0].split("/").pop() || "attachment");
    // 网图直链常常不带扩展名(images.unsplash.com/photo-123…):按 MIME 补一个,
    // 落盘后 /@media 才给得出对的 Content-Type,素材库里也分得清是什么
    const MIME_EXT: Record<string, string> = {
      "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
      "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav",
    };
    const mimeExt = MIME_EXT[blob.type.split(";")[0].trim().toLowerCase()];
    if (mimeExt && !/\.[a-z0-9]{2,5}$/i.test(name)) name += `.${mimeExt}`;
    const file = new File([blob], name, { type: blob.type || "" });
    const detected = classifyFileDetailed(file);
    if (!detected.kind) {
      throw new Error(detected.reason || `无法识别文件“${name}”的类型，请使用视频、音频或图片文件。`);
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
          ? "图片已进“图片”素材库(没放到时间轴)。卡片参数里要用这张图就填 cardUrl;想看它长什么样用 see_frames({ source: \"media\", mediaId })。"
          : "音频已进素材库(没放到时间轴)。",
      };
    }
    const ids = await importVideoFiles([file]);
    if (ids.length === 0) throw new Error("导入失败,没有登记成素材。");
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
      hint: "已装进素材库并放到视频轨上。要做字幕就先 transcribe_media,再 add_clip 建 caption-track 并用 fill_captions 灌入。",
    };
  },
} satisfies Partial<EditorApi>;
