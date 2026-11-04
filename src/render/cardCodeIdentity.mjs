/**
 * Card code identity algorithm (shared by desktop and online page; see header of
 * `server/card-code.mjs` for usage, and Section 5 of `docs/plan/online-card-exec-contract.md`
 * for the online side).
 *
 * A card's identity = definition file plus card / part files it imports relatively along the way
 * (closure), with each file recorded as "repository-relative path + content hash", taking the first
 * 32 hex characters of the overall sha256. Content hash uses the same algorithm as the content store
 * (`sourceHash` in `server/card-sync.mjs`: `sha256(JSON.stringify(source code with line endings normalized to LF))`).
 *
 * This module only handles the two plain-text concerns of "which files to track" and "what to use
 * to compute digest", without reading files or computing digests:
 *   - Desktop (`server/vite-plugin-cards.ts`) injects "overlay layer first" file reading and
 *     Node's sha256;
 *   - Online page (`src/online/cardRuntime/codeIdentity.ts`) injects source code synced from the
 *     content store, built-in source bundled with the page, and WebCrypto.
 * Only when both sides compute the same value can the task's `requires.cardSources` match
 * `cardSourceVersions` reported by the node.
 *
 * Does not depend on Node built-in modules or browser APIs.
 */

/** Scope for inclusion in closure: card directory and part directory */
export const CARD_CODE_ROOTS = Object.freeze(["src/cards/", "src/parts/"]);
const CARD_CODE_EXT = /\.(tsx|ts|css)$/;
/** Maximum number of files tracked in closure */
export const CARD_CODE_CLOSURE_LIMIT = 60;
/** Number of leading hex digits taken for identity digest */
export const CARD_CODE_ID_HEX = 32;

/** Whether repository-relative path is within closure scope: under card / part directory, source/style file, not a test */
export function isCardCodePath(rel) {
  if (typeof rel !== "string" || !rel || rel.includes("..") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  if (/\.test\.(ts|tsx|mjs)$/.test(rel)) return false;
  return CARD_CODE_ROOTS.some((r) => rel.startsWith(r)) && CARD_CODE_EXT.test(rel);
}

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

/** Relative specifier under directory of `fromRel` → repository-relative path; returns null when escaping repository root */
function resolveRel(fromRel, spec) {
  const parts = fromRel.split("/").slice(0, -1);
  for (const p of spec.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(p);
  }
  return parts.length ? parts.join("/") : null;
}

/**
 * Candidate paths for each relative import in source code (in order of appearance in source;
 * grouped per specifier, ordered by trial sequence within group):
 * as-is, `.tsx`, `.ts`, `/index.tsx`, `/index.ts`. Specifiers escaping repository root produce no group.
 */
export function localImportCandidates(rel, source) {
  const out = [];
  for (const m of String(source ?? "").matchAll(IMPORT_RE)) {
    const base = resolveRel(rel, m[1] || m[2]);
    if (!base) continue;
    out.push([base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]);
  }
  return out;
}

/**
 * Local files directly used by a file: takes the first existing candidate for each relative import,
 * keeping only those falling within closure scope; deduplicated, preserving order.
 * @param {string} rel
 * @param {{ read: (rel: string) => string | null, isFile: (rel: string) => boolean }} io
 */
export function localImportsOf(rel, io) {
  let source = null;
  try { source = io.read(rel); } catch { source = null; }
  if (source == null) return [];
  const out = [];
  for (const candidates of localImportCandidates(rel, source)) {
    const hit = candidates.find((c) => io.isFile(c));
    if (!hit) continue;
    if (isCardCodePath(hit) && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** All local source of a card: definition file + card / part files it uses throughout (first is definition file) */
export function importClosureOf(entry, io, limit = CARD_CODE_CLOSURE_LIMIT) {
  const seen = [entry];
  for (let i = 0; i < seen.length && seen.length < limit; i++) {
    for (const r of localImportsOf(seen[i], io)) if (!seen.includes(r)) seen.push(r);
  }
  return seen;
}

/**
 * Text before computing digest: one line of "path" and one line of "content hash" for each file
 * (writes `missing` if unreadable).
 * @param {readonly string[]} files  Closure (result of `importClosureOf`)
 * @param {(rel: string) => string | null} hashOf  Content hash for this file; returns null if unreadable
 */
export function cardCodePreimage(files, hashOf) {
  let text = "";
  for (const rel of files) {
    const hash = hashOf(rel);
    text += `${rel}\n${hash == null ? "missing" : hash}\n`;
  }
  return text;
}
