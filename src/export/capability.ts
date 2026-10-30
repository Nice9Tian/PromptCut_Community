/**
 * 浏览器逐帧导出的能力探测(`docs/plan/c10a-contract.md` 第 11.1 节「能力探测」「音频」)。
 *
 * - 视频:HTTPS(安全上下文)、`VideoEncoder`,以及按项目原尺寸与帧率的 `VideoEncoder.isConfigSupported`;
 *   H.264 依次试 `avc1.640028`、`avc1.4D0028`、`avc1.42E028`。都不支持就停下,不提供 PNG 序列替代〔契约裁定〕。
 * - 音频:`AudioEncoder` 支持 AAC(`mp4a.40.2`)就编一条 AAC 轨;不支持就导出没有音轨的视频,开始前提示一次。
 *
 * 全局对象可注入(单测给桩)。
 */
import { ONLINE_EXPORT_TEXT } from "./text";

export const H264_CODECS = ["avc1.640028", "avc1.4D0028", "avc1.42E028"] as const;
export const AAC_CODEC = "mp4a.40.2";
/** 混音与 AAC 轨的采样率、声道(和桌面导出的混音同一口径:48 kHz 立体声) */
export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;

type Supported = { supported?: boolean };
export interface EncoderEnv {
  isSecureContext?: boolean;
  VideoEncoder?: { isConfigSupported(config: Record<string, unknown>): Promise<Supported> };
  AudioEncoder?: { isConfigSupported(config: Record<string, unknown>): Promise<Supported> };
}

/** 按分辨率和帧率估一个码率(H.264,够看清细节又不太大):每像素每帧 0.1 bit,封顶 40 Mbps */
export function videoBitrate(width: number, height: number, fps: number): number {
  return Math.min(40_000_000, Math.max(1_000_000, Math.round(width * height * fps * 0.1)));
}

export function videoConfigOf(codec: string, width: number, height: number, fps: number): Record<string, unknown> {
  return { codec, width, height, framerate: fps, bitrate: videoBitrate(width, height, fps), avc: { format: "avc" }, latencyMode: "quality" };
}

export function audioConfigOf(): Record<string, unknown> {
  return { codec: AAC_CODEC, sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: AUDIO_CHANNELS, bitrate: 128_000 };
}

export interface ExportCapability {
  ok: boolean;
  /** 选中的 H.264 编码串;不支持时为 null */
  videoCodec: string | null;
  /** AAC 能不能编 */
  audio: boolean;
  /** 不能导出时给用户的话(表 C) */
  message?: string;
}

export async function probeExportCapability(
  { width, height, fps }: { width: number; height: number; fps: number },
  env: EncoderEnv = globalThis as unknown as EncoderEnv,
): Promise<ExportCapability> {
  const fail = (): ExportCapability => ({ ok: false, videoCodec: null, audio: false, message: ONLINE_EXPORT_TEXT.unsupportedSize });
  if (!env.isSecureContext || typeof env.VideoEncoder?.isConfigSupported !== "function") return fail();
  let videoCodec: string | null = null;
  for (const codec of H264_CODECS) {
    try {
      const r = await env.VideoEncoder.isConfigSupported(videoConfigOf(codec, width, height, fps));
      if (r?.supported) { videoCodec = codec; break; }
    } catch { /* 这一个不认,试下一个 */ }
  }
  if (!videoCodec) return fail();
  let audio = false;
  if (typeof env.AudioEncoder?.isConfigSupported === "function") {
    try { audio = !!(await env.AudioEncoder.isConfigSupported(audioConfigOf()))?.supported; } catch { audio = false; }
  }
  return { ok: true, videoCodec, audio };
}
