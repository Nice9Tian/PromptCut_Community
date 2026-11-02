// Types for audioFx.mjs. The implementation is written in pure JS so server running directly on
// Node and unit tests can also import it; see the header comment there.

import type { FilterParamSpec } from "./filters.d.mts";

export type AudioFxKind =
  | "gain" | "highpass" | "lowpass" | "peaking" | "lowshelf" | "highshelf"
  | "compressor" | "limiter" | "delay" | "reverb" | "pan";

export interface AudioKindParamSpec {
  label: string;
  default: number;
  min: number;
  max: number;
  unit?: string;
  /** When all parameters with neutral equal neutral, this step is equivalent to not connected */
  neutral?: number;
}

export interface AudioFxKindSpec {
  label: string;
  hint: string;
  params: Record<string, AudioKindParamSpec>;
}

/** One step: { kind, <paramName>: number | expressionString }. Unfilled parameters use kind default */
export type AudioFxOp = { kind: AudioFxKind } & Record<string, number | string>;

/** An entry in the effects library (project.audioFx), listed on the media library "Audio effects" tab */
export interface AudioFxDef {
  id: string;
  name: string;
  description?: string;
  params?: Record<string, FilterParamSpec>;
  ops: AudioFxOp[];
  createdBy?: "agent" | "user";
  createdAt?: number;
}

/** Effect attached to a clip: references an entry in the library + per-clip parameter overrides */
export interface ClipAudioFx {
  id: string;
  params?: Record<string, number>;
  /** Disabled: attachment and per-clip params are kept, inactive on this clip. Gate in `audioFxOfClip` */
  off?: boolean;
}

export interface ResolvedAudioOp {
  kind: AudioFxKind;
  values: Record<string, number>;
}

export const AUDIO_FX_KINDS: Record<AudioFxKind, AudioFxKindSpec>;
export const MAX_AUDIO_OPS: number;
export const MAX_EXPR_LEN: number;
export const AUDIO_EXPR_HELP: string;
export const AUDIO_FX_PRESETS: Array<Omit<AudioFxDef, "id" | "createdBy" | "createdAt">>;

export function normalizeAudioFxDef(input: unknown): Omit<AudioFxDef, "id" | "createdBy" | "createdAt">;
export function normalizeAudioClipParams(def: AudioFxDef, input: unknown): Record<string, number> | undefined;
export function resolveAudioOps(def: Pick<AudioFxDef, "ops" | "params">, clipParams: Record<string, number> | undefined, t: number, d: number): ResolvedAudioOp[];
export function isNeutralOp(op: ResolvedAudioOp): boolean;
export function isAudioFxAnimated(def: Pick<AudioFxDef, "ops" | "params">): boolean;
export function describeAudioFx(def: Pick<AudioFxDef, "ops">): string;
export function reverbImpulse(sampleRate: number, decay: number, seed?: number): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>];
export function audioFxOfClip(project: { audioFx?: AudioFxDef[] }, clip: { audioFx?: ClipAudioFx } | null | undefined): AudioFxDef | null;
export function clipAudioFxAt(project: { audioFx?: AudioFxDef[] }, clip: { audioFx?: ClipAudioFx; start: number; end: number }, T: number): ResolvedAudioOp[] | null;
