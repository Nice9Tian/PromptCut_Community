/**
 * 守门:页面(编辑器页与舞台页,入口 `src/main.tsx`)的静态依赖链里不许出现 Node 内置模块(`node:*` 或 `fs`、`crypto` 这类裸名)。
 * 跑:node --test src/pageNodeImports.test.mjs
 *
 * 为什么(M7 探针 P6,主会话裁定):页面引 `server/render-node/*.mjs`(纯浏览器节点的会话、过滤、细任务编排)时,只要链上有一个模块
 * 静态引了 `node:crypto`,**在线构建不会失败**(摇树摇掉、只剩一条警告),但**开发服务器里整页白屏**
 * (`Module "node:crypto" has been externalized for browser compatibility`,`main.tsx` 之后什么都不执行)。
 * 这种依赖加一行 import 就悄悄长出来,只有这里拦得住。
 *
 * 做法:从 `src/main.tsx` 出发,顺着**静态** import / re-export(`import type`、`export type` 不算;`import()` 是按需载入、不跟)
 * 走遍会被载入的仓库内模块(`src/` 与 `server/` 都跟),遇到 Node 内置模块就判红,并给出引用链。包名(`react` 等)不跟。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const ENTRY = path.join(ROOT, "src", "main.tsx");
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");
const EXTS = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx", "/index.mjs", "/index.js"];
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, m.split("/")[0]]));

function resolveFrom(fromAbs, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const clean = spec.split("?")[0];
  const base = clean.startsWith("/") ? path.join(ROOT, clean) : path.resolve(path.dirname(fromAbs), clean);
  for (const e of EXTS) {
    const p = base + e;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 下一个 */ }
  }
  return null;
}

/** 源码里的静态 import / re-export(不含 `import type`、`export type`) */
function staticSpecs(text) {
  const out = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  for (const m of code.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s+(type\s+)?(?:[\w*${}\s,]*?\s+from\s+)?["']([^"']+)["']/g)) {
    if (!m[1]) out.push(m[2]);
  }
  return out;
}

const isNodeBuiltin = (spec) => spec.startsWith("node:") || BUILTIN.has(spec) || BUILTIN.has(spec.split("/")[0]) && !spec.includes(".");

test("页面的静态依赖链里没有 Node 内置模块(否则开发服务器整页白屏)", () => {
  assert.ok(fs.existsSync(ENTRY), "入口 src/main.tsx 在");
  const parent = new Map([[ENTRY, null]]);
  const queue = [ENTRY];
  const bad = [];
  let visited = 0;
  let serverModules = 0;
  while (queue.length) {
    const file = queue.shift();
    visited++;
    if (rel(file).startsWith("server/")) serverModules++;
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const spec of staticSpecs(text)) {
      if (isNodeBuiltin(spec)) {
        const chain = [];
        for (let f = file; f; f = parent.get(f)) chain.unshift(rel(f));
        bad.push(`${spec} ← ${chain.join(" → ")}`);
        continue;
      }
      const next = resolveFrom(file, spec);
      if (!next || parent.has(next) || /\.(css|json|svg|png|woff2?)$/.test(next)) continue;
      parent.set(next, file);
      queue.push(next);
    }
  }
  assert.ok(visited > 100, `走到了页面的模块:${visited}`);
  assert.ok(serverModules > 0, "页面确实引了 server/ 下的模块(纯浏览器节点、会话层),守门才有意义");
  assert.deepEqual(bad, [], `页面的静态依赖链里出现了 Node 内置模块:\n${bad.join("\n")}`);
});
