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

/**
 * 素材记录 → 素材服务上的 HTTP 地址(ffmpeg / ffprobe 的输入)。Agent 的测量工具像外部客户端一样经素材服务的接口取字节,
 * 不按素材目录找文件(`docs/semantics/product/agent.md`「素材与产物」):
 *
 * - 一般的素材走 `mediaSourceOf`(与看画面的素材层同一条):有哈希 → `/@media/<hash>`;迁移期按文件名 → `/@media/<文件名>`;
 *   老 .proc 的绝对路径 → `/api/media/file?path=…`(那一侧按白名单判)。共享项目里本地内容库没有的,本地素材服务的
 *   `/@media/<hash>` 会向当前连接的远程素材服务拉(`server/media-pull.mjs`),所以这里只认本进程的素材服务地址。
 * - 导出时浏览器上传的素材 `/@export/<id>/media/<文件>` 落在那一趟导出自己的产物目录,照原样走编辑器的 HTTP 路由。
 *
 * 请求体里递进来的 `path` 不再用来读盘:地址只由哈希、文件名或上面两种路由拼成,边界由素材服务那一侧守。
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
          // 测响度(measure_audio):主体在 server/audio-loudness.mjs
          try {
            const body = JSON.parse((await readBody(req)).toString("utf-8"));
            const ffmpeg = findFfmpeg();
            if (!ffmpeg) return sendJson(res, 400, { ok: false, error: "找不到 ffmpeg" });
            const ffprobe = path.join(path.dirname(ffmpeg), "ffprobe" + path.extname(ffmpeg));
            const out = await measureLoudness({ body, resolveSource, ffmpeg, ffprobe });
            sendJson(res, out.status, out.body);
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        } else if (req.method === "POST" && req.url === "/api/audio/measure-js") {
          // 自定义测量(measure_audio_js,计划 A6):解码成 PCM,在专用 Chrome 的沙箱里跑 Agent 写的 JS,只回 JSON。见 server/audio-measure-js.mjs
          try {
            const body = JSON.parse((await readBody(req)).toString("utf-8"));
            const ffmpeg = findFfmpeg();
            if (!ffmpeg) return sendJson(res, 400, { ok: false, error: "找不到 ffmpeg" });
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
