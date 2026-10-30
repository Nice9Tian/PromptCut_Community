/**
 * 在线双舞台每层的换帧成本(swap-tuning 任务 A):片段 → 卡种(`beatSwap.mjs` 的 `swapKindOf`)→ `SWAP_MS_BY_KIND`,
 * 认不出卡种的按缺省 `SWAP_MS`。播放时按拍装箱(`snapshotFeed.ts` 的 `fitBeatSwaps`)与分派时每张重卡的固定成本
 * (`planDispatch.ts` 的 `planPipelines` `deadMs`)用同一个数。
 *
 * 卡种按这个页面上的卡片定义判:定义里声明了画布契约(`dom2d` 除外)或审阅表登记成画布(`surface` 是 canvas2d / webgl)、定义标了 `canvasHeavy` 的算画布卡;
 * 页面上没有定义的(代码不在这里的用户卡、未知卡片)与素材效果卡(只有 `nodeId`)认不出来,走兜底。
 */
import type { Project } from "../kernel/project";
import { cardsRegistryGen, getCard, syncedUserCardsGen } from "../kernel/registry";
import { reviewedCanvas } from "../kernel/frameMode.mjs";
import { swapCostOf, swapKindOf } from "../render/beatSwap.mjs";

type Kind = ReturnType<typeof swapKindOf>;

let memo: { project: Project; gen: string; kinds: Map<string, Kind> } | null = null;

function kindsOf(project: Project): Map<string, Kind> {
  const gen = `${cardsRegistryGen()}:${syncedUserCardsGen()}`;
  if (memo && memo.project === project && memo.gen === gen) return memo.kinds;
  const kinds = new Map<string, Kind>();
  for (const tr of project.tracks) {
    for (const clip of tr.clips) {
      if (!clip.cardId) { if (clip.nodeId) kinds.set(clip.id, null); continue; }
      const def = getCard(clip.cardId) as ({ source?: string; canvasHeavy?: boolean; canvas?: { kind?: string } } | undefined);
      kinds.set(clip.id, swapKindOf({
        cardId: clip.cardId,
        known: !!def,
        source: def?.source,
        canvas: !!(def?.canvas && def.canvas.kind !== "dom2d"),
        canvasHeavy: reviewedCanvas(clip.cardId) === true || def?.canvasHeavy === true,
      }));
    }
  }
  memo = { project, gen, kinds };
  return kinds;
}

/** 这一层的卡种;认不出来回 null */
export function layerSwapKind(project: Project, clipId: string): Kind {
  return kindsOf(project).get(clipId) ?? null;
}

/** 这一层换一次快照的成本(毫秒);认不出卡种按 `SWAP_MS` */
export function layerSwapMs(project: Project, clipId: string): number {
  return swapCostOf(layerSwapKind(project, clipId));
}
