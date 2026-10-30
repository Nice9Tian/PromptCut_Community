/**
 * 把探针回来的**原始样本**折成一条成本记录该有的几个数（任务书 K1 + 3.8）。
 *
 * **一处算，两条路共用**：离线探针 `scripts/probe-card-costs.mjs` 和常驻探针
 * `src/editor/probeRunner.ts` 量的必须是同一口径的数 —— 两处各写一遍统计，
 * 「同一批卡两条路量出来对得上」这件事就无从验起（`device` 串同理，见 `costDevice.mjs`）。
 *
 * 页面那一侧只负责**量**、只回原始数组；分位数、外推、判重全在这里做。好处是
 * `--json` 里留的是原始样本：换了系数重算、两次跑比判重名单差异，都不用重测。
 *
 * # 几个数怎么来的
 *
 * - `stepMs` = `robustStep(steps)`：第 `STEP_PERCENTILE` 百分位（样本不足取最大）。
 *   **唯一进判重的数。**
 * - `stepMaxMs` = 单次最大，**只作诊断**，不进判重和分派（限 2 核下两趟能差十几倍）。
 * - `catchUpMs` = 各帧之和；计时趟被 `PROBE_MAX_FRAMES` / `PROBE_MAX_MS` 封顶时，
 *   没推到的帧按**除首帧外的中位数**补上 —— 不用平均值：首帧要建树、解析关键帧，
 *   拿它进平均会系统性偏大（旧做法偏大 1.7～3.6 倍）。`direct` 卡恒为 0。
 * - `inlineMs` / `rasterMs` / `serializeMs` 同样取稳健值（生成快照三段，不进判重）。
 */

import { robustStep } from './pipelineTuning.mjs';

const finite = (xs) => (Array.isArray(xs) ? xs.map(Number).filter((x) => Number.isFinite(x)) : []);

export const maxOf = (xs) => finite(xs).reduce((m, x) => (x > m ? x : m), 0);
export const sumOf = (xs) => finite(xs).reduce((a, x) => a + x, 0);

/** 升序最近秩分位（和 `robustStep` 同一口径，不插值）。只为打表和诊断用 */
export function percentile(xs, p) {
  const s = finite(xs).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1] : 0;
}

export function median(xs) {
  const s = finite(xs).sort((a, b) => a - b);
  if (!s.length) return 0;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * @param {object} raw
 * @param {'random'|'stepped'} raw.kind
 * @param {number[]} raw.steps        逐帧活渲耗时（计时趟；`direct` 卡是每次抽样的 `stepMs`）
 * @param {number[]} [raw.inline]     逐帧样式内联耗时
 * @param {number[]} [raw.raster]     逐帧画布栅格化耗时
 * @param {number[]} [raw.serialize]  逐帧序列化耗时
 * @param {number} [raw.totalFrames]  片段总帧数（`stepped` 卡外推用）
 * @param {boolean} [raw.truncated]   计时趟有没有被封顶（只进诊断字段）
 * @param {object} [tuning]           K2 系数
 */
export function summarizeProbe(raw, tuning) {
  const steps = finite(raw?.steps);
  const rest = steps.slice(1);
  const pushed = steps.length;
  const stepped = raw?.kind === 'stepped';
  const remaining = stepped ? Math.max(0, (Number(raw?.totalFrames) || 0) - pushed) : 0;
  const tailMs = remaining > 0 ? median(rest) * remaining : 0;
  return {
    stepMs: robustStep(steps, tuning),
    stepMaxMs: maxOf(steps),
    inlineMs: robustStep(raw?.inline, tuning),
    rasterMs: robustStep(raw?.raster, tuning),
    serializeMs: robustStep(raw?.serialize, tuning),
    catchUpMs: stepped ? sumOf(steps) + tailMs : 0,

    /* 以下只进诊断 / 报告，不进成本记录 */
    samples: pushed,
    stepP50: percentile(steps, 0.5),
    stepP90: percentile(steps, 0.9),
    firstMs: steps[0] ?? 0,
    restMedianMs: median(rest),
    extrapolatedMs: tailMs,
    remainingFrames: remaining,
    /** 旧口径（「已推帧的平均 × 片段总帧数」）算出来会是多少，给报告并排比 */
    legacyCatchUpMs: !stepped ? 0
      : (raw?.truncated && pushed ? (sumOf(steps) / pushed) * (Number(raw?.totalFrames) || pushed) : sumOf(steps)),
  };
}
