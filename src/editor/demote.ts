/**
 * K6 自动再平衡的父页一半（只降不升）。
 *
 * 舞台侧（`StageView` 的 `checkDemote`）算一秒窗口、挑出本窗口实测累计耗时最大的那张轻卡、
 * post `{ type: 'demote', clipId }`；这里做四件事：
 *
 *  1. 按 clipId 反查 `identityKey`（`costs` 是内容寻址的，记录里没有 clipId），拿到**旧记录**；
 *  2. **整条 PUT** `{ ...旧记录, capped: true, demoted: true }` —— `costs-store` 是整条替换、
 *     `validRecord` 要 `identityKey` + `device`，只发几项会被拒；各测量值保留旧值、不写 `null`；
 *     **只用 `demoted` 这一面旗**，不写 `pinnedHeavy`；
 *  3. 就地并进 `planDispatch` 手里那份 `costs` —— `planPipelines` 见到 `demoted` 就当 `capped`，
 *     于是这张卡在每个位置都判重、并进预渲染集合。**两端各自重算**：页面这边是 `setPlan`，
 *     预渲染进程那边由 `vite-plugin-costs` 的 `forwardToPrerender` 把同一条 PUT 转过去；
 *  4. 记进 `pendingDemote`（`snapshotFeed`）：**死素材就绪之前照常活渲**（用户看到的画面不变，
 *     只是可能慢），就绪之后的下一拍才切进 `suppressed` / `snapshots`。
 *
 * `demoted` 只在本次会话生效：下次打开项目 `probeRunner` 的「已有记录且 `demoted !== true`
 * 才跳过」会让这张卡重新探针，探针显式写回 `demoted: false`。
 */
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import { getState } from "../store/project";
import { clipIdentityOf } from "./costIdentity";
import { currentCosts, mergePlanCosts } from "./planDispatch";
import { markPendingDemote } from "./snapshotFeed";

/** 这一次会话里已经降过的（别对同一张卡反复 PUT） */
const demoted = new Set<string>();

export function demotedClips(): ReadonlySet<string> {
  return demoted;
}

/** 验收探针要看这条真的写进去了没有 */
export interface DemoteResult {
  ok: boolean;
  clipId: string;
  identityKey?: string;
  reason?: string;
}

export async function onStageDemote(clipId: string): Promise<DemoteResult> {
  if (demoted.has(clipId)) return { ok: true, clipId, reason: "already" };
  const project = getState().project;
  const identityKey = clipIdentityOf(project).identityKeys[clipId];
  if (!identityKey) return { ok: false, clipId, reason: "no-identity" };
  const old = currentCosts().find((r) => r.identityKey === identityKey);
  if (!old) return { ok: false, clipId, identityKey, reason: "no-record" };
  demoted.add(clipId);
  // 就绪之前照常活渲（pinned 渲染 6：降级不立即生效）
  markPendingDemote(clipId);
  const next: CardCostRecord = { ...old, capped: true, demoted: true };
  // 先并进手里这一份：setPlan 立刻重算，不用等 PUT 的往返
  mergePlanCosts([next]);
  try {
    const res = await fetch("/api/data/costs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: [next] }),
    });
    return { ok: res.ok, clipId, identityKey, ...(res.ok ? {} : { reason: `http ${res.status}` }) };
  } catch (err) {
    return { ok: false, clipId, identityKey, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** 测试用 */
export function resetDemote(): void {
  demoted.clear();
}
