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
  /** 停用:挂载和逐段参数都留着,这一段上不生效。闸门在 `pixelMapOfClip` */
  off?: boolean;
}
/** 片段挂着的像素映射定义;没挂、定义被删了、或者这一段上停用了都给 null */
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
 * 参考实现:不再进任何渲染路径(逐像素 CPU 循环已删,见 render/pixelMapGl.ts),
 * 只留给单测和 GPU / CPU 逐像素对照。
 */
export function mapRgba(def: PixelMapDef, rgba: number[], env?: { x?: number; y?: number; t?: number }, targetRgba?: number[] | null): number[];

/** 三条去向:A 整帧调色(改用 create_filter)、B 逐像素(WebGL)、C 翻译不了 */
export type PixelMapClass =
  | { kind: "A"; reason: string; ops: FilterOp[]; filter: { name: string; description?: string; ops: FilterOp[] }; diff: number; alphaNote?: string }
  | { kind: "B"; backend: "webgl"; reason: string; usesTarget: boolean }
  | { kind: "C"; reason: string };
export function classifyPixelMap(def: PixelMapDef | Omit<PixelMapDef, "id">): PixelMapClass;
export function pixelMapOpsDiff(def: PixelMapDef | Omit<PixelMapDef, "id">, ops: FilterOp[], samples?: Iterable<number[]>): number;

export interface PixelMapGlsl {
  fragment: string;
  vertex: string;
  /** to 是另一段素材:要第二张纹理 */
  usesTarget: boolean;
  /** 表达式里用到 t:每帧要重设 uT */
  usesTime: boolean;
  /** 片元源码的内容哈希,program 按它缓存 */
  key: string;
}
export function compilePixelMapGlsl(def: PixelMapDef | Omit<PixelMapDef, "id">): PixelMapGlsl;
export const PIXEL_MAP_VERTEX_GLSL: string;
export function hash36(text: string): string;
export class PixelMapGlslError extends Error {}
