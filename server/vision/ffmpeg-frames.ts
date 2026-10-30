/**
 * ffmpeg 抽帧与素材层渲染。从 server/vite-plugin-vision.ts 逐字搬来,函数体和注释一字未改。
 *
 * 这一层不碰浏览器、不碰队列 —— 传进来项目状态和时刻,交回抽出来的 PNG 路径。
 *
 * 素材从哪儿读:**只经素材服务的 HTTP API**(`mediaSourceOf` → `asset-client.ts` 的 mediaHttpUrl),
 * ffmpeg 直接拿 http 地址当输入、自己按 Range 定位;这个进程不读本地内容库的目录
 * (`docs/semantics/product/asset-service.md`「职责」)。`routes.ts` 的 `/api/vision/sheet` 也走这一条。
 */
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { extractArgs, mediaLayersAt } from "../vision-compose.mjs";
import { assetServiceOrigin, mediaHttpUrl } from "../asset-client";
import { mediaHashOf } from "../media-stamp.mjs";

/** ffmpeg 抽一帧的上限:本地文件按关键帧定位,正常两三秒 */
export const EXTRACT_TIMEOUT_MS = 30000;

/**
 * ffmpeg 在哪:PATH 上的优先;没有就用 winget 装的那份(和 server/bakery/ffmpeg.mjs 同一个兜底);
 * 都没有返回 null,素材那一层就不画、在 note 里说清楚。结果缓存,别每次看图都 spawn 一遍 -version。
 */
let ffmpegResolved: string | null | undefined;
export function ffmpegCommand(): string | null {
  if (ffmpegResolved !== undefined) return ffmpegResolved;
  const candidates = [
    process.env.PROMPTCUT_FFMPEG,
    "ffmpeg",
    path.join(process.env.LOCALAPPDATA || os.homedir(), "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "ffmpeg-9.0.1-full_build", "bin", "ffmpeg.exe"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["-version"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
      if (r.status === 0) return (ffmpegResolved = c);
    } catch { /* 下一个 */ }
  }
  return (ffmpegResolved = null);
}

/**
 * 素材在素材服务上的 HTTP 地址(ffmpeg 的 `-i`)。素材服务不可达(基址取不到)时返回 null,
 * 调用方在 notes 里如实说那一层是空的。地址只由哈希或最后一段文件名拼成,
 * 请求体里递进来的 `path` 指不到本地内容库以外的文件 —— 边界由素材服务那一侧守。
 *
 * 老 .proc 里只剩绝对路径的素材,页面拿的是 `/api/media/file?path=…`(`src/editor/io/mediaUrls.ts`):
 * 没有哈希时照原样交给素材服务的这条路由,它自己按白名单判路径;不然按「最后一段文件名」会拼成 `/@media/file`。
 */
export function mediaSourceOf(m: any, origin: string | null = assetServiceOrigin()): string | null {
  if (!mediaHashOf(m) && origin) {
    const url = String(m?.url || "");
    if (url.startsWith("/api/media/file?")) return `${origin}${url}`;
  }
  return mediaHttpUrl(m, origin);
}

/**
 * 素材的内容哈希:`m.hash`,或 `url` 是 `/@media/<hash>[.ext]`。实现搬到了 `server/media-stamp.mjs`
 * (帧管线的素材戳也用它,.mjs 那一侧 import 不了这个 .ts),这里原样转出,调用方不用改。
 */
export { mediaHashOf };

/** 用 ffmpeg 把素材的第 seconds 秒抽成 w×h 的 RGBA PNG(object-fit: cover),写到 opts.out */
function extractFrame(ffmpeg: string, opts: { file: string; kind: string; seconds: number; width: number; height: number; opacity: number; filter?: string; out: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, extractArgs(opts), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("ffmpeg 抽帧超时")); }, EXTRACT_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg 退出码 ${code}${err ? `:${err.trim().slice(-300)}` : ""}`));
      resolve();
    });
  });
}

/**
 * 素材层:第 t 秒画面里的每一段视频 / 图片各抽一帧。抽不到的(文件没了、ffmpeg 不在)
 * 在 notes 里如实说,那一层留空 —— 别让模型对着一张缺层的图得出「视频没进来」。
 *
 * 返回的是抽出来的 PNG **文件路径**(从下到上),不在这里解码:合成由渲染 worker 做
 * (server/png-post.mjs),这个进程只管调度。
 */
async function renderMediaLayers(root: string, project: any, t: number, dir: string, notes: string[]): Promise<string[]> {
  const layers = mediaLayersAt(project, t);
  if (layers.length === 0) return [];
  const ffmpeg = ffmpegCommand();
  if (!ffmpeg) {
    notes.push("这台机器上找不到 ffmpeg,画面里素材那一层是空的(不是素材的问题)。");
    return [];
  }
  const width = project.width || 1920;
  const height = project.height || 1080;
  const out: string[] = [];
  let i = 0;
  for (const layer of layers) {
    const file = mediaSourceOf(layer.media);
    if (!file) {
      notes.push(`素材「${layer.media.name || layer.media.id}」取不到(素材服务不可达),画面里它那一层是空的。`);
      continue;
    }
    try {
      // 帧号带进文件名:renderFrames 一趟抽好几个时刻的素材层,都落在同一个目录里
      const layerOut = path.join(dir, `layer-${Math.round(t * 1000)}-${i++}.png`);
      await extractFrame(ffmpeg, {
        file, kind: layer.media.kind, seconds: Math.max(0, layer.mediaTime), width, height, opacity: layer.opacity, filter: layer.filter,
        out: layerOut,
      });
      out.push(layerOut);
    } catch (e: any) {
      notes.push(`素材「${layer.media.name || layer.media.id}」第 ${layer.mediaTime.toFixed(2)} 秒抽帧失败(${e?.message || e}),画面里它那一层是空的。`);
    }
  }
  return out;
}
