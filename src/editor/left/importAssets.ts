import type { MediaAsset } from "../../kernel/project";
import { actions } from "../../store/project";
import { importVideoFiles, registerMediaFile } from "../io";
import { applyUploadedMedia, uploadMediaFile } from "../io/mediaUpload";
import { classifyFileDetailed, EXT_KIND } from "../io/mediaKinds";
import { holdOnlineQueueOriginals } from "../../online/mediaUploadQueue";
import { blockedByReadOnly } from "../readOnlyCore";
import { viewOnlyText } from "../io/viewOnly";

export type AssetKind = MediaAsset["kind"];

/**
 * 「导入素材」用的通用导入:按内容类型分别登记成 video / audio / image 素材,
 * 让它们各自落到素材库对应的分页里；类型冲突或无法识别的文件会被拒绝。
 *
 * 视频那一路直接复用 io 里的 importVideoFiles —— 它除了登记素材还会把 File 存进 io 的私有表
 * (导出和语音转写靠 getMediaFile 取原文件)、并把片段放到播放头处,自己另写一套只会和它走岔。
 * 音频和图片在 io 里没有对应入口(importVideoFiles 的 kind 是写死的 "video"),所以在这里登记,
 * 但**登记完必须调 registerMediaFile 把原始 File 交回 io** —— 语音转写和导出都靠
 * io.getMediaFile 取原文件,漏了这一步,导入的 mp3 转写时会报「素材文件不在内存里」。
 * 不会提示是导入漏登记造成的。
 */

/** 文件选择器的 accept:MIME 通配打头,再补一串后缀,免得系统不认 MIME 时把文件灰掉 */
export const MEDIA_ACCEPT = [
  "video/*",
  "audio/*",
  "image/*",
  ...Object.keys(EXT_KIND).map((ext) => `.${ext}`),
].join(",");

export { classifyFileDetailed, EXT_KIND, KIND_LABEL } from "../io/mediaKinds";
export type { FileClassification } from "../io/mediaKinds";
export const classifyFile = (file: File): AssetKind | null => classifyFileDetailed(file).kind;

/** 探测元数据都给 5 秒上限:坏文件不该把整批导入卡死,拿不到就留空,后面按默认时长处理 */
function withTimeout<T>(run: (settle: (v: T) => void) => void, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => settle(fallback), 5000);
    run(settle);
  });
}

function probeAudio(url: string, name: string): Promise<{ duration?: number }> {
  return withTimeout<{ duration?: number }>((settle) => {
    const el = document.createElement("audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => settle({ duration: Number.isFinite(el.duration) ? el.duration : undefined });
    el.onerror = () => {
      console.warn(`[left] 探测音频失败: ${name}`);
      settle({});
    };
    el.src = url;
  }, {});
}

function probeImage(url: string, name: string): Promise<{ width?: number; height?: number }> {
  return withTimeout<{ width?: number; height?: number }>((settle) => {
    const img = new Image();
    img.onload = () => settle({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
    img.onerror = () => {
      console.warn(`[left] 探测图片失败: ${name}`);
      settle({});
    };
    img.src = url;
  }, {});
}

/**
 * 登记一条音频 / 图片素材。
 *
 * 素材地址一律是 /@media/<内容哈希>(A1),不留 blob: ——
 * 渲染进程和导出进程都在浏览器之外,够不着 blob:,而 io 里那张「blob → File」的表是私有的,
 * 外面登记的素材进不去。blob: 只在这里当一次性的探测地址(探时长 / 宽高),探完就撤。
 * 入库(上传 + 算哈希)期间素材先挂 pending,素材层画「上传中」占位;
 * 失败不退回 blob:,留空地址(见 io/mediaUpload.ts)。
 */
export async function registerAsset(file: File, kind: "audio" | "image"): Promise<string> {
  const blobUrl = URL.createObjectURL(file);
  const meta = kind === "audio" ? await probeAudio(blobUrl, file.name) : await probeImage(blobUrl, file.name);
  URL.revokeObjectURL(blobUrl);

  const media = actions.addMedia({
    kind,
    name: file.name,
    url: "",
    pending: true,
    duration: (meta as { duration?: number }).duration,
    width: (meta as { width?: number }).width,
    height: (meta as { height?: number }).height,
  });
  registerMediaFile(media.id, file);
  applyUploadedMedia(media.id, await uploadMediaFile(file));
  return media.id;
}

export interface ImportResult {
  counts: Record<AssetKind, number>;
  /** 认不出类型、被跳过的文件名 */
  skipped: string[];
  /** 第一个收下的文件属于哪一类,用来把用户带到对应分页 */
  firstKind: AssetKind | null;
  /** 类型冲突或完全无法识别的文件，以及给用户的修复建议 */
  rejected: string[];
}

export async function importMediaFiles(files: FileList | File[]): Promise<ImportResult> {
  // 只读项目(游客):导入素材是写。按钮已置灰,走到这里是拖放之类没盖到的路
  if (blockedByReadOnly()) throw new Error(viewOnlyText());
  const releaseHold = holdOnlineQueueOriginals();
  try {
    const counts: Record<AssetKind, number> = { video: 0, audio: 0, image: 0 };
    const skipped: string[] = [];
    const rejected: string[] = [];
    let firstKind: AssetKind | null = null;

    const videos: File[] = [];
    const rest: { file: File; kind: "audio" | "image" }[] = [];
    for (const file of Array.from(files)) {
      const detected = classifyFileDetailed(file);
      const kind = detected.kind;
      if (!kind) {
        skipped.push(file.name);
        if (detected.reason) rejected.push(detected.reason);
        continue;
      }
      if (!firstKind) firstKind = kind;
      if (kind === "video") videos.push(file);
      else rest.push({ file, kind });
    }

    if (videos.length > 0) {
      counts.video = (await importVideoFiles(videos)).length;
    }
    for (const { file, kind } of rest) {
      await registerAsset(file, kind);
      counts[kind] += 1;
    }

    return { counts, skipped, firstKind, rejected };
  } finally {
    releaseHold();
  }
}
