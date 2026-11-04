/**
 * Capability probe for browser frame-by-frame export (`docs/plan/c10a-contract.md` section 11.1
 * "Capability probe" "Audio").
 *
 * - Video: HTTPS (secure context), `VideoEncoder`, and `VideoEncoder.isConfigSupported` matching
 *   project original size and frame rate;
 *   try H.264 in sequence: `avc1.640028`, `avc1.4D0028`, `avc1.42E028`. If none is supported,
 *   stop and do not provide a PNG sequence alternative [contract ruling].
 * - Audio: if `AudioEncoder` supports AAC (`mp4a.40.2`), encode an AAC track; if not supported,
 *   export video without an audio track, prompting once before starting.
 *
 * Global objects are injectable (stubs for unit tests).
 */
import { ONLINE_EXPORT_TEXT } from "./text";

export const H264_CODECS = ["avc1.640028", "avc1.4D0028", "avc1.42E028"] as const;
export const AAC_CODEC = "mp4a.40.2";
/** Sample rate and channels for mix and AAC track (same standard as desktop export mix: 48 kHz stereo) */
export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;

type Supported = { supported?: boolean };
export interface EncoderEnv {
  isSecureContext?: boolean;
  VideoEncoder?: { isConfigSupported(config: Record<string, unknown>): Promise<Supported> };
  AudioEncoder?: { isConfigSupported(config: Record<string, unknown>): Promise<Supported> };
}

/** Estimate bitrate from resolution and frame rate (H.264, clear detail, not too large): 0.1 bit/pixel/frame, capped at 40 Mbps */
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
  /** Selected H.264 codec string; null when unsupported */
  videoCodec: string | null;
  /** Whether AAC can be encoded */
  audio: boolean;
  /** Message for user when export cannot proceed (Table C) */
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
    } catch { /* Not supported, try the next one */ }
  }
  if (!videoCodec) return fail();
  let audio = false;
  if (typeof env.AudioEncoder?.isConfigSupported === "function") {
    try { audio = !!(await env.AudioEncoder.isConfigSupported(audioConfigOf()))?.supported; } catch { audio = false; }
  }
  return { ok: true, videoCodec, audio };
}
