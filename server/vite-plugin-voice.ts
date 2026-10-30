/**
 * 配音(voice_generate):云端语音合成,走 API 调 MiniMax / 可灵 / Vidu。API Key 走 ai-config 那一套落盘加密。
 *
 *   GET  /api/voice/config          设置 + 静态数据(服务商、模型、系统音色、情绪、字数上限)
 *   POST /api/voice/config          局部更新设置;带 apiKey 就换 API Key
 *   POST /api/voice/clear-key       删 API Key
 *   POST /api/voice/generate        合成一段,先落临时目录、再经素材服务的入库接口进内容库(和用户导入同一条路),
 *                                   回 /@media/<hash>;preview: true 写固定的试听文件(不进素材库,落试听缓存目录)
 *   GET  /api/voice/preview/<文件名> 试听文件(合成试听、音色设计与复刻的试听),从试听缓存目录回放
 *   POST /api/voice/custom          往「我的音色」里手填一条
 *   POST /api/voice/custom/remove   从「我的音色」里移除(只删本地记录,服务商那边不动)
 *   POST /api/voice/design          MiniMax 音色设计(新音色首次合成收 ¥9.9)
 *   POST /api/voice/clone           MiniMax 快速复刻,源文件先入库、只递素材标识,服务端经素材服务取字节(同上收费)
 *
 * 真正的逻辑在 server/voice/*.mjs(纯函数,可单测),这里只做路由和落盘。
 */
import type { Plugin, ViteDevServer, Connect } from "vite";
import type { ServerResponse } from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { dataDir, readBody } from "./vite-plugin-stt";
import { serveFile } from "./vite-plugin-media";
import { findFfmpeg } from "./ai-visual.mjs";
import { AssetSourceError, createAssetSourceResolver } from "./audio-source.mjs";
import { assetServiceOrigin } from "./asset-client";
import { mediaSourceOf } from "./vision/ffmpeg-frames";
import { mediaLabel, resolveMediaSource } from "./perception-source.mjs";
import { ingestFile } from "./media-ingest.mjs";
import {
  readVoiceConfig, writeVoiceConfig, clearVoiceKey, publicVoiceConfig, addCustomVoice, removeCustomVoice,
} from "./voice/voice-config.mjs";
import { generateVoice } from "./voice/generate.mjs";
import { designVoice, cloneVoice, VoiceError } from "./voice/providers.mjs";
import {
  PROVIDERS, PROVIDER_LABELS, MINIMAX_MODELS, EMOTIONS, EMOTION_LABELS, SYSTEM_VOICES, TEXT_LIMITS,
  isVoiceIdShape, isCloneIdShape,
} from "./voice/presets.mjs";

const PRESETS = {
  providers: PROVIDERS, labels: PROVIDER_LABELS, models: MINIMAX_MODELS,
  emotions: EMOTIONS, emotionLabels: EMOTION_LABELS, systemVoices: SYSTEM_VOICES, textLimits: TEXT_LIMITS,
};

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

async function readJson(req: Connect.IncomingMessage): Promise<Record<string, any>> {
  const buf = await readBody(req);
  if (!buf.length) return {};
  const v = JSON.parse(buf.toString("utf8"));
  return v && typeof v === "object" ? v : {};
}

function fail(res: ServerResponse, e: unknown): void {
  if (e instanceof VoiceError) return sendJson(res, e.status && e.status >= 500 ? 502 : 400, { ok: false, error: e.message });
  if (e instanceof SyntaxError) return sendJson(res, 400, { ok: false, error: "请求体不是合法的 JSON" });
  if (e instanceof AssetSourceError) return sendJson(res, 502, { ok: false, kind: "asset-service", error: e.message });
  sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
}

/**
 * 试听文件(合成试听、音色设计与复刻的试听)放哪儿:数据目录下的缓存 `cache/voice-preview/`,**不是素材服务的存储目录**。
 * 它们只在设置面板里听一下、不进素材库,所以不入库;但也不该写进素材目录绕过素材服务
 * (`docs/semantics/product/asset-service.md`「职责」)。由 `GET /api/voice/preview/<文件名>` 回放,页面照回来的地址播。
 */
function previewDir(root: string): string {
  return path.join(dataDir(root), "cache", "voice-preview");
}
/** 试听文件名:只认字母数字和 . _ -(音色 id 来自服务商,拼进文件名前先洗一遍) */
const PREVIEW_NAME = /^[\w.-]+\.(mp3|wav|flac|pcm)$/;
function previewName(raw: string): string {
  return raw.replace(/[^\w.-]/g, "_");
}
function previewUrl(name: string): string {
  return `/api/voice/preview/${encodeURIComponent(name)}`;
}
/** 写一份试听文件,回它的播放地址 */
function writePreview(root: string, rawName: string, buf: Buffer): string {
  const name = previewName(rawName);
  fs.mkdirSync(previewDir(root), { recursive: true });
  fs.writeFileSync(path.join(previewDir(root), name), buf);
  return previewUrl(name);
}

let ffmpegBin: string | null | undefined;

