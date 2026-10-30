/**
 * 运行时载入的卡(在线浏览器执行同步来的用户卡与素材效果卡)在这份文档里出了事的登记处
 * (`docs/plan/online-card-exec-contract.md` 4.3、第 8 节)。render 层只管记与通知;舞台(`StageView`)订阅它,
 * 把出事的卡撤下、退回原做法,并把状态报给编辑页面。没有订阅方时(桌面、导出、预渲染)只是白记一笔,不改任何行为。
 *
 *   - `media`:素材效果卡的视频或图片输入这台设备解不了(`<video>` 报错,例如没有 HEVC 解码);一次就算。
 *   - `runtime-error`:素材效果卡求值或上 GPU 抛错(着色器编译失败等),或组件渲染时抛错被错误边界接住。
 *     素材效果卡的求值错要**连着两次**才算(中间成功过一次就清零):项目正在换、输入片段刚删掉时会有一次性的错。
 */
export type CardTroubleKind = "media" | "runtime-error";
export interface CardTrouble { kind: CardTroubleKind; detail: string }

/** 素材效果卡求值连着错这么多次才算 `runtime-error` */
export const GRAPH_ERROR_STRIKES = 2;
const MEDIA_ERROR = /Card media could not be decoded|MEDIA_ERR|could not be decoded/i;

const troubles = new Map<string, CardTrouble>();
const strikes = new Map<string, number>();
const listeners = new Set<() => void>();

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split("\n")[0].slice(0, 200);
function emit(): void {
  for (const l of [...listeners]) { try { l(); } catch { /* 订阅方坏了不影响渲染 */ } }
}

/** 素材效果卡这一帧求值失败 */
export function noteGraphCardError(cardId: string, err: unknown): void {
  if (!cardId || troubles.has(cardId)) return;
  const detail = firstLine(err);
  if (MEDIA_ERROR.test(detail)) { troubles.set(cardId, { kind: "media", detail }); emit(); return; }
  const n = (strikes.get(cardId) ?? 0) + 1;
  strikes.set(cardId, n);
  if (n >= GRAPH_ERROR_STRIKES) { troubles.set(cardId, { kind: "runtime-error", detail }); emit(); }
}

/** 素材效果卡这一帧求值成功:连错的计数清零 */
export function noteGraphCardOk(cardId: string): void {
  if (strikes.has(cardId)) strikes.delete(cardId);
}

/** 组件渲染时抛错(错误边界接住) */
export function noteCardRenderError(cardId: string, err: unknown): void {
  if (!cardId || troubles.has(cardId)) return;
  troubles.set(cardId, { kind: "runtime-error", detail: firstLine(err) });
  emit();
}

export function cardTroubles(): ReadonlyMap<string, CardTrouble> {
  return troubles;
}

export function onCardTrouble(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 这张卡换了一代源码:旧的出事记录不作数(新一代重新来过) */
export function clearCardTrouble(cardIds: Iterable<string>): void {
  let changed = false;
  for (const id of cardIds) { strikes.delete(id); if (troubles.delete(id)) changed = true; }
  if (changed) emit();
}

/** 单测用 */
export function resetCardTroubleForTest(): void {
  troubles.clear(); strikes.clear(); listeners.clear();
}
