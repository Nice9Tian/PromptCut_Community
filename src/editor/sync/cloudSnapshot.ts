/**
 * 固定非本机快照(语义 `workflow/project.md`「暂时离线项目与保存」:保存时记录非本机内容确定快照的哈希、时间和历史序号;
 * `mechanism/document-service.md`:哈希和时间不替代可比较的基准内容)。
 *
 * 账号云端项目另存成 .proc / .procp 时,文件的云端关联记号(`cloudAssociation`)除了历史序号与时间,另带:
 *   - `base`:另存那一刻文档服务确认过的那一版项目(本页面 DocSync 的已确认副本)——**基准内容**;
 *   - `baseSha256`:`JSON.stringify(base)` 的 SHA-256,读回时核对,对不上就当没有基准(文件被改坏了)。
 * 重开连回云端时拿它当基准:基准 → 文件内容逐项比出「我这边的修改」,云端在另存之后被别人改过的地方不会被当成「我撤销的」。
 * 老文件没有这一段:照旧打开,连回时退回原来的做法(以连回时的云端为基准)。
 *
 * 纯函数,Node 单测可载入。
 */
import type { Project } from "../../kernel/project";
import { diffThings, type MergeThing } from "./mergeItems";
import { sha256Hex } from "./sha256";

export interface CloudSnapshot {
  /** 基准的历史序号 */
  rev: number;
  /** 基准内容(文档服务确认过的那一版) */
  project: Project;
}

/** 另存时云端关联记号里的快照那几项 */
export interface SnapshotFields {
  savedRev: number;
  savedAt: string;
  base?: Project;
  baseSha256?: string;
}

export const snapshotHash = (base: Project): string => sha256Hex(JSON.stringify(base));

/**
 * 另存时的快照字段:连着这个云端项目时取当下的已确认副本;没连着(以本地副本打开、断网)时沿用文件里原来的基准与序号——
 * 那一版仍是「我这边修改之前云端的样子」,换成别的就把基准弄错了。
 */
export function snapshotForSave(prev: { savedRev: number; base?: Project; baseSha256?: string }, live: CloudSnapshot | null, now: Date = new Date()): SnapshotFields {
  if (live) return { savedRev: live.rev, savedAt: now.toISOString(), base: live.project, baseSha256: snapshotHash(live.project) };
  return { savedRev: prev.savedRev, savedAt: now.toISOString(), ...(prev.base ? { base: prev.base, baseSha256: prev.baseSha256 ?? snapshotHash(prev.base) } : {}) };
}

/** 读回的基准:形状对、哈希对得上才用;老文件(没有)或被改坏了回 null */
export function verifiedBase(v: { base?: unknown; baseSha256?: unknown }): Project | null {
  const base = v.base as Project | undefined;
  if (!base || typeof base !== "object" || !Array.isArray((base as Project).tracks)) return null;
  if (typeof v.baseSha256 !== "string" || snapshotHash(base) !== v.baseSha256) return null;
  return base;
}

export type ReopenPlan =
  /** 云端在另存之后没人动过:文件里的修改当一次普通修改提交 */
  | { kind: "commit" }
  /** 云端被别人改过:基准 → 文件逐项比出我的修改,进待合并表(冲突合并窗口) */
  | { kind: "table"; things: MergeThing[] }
  /** 老文件没有基准:退回原来的做法 */
  | { kind: "legacy" }
  /** 文件与基准一样(本机没改过) */
  | { kind: "none" };

/** 重开连回云端时怎么处理文件里的修改 */
export function reopenPlan(assoc: { savedRev: number; base?: unknown; baseSha256?: unknown }, file: Project, cloudRev: number, meta: { batch: string; at: number }): ReopenPlan {
  const base = verifiedBase(assoc);
  if (!base) return { kind: "legacy" };
  const things = diffThings(base, file, { source: "offline", batch: meta.batch, baseRev: assoc.savedRev, at: meta.at });
  if (!things.length) return { kind: "none" };
  if (cloudRev === assoc.savedRev) return { kind: "commit" };
  return { kind: "table", things };
}
