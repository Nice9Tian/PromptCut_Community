// Watch ignore and dependency scan entries for dev server (vite.config.ts, vite.prerender.config.ts).
//
// Why not use glob strings for ignores: Vite 8 passes `server.watch.ignored` as-is to bundled chokidar 3,
// and chokidar uses picomatch default options (dot: false) to match **absolute paths**. With dot: false,
// `**` does not cross segments starting with a dot, so as long as the project root's absolute path
// contains such a segment (worktrees are under `<repo>/.worktrees/<name>/`), patterns like `**/out/**`
// never take effect, and even Vite's built-in `**/node_modules/**` and `**/.git/**` fail similarly.
// Conversely, when starting the service at repo root, source code and out/ under each worktree in
// `.worktrees/` get included in watching. Here, it is changed to a function evaluating "path segments
// relative to project root", irrespective of what the root's absolute path looks like.
//
// Dependency scan entries: when `optimizeDeps.entries` is omitted, Vite scans for entries using
// `**/*.html`, excluding only node_modules and build.outDir(dist); frame store (tens of thousands of
// .html files under out/frame-library) would be read entirely as entries: slowing cold start by over
// 10x with 150,000 files. Here, entries are restricted to the few locations that are genuinely pages.
// When new pages are placed outside these locations, dependencies can still be discovered at runtime,
// with just an extra prebundle on first launch.
import path from "node:path";

/** Do not watch if these segments appear in path (relative to project root). Original semantics of `**\/x/**`: matching same-named directories at any depth. */
const IGNORED_SEGMENTS = new Set([
  // Vite's default ignores (passing a function does not replace them, but their globs are also affected by the dot issue above, handled together here)
  ".git", "node_modules", "test-results",
  // Not source code: desktop shell binaries, export artifacts and frame store, built-in Python,
  // local work and acceptance artifacts, tool build artifacts, build artifacts and documentation
  "desktop", "out", "python", "work", "tools", "dist", "dist-online", "docs", "archive",
  // Drafts, task directories, session history: runtime data; triggering hot reload on every change is a pure waste
  ".pc-projects", ".pc-work", ".pc-chats",
  // When starting the server from the repo root, other worktrees are not source code for this service
  ".worktrees",
]);

/**
 * Predicate function used by `server.watch.ignored`. Called by chokidar via anymatch; incoming
 * paths are already normalized to forward slashes.
 * Paths outside the project root (config file dependencies, env files) are not ignored here,
 * leaving them to Vite's own rules.
 * `.lock`: exclusive lock for .proc; the shell holds it with share mode 0, so chokidar gets
 * EBUSY immediately on fs.watch, causing the entire dev server to exit on the spot.
 */
export function watchIgnored(root) {
  const base = path.resolve(root);
  return (p) => {
    if (typeof p !== "string" || p === "") return false;
    if (p.endsWith(".lock")) return true;
    const rel = path.relative(base, path.resolve(p));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return rel.split(/[\\/]/).some((seg) => IGNORED_SEGMENTS.has(seg));
  };
}

/** `optimizeDeps.entries`: glob relative to project root; matches the same pages actually found by original `**\/*.html`, but avoids scanning large directories like out/. */
export const DEP_SCAN_ENTRIES = ["*.html", "src/**/*.html", "desktop/ui/**/*.html", "scripts/**/*.html"];
