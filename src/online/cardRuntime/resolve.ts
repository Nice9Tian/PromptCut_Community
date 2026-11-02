/**
 * Where an import in card source code resolves (`docs/plan/online-card-exec-contract.md` Section 2).
 * Pure function, does not read files.
 *
 * | Syntax | Resolves to |
 * |---|---|
 * | Package name on allowlist | The copy bundled with the page |
 * | Relative import under user card directory and present in content store | Synced source code (`.css` is stylesheet, not executed) |
 * | Relative import targeting a built-in module bundled with the page | The page's copy |
 * | Everything else | Unsupported: `{ ok: false }`, caller reports "referenced module not present in online page" |
 *
 * Built-in module scope: `src/cards/` (excluding user card directory), `src/parts/`, `src/kernel/`,
 * and `src/render/cards/graphValues.ts`. Outside this scope (e.g. `src/editor/`, `src/store/`),
 * imports are not allowed even if present on the page.
 */
import { CARD_PACKAGES, type ResolvedImport } from "./protocol.ts";

export const USER_CARD_DIR = "src/cards/user/";
const BUILTIN_PREFIXES = ["src/cards/", "src/parts/", "src/kernel/"];
const BUILTIN_FILES = new Set(["src/render/cards/graphValues.ts"]);
/** Extensions added for relative imports (order matches Vite) */
const MODULE_EXTS = [".ts", ".tsx", ".mjs", ".js"];

export interface ResolveEnv {
  /** Whether this key exists in the content store list */
  hasSynced: (key: string) => boolean;
  /** Whether this path exists in the table of built-in modules bundled with the page */
  hasBuiltin: (path: string) => boolean;
}

export type ResolveOutcome = { ok: true; to: ResolvedImport } | { ok: false; reason: string };

/** Whether this path is within the scope of built-in modules that cards are allowed to import */
export function isBuiltinModulePath(path: string): boolean {
  if (path.startsWith(USER_CARD_DIR)) return false;
  if (/\.test\.(ts|tsx|mjs|js)$/.test(path)) return false;
  if (BUILTIN_FILES.has(path)) return true;
  return BUILTIN_PREFIXES.some((p) => path.startsWith(p)) && /\.(tsx?|mjs|js)$/.test(path);
}

/** Relative specifier under `fromKey` directory → repo-relative path (no extension added); returns null if escaping repo root */
function join(fromKey: string, spec: string): string | null {
  const parts = fromKey.split("/").slice(0, -1);
  for (const p of spec.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(p);
  }
  return parts.length ? parts.join("/") : null;
}

function candidates(base: string): string[] {
  if (/\.(tsx?|mjs|js)$/.test(base)) {
    const stem = base.replace(/\.(tsx?|mjs|js)$/, "");
    return [...new Set([base, ...MODULE_EXTS.map((e) => stem + e)])];
  }
  return [...MODULE_EXTS.map((e) => base + e), `${base}/index.ts`, `${base}/index.tsx`];
}

export function resolveCardImport(fromKey: string, spec: string, env: ResolveEnv): ResolveOutcome {
  if (typeof spec !== "string" || !spec) return { ok: false, reason: "Empty import" };
  if (!(spec.startsWith("./") || spec.startsWith("../"))) {
    if (CARD_PACKAGES.includes(spec)) return { ok: true, to: { kind: "package", name: spec } };
    return { ok: false, reason: spec };
  }
  if (spec.includes("?") || spec.includes("\\") || spec.includes("#")) return { ok: false, reason: spec };
  const base = join(fromKey, spec);
  if (!base) return { ok: false, reason: spec };
  if (base.endsWith(".css")) {
    if (base.startsWith(USER_CARD_DIR) && env.hasSynced(base)) return { ok: true, to: { kind: "style", key: base } };
    return { ok: false, reason: spec };
  }
  // Asset imports (.json, .png, .svg…) have no corresponding candidate files, falling through to the final "unsupported"
  for (const c of candidates(base)) {
    if (c.startsWith(USER_CARD_DIR)) {
      if (env.hasSynced(c)) return { ok: true, to: { kind: "synced", key: c } };
      continue;
    }
    if (isBuiltinModulePath(c) && env.hasBuiltin(c)) return { ok: true, to: { kind: "builtin", path: c } };
  }
  return { ok: false, reason: spec };
}
