/**
 * Frame-swap cost of each layer of the online dual stage (swap-tuning task A): clip → card kind
 * (`swapKindOf` in `beatSwap.mjs`) → `SWAP_MS_BY_KIND`; if the card kind is not recognized, the default
 * `SWAP_MS`. The beat packing during playback (`fitBeatSwaps` in `snapshotFeed.ts`) and the fixed cost
 * of each heavy card at dispatch (`deadMs` of `planPipelines` in `planDispatch.ts`) use the same number.
 *
 * The card kind is decided by the card definitions on this page: a card counts as a canvas card if its
 * definition declares a canvas contract (except `dom2d`), or the review table registers it as a canvas
 * (`surface` is canvas2d / webgl), or the definition is marked `canvasHeavy`;
 * cards with no definition on the page (user cards whose code is not here, unknown cards) and media
 * effect cards (which only have `nodeId`) cannot be recognized and take the fallback.
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

/** The card kind of this layer; returns null if not recognized */
export function layerSwapKind(project: Project, clipId: string): Kind {
  return kindsOf(project).get(clipId) ?? null;
}

/** The cost (in milliseconds) of one snapshot swap on this layer; if the card kind is not recognized, `SWAP_MS` */
export function layerSwapMs(project: Project, clipId: string): number {
  return swapCostOf(layerSwapKind(project, clipId));
}
