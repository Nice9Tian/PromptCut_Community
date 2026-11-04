/**
 * Static check of module dependencies for src/store. Run: node --test src/store/importGraph.test.mjs
 *
 * Pinned down two rules here, both preventing the same thing: initialization order errors (TDZ)
 * caused by runtime circular dependencies:
 *   - `src/store/actions/*.ts` must not import `../project`. project.ts is a facade assembling each
 *     action object; if an action in turn imports it, that forms a cycle. Currently it is only used
 *     inside function bodies so it has not broken, but if someone uses it at the module top level
 *     someday, that triggers TDZ. When actions need to call each other, directly import each other's
 *     objects.
 *   - The runtime import graph of `src/store/**` is acyclic (`import type` / `type` specifiers do
 *     not count; they leave no imports after compilation).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STORE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Recursively collects .ts source files under src/store (tests themselves are .mjs, not included) */
function listSources(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listSources(full));
    else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * Extracts all **runtime** import targets in a file.
 * Skips `import type { X } from "..."`, as well as cases where every specifier inside curly braces
 * is marked with `type `: neither generates an import after compilation, forming no runtime cycle.
 */
function runtimeImports(src) {
  const targets = [];
  const re = /\bimport\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    const clause = m[1].trim();
    const spec = m[2];
    if (/^type\b/.test(clause)) continue;
    const braced = /^\{([\s\S]*)\}$/.exec(clause);
    if (braced) {
      const parts = braced[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0 && parts.every((p) => /^type\b/.test(p))) continue;
    }
    targets.push(spec);
  }
  // Pure side-effect import("x")
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["'];?\s*$/gm)) targets.push(m[1]);
  return targets;
}

/**
 * Resolves relative specifiers to absolute file paths under src/store; returns null if
 * unresolvable (external module).
 */
function resolve(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + ".ts", path.join(base, "index.ts")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

const files = listSources(STORE_DIR);

test("src/store/actions/* must not import ../project (otherwise it is a project ↔ actions cycle)", () => {
  const offenders = [];
  for (const file of files) {
    if (path.basename(path.dirname(file)) !== "actions") continue;
    for (const spec of runtimeImports(fs.readFileSync(file, "utf8"))) {
      const target = resolve(file, spec);
      if (target && path.resolve(target) === path.join(STORE_DIR, "project.ts")) {
        offenders.push(path.relative(STORE_DIR, file).replace(/\\/g, "/"));
      }
    }
  }
  assert.deepEqual(offenders, [], `These action files import ../project: ${offenders.join(", ")}`);
});

test("The runtime import graph of src/store has no cycles", () => {
  const graph = new Map();
  for (const file of files) {
    const deps = runtimeImports(fs.readFileSync(file, "utf8"))
      .map((spec) => resolve(file, spec))
      .filter((t) => t !== null);
    graph.set(path.resolve(file), deps.map((d) => path.resolve(d)));
  }

  const rel = (f) => path.relative(STORE_DIR, f).replace(/\\/g, "/");
  const state = new Map(); // 0 = visiting, 1 = completed
  const cycles = [];
  const walk = (node, stack) => {
    if (state.get(node) === 1) return;
    if (state.get(node) === 0) {
      cycles.push([...stack.slice(stack.indexOf(node)), node].map(rel).join(" -> "));
      return;
    }
    state.set(node, 0);
    stack.push(node);
    for (const next of graph.get(node) ?? []) walk(next, stack);
    stack.pop();
    state.set(node, 1);
  };
  for (const node of graph.keys()) walk(node, []);

  assert.deepEqual(cycles, [], `Found runtime circular dependencies:\n${cycles.join("\n")}`);
});
