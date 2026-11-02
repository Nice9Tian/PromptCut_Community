/** Three tunable coefficients for K2 (task brief K2 "Tunable coefficients"). Both ends must use the same copy or they cannot compute the same table. */
export interface PipelineTuning {
  /** Multiplied into measured costs (both heavy classification comparisons and greedy weights). Does not change budget formula B = 1000 / fps × 70%. */
  COST_SCALE: number;
  /** Which percentile `stepMs` takes. 1 = fall back to the old standard of single maximum. */
  STEP_PERCENTILE: number;
  /** When there are fewer samples than this, `robustStep` uses the maximum instead. */
  STEP_MIN_SAMPLES: number;
}

/** Override values (shape of `out/pipeline-tuning.json`): all three items are optional; missing ones use defaults. */
export type PipelineTuningOverrides = Partial<Record<keyof PipelineTuning, number>> | null | undefined;

export const DEFAULT_TUNING: Readonly<PipelineTuning>;
export const TUNING_RANGE: Readonly<Record<keyof PipelineTuning, Readonly<{ min: number; max: number }>>>;

/** Cap on probe timing passes (task brief K1): at most this many frames / this many milliseconds; excess is extrapolated by median. */
export const PROBE_MAX_FRAMES: number;
export const PROBE_MAX_MS: number;

/** Separate upper limit for the two boolean probe passes (task brief K1): 8 frames or 200 ms each; records `false` / `null` if exceeded. */
export const PROBE_BOOL_FRAMES: number;
export const PROBE_BOOL_MS: number;

export function resolveTuning(overrides?: PipelineTuningOverrides): Readonly<PipelineTuning>;

/**
 * A card's `stepMs`: `STEP_PERCENTILE` percentile of per-frame live render duration samples
 * (nearest rank, no interpolation). Takes the maximum when samples are fewer than `STEP_MIN_SAMPLES`
 * (conservative side); returns 0 if there are no samples.
 */
export function robustStep(samples: readonly number[], tuning?: PipelineTuning | PipelineTuningOverrides): number;
