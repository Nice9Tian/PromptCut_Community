/**
 * Gatekeeper: modules loaded by Node unit tests must not statically import `src/online/mode.ts`
 * (C10a integration, constraint from lead session 2026-09-27).
 * Run: node --test src/online/modeImportGuard.test.mjs
 *
 * The content of `mode.ts` is fixed byte-for-byte per C10a contract section 2:
 * `import.meta.env.VITE_PC_ONLINE === "1"`. Node has no `import.meta.env`, so loading it in Node
 * immediately throws TypeError (hit halfway through c10a implementation: `C65B-V7-01` loading
 * `io/index.ts` crashed). Therefore:
 *   - Modules loaded by unit tests that need `ONLINE` must `await import(".../online/mode")` on
 *     demand, or have callers pass `online` in;
 *   - If a unit test itself needs to load a module that statically imports `mode.ts`, replace it
 *     with a stub first via `mock.module(srcUrl("online/mode.ts"), …)`.
 *
 * Approach: starting from each unit test file, trace along **static** imports (`import type` does
 * not count, `await import()` is on-demand loading and is not followed) through all loaded `src/`
 * modules; module X stubbed with `mock.module(srcUrl("X"))` in the test is replaced with a stub and
 * not traversed further. If `src/online/mode.ts` is reached and this unit test has not stubbed it
 * out, fail (mark red) and report the import chain.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const MODE = "src/online/mode.ts";
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");
const EXTS = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx", "/index.mjs"];

function resolveFrom(fromAbs, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // Package name: ignore
  const base = spec.startsWith("/") ? path.join(ROOT, spec) : path.resolve(path.dirname(fromAbs), spec);
  for (const e of EXTS) {
    const p = base + e;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* Next */ }
  }
  return null;
}

/** Static import / re-export in source code (excluding `import type`, `export type`) */
function staticSpecs(text) {
  const out = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  for (const m of code.matchAll(/(?:^|[;\n])\s*(?:import|export)\s+(type\s+)?(?:[\w*${}\s,]*?\s+from\s+)?["']([^"']+)["']/g)) {
    if (!m[1]) out.push(m[2]);
  }
  return out;
}

/** Entry points in unit test files pointing to `src/`: static import, literal `import("…")`, `srcUrl("…")`, `repoUrl('src/…')`, `new URL('…', import.meta.url)` */
function testEntries(fileAbs, text) {
  const entries = [];
  const add = (abs) => { if (abs) entries.push(abs); };
  for (const s of staticSpecs(text)) add(resolveFrom(fileAbs, s));
  for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) add(resolveFrom(fileAbs, m[1]));
  for (const m of text.matchAll(/srcUrl\(\s*["']([^"']+)["']\s*\)/g)) add(resolveFrom(path.join(ROOT, "src", "x"), `./${m[1]}`));
  for (const m of text.matchAll(/repoUrl\(\s*["'](src\/[^"']+)["']\s*\)/g)) add(resolveFrom(path.join(ROOT, "x"), `./${m[1]}`));
  // new URL(…) only counts when passed directly to import() (readFileSync(new URL(…)) used to read file text does not count)
  for (const m of text.matchAll(/import\(\s*new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) add(resolveFrom(fileAbs, m[1]));
  return entries;
}

/** `src/` modules stubbed in unit tests */
function mockedIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/mock\.module\(\s*srcUrl\(\s*["']([^"']+)["']\s*\)/g)) out.add(`src/${m[1]}`);
  return out;
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
  return [p];
});

const testFiles = [
  ...walk(path.join(ROOT, "src")).filter((f) => f.endsWith(".test.mjs")),
  ...fs.readdirSync(path.join(ROOT, "server", "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => path.join(ROOT, "server", "test", f)),
  // After A3, the closed-source parts live under cloud/ (this directory does not exist in the public
  // repository); this check originally guarded them, and must continue guarding them after the move
  ...(fs.existsSync(path.join(ROOT, "cloud", "src")) ? walk(path.join(ROOT, "cloud", "src")).filter((f) => f.endsWith(".test.mjs")) : []),
  ...(fs.existsSync(path.join(ROOT, "cloud", "server", "test")) ? fs.readdirSync(path.join(ROOT, "cloud", "server", "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => path.join(ROOT, "cloud", "server", "test", f)) : []),
];

const textCache = new Map();
const read = (abs) => { if (!textCache.has(abs)) textCache.set(abs, fs.readFileSync(abs, "utf8")); return textCache.get(abs); };

/** Follow static imports from the entry point; returns "reference chain to mode.ts" or null */
function chainToMode(entries, mocked) {
  const prev = new Map();
  const queue = [];
  for (const e of entries) if (!prev.has(e)) { prev.set(e, null); queue.push(e); }
  while (queue.length) {
    const cur = queue.shift();
    const r = rel(cur);
    if (mocked.has(r)) continue;
    if (r === MODE) {
      const chain = [];
      for (let x = cur; x; x = prev.get(x)) chain.unshift(rel(x));
      return chain;
    }
    if (!/\.(ts|tsx|mjs|js)$/.test(cur)) continue;
    const text = read(cur);
    // Only follow static imports after the entry point: await import() in source code is loaded on demand;
    // import() in test helper (server/test/*-kit.mjs etc.) functions is only loaded when called by a test,
    // and the calling test is responsible for stubbing (like pickDecider in c10a-kit.mjs)
    const next = staticSpecs(text).map((s) => resolveFrom(cur, s));
    for (const n of next) if (n && !prev.has(n)) { prev.set(n, cur); queue.push(n); }
  }
  return null;
}

test("C10A-MODE-01 Modules loaded by Node unit tests do not statically reference src/online/mode.ts (either load on demand, or stub it in the unit test first)", () => {
  assert.ok(testFiles.length > 100, `Too few unit test files found: ${testFiles.length}`);
  const bad = [];
  for (const f of testFiles) {
    const text = read(f);
    const mocked = mockedIn(text);
    if (mocked.has(MODE)) continue;
    const chain = chainToMode(testEntries(f, text), mocked);
    if (chain) bad.push(`${rel(f)}:${chain.join(" → ")}`);
  }
  assert.deepEqual(bad, [], `These unit tests load mode.ts in Node (import.meta.env does not exist, throws immediately):\n${bad.join("\n")}`);
});

test("C10A-MODE-02 the gate works on itself: modules that statically import mode.ts are recognized", () => {
  const importers = walk(path.join(ROOT, "src"))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts"))
    .filter((f) => staticSpecs(read(f)).some((s) => rel(resolveFrom(f, s) ?? "") === MODE));
  assert.ok(importers.length >= 3, `modules that statically import mode.ts should be recognized, actual: ${importers.map(rel).join(", ")}`);
  // A dummy unit test: directly loads Preview.tsx (which statically imports mode.ts), not stubbed → should fail
  const fake = path.join(ROOT, "src", "editor", "fake.test.mjs");
  const chain = chainToMode(testEntries(fake, 'const P = await import("./Preview.tsx");'), new Set());
  assert.ok(chain && chain.at(-1) === MODE, `the fake unit test should reach mode.ts: ${JSON.stringify(chain)}`);
  // Does not count if stubbed
  assert.equal(chainToMode(testEntries(fake, 'await import(srcUrl("online/mode.ts"))'), new Set([MODE])), null);
});
