import type { AudioFxDef } from "./audioFx.d.mts";

export interface AudioPlanEntry {
  clipId: string;
  trackId: string;
  mediaId: string;
  start: number;
  dur: number;
  offset: number;
  /** 变速的声音段才有:随倍率变速变调(kernel/clipTime.mjs 的 ffmpegVarispeed / resampleVarispeed) */
  speed?: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  fx: { def: AudioFxDef; params?: Record<string, number> } | null;
  /** 剪辑段展开出来的片段才有:外层各段的包络(时间轴绝对时间) */
  env?: import("./cutAudio.d.mts").CutEnvelope[];
}

export function audioPlanOf(project: unknown): AudioPlanEntry[];
export function soundingAt(plan: AudioPlanEntry[], T: number): string[];
export function fadeEnvelope(volume: number, fadeIn: number, fadeOut: number, dur: number, n: number): Float32Array<ArrayBuffer>;
export function gainCurve(entry: { volume: number; fadeIn: number; fadeOut: number; dur: number; start: number; env?: import("./cutAudio.d.mts").CutEnvelope[] }, n: number): Float32Array<ArrayBuffer>;
export function needsGainCurve(entry: { fadeIn: number; fadeOut: number; env?: import("./cutAudio.d.mts").CutEnvelope[] }): boolean;
