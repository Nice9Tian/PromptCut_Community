/*
 * **Browser-side registration** of the cloud AI provider (public side). Imported once by the page
 * boot sequence `src/online/pageBoot.ts`.
 *
 * ── Why it must be synchronous, and at the entry point ──
 *
 * `useCloudAgent` / `useCloudDigest` / `useCloudChat` / `useCloudNotices` in `src/ai/extensions.ts`
 * all forward to `currentProvider`. The community edition's defaults for these barely call any
 * hooks, while the real cloud implementation (`useCloud.ts`) calls a whole string of them. So
 * **once the provider is swapped between two renders, the number of hooks in the same component
 * changes**, and React throws on the spot:
 *
 *     React has detected a change in the order of Hooks called by AiPanel
 *     The final argument passed to useSyncExternalStore changed size between renders
 *     TypeError: Cannot read properties of null (reading 'getSnapshot')
 *
 * That is exactly how the LAN end-to-end probe of 2026-10-28 crashed: `AiPanel` threw and took half
 * the tree with it, the collaboration settings section never rendered at all, and the probe never got
 * the invite link (although the server's `invite-create` had in fact succeeded).
 * The first version of this file was written as "a `void` async import as soon as the module is
 * imported", which is exactly what builds that mid-way swap.
 *
 * So: **static import + synchronous apply, and imported by the entry point**. Both are required:
 *   - Static import: the cloud table is fully evaluated before this module's function bodies run
 *     (ES modules are depth-first), so there is no "swapped in later";
 *   - Imported by the entry point: if it is imported somewhere deep in the tree and possibly
 *     lazy-loaded, like `CloudAiPanel`, registration can still come after the first render.
 *
 * In the community edition this alias resolves to an empty stub (`src/community/cloudSeamStub.ts`)
 * that exports nothing: `applyAiManifest` gets no table, the public side's default of "cloud is
 * off" stays in effect throughout, and so there is no swap.
 */
import { applyAiManifest } from "./extensions.ts";
// Cloud AI load table. In the community edition it is an empty stub; the specifier must be a
// literal for Vite to be able to resolve it
import * as cloudAi from "#promptcut-cloud-ai";

/**
 * Called once by the entry point. Returns whether a cloud provider was actually registered (false
 * in the community edition).
 */
export function registerAiCloudProviderFromTable(): boolean {
  const table = cloudAi.manifest ?? cloudAi.default;
  if (!table) return false;
  return applyAiManifest(table).length > 0;
}
