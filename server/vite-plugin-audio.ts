import type { Plugin, Connect } from "vite";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { findFfmpeg } from "./ai-visual.mjs";
import { readBody } from "./vite-plugin-stt";
import { measureLoudness } from "./audio-loudness.mjs";
import { measureJs } from "./audio-measure-js.mjs";
import { getAudioSandbox } from "./audio-sandbox.mjs";
import { createAssetSourceResolver } from "./audio-source.mjs";
import { assetServiceOrigin } from "./asset-client";
import { mediaSourceOf } from "./vision/ffmpeg-frames";
import { tr } from "./i18n.mjs";

/**
 * Asset record → HTTP URL on asset service (ffmpeg / ffprobe input). The Agent's measurement tools
 * fetch bytes through asset service endpoints like an external client, without looking up files by
 * asset catalog (`docs/semantics/product/agent.md` "Assets and outputs"):
 *
 * - Regular assets use `mediaSourceOf` (same path as media layer for viewing): with hash →
 *   `/@media/<hash>`; during transition period by filename → `/@media/<filename>`; legacy .proc
 *   absolute path → `/api/media/file?path=…` (checked against whitelist on that side). For items
 *   missing from the local content store in a shared project, `/@media/<hash>` on the local asset
 *   service pulls from the currently connected remote asset service (`server/media-pull.mjs`), so
 *   only this process's asset service address is recognized here.
 * - Assets uploaded by the browser during export `/@export/<id>/media/<file>` land in that export
 *   pass's own output directory, routed as-is through the editor's HTTP routes.
 *
 * The `path` passed in the request body is no longer used to read from disk: addresses are composed
 * only of hashes, filenames, or the two routes above, with boundaries guarded by the asset service.
 */
export function audioMediaUrl(m: any, origin: string): string | null {
  const url = String(m?.url || "");
  if (/^\/@export\/[^/?#]+\/media\/[^/?#]+$/.test(url)) return `${origin}${url}`;
  return mediaSourceOf(m, origin);
}

const resolveSource = createAssetSourceResolver({ origin: assetServiceOrigin, toUrl: audioMediaUrl });

function sendJson(res: ServerResponse, statusCode: number, data: any) {
  if (res.headersSent) return;
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

export function audioPlugin(): Plugin {
  return {
    name: "vite-plugin-audio",
    configureServer(server) {
      server.middlewares.use(async (req: Connect.IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method === "POST" && req.url === "/api/audio/measure") {
          // Measure loudness (measure_audio): core logic in server/audio-loudness.mjs
          try {
            const body = JSON.parse((await readBody(req)).toString("utf-8"));
            const ffmpeg = findFfmpeg();
            if (!ffmpeg) return sendJson(res, 400, { ok: false, error: tr("ffmpeg not found") });
            const ffprobe = path.join(path.dirname(ffmpeg), "ffprobe" + path.extname(ffmpeg));
            const out = await measureLoudness({ body, resolveSource, ffmpeg, ffprobe });
            sendJson(res, out.status, out.body);
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        } else if (req.method === "POST" && req.url === "/api/audio/measure-js") {
          // Custom measurement (measure_audio_js, plan A6): decode to PCM, run Agent-written JS inside
          // dedicated Chrome sandbox, returning only JSON. See server/audio-measure-js.mjs
          try {
            const body = JSON.parse((await readBody(req)).toString("utf-8"));
            const ffmpeg = findFfmpeg();
            if (!ffmpeg) return sendJson(res, 400, { ok: false, error: tr("ffmpeg not found") });
            const ffprobe = path.join(path.dirname(ffmpeg), "ffprobe" + path.extname(ffmpeg));
            const out = await measureJs({ body, resolveSource, ffmpeg, ffprobe, sandbox: getAudioSandbox() });
            sendJson(res, out.status, out.body);
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        } else {
          next();
        }
      });
    }
  };
}
