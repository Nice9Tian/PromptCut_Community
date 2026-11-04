/**
 * Inventory and cleanup of prerender outputs (PNG snapshots).
 *
 * Previously directly listed and deleted `bake-*.png` in the asset catalog; bytes are now in `px` of
 * the asset service, and this only reads and writes the "input hash → content hash" index via
 * `bake-store.mjs` (`docs/semantics/product/asset-service.md` "Prerender outputs": the prerender
 * process reads and writes outputs through asset service interfaces, without directly reading its
 * storage directory). How keys are calculated is in `bakeTarget` of bake.ts.
 *
 * Legacy files previously left in the asset catalog are untouched: `/@media/bake-….png` in old
 * project parameters can still be fetched through them as usual, and when the same key is requested
 * again, bake.ts migrates them into `px` via the asset service. They are no longer counted in
 * inventory and are no longer deleted here.
 */
import { bakeStoreFor } from "./bake";

/**
 * Existing PNG snapshots in the index: key (12-character input hash), legacy filename, byte count,
 * content hash. Does not query the asset service.
 *
 * Prerender scheduling must first know "which ones already exist and their respective sizes" to
 * queue and calculate space usage:
 * and only the server has this answer: the browser forgets once the page is closed.
 */
export async function listBakes(root: string): Promise<{ key: string; name: string; bytes: number; hash: string; url: string }[]> {
  return (await bakeStoreFor(root).list()).map((e: any) => ({ key: e.key, name: e.name || `${e.key}.png`, bytes: e.bytes, hash: e.hash, url: e.url }));
}

/**
 * Which of these keys are already rendered: present in the index and this chunk is fully received
 * on the asset service (sync state is queried only from the asset service).
 * Throws when the asset service is unreachable (message states address and reason).
 */
export async function bakedOf(root: string, keys: string[]): Promise<Map<string, { key: string; bytes: number; hash: string; url: string }>> {
  return await bakeStoreFor(root).status(keys);
}

/**
 * Evicts specified PNG snapshots. **Matches by key only, not by path**: compares one by one
 * against its own listed index, deleting only matching entries; files outside the index are
 * never touched. Bytes remain in the asset service (which has no deletion API, is
 * content-addressed, and is immutable once written); reclamation is left to the asset service side;
 * when the same image is rendered again, storing it is merely a reconciliation, without taking up
 * duplicate space.
 */
export async function evictBakes(root: string, keys: unknown): Promise<{ deleted: string[]; freedBytes: number }> {
  return await bakeStoreFor(root).evict(keys);
}
