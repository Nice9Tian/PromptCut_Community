/**
 * 每个脚本至少得能被解析。跑:node --test server/test/syntax.test.mjs
 *
 * # 为什么要有这么低级的一条
 *
 * `tsconfig` 不含 `server/`,所以 `tsc --noEmit` 根本不看那边的 .ts;而 .mjs 谁都不看 ——
 * 它们只在真正被 import 或者被 node 跑起来的那一刻才解析。于是「这个文件语法坏了」这件事
 * 可以一路混过全部检查,直到某天有人跑打包脚本。
 *
 * 实际发生过两次,都是同一个坑:**块注释里写了 `tools/<星号>/target` 这种路径**,
 * 里面的 `<星号>` 加 `/` 就是注释结束符,注释当场关掉,后面整个文件被当代码解析。
 *
 *   - server/vite-plugin-api-guard.ts —— 写的时候撞上,dev server 起不来,当场发现;
 *   - desktop/scripts/prepare-runtime.mjs —— 同一天又撞一次,而且**提交进了 c0a66b8**。
 *     当时验证只抽了文件里的一段函数出来跑,整份文件从没被解析过,所以测试全绿。
 *
 * 这条测试只做一件很笨的事:把每个脚本都解析一遍。笨,但上面那两次它都拦得住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 要看的目录。深度有限,不递归进 node_modules / 产物目录 */
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

test(".mjs 脚本全部能解析", () => {
  const files = collect(".mjs");
  assert.ok(files.length > 15, `只找到 ${files.length} 个 .mjs,目录清单大概写错了`);
  const broken = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    if (r.status !== 0) broken.push(`${rel(f)}\n${(r.stderr || "").split("\n").slice(0, 4).join("\n")}`);
  }
  assert.equal(broken.length, 0, `下面这些解析不了:\n\n${broken.join("\n\n")}`);
});

test("server/ 下的 .ts 全部能解析(tsc --noEmit 不看这个目录)", () => {
  const files = collect(".ts");
  assert.ok(files.length > 8, `只找到 ${files.length} 个 .ts,目录清单大概写错了`);
  const broken = [];
  for (const f of files) {
    const src = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    // parseDiagnostics 不是公开 API,但它是拿到「纯语法错误」最直接的一条路;
    // 真哪天没了,下面这句断言会因为 undefined 而失败,不会假装通过
    const diags = src.parseDiagnostics;
    assert.ok(Array.isArray(diags), `拿不到 ${rel(f)} 的解析诊断,这条测试得换实现了`);
    if (diags.length) {
      const first = diags[0];
      const { line } = src.getLineAndCharacterOfPosition(first.start ?? 0);
      broken.push(`${rel(f)}:${line + 1} ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`);
    }
  }
  assert.equal(broken.length, 0, `下面这些解析不了:\n${broken.join("\n")}`);
});

test("块注释里没有会把自己关掉的路径", () => {
  /*
   * 上面两条抓「已经坏了」,这一条抓「写法危险」—— 注释被提前关掉之后,剩下的内容
   * 有时正好还能凑成合法代码,那样前两条就漏了。
   *
   * 判据不是「这行有没有结束符」—— 一段注释本来就要在某一行结束,而且经常是
   * 「文字…… <星号>/」这样收尾,那是正常的。真正的事故长这样:
   *
   *     * `tools/<星号>/target`、`.cache` —— Rust 编译产物……
   *
   * 结束符**出现在行中间,后面还有内容**。那说明写的人没打算在这里结束注释,
   * 只是路径里的通配符凑巧撞上了结束符。所以只报这一种。
   */
  const files = [...collect(".mjs"), ...collect(".ts")];
  const bad = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("*")) return; // 只看块注释的续行
      const idx = trimmed.indexOf("*/");
      if (idx <= 0) return;
      // 结束符后面还有非空内容 = 作者没想在这儿结束
      if (trimmed.slice(idx + 2).trim() !== "") bad.push(`${rel(f)}:${i + 1}  ${trimmed.slice(0, 80)}`);
    });
  }
  assert.equal(bad.length, 0, `注释里的这些位置会把块注释提前关掉(路径通配请写成 <id> 或加反引号断开):\n${bad.join("\n")}`);
});
