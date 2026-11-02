// Raw module text is used only for cache identity.  We follow each card's own
// static relative imports, rather than hashing the whole card catalog.
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.css'];
const imports = text => [...text.matchAll(/(?:import\s*(?:[^'"()]*?\s+from\s*)?|import\s*)["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1] || m[2]);
const resolve = (from, specifier, files) => {
  if (!specifier.startsWith('.')) return null;
  const base = new URL(specifier, `file://${from}`).pathname;
  const candidates = [base, ...EXTENSIONS.map(x => base + x), ...EXTENSIONS.map(x => `${base}/index${x}`)];
  return candidates.find(x => Object.hasOwn(files, x)) ?? null;
};
/**
 * Newlines are normalized to LF before factoring into identity: the same commit must compute
 * the same key on Windows (checked out as CRLF via autocrlf) and LF checkouts, matching the criteria
 * for server-side code version (`server/frame-code.mjs` textOf).
 */
export const normalizeEol = text => String(text).replace(/\r\n/g, '\n');
export function cardSourceVersion(card, files, entryPath) {
  const escaped = String(card.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = entryPath && Object.hasOwn(files, entryPath) ? entryPath : Object.keys(files).find(file => new RegExp(`\\bid\\s*:\\s*['"]${escaped}['"]`).test(files[file]));
  if (!entry) return `builtin-contract:${JSON.stringify({ id: card.id, defaults: card.defaults, controls: card.controls, lifecycle: card.lifecycle, frameMode: card.frameMode, need_prerendering: card.need_prerendering, compositing: card.compositing })}`;
  const seen = new Set(), visit = file => {
    if (!file || seen.has(file)) return ''; seen.add(file);
    const text = normalizeEol(files[file] || '');
    return `${file}\n${text}\n${imports(text).map(spec => visit(resolve(file, spec, files))).join('')}`;
  };
  return visit(entry);
}
