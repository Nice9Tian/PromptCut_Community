/**
 * Cost records for online dual stage are stored in the `costs` table of in-page snapshot store L2
 * (C10 contract Section 3: "Cost records are written to the `costs` table in L2 with `mode=build`,
 * keyed by card identity and local environment fingerprint; after closing and reopening, cards
 * with existing records are not measured again").
 *
 * Shape matches desktop editor process `GET / PUT /api/data/costs`
 * (cost backend of `src/editor/probeRunner.ts`):
 *   - `load()` returns `{ costs, tuning }` (online pages do not have tunable coefficients
 *     provided by editor process, uses defaults);
 *   - `save(records)` replaces whole entries by `(identityKey, device)`
 *     (same upsert key as `costs-store.mjs`).
 *
 * This module belongs to the render layer (`src/online/`): only imports render and current directory.
 */
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import { resolveTuning, type PipelineTuning } from "../render/pipelineTuning.mjs";
import type { L2Store } from "./l2";

/** Cost record key in `costs` table: card identity + local environment (`device` string contains environment fingerprint, running mode, and tunable coefficients) */
export const costKeyOf = (r: Pick<CardCostRecord, "identityKey" | "device">): string => `${r.identityKey}\n${r.device}`;

const validRecord = (r: unknown): r is CardCostRecord =>
  !!r && typeof r === "object" && typeof (r as CardCostRecord).identityKey === "string" && typeof (r as CardCostRecord).device === "string";

export interface CostBackendLike {
  load(): Promise<{ costs: CardCostRecord[]; tuning: PipelineTuning }>;
  save(records: CardCostRecord[]): Promise<boolean>;
}

export function l2CostBackend(store: Promise<L2Store | null> | L2Store | null): CostBackendLike {
  return {
    async load() {
      const s = await store;
      let costs: CardCostRecord[] = [];
      try { costs = s ? (await s.listCosts()).filter(validRecord) : []; } catch { costs = []; }
      return { costs, tuning: resolveTuning(null) };
    },
    async save(records) {
      const s = await store;
      if (!s) return false;
      try {
        for (const r of records) if (validRecord(r)) await s.putCost(costKeyOf(r), r);
        return true;
      } catch {
        return false;
      }
    },
  };
}
