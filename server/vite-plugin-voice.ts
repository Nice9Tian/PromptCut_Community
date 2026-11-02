/**
 * Voiceover (voice_generate): cloud voice synthesis, calling MiniMax / Kling / Vidu via API.
 * API Key is encrypted on disk following the ai-config scheme.
 *
 *   GET  /api/voice/config          Settings + static data (provider, model, system voice, emotion, word limit)
 *   POST /api/voice/config          Partially update settings; change API Key if apiKey is provided
 *   POST /api/voice/clear-key       Delete API Key
 *   POST /api/voice/generate        Synthesize a segment, save to temp dir first, then enter content store
 *                                   via asset service store interface (same path as user media imports),
 *                                   return /@media/<hash>; preview: true writes fixed preview file
 *                                   (does not enter media library, saved to preview cache directory)
 *   GET  /api/voice/preview/<filename> Preview file (synthesis preview, voice design and clone preview),
 *                                   played back from preview cache directory
 *   POST /api/voice/custom          Manually add an entry to "My voices"
 *   POST /api/voice/custom/remove   Remove from "My voices" (only deletes local record, provider side untouched)
 *   POST /api/voice/design          MiniMax voice design (first synthesis of a new voice charges 9.9 yuan)
 *   POST /api/voice/clone           MiniMax quick clone, source file stored into library first, only passes
 *                                   asset identifier, server fetches bytes via asset service (charged as above)
 *
 * Real logic is in server/voice/*.mjs (pure functions, unit testable); only routing and persistence are done here.
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
import { tr } from "./i18n.mjs";

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
  if (e instanceof SyntaxError) return sendJson(res, 400, { ok: false, error: tr("Request body is not valid JSON") });
  if (e instanceof AssetSourceError) return sendJson(res, 502, { ok: false, kind: "asset-service", error: e.message });
  sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
}

/**
 * Where preview files (synthesis preview, voice design and clone preview) are placed: cache under
 * data directory `cache/voice-preview/`, **not asset service storage directory**. They are only
 * listened to in settings panel and do not enter media library, so not stored into library;
 * but should not be written to asset catalog bypassing asset service
 * (`docs/semantics/product/asset-service.md` "Responsibilities"). Played back via
 * `GET /api/voice/preview/<filename>`, and page plays using the returned address.
 */
function previewDir(root: string): string {
  return path.join(dataDir(root), "cache", "voice-preview");
}
/** Preview filename: only alphanumeric and . _ - allowed (voice id comes from provider, sanitized before interpolating into filename) */
const PREVIEW_NAME = /^[\w.-]+\.(mp3|wav|flac|pcm)$/;
function previewName(raw: string): string {
  return raw.replace(/[^\w.-]/g, "_");
}
function previewUrl(name: string): string {
  return `/api/voice/preview/${encodeURIComponent(name)}`;
}
/** Write a preview file and return its playback address */
function writePreview(root: string, rawName: string, buf: Buffer): string {
  const name = previewName(rawName);
  fs.mkdirSync(previewDir(root), { recursive: true });
  fs.writeFileSync(path.join(previewDir(root), name), buf);
  return previewUrl(name);
}

let ffmpegBin: string | null | undefined;

/**
 * Asset record → HTTP address on asset service (ffmpeg's `-i`). Same path as perception tools and
 * audio measurement (`mediaSourceOf`): `/@media/<hash>` on local asset service pulls from remote
 * asset service in shared projects. Ignore `path` in request body.
 */
const resolveSource = createAssetSourceResolver({ origin: assetServiceOrigin, toUrl: (m: any, origin: string) => mediaSourceOf(m, origin) });

/**
 * Where source files for clone are read: **only via asset service**
 * (`docs/semantics/product/asset-service.md` "Responsibilities"; same style as `perception-source.mjs`).
 * Page first stores source file into library via `/api/media/upload`, then only passes asset
 * identifier `media: { hash, url, name }` in response.
 * Previously, reading `path` (absolute path in local content store) and `isInside` directly from
 * response failed when shared projects or asset service were elsewhere;
 * now `path` in request body is completely ignored: this interface uploads files to third parties,
 * only accepts the copy returned by asset service, and avoids arbitrary file exfiltration.
 * Returns `{ src, label }`; returns VoiceError(400) if identifier is missing or absent on asset service,
 * throws AssetSourceError(502) if asset service is unreachable.
 */
export async function resolveCloneSource(body: any, resolve: (m: any) => Promise<string | null> = resolveSource): Promise<{ src: string; label: string }> {
  const r: any = await resolveMediaSource(body, resolve);
  if (r.ok) return { src: r.src, label: mediaLabel(r.media) };
  if (r.kind === "asset-service") throw new AssetSourceError(r.error);
  if (r.status === 400) throw new VoiceError(tr("The source file must be uploaded to the media library first (the clone form on the start page does this automatically); include the media id in the request as media."));
  throw new VoiceError(r.error);
}

/**
 * Format source file before clone to MiniMax expected format: mono wav, trimmed leading silence,
 * normalized volume, up to 5 minutes. Videos can also be used directly for clone (extracting audio).
 * `src` is address on asset service. Returns path and duration in seconds of temporary wav.
 *
 * ffmpeg must be started asynchronously: in single-process mode asset service resides on editor
 * process itself; synchronous spawnSync blocks event loop, leaving HTTP requests from ffmpeg
 * unanswered (same as `ffprobeText` in `audio-source.mjs`).
 */
