/**
 * ffmpeg frame extraction and media layer rendering. Copied verbatim from
 * server/vite-plugin-vision.ts, function body and comments unchanged.
 *
 * This layer does not touch the browser or queues: pass in project state and timestamp, get back
 * the extracted PNG paths.
 *
 * Where assets are read from: **only via the asset service HTTP API** (`mediaSourceOf` →
 * mediaHttpUrl in `asset-client.ts`), ffmpeg directly takes the http URL as input and seeks by
 * Range on its own; this process does not read the local content store directory
 * (`docs/semantics/product/asset-service.md` "Responsibilities"). `/api/vision/sheet` in `routes.ts`
 * also follows this path.
 */
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { extractArgs, mediaLayersAt } from "../vision-compose.mjs";
import { assetServiceOrigin, mediaHttpUrl } from "../asset-client";
import { mediaHashOf } from "../media-stamp.mjs";

/** Upper bound for ffmpeg to extract a frame: local files seek by keyframe, normally 2-3 seconds */
export const EXTRACT_TIMEOUT_MS = 30000;

/**
 * Where ffmpeg is: prefers PATH; if not found, uses the one installed by winget (same fallback as
 * server/bakery/ffmpeg.mjs); if neither exists, returns null, so the media layer is not drawn and
 * this is explained in note. Results are cached to avoid spawning -version on every frame inspection.
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
    } catch { /* Next */ }
  }
  return (ffmpegResolved = null);
}

/**
 * HTTP URL of the asset on the asset service (ffmpeg `-i`). Returns null when the asset service is
 * unreachable (base URL unavailable), and the caller truthfully reports in notes that the layer is
 * empty. The URL is constructed only from the hash or the final filename segment, so `path` passed
 * in the request body cannot point to files outside the local content store: the boundary is guarded
 * on the asset service side.
 *
 * For assets in legacy .proc with only absolute paths, the page fetches `/api/media/file?path=…`
 * (`src/editor/io/mediaUrls.ts`): when there is no hash, it is passed as is to this route on the
 * asset service, which checks the path against its whitelist; otherwise using the "last filename
 * segment" would construct `/@media/file`.
 */
export function mediaSourceOf(m: any, origin: string | null = assetServiceOrigin()): string | null {
  if (!mediaHashOf(m) && origin) {
    const url = String(m?.url || "");
    if (url.startsWith("/api/media/file?")) return `${origin}${url}`;
  }
  return mediaHttpUrl(m, origin);
}

/**
 * Content hash of the asset: `m.hash`, or `url` is `/@media/<hash>[.ext]`. Implementation moved to
 * `server/media-stamp.mjs` (the frame pipeline asset stamp also uses it, and the .mjs side cannot
 * import this .ts), re-exported here as is so callers do not need to change.
 */
export { mediaHashOf };

/** Uses ffmpeg to extract second `seconds` of asset as w×h RGBA PNG (object-fit: cover) to opts.out */
function extractFrame(ffmpeg: string, opts: { file: string; kind: string; seconds: number; width: number; height: number; opacity: number; filter?: string; out: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, extractArgs(opts), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("ffmpeg frame extraction timed out")); }, EXTRACT_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg exit code ${code}${err ? `:${err.trim().slice(-300)}` : ""}`));
      resolve();
    });
  });
}

/**
 * Media layer: extracts one frame for each video/image clip in the frame at second t. If extraction
 * fails (file missing, ffmpeg absent), state so truthfully in notes and leave that layer blank:
 * avoid letting the model conclude "video was not imported" from an image with a missing layer.
 *
 * Returns the extracted PNG **file paths** (bottom to top), not decoded here: compositing is done
 * by render workers (server/png-post.mjs); this process only handles scheduling.
 */
async function renderMediaLayers(root: string, project: any, t: number, dir: string, notes: string[]): Promise<string[]> {
  const layers = mediaLayersAt(project, t);
  if (layers.length === 0) return [];
  const ffmpeg = ffmpegCommand();
  if (!ffmpeg) {
    notes.push("ffmpeg was not found on this machine, so the media layer in the picture is empty (not a problem with the media).");
    return [];
  }
  const width = project.width || 1920;
  const height = project.height || 1080;
  const out: string[] = [];
  let i = 0;
  for (const layer of layers) {
    const file = mediaSourceOf(layer.media);
    if (!file) {
      notes.push(`Media "${layer.media.name || layer.media.id}" could not be fetched (asset service unreachable), so its layer in the picture is empty.`);
      continue;
    }
    try {
      // Frame number in filename: renderFrames extracts media layers for multiple timestamps in one pass, all in the same directory
      const layerOut = path.join(dir, `layer-${Math.round(t * 1000)}-${i++}.png`);
      await extractFrame(ffmpeg, {
        file, kind: layer.media.kind, seconds: Math.max(0, layer.mediaTime), width, height, opacity: layer.opacity, filter: layer.filter,
        out: layerOut,
      });
      out.push(layerOut);
    } catch (e: any) {
      notes.push(`Frame extraction failed for media "${layer.media.name || layer.media.id}" at second ${layer.mediaTime.toFixed(2)} (${e?.message || e}), so its layer in the picture is empty.`);
    }
  }
  return out;
}