/**
 * 素材记录 → 素材服务上的 HTTP 地址(ffmpeg 的 `-i`)。和感知工具、音频测量同一条(`mediaSourceOf`):
 * 本地素材服务的 `/@media/<hash>` 在共享项目里会向远程素材服务拉。请求体里的 `path` 不看。
 */
const resolveSource = createAssetSourceResolver({ origin: assetServiceOrigin, toUrl: (m: any, origin: string) => mediaSourceOf(m, origin) });

/**
 * 复刻的源文件从哪儿读:**只经素材服务**(`docs/semantics/product/asset-service.md`「职责」;写法同 `perception-source.mjs`)。
 * 页面先把源文件经 `/api/media/upload` 入库,再只递回包里的素材标识 `media: { hash, url, name }`。
 * 原来收回包里的 `path`(本地内容库里的绝对路径)、`isInside` 后直接读,共享项目或素材服务在别处时就读不到;
 * 现在请求体里的 `path` 一概不看 —— 这个接口会把文件上传到第三方,只认素材服务答得出的那一份,也不会变成任意文件外发。
 * 回 `{ src, label }`;没给标识、素材服务上没有回 VoiceError(400),素材服务不可达抛 AssetSourceError(502)。
 */
export async function resolveCloneSource(body: any, resolve: (m: any) => Promise<string | null> = resolveSource): Promise<{ src: string; label: string }> {
  const r: any = await resolveMediaSource(body, resolve);
  if (r.ok) return { src: r.src, label: mediaLabel(r.media) };
  if (r.kind === "asset-service") throw new AssetSourceError(r.error);
  if (r.status === 400) throw new VoiceError("源文件要先上传进素材库（开始页的复刻表单会自动做），请求里带素材标识 media。");
  throw new VoiceError(r.error);
}

/**
 * 复刻前把源文件整理成 MiniMax 收的样子:单声道 wav、去掉开头静音、音量拉平、最长 5 分钟。
 * 视频也能直接拿来复刻(取它的声音)。`src` 是素材服务上的地址。返回临时 wav 的路径和秒数。
 *
 * ffmpeg 必须异步起:单进程形态里素材服务就在编辑器进程自己身上,同步的 spawnSync 会卡住事件循环,
 * ffmpeg 发来的 HTTP 请求没人答(同 `audio-source.mjs` 的 `ffprobeText`)。
 */
