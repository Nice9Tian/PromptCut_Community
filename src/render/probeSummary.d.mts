import type { PipelineTuning, PipelineTuningOverrides } from './pipelineTuning.mjs';

export function maxOf(xs: readonly number[] | null | undefined): number;
export function sumOf(xs: readonly number[] | null | undefined): number;
export function percentile(xs: readonly number[] | null | undefined, p: number): number;
export function median(xs: readonly number[] | null | undefined): number;

export interface ProbeRaw {
  kind: 'random' | 'stepped';
  steps: readonly number[];
  inline?: readonly number[];
  raster?: readonly number[];
  serialize?: readonly number[];
  totalFrames?: number;
  truncated?: boolean;
}

export interface ProbeSummary {
  stepMs: number;
  stepMaxMs: number;
  inlineMs: number;
  rasterMs: number;
  serializeMs: number;
  catchUpMs: number;
  /** 以下只进诊断 / 报告 */
  samples: number;
  stepP50: number;
  stepP90: number;
  firstMs: number;
  restMedianMs: number;
  extrapolatedMs: number;
  remainingFrames: number;
  legacyCatchUpMs: number;
}

export function summarizeProbe(raw: ProbeRaw, tuning?: PipelineTuning | PipelineTuningOverrides): ProbeSummary;
