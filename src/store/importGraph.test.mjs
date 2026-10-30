/**
 * src/store 的模块依赖静态检查。跑:node --test src/store/importGraph.test.mjs
 *
 * 这里钉死两条,防的是同一件事 —— 运行时循环依赖带来的初始化顺序错误(TDZ):
 *   - `src/store/actions/*.ts` 不许 import `../project`。project.ts 是把各个 action
 *     对象拼起来的门面,action 反过来 import 它就成了环;现在只在函数体里用所以没炸,
 *     哪天有人在模块顶层用一次就是 TDZ。action 之间要互相调,直接 import 对方的对象。
 *   - `src/store/**` 的运行时 import 图无环(`import type` / `type` 说明符不算,
 *     它们编译后不留下 import)。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STORE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 递归收集 src/store 下的 .ts 源文件(测试自己是 .mjs,不在内) */
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
 * 取出一个文件里所有**运行时**的 import 目标。
 * 跳过 `import type { X } from "..."`,也跳过花括号里每个说明符都写了 `type ` 的那种 ——
 * 这两种编译后不生成 import,构不成运行时的环。
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
  // 纯副作用 import("x")
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["'];?\s*$/gm)) targets.push(m[1]);
  return targets;
}

/** 把相对说明符解析成 src/store 下的绝对文件路径;解析不到(外部模块)返回 null */
function resolve(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + ".ts", path.join(base, "index.ts")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

const files = listSources(STORE_DIR);

test("src/store/actions/* 不 import ../project(否则就是 project ↔ actions 的环)", () => {
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
  assert.deepEqual(offenders, [], `这些 action 文件 import 了 ../project:${offenders.join(", ")}`);
});

test("src/store 的运行时 import 图无环", () => {
  const graph = new Map();
  for (const file of files) {
    const deps = runtimeImports(fs.readFileSync(file, "utf8"))
      .map((spec) => resolve(file, spec))
      .filter((t) => t !== null);
    graph.set(path.resolve(file), deps.map((d) => path.resolve(d)));
  }

  const rel = (f) => path.relative(STORE_DIR, f).replace(/\\/g, "/");
  const state = new Map(); // 0 = 访问中,1 = 已完成
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

  assert.deepEqual(cycles, [], `发现运行时循环依赖:\n${cycles.join("\n")}`);
});
