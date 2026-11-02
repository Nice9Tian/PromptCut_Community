/**
 * Entry point for transpiling synced cards in the editor page
 * (`docs/plan/online-card-exec-contract.md` Section 1). **Loaded on demand**: `Preview.tsx` calls
 * `import()` on it only when this page can execute synced cards (`gate.ts`) and such cards
 * exist in the project: Sucrase and the Tailwind compiler are both in this chunk, excluded from
 * the main chunk. Used only in browsers (`?raw`, IndexedDB).
 */
import theme from "tailwindcss/theme.css?raw";
import utilities from "tailwindcss/utilities.css?raw";
import { builtinCardSourceFiles } from "../../render/cardSourceFiles.mjs";
import { CARD_RUNTIME_VERSION } from "./version.ts";
import { bundleCard } from "./transpile.ts";
import { createTranspileCache } from "./transpileCache.ts";
import { createCardCssCompiler } from "./tailwind.ts";
import { isBuiltinModulePath } from "./resolve.ts";
import { cardCodeIdentityOf } from "./codeIdentity.ts";
import type { BundleResult } from "./protocol.ts";

export interface BundleJob {
  /** Key of entry file */
  entries: readonly string[];
  /** Content and hash for this key in the content store */
  read: (key: string) => { body: string; hash: string } | null;
}

const cache = createTranspileCache(CARD_RUNTIME_VERSION);
let warmed: Promise<void> | null = null;
const css = createCardCssCompiler({ theme, utilities });
/** Built-in modules bundled with page: source table keys are `/src/...`; having source text means the module exists in the page */
const hasBuiltin = (path: string) => isBuiltinModulePath(path) && Object.hasOwn(builtinCardSourceFiles, `/${path}`);
const builtinHashes = new Map<string, string>();

/** One card per entry: transpile into a bundle, or provide runtime state. Same order as `entries`. */
export async function bundleCards(job: BundleJob): Promise<BundleResult[]> {
  await (warmed ??= cache.warm());
  const out: BundleResult[] = [];
  for (const entry of job.entries) out.push(await bundleCard({ runtime: CARD_RUNTIME_VERSION, entry, read: job.read, hasBuiltin, css, cache }));
  return out;
}

/** Code identity for each entry (used when browser-only nodes report `cardSourceVersions` or send manifest plans); omitted if cannot be computed */
export async function codeIdentities(job: BundleJob): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const files = { synced: job.read, builtin: (path: string) => (Object.hasOwn(builtinCardSourceFiles, `/${path}`) ? String(builtinCardSourceFiles[`/${path}`]) : null) };
  for (const entry of job.entries) {
    const id = await cardCodeIdentityOf(entry, files, { builtinHashes });
    if (id) out[entry] = id.version;
  }
  return out;
}

export { CARD_RUNTIME_VERSION };
