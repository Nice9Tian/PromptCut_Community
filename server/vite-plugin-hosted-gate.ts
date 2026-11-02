/*
 * Cloud extension loading point for build plugins (public side, `docs/plan/community-boundary.md`
 * Section 2), and doubles as the public shell for the hosted page gate plugin.
 *
 * 1. **Why use top-level `await`**: `vite.config.ts`, `vite.prerender.config.ts`, and
 *    `cardOverridesLoader()` in `vite-plugin-cards.ts` all assemble plugin lists synchronously, so
 *    cloud build extensions must already be ready when called; ESM top-level `await` is used to
 *    complete existence probing and loading in one pass during module evaluation.
 * 2. **Why support `PROMPTCUT_CLOUD_DIR`**: Follows the same convention as
 *    `server/docservice/extensions.mjs`. Under the final two-repo submodule layout, the public
 *    repo is a submodule under `community/` of the private repo, so `..` relative to this file
 *    points to `community/` rather than the private root; allows specifying the cloud directory
 *    via `PROMPTCUT_CLOUD_DIR` (defaults to `<current repo root>/cloud`; if this file is
 *    transpiled by unit tests into the system temp directory, it falls back to `process.cwd()/cloud`).
 * 3. **Why not move this file and change the import in `vite.config.ts`**:
 *    Both `vite.config.ts` (line 8) and `vite.prerender.config.ts` (line 8) directly
 *    `import { hostedGatePlugin } from "./server/vite-plugin-hosted-gate"`, and both are public
 *    shared config files (by gatekeeper rules, direct imports of `cloud/` are not allowed;
 *    otherwise, in community edition without `cloud/`, both `npm run build` and the prerender
 *    process would fail immediately because the module cannot be found). Therefore, the actual
 *    gate implementation was moved into `cloud/build/vite-plugin-hosted-gate.mjs` and registered
 *    by `cloud/build/manifest.mjs`, while this file remains on the public side as the
 *    **sole extension loading entry point** for the build block (isomorphic to
 *    `server/docservice/extensions.mjs`): when `cloud/build/manifest.mjs` is present, it mounts
 *    the real gate; otherwise, it returns an empty plugin `{ name: "promptcut-hosted-gate" }`.
 * 4. **Gatekeeper exception declaration**: This file is the **sole exception** in the build block
 *    to the "shared tree must not load `cloud/`" gatekeeper rule. No specific cloud business module
 *    paths appear in this file; it only probes the fixed `<cloud directory>/build/manifest.mjs`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = existsSync(path.join(here, "..", "package.json"))
  ? path.resolve(here, "..")
  : process.cwd();
const envCloudDir = process.env.PROMPTCUT_CLOUD_DIR?.trim();
const cloudDir = envCloudDir
  ? path.resolve(envCloudDir)
  : path.join(repoRoot, "cloud");
const manifestFile = path.join(cloudDir, "build", "manifest.mjs");

let loaded: Record<string, any> = {};
if (existsSync(manifestFile)) {
  const mod: any = await import(pathToFileURL(manifestFile).href);
  const table: any = mod?.default ?? mod?.manifest;
  if (table && typeof table === "object" && !Array.isArray(table)) {
    const clean: Record<string, any> = {};
    for (const [key, item] of Object.entries(table)) {
      if (item && typeof item === "object" && typeof (item as any).name === "string" && (item as any).name) {
        clean[key] = item;
      }
    }
    loaded = clean;
  }
}

export const buildExtensions: Record<string, any> = Object.freeze({ ...loaded });

// Pass-through rules for the stage gate, read by `stage-gate.mjs` under this key. Not imported
// here: this entry point may be copied to a temporary directory for evaluation, where relative
// paths cannot be found
(globalThis as Record<symbol, unknown>)[Symbol.for("promptcut.stage-allow")] = buildExtensions.stageAllow?.rules ?? [];

export function hostedGatePlugin(): Plugin {
  if (typeof buildExtensions.hostedGate?.createPlugin === "function") {
    return buildExtensions.hostedGate.createPlugin();
  }
  return { name: "promptcut-hosted-gate" };
}

export default hostedGatePlugin;
