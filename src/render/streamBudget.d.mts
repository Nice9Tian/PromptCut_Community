export const STREAM_BUDGET_HALF_PAD: number;
export const STREAM_BUDGET_OVERFLOW_PX: number;
export const STREAM_PIXEL_RATE_BUDGET: number;
export const STREAM_COUNT_BUDGET: number;
export const STREAM_FREE_COUNT: number;
export const STREAM_BUDGET_MIN_FPS: number;
export const STREAM_DEFAULT_PIXELS: number;
export const SPARSE_STREAM_COUNT: number;
export const SPARSE_STREAM_PIXELS: number;
export const SPARSE_STREAM_FREE: number;
export function sparseStreamBudget(): { count: number; pixelRate: number; free: number };
export type StreamBudget = number | { count?: number; pixelRate?: number; free?: number } | null | undefined;
export function streamCodedPixels(w: number, h: number): number;
export function stageStreamPixels(stage: { width?: number; height?: number } | null | undefined): number;
export function localStreamBoundSize(frame: { w?: number; h?: number } | null | undefined, stage: { width: number; height: number }): { w: number; h: number };
export function localStreamPixels(frame: { w?: number; h?: number } | null | undefined, stage: { width: number; height: number }): number;
export function streamCost(pixels: number | null | undefined, fps: number): number;
export function streamBudgetOf(budget?: StreamBudget): { count: number; pixelRate: number; free: number };
export function withinStreamBudget(costs: readonly number[], budget?: StreamBudget): number[];
export function peakConcurrency(intervals: readonly { from: number; to: number }[], skip?: ReadonlySet<number> | null): { peak: number; at: number };
export function peakCost(intervals: readonly { from: number; to: number; cost?: number }[], skip?: ReadonlySet<number> | null, moreThan?: number): { peak: number; at: number; count: number };
export interface StreamGroupItem { clipIds: string[]; order: number; minOrder?: number; from: number; to: number; cost?: number }
export function groupStreams<T extends StreamGroupItem>(
  streams: readonly T[],
  layers: readonly { clipId: string; order: number; from: number; to: number }[],
  budget?: StreamBudget,
  fixed?: readonly { from: number; to: number; cost?: number }[],
  groupCost?: number,
): StreamGroupItem[];
