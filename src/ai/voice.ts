/**
 * 配音的前端胶水:读写设置、合成、管理「我的音色」、音色设计 / 复刻。
 * 服务端在 server/vite-plugin-voice.ts,API Key 只在服务端,这边只看得到后四位。
 */
import type { UploadedMedia } from "../editor/io/mediaUpload";

export type Provider = "minimax" | "kling" | "vidu";

export interface VoiceEntry { voiceId: string; name: string }

export interface CustomVoice extends VoiceEntry {
  provider: Provider;
  kind: "clone" | "design" | "manual";
  createdAt: string;
  note: string;
}

export interface VoiceConfig {
  /** 自己填的 API 地址;空串 = 跟随 API 设置 */
  baseUrl: string;
  /** 实际要打的地址(自己填的,或 API 设置里自定义那一路的协议 + 主机) */
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
  /** 只有试听(preview)才有:固定文件名的那份。正式合成经素材服务入库,不回磁盘路径 */
  path?: string;
  /** 正式合成:/@media/<hash>(入库后的地址);试听:/@media/<文件名> */
  url: string;
  /** 正式合成:内容哈希 */
  hash?: string;
  /** 正式合成:素材服务入库接口的回包(和用户导入拿到的是同一种),页面据它登记素材 */
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
  if (!r.ok || data.ok === false) throw new Error(data.error || `${url} 返回 ${r.status}`);
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
 * 合成一段。MCP 桥的调用上限是 60 秒,这里 55 秒就放弃,好让报错是真正的原因而不是「超时」。
 * preview 为真时服务端写固定的试听文件,不进素材库。
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
 * 复刻:先把源文件原样入库,再只递素材标识(哈希、地址、名字),服务端经素材服务取字节、转音频、上传、建音色。
 * 不递本地路径:服务端不再按路径读内容库(字节一律经素材服务取)。
 */
export async function cloneVoiceFromFile(
  file: File,
  args: { name?: string; previewText?: string; voiceId?: string },
): Promise<{ voiceId: string; demoUrl: string; seconds: number; config: VoiceConfig }> {
  const upName = `voice-clone-src-${Date.now()}-${file.name}`;
  const up = await fetch(`/api/media/upload/${encodeURIComponent(upName)}`, { method: "POST", body: file });
  const data = await up.json().catch(() => ({}));
  if (!up.ok || !(data.hash || data.url)) throw new Error(data.error || `上传源文件失败(HTTP ${up.status})`);
  const media = { hash: data.hash, url: data.url, name: file.name };
  return post("/api/voice/clone", { ...args, media, consent: true }, 180_000);
}
