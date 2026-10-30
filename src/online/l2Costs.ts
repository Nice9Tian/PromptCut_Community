/**
 * 在线双舞台的成本记录存在页面内快照库 L2 的 `costs` 表里(C10 契约第 3 节:「成本记录以 `mode=build` 按卡片身份与本机环境指纹为键
 * 写进 L2 的 `costs` 表;关掉再开,已有记录的卡不再测」)。
 *
 * 形状同桌面编辑器进程的 `GET / PUT /api/data/costs`(`src/editor/probeRunner.ts` 的成本后端):
 *   - `load()` 回 `{ costs, tuning }`(在线页面没有编辑器进程给的可调系数,用缺省);
 *   - `save(records)` 按 `(identityKey, device)` 整条替换(同 `costs-store.mjs` 的 upsert 键)。
 *
 * 本模块属于 render 这一层(`src/online/`):只引 render 与同目录。
 */
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import { resolveTuning, type PipelineTuning } from "../render/pipelineTuning.mjs";
import type { L2Store } from "./l2";

/** 一条成本记录在 `costs` 表里的键:卡片身份 + 本机环境(`device` 串里已含环境指纹、运行模式与可调系数) */
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
