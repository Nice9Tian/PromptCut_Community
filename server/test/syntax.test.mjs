/**
 * Every script must at least be parseable. Run: node --test server/test/syntax.test.mjs
 *
 * # Why have such a rudimentary check
 *
 * `tsconfig` does not include `server/`, so `tsc --noEmit` does not look at .ts files there at
 * all; and nobody checks .mjs: they are only parsed at the exact moment they are imported or run
 * by node. As a result, "this file has broken syntax" can slip through all checks until someone
 * runs the build script one day.
 *
 * This actually happened twice, both from the same pitfall: **writing paths like
 * `tools/<asterisk>/target` inside block comments**, where `<asterisk>` plus `/` is the comment
 * closing delimiter; the comment closes right there, and the rest of the file is parsed as code.
 *
 *   - server/vite-plugin-api-guard.ts: hit while writing, dev server failed to start, caught on the spot;
 *   - desktop/scripts/prepare-runtime.mjs: hit again the same day, and **committed in c0a66b8**.
 *     Verification back then only extracted a function from the file to run; the whole file was
 *     never parsed, so tests were all green.
 *
 * This test does only one very dumb thing: parses every script once. Dumb, but it catches both
 * cases above.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Directories to inspect. Limited depth, does not recurse into node_modules / build output directories */
const DIRS = ["scripts", "server", "server/vision", "server/runners", "server/test", "desktop/scripts", "tools/report-worker"];
const SKIP_DIR = new Set(["node_modules", "target", "catalog", ".cache", "runtime", "release", "out", "dist"]);

function collect(ext) {
  const out = [];
  for (const d of DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (ent.isDirectory() || SKIP_DIR.has(ent.name)) continue;
      if (ent.name.endsWith(ext)) out.push(path.join(abs, ent.name));
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");

test("All .mjs scripts parse", () => {
  const files = collect(".mjs");
  assert.ok(files.length > 15, `Only ${files.length} .mjs files found, the directory list is probably wrong`);
  const broken = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    if (r.status !== 0) broken.push(`${rel(f)}\n${(r.stderr || "").split("\n").slice(0, 4).join("\n")}`);
  }
  assert.equal(broken.length, 0, `These cannot be parsed:\n\n${broken.join("\n\n")}`);
});

test("All .ts files under server/ parse (tsc --noEmit does not look at this directory)", () => {
  const files = collect(".ts");
  assert.ok(files.length > 8, `Only ${files.length} .ts files found, the directory list is probably wrong`);
  const broken = [];
  for (const f of files) {
    const src = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    // parseDiagnostics is not a public API, but it is the most direct way to get "pure syntax errors";
    // if it really disappears one day, the assertion below will fail on undefined rather than falsely passing
    const diags = src.parseDiagnostics;
    assert.ok(Array.isArray(diags), `Cannot get the parse diagnostics for ${rel(f)}, this test needs a different implementation`);
    if (diags.length) {
      const first = diags[0];
      const { line } = src.getLineAndCharacterOfPosition(first.start ?? 0);
      broken.push(`${rel(f)}:${line + 1} ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`);
    }
  }
  assert.equal(broken.length, 0, `These cannot be parsed:\n${broken.join("\n")}`);
});

test("Block comments contain no paths that would close the comment early", () => {
  /*
   * The first two rules above catch "already broken"; this one catches "dangerous syntax": after a
   * comment is closed early, the remaining content sometimes happens to still form valid code,
   * causing the first two to miss it.
   *
   * The criterion is not "whether this line has a closing delimiter": a comment naturally ends on
   * some line, and often finishes like "text... <asterisk>/", which is normal. A real incident looks
   * like this:
   *
   *     * `tools/<asterisk>/target`, `.cache`: Rust build artifacts...
   *
   * The closing delimiter **appears mid-line, with content following it**. That indicates the author
   * did not intend to end the comment here, and a wildcard in a path happened to collide with the
   * closing delimiter. Only report this case.
   */
  const files = [...collect(".mjs"), ...collect(".ts")];
  const bad = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("*")) return; // Only check continuation lines of block comments
      const idx = trimmed.indexOf("*/");
      if (idx <= 0) return;
      // Non-empty content after closing delimiter = author did not intend to end here
      if (trimmed.slice(idx + 2).trim() !== "") bad.push(`${rel(f)}:${i + 1}  ${trimmed.slice(0, 80)}`);
    });
  }
  assert.equal(bad.length, 0, `These places in comments close the block comment early (write path wildcards as <id> or break them up with backticks):\n${bad.join("\n")}`);
});
