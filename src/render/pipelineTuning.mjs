/**
 * K2 的可调系数（用户 2026-09-22 要求保留）+ K1 的稳健单帧耗时。
 *
 * 为什么要有这个文件：限 2 核实测里同一张卡两次跑出来的「单帧最差」能差十几倍
 * （`particles-orbit` 33 ms 对 2.2 ms），越线的是偶发的一帧卡顿、不是卡的稳定成本。
 * 所以 `stepMs` 改成取百分位（`robustStep`），判重和贪心权重再乘一个成本倍率，
 * 三个数都放在这里、可以不改代码就调（覆盖值在本机 `out/pipeline-tuning.json`，
 * 由 `GET /api/data/costs` 随记录一起回给页面和预渲染进程）。
 *
 * **浏览器和 Node 共用、纯函数**：`planPipelines` 两端必须算出逐字段相同的表，
 * 系数只要有一端不一样，两张表就对不上（K2「可调系数」）。所以这里不读文件、不看
 * 环境变量、不用 `Date`、不用 `Math.random`；输入一样，输出就一样。
 */

/** 缺省系数（任务书 K2） */
export const DEFAULT_TUNING = Object.freeze({
  /**
   * 成本倍率。乘在每张卡的**实测**成本上（`stepMs` / `catchUpMs` / `seekMs`）：
   * 判重比较式 `stepMs × COST_SCALE > B` 和贪心权重 `w` 都乘。
   * 调大 = 更保守、更多卡进重管线；调小 = 更多卡活渲。
   * **它不改预算公式 `B = 1000 / fps × 70%`**，改的只是「实测值有多可信」。
   */
  COST_SCALE: 1,
  /** `stepMs` 取每帧活渲耗时样本的第几百分位。取 1 就退回「单次最大」的旧口径。 */
  STEP_PERCENTILE: 0.9,
  /** 少于这么多样本时百分位不可信，`robustStep` 改取最大值（见下）。 */
  STEP_MIN_SAMPLES: 16,
});

/** 夹取范围（任务书 K2）。超出范围的值夹到边界，不报错——系数是人手写进 JSON 的。 */
export const TUNING_RANGE = Object.freeze({
  COST_SCALE: Object.freeze({ min: 0.25, max: 4 }),
  STEP_PERCENTILE: Object.freeze({ min: 0.5, max: 1 }),
  STEP_MIN_SAMPLES: Object.freeze({ min: 8, max: 120 }),
});

/**
 * 探针计时趟的封顶（任务书 K1）。**只为长片段留**，不是判重的截断：
 * 单帧太慢是按 `robustStep` 的结果一越过 B 就停，不按整趟累计墙钟。
 * 到封顶还没推完的，剩下的帧按「首帧实测 + 其余帧中位数 × 剩余帧数」外推
 * （不用含挂载成本的平均值——首帧要建树、解析关键帧，拿它当平均会偏大 1.7～3.6 倍）。
 */
export const PROBE_MAX_FRAMES = 300;
export const PROBE_MAX_MS = 500;

/**
 * 两趟布尔探针（`vtOk` / `seekOk` / `seekMs`）另算的一份上限（任务书 K1）：
 * **各 8 帧或 200 ms 封顶**，比对趟超了就记 `false`，量 `seekMs` 那一趟超了就记 `null`。
 * 它们不占计时趟 / 快照趟的额度。
 *
 * 8 这个数是判据本身的一部分（pinned 划分轴一「如何区分 SeekOK」明写「推到第 8 帧」），
 * 不是可调系数，所以不进 `device` 串、也不进 `resolveTuning`。
 */
export const PROBE_BOOL_FRAMES = 8;
export const PROBE_BOOL_MS = 200;

const clamp = (value, { min, max }) => (value < min ? min : value > max ? max : value);

/**
 * 把一份覆盖值夹成一份完整系数。`overrides` 里缺的、不是有限数的字段一律用缺省值，
 * 所以 `resolveTuning()`、`resolveTuning(null)`、`resolveTuning({})` 都回缺省。
 * 返回的对象是冻住的新对象，不改入参。
 */
export function resolveTuning(overrides) {
  const raw = overrides && typeof overrides === 'object' ? overrides : {};
  const pick = (name) => {
    const value = Number(raw[name]);
    return Number.isFinite(value) ? clamp(value, TUNING_RANGE[name]) : DEFAULT_TUNING[name];
  };
  return Object.freeze({
    COST_SCALE: pick('COST_SCALE'),
    STEP_PERCENTILE: pick('STEP_PERCENTILE'),
    STEP_MIN_SAMPLES: Math.round(pick('STEP_MIN_SAMPLES')),
  });
}

/**
 * 一张卡的 `stepMs`：每帧活渲耗时样本的稳健值。
 *
 * - 取法是**最近秩**百分位：样本升序排好，取第 `ceil(p × n)` 个（1 起数）。
 *   `p = 1` 正好是最大值，于是「`STEP_PERCENTILE` 取 1 = 旧的单次最大口径」自动成立；
 *   不做插值，因为两端要逐字段相同，插值会把浮点末位差带进判重。
 * - **样本不足 `STEP_MIN_SAMPLES` 时取最大值**（这是本任务定的，任务书把它留给实现者）。
 *   理由：样本少的时候百分位挑出来的那一个纯属运气（8 个样本取 0.9 分位 = 第 8 个 = 最大值，
 *   再少就开始挑到中间的数了），而少测一半就判轻的代价是播放掉帧。取最大值是保守的一侧，
 *   和 `catchUpMs` 截断时「按中位数外推、不按平均」同一个方向：宁可判重，不要判错轻。
 *   探针那一侧对应有一条：`direct` 卡的 8 次抽样不够 `STEP_MIN_SAMPLES` 就补抽到够，
 *   所以正常跑完的卡都走百分位，这条兜底只在探针被掐断时生效。
 * - 非有限数（NaN / Infinity）的样本丢掉；一个样本都没有回 0。
 */
export function robustStep(samples, tuning) {
  const t = tuning && typeof tuning === 'object' && 'STEP_PERCENTILE' in tuning ? tuning : resolveTuning(tuning);
  const list = (Array.isArray(samples) ? samples : []).map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!list.length) return 0;
  if (list.length < t.STEP_MIN_SAMPLES) return list[list.length - 1];
  const rank = Math.ceil(t.STEP_PERCENTILE * list.length);
  return list[Math.min(list.length, Math.max(1, rank)) - 1];
}
