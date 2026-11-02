/**
 * Export interception for `/api/export` in the prerender process (C6.6 design doc
 * `docs/plan/c66-design.md`, Section 9, item 3 [ruling]).
 *
 * Export only uses original-size assets (`docs/semantics/product/asset-service.md` "Two asset tiers"):
 * if original-size assets referenced by clips are not yet `complete` on the **current asset service**,
 * intercept before export, return 409 `awaiting-uploader`, and list missing assets. The two
 * interceptions on the page (top bar, beginning of `exportVideo`) are retained; this guard is for
 * Agents or scripts calling `/api/export` directly.
 *
 * The "current asset service" is known by the editor process (the remote asset service registered
 * when the page enters a shared project, see `server/media-pull.mjs`), so here we query the editor
 * process via `POST /api/media/originals { hashes }` (returns `{ missing }`); the editor process
 * origin is obtained from `assetServiceOrigin()` (`PROMPTCUT_EDITOR_URL` in the prerender process, or
 * this process in single-process mode). If unreachable (no origin, network error, non-2xx), treat as
 * all not ready: better to intercept than produce a final video with uncertain assets. If none of the
 * assets referenced by clips have hashes, do not send a request and allow directly (legacy assets
 * without hashes can only be on this machine, do not intercept).
 */
import { checkExportOriginals, missingOriginals, type ExportGateResult } from "../src/render/mediaTier";
import { assetServiceOrigin } from "./asset-client";
import { withoutConfirmedMissing } from "../src/audio/missingMaterialRecord";

export async function exportOriginalsGate(
  project: any,
  { origin = assetServiceOrigin(), fetchImpl = globalThis.fetch, timeoutMs = 10_000 }: { origin?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ExportGateResult> {
  if (!project || !Array.isArray(project.media) || !Array.isArray(project.tracks)) return { ok: true, missing: [] };
  // Assets marked as "confirmed missing" will never arrive: do not intercept; output placeholders at
  // their original positions during export (src/audio/missingMaterialRecord.ts)
  project = withoutConfirmedMissing(project);
  const candidates = missingOriginals(project, []).map((m) => m.hash);
  if (!candidates.length) return { ok: true, missing: [] };
  let incomplete: Set<string> | null = null;
  if (origin) {
    try {
      const res = await fetchImpl(`${origin.replace(/\/+$/, "")}/api/media/originals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: candidates }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const body = await res.json() as { missing?: unknown };
        if (Array.isArray(body?.missing)) incomplete = new Set(body.missing.map((h) => String(h).toLowerCase()));
      }
    } catch { /* Unreachable: treat below as all not ready */ }
  }
  return checkExportOriginals({ project, has: (hash) => incomplete !== null && !incomplete.has(hash.toLowerCase()) });
}
