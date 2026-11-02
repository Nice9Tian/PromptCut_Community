import type { FilterOp } from "./filters.d.mts";

export type PixelMapStage = "origin" | "after_filters";
export type PixelMapMode = "continuous" | "discrete";
export type PixelMapTarget =
  | { kind: "media"; mediaId: string; stage: PixelMapStage; filterId?: string }
  | { kind: "color"; value: string }
  | { kind: "transparent" }
  | { kind: "expr"; r: string | number; g: string | number; b: string | number; a?: string | number };
export interface PixelMapDef {
  id: string;
  name: string;
  description?: string;
  source: { mediaId?: string; stage: PixelMapStage; filterId?: string };
  where: string;
  to: PixelMapTarget;
  mode: PixelMapMode;
  colorSequence?: { from: string[]; to: string[]; mode: PixelMapMode };
  createdBy?: "agent" | "user";
  createdAt?: number;
}
export interface ClipPixelMap {
  id: string;
  params?: Record<string, number>;
  /**
   * Disabled: attachment and per-clip params are retained, but inactive on this clip. Gate is in
   * `pixelMapOfClip`.
   */
  off?: boolean;
}
/** Pixel map definition attached to clip; returns null if not attached, deleted, or disabled on this clip */
export function pixelMapOfClip(
  project: { pixelMaps?: PixelMapDef[] },
  clip: { pixelMap?: ClipPixelMap } | null | undefined,
): PixelMapDef | null;
export const PIXEL_MAP_MODES: PixelMapMode[];
export const PIXEL_MAP_STAGES: PixelMapStage[];
export const MAX_PIXEL_MAPS: number;
export function parseColor(value: string): [number, number, number, number] | null;
export function normalizePixelMapDef(input: unknown): Omit<PixelMapDef, "id" | "createdBy" | "createdAt">;
export function compilePixelMap(def: PixelMapDef): unknown;
/**
 * Reference implementation: no longer enters any render path (per-pixel CPU loop deleted, see
 * render/pixelMapGl.ts), kept only for unit tests and GPU / CPU per-pixel comparison.
 */
export function mapRgba(def: PixelMapDef, rgba: number[], env?: { x?: number; y?: number; t?: number }, targetRgba?: number[] | null): number[];

/** Three destinations: A whole-frame color grading (use create_filter instead), B per-pixel (WebGL), C untranslatable */
export type PixelMapClass =
  | { kind: "A"; reason: string; ops: FilterOp[]; filter: { name: string; description?: string; ops: FilterOp[] }; diff: number; alphaNote?: string }
  | { kind: "B"; backend: "webgl"; reason: string; usesTarget: boolean }
  | { kind: "C"; reason: string };
export function classifyPixelMap(def: PixelMapDef | Omit<PixelMapDef, "id">): PixelMapClass;
export function pixelMapOpsDiff(def: PixelMapDef | Omit<PixelMapDef, "id">, ops: FilterOp[], samples?: Iterable<number[]>): number;

export interface PixelMapGlsl {
  fragment: string;
  vertex: string;
  /** to is another media clip: requires a second texture */
  usesTarget: boolean;
  /** Expression uses t: uT must be reset every frame */
  usesTime: boolean;
  /** Content hash of fragment source; program is cached by it */
  key: string;
}
export function compilePixelMapGlsl(def: PixelMapDef | Omit<PixelMapDef, "id">): PixelMapGlsl;
export const PIXEL_MAP_VERTEX_GLSL: string;
export function hash36(text: string): string;
export class PixelMapGlslError extends Error {}
