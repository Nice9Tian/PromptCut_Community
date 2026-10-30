/**
 * 导出期间要渲染节点补上预渲染原尺寸的片段(`docs/plan/online-card-exec-contract.md` 第 8 节「在线导出」)。
 *
 * 同步来的用户卡与素材效果卡在本页判轻时不在预渲染集合里,页面平时发布的清单计划不含它们;可导出页不执行它们的代码,
 * 导出时必须用预渲染原尺寸。所以导出开始时把这些片段记在这里,页面发布清单计划时并进去(`Preview.tsx` 的 `clips()`),
 * 渲染节点(含本页后台舞台)据此渲出来,导出前的核对等到齐了继续;导出结束(成功、失败、取消)清掉。
 * 只有一个导出在跑(`onlineExport.ts` 的单飞),所以一张表就够。
 */
let wanted: readonly string[] = [];
const listeners = new Set<() => void>();

export function exportWantedClips(): readonly string[] {
  return wanted;
}

export function setExportWantedClips(ids: Iterable<string>): void {
  const next = [...new Set(ids)].sort();
  if (next.length === wanted.length && next.every((id, i) => id === wanted[i])) return;
  wanted = next;
  for (const l of [...listeners]) { try { l(); } catch { /* 订阅方坏了不影响导出 */ } }
}

export function subscribeExportWanted(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
