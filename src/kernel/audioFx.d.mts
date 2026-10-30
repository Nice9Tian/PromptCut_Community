// audioFx.mjs 的类型。实现写成纯 JS 是为了 node 直接跑的服务端和单测也能 import,见那边的头注释。

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
  /** 全部带 neutral 的参数都等于 neutral 时,这一步等于没接 */
  neutral?: number;
}

export interface AudioFxKindSpec {
  label: string;
  hint: string;
  params: Record<string, AudioKindParamSpec>;
}

/** 一步:{ kind, <参数名>: 数字 | 表达式字符串 }。没填的参数取种类的 default */
export type AudioFxOp = { kind: AudioFxKind } & Record<string, number | string>;

/** 效果库里的一条(project.audioFx),素材库「音频效果」页列的就是它 */
export interface AudioFxDef {
  id: string;
  name: string;
  description?: string;
  params?: Record<string, FilterParamSpec>;
  ops: AudioFxOp[];
  createdBy?: "agent" | "user";
  createdAt?: number;
}

/** 片段上挂的效果:引用库里的一条 + 逐段覆盖参数 */
export interface ClipAudioFx {
  id: string;
  params?: Record<string, number>;
  /** 停用:挂载和逐段参数都留着,这一段上不生效。闸门在 `audioFxOfClip` */
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