export async function prepareCloneAudio(src: string, { ffmpeg, timeoutMs = 120_000 }: { ffmpeg?: string; timeoutMs?: number } = {}): Promise<{ file: string; seconds: number }> {
  if (!ffmpeg) {
    if (ffmpegBin === undefined) ffmpegBin = findFfmpeg();
    ffmpeg = ffmpegBin || undefined;
  }
  if (!ffmpeg) throw new VoiceError(tr("ffmpeg not found, cannot convert the source file to the audio needed for cloning."));
  const out = path.join(os.tmpdir(), `pc-voice-clone-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  const r = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(ffmpeg!, [
      "-y", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", "32000", "-t", "300",
      "-af", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.2,loudnorm=I=-18:TP=-1.5:LRA=11",
      "-c:a", "pcm_s16le", out,
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (c) => { if (stderr.length < 64_000) stderr += c; });
    const timer = setTimeout(() => { stderr += " ffmpeg timed out"; child.kill(); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stderr: String(e?.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
  if (r.code !== 0 || !fs.existsSync(out)) {
    fs.rm(out, { force: true }, () => {});
    throw new VoiceError(tr("Failed to convert source file to audio: {0}", r.stderr.trim().slice(-300) || tr("ffmpeg produced no output")));
  }
  // 16-bit mono 32kHz: 64,000 bytes per second, minus 44 bytes of wav header
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
            try { name = decodeURIComponent(url.slice("/api/voice/preview/".length)); } catch { /* Handled as unrecognized below */ }
            // Filename is strictly restricted by regex (no path separators); constructed path cannot escape preview cache directory
            if (!PREVIEW_NAME.test(name)) return sendJson(res, 404, { ok: false, error: tr("No such preview file") });
            res.setHeader("Cache-Control", "no-store");
            return serveFile(path.join(previewDir(root), name), req, res);
          }
          if (method !== "POST") return sendJson(res, 405, { ok: false, error: "Only POST is accepted" });
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
              // Preview: fixed filename, overwrites previous, does not enter media library (discarded after playing in settings panel); written to preview cache directory, not written to asset catalog
              const out = await generateVoice({ cfg: readVoiceConfig(), args, outDir: previewDir(root), preview: true });
              const { path: _cached, ...rest } = out;
              return sendJson(res, 200, { ok: true, ...rest, url: previewUrl(out.name) });
            }
            // Formal synthesis (voice_generate): written to its own temporary directory first, then stored
            // into content store via asset service store interface, following the same path as user media imports
            // (docs/semantics/product/asset-service.md "Storing into the library cannot be omitted").
            // Returns post-storage identifiers (/@media/<hash>, hash, storage record), not temporary paths:
            // deleted after returning.
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
            if (!PROVIDERS.includes(body.provider)) throw new VoiceError(tr("provider must be one of {0}", PROVIDERS.join(" / ")));
            if (!isVoiceIdShape(body.voiceId)) throw new VoiceError(tr("Voice id may only contain letters, digits and - _ ."));
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
              provider: "minimax", voiceId: r.voiceId, name: body.name || tr("Designed voice"), kind: "design",
              note: String(body.prompt || "").slice(0, 200),
            });
            return sendJson(res, 200, { ok: true, voiceId: r.voiceId, previewUrl: trialUrl, config: publicVoiceConfig(next) });
          }
          if (url === "/api/voice/clone") {
            if (body.consent !== true) throw new VoiceError(tr("Cloning someone else's voice requires their consent first; tick the confirmation and submit again."));
            const voiceId = body.voiceId || `pcVoice${Date.now()}`;
            if (!isCloneIdShape(voiceId)) throw new VoiceError(tr("Voice id must be 8-256 characters, start with a letter, and contain only letters, digits and - _."));
            // Bytes are only fetched via asset service (see resolveCloneSource); ignore path in request body
            const source = await resolveCloneSource(body);
            const prepared = await prepareCloneAudio(source.src);
            try {
              if (prepared.seconds < 10) throw new VoiceError(tr("Only {0} seconds remain after removing silence; cloning needs at least 10 seconds of speech.", prepared.seconds.toFixed(1)));
              const cfg = readVoiceConfig();
              const r = await cloneVoice({ baseUrl: cfg.effectiveBaseUrl, apiKey: cfg.apiKey }, {
                audio: fs.readFileSync(prepared.file), filename: "voice.wav", voiceId, previewText: body.previewText,
              });
              let demoUrl = "";
              if (r.demo) demoUrl = writePreview(root, `voice-clone-${voiceId}.mp3`, r.demo);
              const next = addCustomVoice({
                provider: "minimax", voiceId, name: body.name || tr("Cloned voice"), kind: "clone",
                note: tr("Source file {0}, {1} seconds", source.label, prepared.seconds.toFixed(1)),
              });
              return sendJson(res, 200, { ok: true, voiceId, demoUrl, seconds: prepared.seconds, config: publicVoiceConfig(next) });
            } finally {
              fs.rm(prepared.file, { force: true }, () => {});
            }
          }
          return sendJson(res, 404, { ok: false, error: `No such endpoint: ${url}` });
        } catch (e) {
          return fail(res, e);
        }
      });
    },
  };
}
