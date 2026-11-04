/**
 * Whether the card code in the stages has been updated to the latest (C6.6 integration 3b).
 *
 * When a card is changed, vite pushes the same hot update (with the same timestamp) to the editor page
 * and to both stage iframes; each of them picks it up in `cards/index.ts` and reinstalls the whole
 * set of cards (`noteCardsUpdated(stamp)` in `kernel/registry.ts`). After a stage has re-rendered the
 * new cards, it sends `pc-stage-cards { stamp }` to the parent page (`postStageCards` in
 * `render/stageRpc.ts`), and `Preview` forwards it here to be recorded.
 *
 * Why wait: if the editor page receives the hot update first, a re-measurement queued right away may
 * enter while the background stage still has old cards or is in the middle of swapping cards -- it
 * would measure the old code, or that round of rendering would be interrupted by the card swap and
 * wait for the RPC to time out (once observed dragging to 16 s). So before re-measuring, wait for both
 * stages to report this version.
 *
 * Only a stage that still hasn't reported after the time limit counts as "code really is stale" (its
 * hot update connection dropped, or it didn't pick it up); only then is that one iframe reloaded as a
 * whole page (the `reload` registered by `Preview`); when the reloaded stage does its handshake it has
 * the latest code (`pc-stage-ready` is recorded as "up to date as of now").
 */
import type { StageId } from "./previewMode";

/** The latest version each stage instance has reported (hot update timestamp; at handshake, recorded as the moment of the handshake) */
const seen: Record<StageId, number> = { A: 0, B: 0 };
/** The stage instances attached right now (registered by `Preview`; the legacy single stage has only A) */
let mounted: readonly StageId[] = [];
let reload: ((id: StageId) => void) | null = null;
const waiters = new Set<() => void>();

/** If a stage hasn't reported this version after this long, reload it */
export const STAGE_CARDS_TIMEOUT_MS = 4000;

function wake() {
  for (const w of [...waiters]) w();
}

/** `Preview`: received `pc-stage-cards` from a stage */
export function noteStageCards(id: StageId, stamp: number): void {
  if (!(stamp > seen[id])) return;
  seen[id] = stamp;
  wake();
}

/** `Preview`: stage handshake (a newly loaded stage has the latest code) */
export function noteStageFresh(id: StageId, now = Date.now()): void {
  noteStageCards(id, now);
}

/** `Preview`: register which stages are attached and how to reload them when stale */
export function bindStageCards(ids: readonly StageId[], reloadStage: ((id: StageId) => void) | null): () => void {
  mounted = ids;
  reload = reloadStage;
  wake();
  return () => {
    if (reload === reloadStage) { reload = null; mounted = []; }
  };
}

/** Among the attached stages, those that haven't yet reported version `stamp` */
export function staleStages(stamp: number): StageId[] {
  return mounted.filter((id) => seen[id] < stamp);
}

/**
 * Wait until all attached stages have switched to version `stamp`; those that time out get a whole-page
 * reload (returns their ids). Returns immediately when there are no stages.
 */
export function whenStagesHaveCards(stamp: number, timeoutMs = STAGE_CARDS_TIMEOUT_MS): Promise<StageId[]> {
  if (!stamp || !staleStages(stamp).length) return Promise.resolve([]);
  return new Promise((resolve) => {
    let done = false;
    const finish = (reloaded: StageId[]) => {
      if (done) return;
      done = true;
      waiters.delete(check);
      clearTimeout(timer);
      resolve(reloaded);
    };
    const check = () => { if (!staleStages(stamp).length) finish([]); };
    const timer = setTimeout(() => {
      const late = staleStages(stamp);
      for (const id of late) reload?.(id);
      finish(late);
    }, timeoutMs);
    waiters.add(check);
  });
}

/** For unit tests */
export function resetStageCardsForTest(): void {
  seen.A = 0;
  seen.B = 0;
  mounted = [];
  reload = null;
  waiters.clear();
}