export async function prepareCloneAudio(src: string, { ffmpeg, timeoutMs = 120_000 }: { ffmpeg?: string; timeoutMs?: number } = {}): Promise<{ file: string; seconds: number }> {
  if (!ffmpeg) {
    if (ffmpegBin === undefined) ffmpegBin = findFfmpeg();
    ffmpeg = ffmpegBin || undefined;
  }
  if (!ffmpeg) throw new VoiceError("找不到 ffmpeg，没法把源文件转成复刻要的音频。");
  const out = path.join(os.tmpdir(), `pc-voice-clone-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  const r = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(ffmpeg!, [
      "-y", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", "32000", "-t", "300",
      "-af", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.2,loudnorm=I=-18:TP=-1.5:LRA=11",
      "-c:a", "pcm_s16le", out,
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (c) => { if (stderr.length < 64_000) stderr += c; });
    const timer = setTimeout(() => { stderr += " ffmpeg 超时"; child.kill(); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stderr: String(e?.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
  if (r.code !== 0 || !fs.existsSync(out)) {
    fs.rm(out, { force: true }, () => {});
    throw new VoiceError(`源文件转音频失败：${r.stderr.trim().slice(-300) || "ffmpeg 没有输出"}`);
  }
  // 16 位单声道 32kHz:每秒 64000 字节,减掉 44 字节的 wav 头
  const seconds = Math.max(0, (fs.statSync(out).size - 44) / 64000);
  return { file: out, seconds };
}

export function voicePlugin(): Plugin {
  return {
    name: "vite-plugin-voice",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || "").split("?")[0];
        if (!url.startsWith("/api/voice/")) return next();
        const method = (req.method || "GET").toUpperCase();
        try {
          if (method === "GET" && url === "/api/voice/config") {
            return sendJson(res, 200, { ok: true, config: publicVoiceConfig(), presets: PRESETS });
          }
          if ((method === "GET" || method === "HEAD") && url.startsWith("/api/voice/preview/")) {
            let name = "";
            try { name = decodeURIComponent(url.slice("/api/voice/preview/".length)); } catch { /* 下面按不认处理 */ }
            // 文件名被正则限死(不含路径分隔符),拼出来的路径跑不出试听缓存目录
            if (!PREVIEW_NAME.test(name)) return sendJson(res, 404, { ok: false, error: "没有这个试听文件" });
            res.setHeader("Cache-Control", "no-store");
            return serveFile(path.join(previewDir(root), name), req, res);
          }
          if (method !== "POST") return sendJson(res, 405, { ok: false, error: "只接受 POST" });
          const body = await readJson(req);

          if (url === "/api/voice/config") {
            return sendJson(res, 200, { ok: true, config: publicVoiceConfig(writeVoiceConfig(body)) });
          }
          if (url === "/api/voice/clear-key") {
            return sendJson(res, 200, { ok: true, config: publicVoiceConfig(clearVoiceKey()) });
          }
          if (url === "/api/voice/generate") {
            const args = {
              text: body.text, provider: body.provider, voiceId: body.voiceId,
              speed: body.speed, emotion: body.emotion, name: body.name,
            };
            if (body.preview === true) {
              // 试听:固定文件名、覆盖上一次,不进素材库(设置面板里听一下就扔);落试听缓存目录,不写素材目录
              const out = await generateVoice({ cfg: readVoiceConfig(), args, outDir: previewDir(root), preview: true });
              const { path: _cached, ...rest } = out;
              return sendJson(res, 200, { ok: true, ...rest, url: previewUrl(out.name) });
            }
            // 正式合成(voice_generate):先落这一次自己的临时目录,再经素材服务的入库接口进内容库,
            // 和用户导入素材走同一条路(docs/semantics/product/asset-service.md「入库这一步不能省」)。
            // 回的是入库后的标识(/@media/<hash>、哈希、入库记录),不回临时路径 —— 回完它就删了。
            const stage = fs.mkdtempSync(path.join(os.tmpdir(), "pc-voice-"));
            try {
              const out = await generateVoice({ cfg: readVoiceConfig(), args, outDir: stage, preview: false });
              const media = await ingestFile({ file: out.path, name: out.name, origin: assetServiceOrigin });
              const { path: _staged, ...rest } = out;
              return sendJson(res, 200, { ok: true, ...rest, url: media.url, hash: media.hash, bytes: media.bytes, media });
            } finally {
              fs.rm(stage, { recursive: true, force: true }, () => {});
            }
          }
          if (url === "/api/voice/custom") {
            if (!PROVIDERS.includes(body.provider)) throw new VoiceError(`provider 只能是 ${PROVIDERS.join(" / ")}`);
            if (!isVoiceIdShape(body.voiceId)) throw new VoiceError("音色 id 只能含字母数字和 - _ .");
            const cfg = addCustomVoice({ provider: body.provider, voiceId: body.voiceId, name: body.name, kind: "manual", note: body.note });
            return sendJson(res, 200, { ok: true, config: publicVoiceConfig(cfg) });
          }
          if (url === "/api/voice/custom/remove") {
            return sendJson(res, 200, { ok: true, config: publicVoiceConfig(removeCustomVoice(body.provider, body.voiceId)) });
          }
          if (url === "/api/voice/design") {
            const cfg = readVoiceConfig();
            const r = await designVoice({ baseUrl: cfg.effectiveBaseUrl, apiKey: cfg.apiKey }, { prompt: body.prompt, previewText: body.previewText });
            let trialUrl = "";
            if (r.trial) trialUrl = writePreview(root, `voice-design-${r.voiceId}.mp3`, r.trial);
            const next = addCustomVoice({
              provider: "minimax", voiceId: r.voiceId, name: body.name || "设计的音色", kind: "design",
              note: String(body.prompt || "").slice(0, 200),
            });
            return sendJson(res, 200, { ok: true, voiceId: r.voiceId, previewUrl: trialUrl, config: publicVoiceConfig(next) });
          }
          if (url === "/api/voice/clone") {
            if (body.consent !== true) throw new VoiceError("复刻别人的声音要先得到本人同意；勾选确认后再提交。");
            const voiceId = body.voiceId || `pcVoice${Date.now()}`;
            if (!isCloneIdShape(voiceId)) throw new VoiceError("音色 id 要 8~256 位、字母开头、只含字母数字和 - _。");
            // 字节只经素材服务取(见 resolveCloneSource);请求体里的 path 不看
            const source = await resolveCloneSource(body);
            const prepared = await prepareCloneAudio(source.src);
            try {
              if (prepared.seconds < 10) throw new VoiceError(`去掉静音后只有 ${prepared.seconds.toFixed(1)} 秒，复刻至少要 10 秒人声。`);
              const cfg = readVoiceConfig();
              const r = await cloneVoice({ baseUrl: cfg.effectiveBaseUrl, apiKey: cfg.apiKey }, {
                audio: fs.readFileSync(prepared.file), filename: "voice.wav", voiceId, previewText: body.previewText,
              });
              let demoUrl = "";
              if (r.demo) demoUrl = writePreview(root, `voice-clone-${voiceId}.mp3`, r.demo);
              const next = addCustomVoice({
                provider: "minimax", voiceId, name: body.name || "复刻的音色", kind: "clone",
                note: `源文件 ${source.label}，${prepared.seconds.toFixed(1)} 秒`,
              });
              return sendJson(res, 200, { ok: true, voiceId, demoUrl, seconds: prepared.seconds, config: publicVoiceConfig(next) });
            } finally {
              fs.rm(prepared.file, { force: true }, () => {});
            }
          }
          return sendJson(res, 404, { ok: false, error: `没有这个接口：${url}` });
        } catch (e) {
          return fail(res, e);
        }
      });
    },
  };
}
