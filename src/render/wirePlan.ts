/**
 * Wire shape of `setPlan` (E0 / K2): **sets serialized as arrays**.
 *
 * In `PipelinePlan` returned by `planPipelines`, `heavy` / `light` / `prerenderSet` are all `Set`s.
 * Structured clone can indeed transfer `Set`, but the RPC side requires the minimal shape that is
 * "structured-cloneable **and** recognizable by a different host" (E0: put nothing same-origin
 * dependent into the protocol), and in the future L1 online browser mode will send the same table
 * via JSON to Worker / cloud: `Set` cannot pass `JSON.stringify`. Thus wire format is always arrays;
 * the stage backfills them into `Set`s upon receipt, and consumers (K3 / K5, R5) use `pipelineAt`
 * as usual.
 *
 * Both directions live here; parent page and stage each import half, saving both sides from writing
 * the serialization order separately. **Array order is preserved as-is**: `planPipelines` builds
 * sets from pre-sorted arrays (R4a report §2), so iteration order of `[...set]` here is deterministic,
 * and JSON serialized on both ends is byte-for-byte identical.
 */
import type { PipelinePlan } from "./pipelinePlan.mjs";
import { resolveTuning, type PipelineTuning } from "./pipelineTuning.mjs";
import type { CardCostRecord } from "./cardCostKey.mjs";

/** Wire segment: sets replaced with arrays */
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
   * clipId → `cardCostKey` (K1 / K2's `clipCostIndex`).
   *
   * **The stage absolutely requires it**: both (a') / (a) / (b) in K3 and the two paths in K5
   * must read that card's `vtOk` / `seekOk` / `seekMs` / `catchUpMs`, whereas `costs` is indexed
   * by `identityKey`, and `CardCostRecord` contains no `clipId` (it is content-addressed; two
   * clips of the same card share one entry). The parent page already computes this in
   * `clipIdentityOf(project)`, piggybacking on `setPlan`.
   */
  identityKeys?: Record<string, string>;
  /** clipId → declared frame mode (`direct` / `stateful`); stage falls back to it without cost records */
  frameModes?: Record<string, string>;
  /**
   * Tunable coefficients for K2. When stage uses `clipWeight` to classify (a') / (a) / (b),
   * it must share the parent page's copy, otherwise tier assignment diverges between both sides
   */
  tuning?: PipelineTuning;
}

/**
 * The stage's copy: backfilled into `Set`s to match `pipelineAt`'s expected shape,
 * plus `costs` indexed by clipId
 */
export interface StagePlan {
  plan: PipelinePlan;
  costs: CardCostRecord[];
  /** clipId → cost record for this card (unavailable if not yet measured) */
  byClip: Map<string, CardCostRecord>;
  /** clipId → declared frame mode */
  frameModes: Map<string, string>;
  /** Parsed tunable coefficients (same copy as parent page) */
  tuning: PipelineTuning;
}

/** `planPipelines` result → wire shape. `index` is the first two items of `clipIdentityOf(project)` */
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

/** Wire shape + `costs` → the stage's copy */
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

/**
 * Wire shape → shape expected by `pipelineAt`. Bad data is treated as an empty table without
 * throwing: the stage cannot crash over a table
 */
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
