/**
 * Frontend glue for voiceover: read and write settings, synthesize, manage "My voices", voice design
 * / cloning.
 * The server is in server/vite-plugin-voice.ts; the API Key exists only on the server, and this side
 * sees only its last four characters.
 */
import type { UploadedMedia } from "../editor/io/mediaUpload";
import { tr } from "../i18n/index.ts";

export type Provider = "minimax" | "kling" | "vidu";

export interface VoiceEntry { voiceId: string; name: string }

export interface CustomVoice extends VoiceEntry {
  provider: Provider;
  kind: "clone" | "design" | "manual";
  createdAt: string;
  note: string;
}

export interface VoiceConfig {
  /** The API address filled in by oneself; empty string = follow the API settings */
  baseUrl: string;
  /**
   * The address actually called (the one filled in by oneself, or the protocol + host of the custom
   * source in the API settings)
   */
  effectiveBaseUrl: string;
  provider: Provider;
  minimax: { model: string; voiceId: string; speed: number; vol: number; pitch: number; emotion: string };
  kling: { voiceId: string; speed: number };
  vidu: { voiceId: string; speed: number; volume: number; pitch: number; emotion: string };
  customVoices: CustomVoice[];
  apiKey: { set: boolean; last4: string };
}

export interface VoicePresets {
  providers: Provider[];
  labels: Record<Provider, string>;
  models: string[];
  emotions: string[];
  emotionLabels: Record<string, string>;
  systemVoices: Record<Provider, VoiceEntry[]>;
  textLimits: Record<Provider, number>;
}

export interface VoiceResult {
  name: string;
  /**
   * Present only for auditioning (preview): the copy with a fixed file name. A real synthesis is
   * stored through the asset service and does not return a disk path
   */
  path?: string;
  /** Real synthesis: /@media/<hash> (the address after storing); audition: /@media/<file name> */
  url: string;
  /** Real synthesis: content hash */
  hash?: string;
  /**
   * Real synthesis: the response of the asset service's store interface (the same kind that a user
   * import gets), from which the page registers the asset
   */
  media?: UploadedMedia;
  bytes: number;
  provider: Provider;
  model: string;
  voiceId: string;
  chars: number;
  ms: number;
}

export type VoicePatch = Partial<Omit<VoiceConfig, "apiKey" | "minimax" | "kling" | "vidu">> & {
  apiKey?: string;
  minimax?: Partial<VoiceConfig["minimax"]>;
  kling?: Partial<VoiceConfig["kling"]>;
  vidu?: Partial<VoiceConfig["vidu"]>;
};

async function req<T>(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || tr("{0} returned {1}", url, r.status));
  return data as T;
}

function post<T>(url: string, body: unknown, timeoutMs?: number): Promise<T> {
  return req<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }, timeoutMs);
}

export async function getVoiceConfig(): Promise<{ config: VoiceConfig; presets: VoicePresets }> {
  return req("/api/voice/config");
}

export async function saveVoiceConfig(patch: VoicePatch): Promise<VoiceConfig> {
  return (await post<{ config: VoiceConfig }>("/api/voice/config", patch)).config;
}

export async function clearVoiceKey(): Promise<VoiceConfig> {
  return (await post<{ config: VoiceConfig }>("/api/voice/clear-key", {})).config;
}

/**
 * Synthesize one passage. The MCP bridge's call limit is 60 seconds, so give up at 55 seconds here,
 * so that the error reports the real cause rather than a "timeout".
 * When preview is true the server writes a fixed audition file, which does not go into the media
 * library.
 */
export async function generateVoice(
  args: { text: string; provider?: string; voiceId?: string; speed?: number; emotion?: string; name?: string },
  opts: { preview?: boolean } = {},
): Promise<VoiceResult> {
  return post<VoiceResult>("/api/voice/generate", { ...args, preview: !!opts.preview }, 55_000);
}

export async function addVoice(entry: { provider: Provider; voiceId: string; name?: string; note?: string }): Promise<VoiceConfig> {
  return (await post<{ config: VoiceConfig }>("/api/voice/custom", entry)).config;
}

export async function removeVoice(provider: Provider, voiceId: string): Promise<VoiceConfig> {
  return (await post<{ config: VoiceConfig }>("/api/voice/custom/remove", { provider, voiceId })).config;
}

export async function designVoice(args: { prompt: string; previewText: string; name?: string }): Promise<{ voiceId: string; previewUrl: string; config: VoiceConfig }> {
  return post("/api/voice/design", args, 90_000);
}

/**
 * Cloning: first store the source file as is, then pass only the asset identifier (hash, address,
 * name); the server fetches the bytes through the asset service, converts to audio, uploads, and
 * creates the voice.
 * No local path is passed: the server no longer reads the content store by path (bytes are always
 * fetched through the asset service).
 */
export async function cloneVoiceFromFile(
  file: File,
  args: { name?: string; previewText?: string; voiceId?: string },
): Promise<{ voiceId: string; demoUrl: string; seconds: number; config: VoiceConfig }> {
  const upName = `voice-clone-src-${Date.now()}-${file.name}`;
  const up = await fetch(`/api/media/upload/${encodeURIComponent(upName)}`, { method: "POST", body: file });
  const data = await up.json().catch(() => ({}));
  if (!up.ok || !(data.hash || data.url)) throw new Error(data.error || tr("Failed to upload source file (HTTP {0})", up.status));
  const media = { hash: data.hash, url: data.url, name: file.name };
  return post("/api/voice/clone", { ...args, media, consent: true }, 180_000);
}
