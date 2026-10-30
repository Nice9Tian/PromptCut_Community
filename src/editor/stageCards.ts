/**
 * 舞台里的卡片代码是不是已经换到最新(C6.6 集成 3b)。
 *
 * 改一张卡,vite 把同一份热更新(带同一个时间戳)推给编辑器页面和两个舞台 iframe,各自在 `cards/index.ts`
 * 接住、重装整套卡片(`kernel/registry.ts` 的 `noteCardsUpdated(stamp)`)。舞台重渲完新卡之后给父页发
 * `pc-stage-cards { stamp }`(`render/stageRpc.ts` 的 `postStageCards`),`Preview` 转到这里记下。
 *
 * 为什么要等:编辑器页面先收到热更新的话,马上排的重测会在后台舞台还是旧卡、或正在换卡的当口进去 ——
 * 测的是旧代码,或者那一轮渲染被换卡打断、等 RPC 超时(实测一次拖到 16 s)。所以重测前先等两个舞台都报到这一版。
 *
 * 过了时限还没报到的舞台才算「代码确实过期」(它的热更新连接断了、或没接住),这时才整页重载那一个 iframe
 * (`Preview` 登记的 `reload`);重载后的舞台握手时就是最新代码(`pc-stage-ready` 记成「此刻已是最新」)。
 */
import type { StageId } from "./previewMode";

/** 每个舞台实例报到的最新一版(热更新时间戳;握手时记成握手那一刻) */
const seen: Record<StageId, number> = { A: 0, B: 0 };
/** 此刻挂着的舞台实例(`Preview` 登记;legacy 单舞台只有 A) */
let mounted: readonly StageId[] = [];
let reload: ((id: StageId) => void) | null = null;
const waiters = new Set<() => void>();

/** 舞台超过这么久没报到这一版就重载它 */
export const STAGE_CARDS_TIMEOUT_MS = 4000;

function wake() {
  for (const w of [...waiters]) w();
}

/** `Preview`:收到舞台的 `pc-stage-cards` */
export function noteStageCards(id: StageId, stamp: number): void {
  if (!(stamp > seen[id])) return;
  seen[id] = stamp;
  wake();
}

/** `Preview`:舞台握手(新载入的舞台就是最新代码) */
export function noteStageFresh(id: StageId, now = Date.now()): void {
  noteStageCards(id, now);
}

/** `Preview`:登记挂着哪些舞台、过期时怎么重载 */
export function bindStageCards(ids: readonly StageId[], reloadStage: ((id: StageId) => void) | null): () => void {
  mounted = ids;
  reload = reloadStage;
  wake();
  return () => {
    if (reload === reloadStage) { reload = null; mounted = []; }
  };
}

/** 挂着的舞台里还没报到 `stamp` 这一版的 */
export function staleStages(stamp: number): StageId[] {
  return mounted.filter((id) => seen[id] < stamp);
}

/**
 * 等挂着的舞台都换到 `stamp` 这一版;超时的那几个整页重载(回它们的 id)。没有舞台时立刻回。
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

/** 单测用 */
export function resetStageCardsForTest(): void {
  seen.A = 0;
  seen.B = 0;
  mounted = [];
  reload = null;
  waiters.clear();
}
