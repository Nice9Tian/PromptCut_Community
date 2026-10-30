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

test("Tailwind 扫描到的 src/、server/ 文件只有代码与样式", () => {
  const bad = scanned
    .filter((f) => GUARDED.some((d) => f.startsWith(d)))
    .filter((f) => !CODE_OR_STYLE.has(path.extname(f).toLowerCase()))
    .sort();
  assert.deepEqual(
    bad,
    [],
    [
      `Tailwind 会扫描下面 ${bad.length} 个非代码文件，开发服务里改它们会让所有打开的页面静默整页重载：`,
      ...bad.map((f) => `  ${f}`),
      "处理（二选一）：",
      "  1. 挪走：放到 src/、server/ 以外（文档进 docs/，测试夹具进 server/test/，运行时产物进被 git 忽略的 out/ 或 data/）；",
      '  2. 排除：在 src/index.css 的排除表里加一行 @source not "../<路径或 glob>";（路径相对于 src/index.css）。',
      "  不要为此排除 src/、server/ 下的 .ts/.tsx/.mjs 等源码：界面类名在里面（见本文件下一条检查）。",
    ].join("\n"),
  );
});

test("界面类名所在的源码仍在扫描里（排除表没有排过头）", () => {
  const set = new Set(scanned);
  assert.ok(set.has("index.html"), "index.html 不在扫描里");
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "src", "server"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((f) => f.endsWith(".tsx") && !f.startsWith("server/test/"));
  assert.ok(tracked.some((f) => f.startsWith("server/catalog/magicui/")), "没找到 server/catalog/magicui 下的卡片源码，检查本测试的前提");
  const missing = tracked.filter((f) => !set.has(f));
  assert.deepEqual(missing, [], `这些 .tsx 被 src/index.css 的 @source not 排除了，里面的 Tailwind 类名不会生成样式：\n${missing.join("\n")}`);
});
