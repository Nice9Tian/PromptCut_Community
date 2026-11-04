import type { AudioFxDef } from "./audioFx.d.mts";

export interface AudioPlanEntry {
  clipId: string;
  trackId: string;
  mediaId: string;
  start: number;
  dur: number;
  offset: number;
  /** Only present for speed-changed audio clips: varispeed and pitch-shift with rate (ffmpegVarispeed / resampleVarispeed in kernel/clipTime.mjs) */
  speed?: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  fx: { def: AudioFxDef; params?: Record<string, number> } | null;
  /** Only present for clips expanded from cut segments: envelopes of outer segments (absolute timeline time) */
  env?: import("./cutAudio.d.mts").CutEnvelope[];
}

export function audioPlanOf(project: unknown): AudioPlanEntry[];
export function soundingAt(plan: AudioPlanEntry[], T: number): string[];
export function fadeEnvelope(volume: number, fadeIn: number, fadeOut: number, dur: number, n: number): Float32Array<ArrayBuffer>;
export function gainCurve(entry: { volume: number; fadeIn: number; fadeOut: number; dur: number; start: number; env?: import("./cutAudio.d.mts").CutEnvelope[] }, n: number): Float32Array<ArrayBuffer>;
export function needsGainCurve(entry: { fadeIn: number; fadeOut: number; env?: import("./cutAudio.d.mts").CutEnvelope[] }): boolean;
