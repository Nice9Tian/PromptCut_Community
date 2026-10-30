/**
 * `setPlan` 在线上的形状（E0 / K2）：**集合序列化成数组**。
 *
 * `planPipelines` 回的 `PipelinePlan` 里 `heavy` / `light` / `prerenderSet` 都是 `Set`。
 * 结构化克隆确实搬得动 `Set`，但 RPC 这一面要的是「可结构化克隆**且**换个宿主还认得出来」
 * 的最小形状（E0：协议里不放任何依赖同源的东西），而且将来 L1 的在线浏览器模式会把同一份
 * 表经 JSON 发给 Worker / 云端 —— `Set` 过不了 `JSON.stringify`。所以线上一律数组，
 * 舞台收到之后自己回填成 `Set`，消费侧（K3 / K5，R5）照常用 `pipelineAt`。
 *
 * 两个方向都在这里，父页和舞台各 import 一半，省得两处各写一遍序列化顺序。
 * **数组顺序原样保留**：`planPipelines` 建集合时就是从排好序的数组建的（R4a 报告 §2），
 * 这里 `[...set]` 的迭代顺序因此是确定的，两端序列化出来的 JSON 逐字节相同。
 */
import type { PipelinePlan } from "./pipelinePlan.mjs";
import { resolveTuning, type PipelineTuning } from "./pipelineTuning.mjs";
import type { CardCostRecord } from "./cardCostKey.mjs";

/** 线上的分段：集合换成数组 */
export interface WireSegment {
  fromSec: number;
  toSec: number;
  heavy: string[];
  light: string[];
}

export interface WirePlan {
  segments: WireSegment[];
  prerenderSet: string[];
  /**
   * clipId → `cardCostKey`（K1 / K2 的 `clipCostIndex`）。
   *
   * **舞台非要它不可**：K3 的 (a′) / (a) / (b) 和 K5 的两路都要读那张卡的 `vtOk` /
   * `seekOk` / `seekMs` / `catchUpMs`，而 `costs` 是按 `identityKey` 索引的、
   * `CardCostRecord` 里没有 `clipId`（它是内容寻址的，同一张卡的两个片段共用一条）。
   * 父页在 `clipIdentityOf(project)` 里本来就算好了这一份，搭 `setPlan` 的车捎过去。
   */
  identityKeys?: Record<string, string>;
  /** clipId → 声明的帧模式（`direct` / `stateful`）；没有成本记录时舞台按它兜底 */
  frameModes?: Record<string, string>;
  /** K2 的可调系数。舞台用 `clipWeight` 判 (a′) / (a) / (b) 时必须和父页同一份，否则两边分档不一致 */
  tuning?: PipelineTuning;
}

/** 舞台手里的那一份：回填成 `Set` 之后就是 `pipelineAt` 认的形状，外加按 clipId 索引好的 `costs` */
export interface StagePlan {
  plan: PipelinePlan;
  costs: CardCostRecord[];
  /** clipId → 这张卡的成本记录（没测过的取不到） */
  byClip: Map<string, CardCostRecord>;
  /** clipId → 声明的帧模式 */
  frameModes: Map<string, string>;
  /** 已解析的可调系数（和父页同一份） */
  tuning: PipelineTuning;
}

/** `planPipelines` 的结果 → 线上的形状。`index` 是 `clipIdentityOf(project)` 的前两项 */
export function wirePlan(
  plan: PipelinePlan,
  index?: { identityKeys?: Record<string, string>; frameModes?: Record<string, string> },
  tuning?: PipelineTuning,
): WirePlan {
  return {
    segments: plan.segments.map((s) => ({ fromSec: s.fromSec, toSec: s.toSec, heavy: [...s.heavy], light: [...s.light] })),
    prerenderSet: [...plan.prerenderSet],
    ...(index?.identityKeys ? { identityKeys: index.identityKeys } : {}),
    ...(index?.frameModes ? { frameModes: index.frameModes } : {}),
    ...(tuning ? { tuning } : {}),
  };
}

/** 线上的形状 + `costs` → 舞台手里那一份 */
export function reviveStagePlan(wire: WirePlan | null | undefined, costs: CardCostRecord[]): StagePlan {
  const byKey = new Map<string, CardCostRecord>();
  for (const record of costs) if (record && typeof record.identityKey === "string") byKey.set(record.identityKey, record);
  const byClip = new Map<string, CardCostRecord>();
  for (const [clipId, key] of Object.entries(wire?.identityKeys ?? {})) {
    const hit = byKey.get(key);
    if (hit) byClip.set(clipId, hit);
  }
  return {
    plan: revivePlan(wire),
    costs,
    byClip,
    frameModes: new Map(Object.entries(wire?.frameModes ?? {})),
    tuning: resolveTuning(wire?.tuning),
  };
}

/** 线上的形状 → `pipelineAt` 认的形状。坏数据一律当空表，不抛——舞台不能因为一份表挂掉 */
export function revivePlan(wire: WirePlan | null | undefined): PipelinePlan {
  const segments = Array.isArray(wire?.segments) ? wire.segments : [];
  return {
    segments: segments.map((s) => ({
      fromSec: Number(s?.fromSec) || 0,
      toSec: Number(s?.toSec) || 0,
      heavy: new Set(Array.isArray(s?.heavy) ? s.heavy : []),
      light: new Set(Array.isArray(s?.light) ? s.light : []),
    })),
    prerenderSet: new Set(Array.isArray(wire?.prerenderSet) ? wire.prerenderSet : []),
  };
}
