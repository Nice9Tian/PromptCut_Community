/**
 * Registry of runtime-loaded cards (synced user cards and media effect cards executed in the
 * online browser) that ran into trouble in this document (`docs/plan/online-card-exec-contract.md`
 * sections 4.3 and 8). The render layer only records and notifies; the stage (`StageView`)
 * subscribes to it, removes troubled cards, falls back to the original approach, and reports
 * the status to the editor. When there is no subscriber (desktop, export, prerender), it only
 * records without effect and does not alter any behavior.
 *
 *   - `media`: The video or image input of the media effect card cannot be decoded on this device
 *     (`<video>` error, e.g. lacking HEVC decoding); a single failure counts.
 *   - `runtime-error`: Media effect card evaluation or uploading to GPU throws an error (shader
 *     compilation failure, etc.), or an error thrown during component rendering is caught by an
 *     error boundary. Media effect card evaluation errors require **two consecutive failures**
 *     to count (reset to zero if one succeeds in between): one-off errors can occur when
 *     switching projects or when an input clip has just been deleted.
 */
export type CardTroubleKind = "media" | "runtime-error";
export interface CardTrouble { kind: CardTroubleKind; detail: string }

/** Media effect card evaluation must fail this many consecutive times to count as `runtime-error` */
export const GRAPH_ERROR_STRIKES = 2;
const MEDIA_ERROR = /Card media could not be decoded|MEDIA_ERR|could not be decoded/i;

const troubles = new Map<string, CardTrouble>();
const strikes = new Map<string, number>();
const listeners = new Set<() => void>();

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split("\n")[0].slice(0, 200);
function emit(): void {
  for (const l of [...listeners]) { try { l(); } catch { /* Broken subscribers do not affect rendering */ } }
}

/** Media effect card evaluation failed for this frame */
export function noteGraphCardError(cardId: string, err: unknown): void {
  if (!cardId || troubles.has(cardId)) return;
  const detail = firstLine(err);
  if (MEDIA_ERROR.test(detail)) { troubles.set(cardId, { kind: "media", detail }); emit(); return; }
  const n = (strikes.get(cardId) ?? 0) + 1;
  strikes.set(cardId, n);
  if (n >= GRAPH_ERROR_STRIKES) { troubles.set(cardId, { kind: "runtime-error", detail }); emit(); }
}

/** Media effect card evaluation succeeded for this frame: reset consecutive error count to zero */
export function noteGraphCardOk(cardId: string): void {
  if (strikes.has(cardId)) strikes.delete(cardId);
}

/** Component threw an error during render (caught by error boundary) */
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

/** This card updated to a new source generation: previous trouble records do not count
 * (the new generation starts fresh) */
export function clearCardTrouble(cardIds: Iterable<string>): void {
  let changed = false;
  for (const id of cardIds) { strikes.delete(id); if (troubles.delete(id)) changed = true; }
  if (changed) emit();
}

/** For unit tests */
export function resetCardTroubleForTest(): void {
  troubles.clear(); strikes.clear(); listeners.clear();
}
