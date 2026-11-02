/**
 * Clips where render nodes must catch up on original-size prerender during export
 * (`docs/plan/online-card-exec-contract.md` section 8 "Online export").
 *
 * Synced user cards and media effect cards are not in the prerender set when classified as light
 * on this page, and manifest plans usually published by the page do not include them; but the
 * export page does not execute their code and must use original-size prerender during export.
 * Therefore, these clips are recorded here when export begins and merged into manifest plans
 * published by the page (`clips()` in `Preview.tsx`). Render nodes (including this page's
 * background stage) render them accordingly, pre-export verification waits until all have
 * arrived before continuing, and they are cleared when export ends (success, failure, or
 * cancellation). Only one export runs at a time (single-flight in `onlineExport.ts`), so a
 * single table is sufficient.
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
  for (const l of [...listeners]) { try { l(); } catch { /* Subscriber failure does not affect export */ } }
}

export function subscribeExportWanted(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
