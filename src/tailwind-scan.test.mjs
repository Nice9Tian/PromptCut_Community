/**
 * Gatekeeper check for Tailwind scan scope (M8 leftover L12). Run: node --test src/tailwind-scan.test.mjs
 *
 * Why pin this down: in the dev server, `@tailwindcss/vite` attaches every scanned file as a style
 * dependency. When a modified file's extension is not code or style (`.md`, `.txt`, `.yaml`,
 * `.toml`, `.html`, `.log`, etc.), it triggers a full page reload on all open pages without logging:
 * the user's resident editor and running probe pages are both reloaded (verification in
 * `docs/archive/agent-reports/AGENT-tailwind-scan.md`). `@source not` in `src/index.css` has already
 * excluded docs, tests, scripts, etc. from scanning, but if a non-code file is added under `src/`
 * or `server/` in the future, it would enter scanning again, which previously relied on human memory.
 *
 * Approach: use the plugin's own two parts (compile from `@tailwindcss/node`, Scanner from
 * `@tailwindcss/oxide`) to compute scan sources from `src/index.css` in the same way as the plugin,
 * getting the actual scanned file list rather than duplicating an exclusion rule set here. Thus the
 * exclusion list has only one source: `src/index.css`. The scanner skips ignored paths per
 * `.gitignore`; unignored untracked files are also scanned and checked here (they trigger reloads too).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SRC);
const ENTRY = path.join(SRC, "index.css");

/**
 * The plugin only hot-reloads changes to these extensions without full page reload (code and
 * styles); all other extensions count as violations.
 */
const CODE_OR_STYLE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".css"]);
/** Guarded scope */
const GUARDED = ["src/", "server/"];

const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");

// Same as generate() in `@tailwindcss/vite` 4.x: when root is null, scans all files using Vite's
// root (repository root) as base, then appends each `@source` rule

async function scannedFiles() {
  const compiler = await compile(fs.readFileSync(ENTRY, "utf8"), { base: SRC, onDependency() {} });
  const root = compiler.root;
  const sources = (root === "none" ? [] : root === null ? [{ base: ROOT, pattern: "**/*", negated: false }] : [{ ...root, negated: false }])
    .concat(compiler.sources);
  const scanner = new Scanner({ sources });
  scanner.scan();
  return scanner.files.map(rel);
}

const scanned = await scannedFiles();

test("Files under src/ and server/ scanned by Tailwind are only code and styles", () => {
  const bad = scanned
    .filter((f) => GUARDED.some((d) => f.startsWith(d)))
    .filter((f) => !CODE_OR_STYLE.has(path.extname(f).toLowerCase()))
    .sort();
  assert.deepEqual(
    bad,
    [],
    [
      `Tailwind will scan the following ${bad.length} non-code files; editing them in the dev server makes every open page silently reload in full:`,
      ...bad.map((f) => `  ${f}`),
      "To fix (pick one):",
      "  1. Move: put it outside src/ and server/ (docs go in docs/, test fixtures in server/test/, runtime output in the git-ignored out/ or data/);",
      '  2. Exclude: add a line @source not "../<path or glob>"; to the exclusion list in src/index.css (the path is relative to src/index.css).',
      "  Do not exclude source such as .ts/.tsx/.mjs under src/ and server/ for this: the UI class names live in it (see the next check in this file).",
    ].join("\n"),
  );
});

test("The source containing UI class names is still scanned (the exclusion list has not gone too far)", () => {
  const set = new Set(scanned);
  assert.ok(set.has("index.html"), "index.html is not in the scan");
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "src", "server"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((f) => f.endsWith(".tsx") && !f.startsWith("server/test/"));
  assert.ok(tracked.some((f) => f.startsWith("server/catalog/magicui/")), "No card source found under server/catalog/magicui, check the premise of this test");
  const missing = tracked.filter((f) => !set.has(f));
  assert.deepEqual(missing, [], `These .tsx files are excluded by @source not in src/index.css, so the Tailwind class names in them will not generate styles:\n${missing.join("\n")}`);
});
