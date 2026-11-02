/**
 * Tailwind 扫描范围的守门检查（M8 遗留 L12）。跑：node --test src/tailwind-scan.test.mjs
 *
 * 为什么要钉死：开发服务里 `@tailwindcss/vite` 把扫描到的每个文件都挂成样式的依赖。改到的文件
 * 后缀不是代码或样式（`.md`、`.txt`、`.yaml`、`.toml`、`.html`、`.log` 等）时，它不打日志就让
 * 所有打开的页面整页重载：用户常驻的编辑器、正在跑的探针页面都会被重载（查证见
 * `docs/archive/agent-reports/AGENT-tailwind-scan.md`）。`src/index.css` 里的 `@source not`
 * 已把文档、测试、脚本等排除出扫描，但以后在 `src/`、`server/` 下新加一个非代码文件，
 * 它就又进了扫描，以前只能靠人记着。
 *
 * 做法：用插件自己的两块（`@tailwindcss/node` 的 compile、`@tailwindcss/oxide` 的 Scanner），
 * 按插件同样的方式从 `src/index.css` 算出扫描源，拿到真实扫描到的文件表，而不是在这里另抄
 * 一份排除规则。所以排除表只有一处：`src/index.css`。扫描器按 `.gitignore` 跳过忽略的路径，
 * 没被忽略的未跟踪文件也会扫到，这里一并检查（它们一样会触发重载）。
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

/** 插件对这些后缀的改动只热更新、不整页重载（代码与样式），其余后缀一律算违例 */
const CODE_OR_STYLE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".css"]);
/** 守的范围 */
const GUARDED = ["src/", "server/"];

const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");

// 与 `@tailwindcss/vite` 4.x 的 generate() 相同：root 为 null 时以 Vite 的 root（仓库根）为 base 扫全部文件，再接上 `@source` 各条

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
