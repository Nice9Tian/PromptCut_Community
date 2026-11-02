/**
 * Static check for layering. Run: node --test src/layering.test.mjs
 *
 * Expected layer order (lower layers must not import upper layers):
 *
 *   src/kernel (data models, pure computation)
 *     ← src/render (stage rendering, frame pipeline)
 *       ← src/editor (editor UI) / src/mcp / src/ai
 *
 * Why pin this down: online browser mode and local mode share the same rendering code
 * (docs/semantics/mechanism/platforms.md). If kernel / render reaches up into editor in reverse,
 * the browser side has to bundle the entire editor along with it: and this kind of dependency
 * creeps in silently: adding a single import line works without throwing errors or dropping
 * frames, and only this check can catch it.
 *
 * Both runtime imports and **type** imports count: although type edges leave no imports after
 * compilation, they still express that "this layer knows concepts from an upper layer", and when
 * making edits it is all too easy to drag runtime code in with them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** Which layers each layer is not allowed to import (directory names, direct subdirectories of src) */
const FORBIDDEN = {
  kernel: ["render", "editor", "mcp", "ai", "store", "cards", "parts"],
  render: ["editor", "mcp", "ai"],
  // c10a: Online browser mode detection (`src/online/`) is on the same layer as render: only
  // imports kernel, render, and the same directory (lead session ruling)
  online: ["editor", "mcp", "ai"],
};

/**
 * Explicitly permitted edges. Each entry must clearly state why: this table should only shrink.
 *
 * `src/kernel/clock.ts` contains `declare global { interface Window { … } }`:
 * those `window.__pc*` global hooks on the page are installed by the render layer (solid /
 * stageRpc / frameWindow / createSnapshot), but declarations must be centralized in one place;
 * otherwise every file using window.__pcSolid would have to declare it itself and conflict with
 * each other. It is a **pure type** `import('…')`, leaving zero lines of code after compilation.
 * To really split it, we would have to move these global types into kernel too, but those types
 * describe render-layer objects themselves, so moving them down amounts to duplicating the
 * render-layer interface. Cost exceeds benefit, keep it for now.
 */
const ALLOWED = new Set([
  "src/kernel/clock.ts -> src/render/frameWindow.mjs",
  "src/kernel/clock.ts -> src/render/createSnapshot.ts",
  "src/kernel/clock.ts -> src/render/solid.ts",
  "src/kernel/clock.ts -> src/render/stageRpc.ts",
]);

const CODE = /\.(ts|tsx|mts|mjs|js|jsx)$/;

function listSources(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listSources(full, out);
    else if (CODE.test(ent.name)) out.push(full);
  }
  return out;
}

/** `import('…')` appearing in comments (explanatory text, @deprecated notes) is not a dependency; strip it first */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** All import targets in a file (both runtime and pure type imports) */
function importSpecs(raw) {
  const src = stripComments(raw);
  const out = [];
  for (const m of src.matchAll(/\bimport\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/g)) out.push(m[1]);
  // Pure side-effect import "x"
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["'];?\s*$/gm)) out.push(m[1]);
  // Inline import('x').Foo (type position) and dynamic import('x')
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

const EXTS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", ".d.mts", ".d.ts"];

/** Resolves relative specifiers to absolute paths under src; returns null if unresolved (external packages, non-code assets) */
function resolve(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [...EXTS.map((e) => base + e)];
  // `./x.mjs` might point to `./x.mts`, `./x.js` might point to `./x.ts` / `./x.tsx`
  if (base.endsWith(".mjs")) cands.push(base.slice(0, -4) + ".mts");
  if (base.endsWith(".js")) cands.push(base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx");
  for (const e of ["index.ts", "index.tsx", "index.mjs", "index.js"]) cands.push(path.join(base, e));
  for (const c of cands) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

const rel = (f) => "src/" + path.relative(SRC, f).replace(/\\/g, "/");
/** Gets the top-level directory name under src */
const layerOf = (r) => r.slice("src/".length).split("/")[0];

/** All cross-layer reverse edges in src/**, in the form `src/a/b.ts -> src/c/d.ts` */
function reverseEdges() {
  const found = [];
  for (const file of listSources(SRC)) {
    const from = rel(file);
    const forbidden = FORBIDDEN[layerOf(from)];
    if (!forbidden) continue;
    for (const spec of importSpecs(fs.readFileSync(file, "utf8"))) {
      // Data files (review tables like capabilities.json) are assets, not modules, and do not count
      // as cross-layer dependencies
      if (/\.(json|css|svg|png|txt|md)$/.test(spec)) continue;
      const target = resolve(file, spec);
      if (!target) continue;
      const to = rel(target);
      if (forbidden.includes(layerOf(to))) found.push(`${from} -> ${to}`);
    }
  }
  return [...new Set(found)].sort();
}

test("src/kernel does not import render / editor / mcp / ai / store / cards / parts", () => {
  const offenders = reverseEdges().filter((e) => layerOf(e.split(" -> ")[0]) === "kernel" && !ALLOWED.has(e));
  assert.deepEqual(offenders, [], `kernel has reverse dependencies on upper layers:\n${offenders.join("\n")}`);
});

test("src/render does not import editor / mcp / ai", () => {
  const offenders = reverseEdges().filter((e) => layerOf(e.split(" -> ")[0]) === "render" && !ALLOWED.has(e));
  assert.deepEqual(offenders, [], `render has reverse dependencies on upper layers:\n${offenders.join("\n")}`);
});

test("Edges in the allowlist still exist (once fixed, remove it from ALLOWED)", () => {
  const live = new Set(reverseEdges());
  const stale = [...ALLOWED].filter((e) => !live.has(e));
  assert.deepEqual(stale, [], `These edges no longer exist, so the allowlist should be shortened:\n${stale.join("\n")}`);
});
