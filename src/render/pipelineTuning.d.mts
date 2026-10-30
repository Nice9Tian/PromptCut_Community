/** K2 的三个可调系数（任务书 K2「可调系数」）。两端必须用同一份，否则算不出同一张表。 */
export interface PipelineTuning {
  /** 乘在实测成本上（判重比较式和贪心权重都乘）。不改预算公式 B = 1000 / fps × 70%。 */
  COST_SCALE: number;
  /** `stepMs` 取第几百分位。1 = 退回单次最大的旧口径。 */
  STEP_PERCENTILE: number;
  /** 少于这么多样本时 `robustStep` 改取最大值。 */
  STEP_MIN_SAMPLES: number;
}

/** 覆盖值（`out/pipeline-tuning.json` 的形状）：三项都可选，缺的用缺省。 */
export type PipelineTuningOverrides = Partial<Record<keyof PipelineTuning, number>> | null | undefined;

export const DEFAULT_TUNING: Readonly<PipelineTuning>;
export const TUNING_RANGE: Readonly<Record<keyof PipelineTuning, Readonly<{ min: number; max: number }>>>;

/** 探针计时趟的封顶（任务书 K1）：最多这么多帧 / 这么多毫秒，超出的按中位数外推。 */
export const PROBE_MAX_FRAMES: number;
export const PROBE_MAX_MS: number;

/** 两趟布尔探针另算的上限（任务书 K1）：各 8 帧或 200 ms，超了记 `false` / `null`。 */
export const PROBE_BOOL_FRAMES: number;
export const PROBE_BOOL_MS: number;

export function resolveTuning(overrides?: PipelineTuningOverrides): Readonly<PipelineTuning>;

/**
 * 一张卡的 `stepMs`：每帧活渲耗时样本的第 `STEP_PERCENTILE` 百分位（最近秩，不插值）。
 * 样本不足 `STEP_MIN_SAMPLES` 时取最大值（保守侧）；没有样本回 0。
 */
export function robustStep(samples: readonly number[], tuning?: PipelineTuning | PipelineTuningOverrides): number;
