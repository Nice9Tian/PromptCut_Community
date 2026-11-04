/**
 * Notification of "which assets were newly judged confirmed missing when this project was opened"; the UI uses
 * it to pop up a dialog once listing them (`MissingMaterialsDialog.tsx`).
 * The judging happens in `mediaUpload.ts` (the background check after opening a local project); this only
 * relays the message and does not judge.
 */
export interface MissingMaterialNotice {
  id: string;
  /** Display name of the original asset (without the "(missing) " marker) */
  name: string;
  kind: "video" | "audio" | "image";
  /** There is a file at the original location, but its content is no longer the original (content hash mismatch) */
  changed?: boolean;
}

let pending: MissingMaterialNotice[] = [];
const listeners = new Set<() => void>();

export function publishMissingMaterials(items: MissingMaterialNotice[]): void {
  if (!items.length) return;
  const seen = new Set(pending.map((item) => item.id));
  pending = [...pending, ...items.filter((item) => !seen.has(item.id))];
  for (const listener of [...listeners]) { try { listener(); } catch { /* One subscriber failing does not block the others */ } }
}
export function takeMissingMaterials(): MissingMaterialNotice[] { const out = pending; pending = []; return out; }
export function onMissingMaterials(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
