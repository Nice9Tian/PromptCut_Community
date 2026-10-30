import type { AssetKind } from "./mediaKinds.ts";

export interface MediaKindMigration {
  id: string;
  name: string;
  from: AssetKind;
  to: AssetKind;
}

let pending: MediaKindMigration[] = [];
const EVENT = "pc-media-kind-migration";

export function publishMediaMigrations(items: MediaKindMigration[]): void {
  if (!items.length) return;
  const seen = new Set(pending.map((item) => `${item.id}:${item.from}:${item.to}`));
  pending = [...pending, ...items.filter((item) => {
    const key = `${item.id}:${item.from}:${item.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

export function takeMediaMigrations(): MediaKindMigration[] {
  const out = pending;
  pending = [];
  return out;
}

export function onMediaMigrations(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
