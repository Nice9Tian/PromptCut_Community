/**
 * Transpiles card source synced from content store into bundles executable by stage
 * (`docs/plan/online-card-exec-contract.md` Sections 1, 2). Runs in the **editor page**: reads text
 * only, does not execute (Sucrase does not use `eval`). Loaded on demand (this chain bundles
 * Sucrase and the Tailwind compiler).
 *
 * Per file: syntax precheck → Sucrase (`typescript`, `jsx`, `imports`, JSX uses automatic runtime)
 * → CommonJS text, then resolves each `require("<specifier>")` inside to a bundle, synced source,
 * built-in module bundled with page, or styles (`resolve.ts`).
 * Per card: starting from the entry file, gathers the closure by following synced relative imports;
 * if any step fails, produces runtime state for the card (`unsupported-syntax` / `missing-module`)
 * without emitting a bundle.
 */
import { transform } from "sucrase";
import { unsupportedSyntax } from "./precheck.ts";
import { REMOTION_LOCK_CACHE_TAG, remotionLockSuffix } from "./remotionLock.mjs";
import { resolveCardImport, type ResolveEnv } from "./resolve.ts";
import { classCandidates, type CardCssCompiler } from "./tailwind.ts";
import type { BundleResult, CardBundle, CardModule, CardRunState, ResolvedImport } from "./protocol.ts";
import { tr } from "../../i18n/index.ts";

/** Limit for a single file (characters); skipped if exceeded */
export const MAX_SOURCE_CHARS = 512 * 1024;
/** Maximum synced files in a single card's closure (same value as `CARD_SOURCE_MAX_DEPS` in `onlineCardSources.ts`) */
export const MAX_CLOSURE_FILES = 200;

export type FileResult =
  | { ok: true; js: string; specifiers: string[] }
  | { ok: false; state: CardRunState };

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split("\n")[0].slice(0, 200);

/** Specifier in `require("…")` within transpile output (Sucrase `imports` transform produces only string-literal `require` calls) */
export function requireSpecifiers(js: string): string[] {
  const out = new Set<string>();
  for (const m of js.matchAll(/\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g)) out.add(m[2]);
  return [...out];
}

/**
 * Transpiles a single file. `key` is used for reporting errors, as filename for the transpiler, and
 * to compute the relative path in the "lock top-level to read-only" snippet.
 * `lockSuffix`: snippet to append at end of source code (`remotionLock.mjs`); computed on the fly
 * if omitted. Present only for cards that need locking; for other cards it is an empty string and
 * source is kept as is.
 */
export function transpileCardFile(key: string, source: string, lockSuffix?: string): FileResult {
  if (typeof source !== "string") return { ok: false, state: { state: "load-error", detail: tr("Source unavailable"), file: key } };
  if (source.length > MAX_SOURCE_CHARS) return { ok: false, state: { state: "unsupported-syntax", detail: tr("File too large (over {0} KB)", MAX_SOURCE_CHARS / 1024), file: key } };
  try {
    const bad = unsupportedSyntax(source);
    if (bad.length) return { ok: false, state: { state: "unsupported-syntax", detail: tr("{0} (line {1})", bad[0].what, bad[0].line), file: key } };
    const js = transform(source + (lockSuffix ?? remotionLockSuffix(key, source)), {
      transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", production: true,
      preserveDynamicImport: true, filePath: key,
    }).code;
    return { ok: true, js, specifiers: requireSpecifiers(js) };
  } catch (err) {
    return { ok: false, state: { state: "unsupported-syntax", detail: tr("Transpile error: {0}", firstLine(err)), file: key } };
  }
}

export interface BundleInput {
  /** Online card runtime version */
  runtime: string;
  /** Key of entry file */
  entry: string;
  /** Content and hash for this key in the content store; returns null if absent */
  read: (key: string) => { body: string; hash: string } | null;
  /** Whether this path exists in the table of built-in modules bundled with the page */
  hasBuiltin: (path: string) => boolean;
  /** Tailwind supplemental generation; omitted means no generation (`tailwind` is empty string) */
  css?: CardCssCompiler;
  /** Transpile cache for single files (keyed by "runtime version + key + hash"; `transpileCache.ts`) */
  cache?: { get: (key: string, hash: string) => FileResult | undefined; set: (key: string, hash: string, value: FileResult) => void };
}

/** Signature of this generation: runtime version + key and hash of each file in closure (sorted by key) */
export function generationOf(runtime: string, files: Iterable<readonly [string, string]>): string {
  return `${runtime}|${[...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, h]) => `${k}@${h}`).join("|")}`;
}

/** Per card: entry plus closure → bundle, or runtime state for this card */
export async function bundleCard(input: BundleInput): Promise<BundleResult> {
  const { runtime, entry, read, hasBuiltin, css, cache } = input;
  const env: ResolveEnv = { hasSynced: (k) => read(k) != null, hasBuiltin };
  const fail = (state: CardRunState): BundleResult => ({ ok: false, entry, state });
  const modules: CardModule[] = [];
  const styles: CardBundle["styles"] = [];
  const sources: string[] = [];
  const hashes = new Map<string, string>();
  const queue = [entry];
  const seen = new Set<string>();
  while (queue.length) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > MAX_CLOSURE_FILES) return fail({ state: "missing-module", detail: tr("This card imports too many files (over {0})", MAX_CLOSURE_FILES), file: entry });
    const file = read(key);
    if (!file) return fail({ state: "missing-module", detail: key, file: entry });
    hashes.set(key, file.hash);
    /*
     * Cards that need locking (declared as remotion-style and referencing the framework) append a
     * statement to "lock top-level to read-only" at end of source, producing transpiled text different
     * from when omitted; therefore, it uses a distinct key in the transpile cache (with a tag after
     * the content hash): keys for other cards remain unchanged, hitting old cache as usual;
     * cards that need locking will not hit old results saved without this snippet appended.
     * Runtime version (`version.ts`) therefore does not need to change.
     */
    const lockSuffix = remotionLockSuffix(key, file.body);
    const cacheHash = lockSuffix ? `${file.hash}${REMOTION_LOCK_CACHE_TAG}` : file.hash;
    let out = cache?.get(key, cacheHash);
    if (!out) {
      out = transpileCardFile(key, file.body, lockSuffix);
      cache?.set(key, cacheHash, out);
    }
    if (!out.ok) return fail(out.state);
    sources.push(file.body);
    const imports: Record<string, ResolvedImport> = {};
    for (const spec of out.specifiers) {
      const r = resolveCardImport(key, spec, env);
      if (!r.ok) return fail({ state: "missing-module", detail: r.reason, file: key });
      imports[spec] = r.to;
      if (r.to.kind === "synced") queue.push(r.to.key);
      if (r.to.kind === "style" && !hashes.has(r.to.key)) {
        const style = read(r.to.key)!;
        hashes.set(r.to.key, style.hash);
        styles.push({ key: r.to.key, hash: style.hash, css: style.body });
        sources.push(style.body);
      }
    }
    modules.push({ key, hash: file.hash, js: out.js, imports });
  }
  let tailwind = "";
  if (css) {
    try { tailwind = await css(classCandidates(sources)); } catch { tailwind = ""; /* Failure to generate styles does not block execution: cards run as usual, merely lacking styles for new class names */ }
  }
  return { ok: true, entry, bundle: { runtime, entry, modules, styles, tailwind, generation: generationOf(runtime, hashes) } };
}
