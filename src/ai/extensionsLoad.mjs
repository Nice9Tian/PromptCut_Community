/**
 * AI cloud extension loading entry (Node-side `.mjs`, modeled on `server/docservice/extensions.mjs`).
 *
 * 1. Why it is split into a separate `.mjs`:
 *    `src/ai/extensions.ts` is imported directly by browser-side React components, and
 *    `tsconfig.json` targets a pure browser environment (`types: ["vite/client"]`), which does not
 *    include `node:fs` / `node:path` / `node:url` / `process`. Putting the Node directory probing
 *    and dynamic loading in a `.mjs` keeps the browser-side `extensions.ts` clean with no Node
 *    dependency, and lets Node unit tests verify the load table contract.
 *
 * 2. Lookup order (same as `server/docservice/extensions.mjs`):
 *    - the directory passed explicitly via `loadAiExtensions({ cloudDir })` (used by unit tests);
 *    - the environment variable `PROMPTCUT_CLOUD_DIR`;
 *    - `<repoRoot>/cloud` under the repository root.
 *    If `<cloudDir>/ai/manifest.{ts,mjs,js}` is not found, an empty frozen array `[]` is returned
 *    and no exception is thrown.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COMMUNITY_AI_CLOUD_PROVIDER,
  applyAiManifest,
  registerAiCloudProvider,
} from "./extensions.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const ENV_KEY = "PROMPTCUT_CLOUD_DIR";
const DEFAULT_CLOUD_DIR_NAME = "cloud";
const AI_SUBDIR_NAME = "ai";

export async function loadAiExtensions(opts = {}) {
  try {
    const fromEnv = typeof process.env?.[ENV_KEY] === "string" ? process.env[ENV_KEY].trim() : "";
    const cloudDir =
      typeof opts.cloudDir === "string" && opts.cloudDir.trim()
        ? path.resolve(opts.cloudDir.trim())
        : fromEnv
          ? path.resolve(fromEnv)
          : path.join(repoRoot, DEFAULT_CLOUD_DIR_NAME);

    const candidates = ["manifest.ts", "manifest.mjs", "manifest.js"].map((f) =>
      path.join(cloudDir, AI_SUBDIR_NAME, f),
    );
    const manifestPath = candidates.find((p) => fs.existsSync(p));
    if (!manifestPath) return applyAiManifest([]);
    const mod = await import(pathToFileURL(manifestPath).href);
    const raw = mod?.AI_MANIFEST ?? mod?.manifest ?? mod?.default;
    return applyAiManifest(raw);
  } catch {
    return applyAiManifest([]);
  }
}

export { COMMUNITY_AI_CLOUD_PROVIDER, registerAiCloudProvider };
export default loadAiExtensions;
