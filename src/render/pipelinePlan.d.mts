import type { CardNode } from '../kernel/cardGraph.mjs';
import type { CardCostRecord } from './cardCostKey.mjs';
import type { PipelineTuning, PipelineTuningOverrides } from './pipelineTuning.mjs';

/** 一个位置（相邻两个分段边界之间）的实时判定结果 */
export interface PipelineSegment {
  fromSec: number;
  toSec: number;
  /** 该位置贴死素材的卡 */
  heavy: Set<string>;
  /** 该位置活渲的卡 */
  light: Set<string>;
}

export interface PipelinePlan {
  segments: PipelineSegment[];
  /** 任一位置判重的卡的并集（pinned 渲染 9）：进预渲染管线的静态集合，整段预渲染 */
  prerenderSet: Set<string>;
}

/** 片段 → 成本记录的索引。Map 和普通对象都收。 */
export type ClipIndex<V> = Readonly<Record<string, V>> | ReadonlyMap<string, V>;

export interface PlanPipelinesOptions {
  /**
   * 一个重卡每拍贴一帧死素材的固定成本（ms）。缺省 `DEAD_MS`；只有 L4 换成实测换帧成本：
   * 数字每张一样，函数按片段各取各的（给不出非负数的按 `DEAD_MS`）。
   */
  deadMs?: number | ((clipId: string) => number);
  /** 可调系数的覆盖值，或已经 `resolveTuning` 过的一份。两端必须一样。 */
  tuning?: PipelineTuning | PipelineTuningOverrides;
  /** clipId → `cardCostKey` 的结果（见 `clipCostIndex`）。缺的片段按「没有记录」兜底。 */
  identityKeys?: ClipIndex<string>;
  /** clipId → 声明的帧模式。只在这张卡没有成本记录时用：`direct` 视为轻，其余视为重。 */
  frameModes?: ClipIndex<string>;
  /**
   * 每张卡在每个位置都判重、整段进预渲染集合,不看成本记录与声明。最低一档的**显示**用它(播放时一律不活渲,
   * 语义 `product/platforms.md`「在线浏览器」的「最低一档」);轻重判定看 `searchLight`。
   */
  allHeavy?: boolean;
  /**
   * 界限搜索的判定(在线页面只有一个舞台时,`src/render/boundarySearch.mjs`):判轻的卡的 identityKey。给了就不看成本记录与声明,
   * 集合里的卡在每个位置都判轻(不受预算挤出),其余在每个位置都判重。`allHeavy` 为 true 时不看它。
   */
  searchLight?: Iterable<string> | null;
  /**
   * 打开 3D 模式时把原本判轻的独立卡片也纳入单卡轨道流生产计划 prerenderSet，
   * scene-3d 自身在 3D 视图里是真三维网格，照旧除外，使得 3D 视图播放时所有卡片板子都有轨道流可贴。
   */
  includeLightCardsFor3D?: boolean;
  /** `includeLightCardsFor3D` 的简写 */
  view3d?: boolean;
  /** 判卡片是否为独立卡的能力表 / 函数，不给时除 scene-3d 外一律纳入 */
  isIndependent?: ((clip: any) => boolean) | null;
  compositing?: ClipIndex<string> | ((clip: any) => string | undefined) | null;
  capabilities?: ClipIndex<{ compositing?: string }> | ((clip: any) => { compositing?: string } | undefined) | null;
}

export const DEAD_MS: number;
export const CATCHUP_STEPS_PER_BEAT: number;
export function maxCatchUpBeats(fps: number): number;
/** pinned 渲染 3 的预算：`1000 / fps × 70%` */
export function budgetOf(fps: number): number;

/** 一张卡走的档位。`pinned` 的三档（`capped` / `over-catchup` / `declared-heavy`）每个位置都判重。 */
export type PipelineTier =
  | 'declared-light' | 'declared-heavy'
  | 'capped' | 'over-catchup'
  | 'direct' | 'seek' | 'catchup-a' | 'catchup-b'
  | 'search-light';

export interface ClipWeight {
  /** 每个位置都判重、不参加贪心 */
  pinned: boolean;
  /** 每拍权重（`pinned` 时是 Infinity） */
  w: number;
  tier: PipelineTier;
}

/** 一张卡的每拍权重和档位。导出只为诊断和单测，`planPipelines` 内部用同一份。 */
export function clipWeight(
  record: CardCostRecord | null | undefined,
  frameMode: string | undefined,
  fps: number,
  tuning?: PipelineTuning | PipelineTuningOverrides,
): ClipWeight;

export function planPipelines(
  project: any,
  costs: readonly CardCostRecord[] | null | undefined,
  fps: number,
  opts?: PlanPipelinesOptions,
): PipelinePlan;

export function pipelineAt(plan: PipelinePlan | null | undefined, clipId: string, tSec: number): 'light' | 'heavy';

export function clipCostIndex(
  project: any,
  graph: { nodes?: CardNode[] } | null | undefined,
  sourceVersionOf?: (node: CardNode) => string | null,
  opts?: ClipCostNodeOptions,
): { identityKeys: Record<string, string>; frameModes: Record<string, string> };

export interface ClipCostNodeOptions {
  /** 片段自己那个素材效果卡节点(没有 `clipId`)算不算它的成本身份节点;不给 = 不算。见 `clipCostNodes` */
  ownNode?: (node: CardNode, clip: any) => boolean;
}

/** 片段 → 成本身份用的那个节点 */
export function clipCostNodes(
  project: any,
  graph: { nodes?: CardNode[] } | null | undefined,
  opts?: ClipCostNodeOptions,
): Map<string, CardNode>;
