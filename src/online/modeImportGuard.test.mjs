/**
 * 守门:Node 单测会载入的模块不许静态引用 `src/online/mode.ts`(C10a 集成,主会话 2026-09-27 的约束)。
 * 跑:node --test src/online/modeImportGuard.test.mjs
 *
 * `mode.ts` 的内容按 C10a 契约第 2 节逐字节固定:`import.meta.env.VITE_PC_ONLINE === "1"`。Node 里没有 `import.meta.env`,
 * 谁在 Node 里载到它就当场抛 TypeError(c10a 实现中途踩过:`C65B-V7-01` 载 `io/index.ts` 挂了)。所以:
 *   - 会被单测载入的模块要用 `ONLINE` 的,按需 `await import(".../online/mode")`,或由调用方把 `online` 传进来;
 *   - 单测自己要载一个静态引了 `mode.ts` 的模块,就先 `mock.module(srcUrl("online/mode.ts"), …)` 换成桩。
 *
 * 做法:从每个单测文件出发,顺着**静态** import(`import type` 不算,`await import()` 是按需载入、不跟)
 * 走遍会被载入的 `src/` 模块;测试里写了 `mock.module(srcUrl("X"))` 的模块 X 换成了桩,不往下走。
 * 走到 `src/online/mode.ts` 而这个单测没有换掉它,就判红,并给出引用链。
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
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // 包名:不管
  const base = spec.startsWith("/") ? path.join(ROOT, spec) : path.resolve(path.dirname(fromAbs), spec);
  for (const e of EXTS) {
    const p = base + e;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 下一个 */ }
  }
  return null;
}

/** 源码里的静态 import / re-export(不含 `import type`、`export type`) */
function staticSpecs(text) {
  const out = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  for (const m of code.matchAll(/(?:^|[;\n])\s*(?:import|export)\s+(type\s+)?(?:[\w*${}\s,]*?\s+from\s+)?["']([^"']+)["']/g)) {
    if (!m[1]) out.push(m[2]);
  }
  return out;
}

/** 单测文件指向 `src/` 的入口:静态 import、字面量的 `import("…")`、`srcUrl("…")`、`repoUrl('src/…')`、`new URL('…', import.meta.url)` */
function testEntries(fileAbs, text) {
  const entries = [];
  const add = (abs) => { if (abs) entries.push(abs); };
  for (const s of staticSpecs(text)) add(resolveFrom(fileAbs, s));
  for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) add(resolveFrom(fileAbs, m[1]));
  for (const m of text.matchAll(/srcUrl\(\s*["']([^"']+)["']\s*\)/g)) add(resolveFrom(path.join(ROOT, "src", "x"), `./${m[1]}`));
  for (const m of text.matchAll(/repoUrl\(\s*["'](src\/[^"']+)["']\s*\)/g)) add(resolveFrom(path.join(ROOT, "x"), `./${m[1]}`));
  // new URL(…) 只在直接交给 import() 时算(读文件文本用的 readFileSync(new URL(…)) 不算)
  for (const m of text.matchAll(/import\(\s*new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) add(resolveFrom(fileAbs, m[1]));
  return entries;
}

/** 单测里换成桩的 `src/` 模块 */
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
  // A3 之后闭源的那几摊在 cloud/ 下（公开仓库里没有这个目录）；这道检查原来就管着它们，搬走以后也要接着管
  ...(fs.existsSync(path.join(ROOT, "cloud", "src")) ? walk(path.join(ROOT, "cloud", "src")).filter((f) => f.endsWith(".test.mjs")) : []),
  ...(fs.existsSync(path.join(ROOT, "cloud", "server", "test")) ? fs.readdirSync(path.join(ROOT, "cloud", "server", "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => path.join(ROOT, "cloud", "server", "test", f)) : []),
];

const textCache = new Map();
const read = (abs) => { if (!textCache.has(abs)) textCache.set(abs, fs.readFileSync(abs, "utf8")); return textCache.get(abs); };

/** 从入口顺着静态 import 走;回「到 mode.ts 的引用链」或 null */
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
    // 入口之后一律只跟静态 import:源码里的 await import() 是按需载入;测试辅助件(server/test/*-kit.mjs 等)函数里的
    // import() 只在用例调到时才载,调它的用例自己负责换桩(c10a-kit.mjs 的 pickDecider 就是这样)
    const next = staticSpecs(text).map((s) => resolveFrom(cur, s));
    for (const n of next) if (n && !prev.has(n)) { prev.set(n, cur); queue.push(n); }
  }
  return null;
}

test("C10A-MODE-01 Node 单测载入的模块不静态引用 src/online/mode.ts(要么按需载入,要么单测先换成桩)", () => {
  assert.ok(testFiles.length > 100, `找到的单测文件太少:${testFiles.length}`);
  const bad = [];
  for (const f of testFiles) {
    const text = read(f);
    const mocked = mockedIn(text);
    if (mocked.has(MODE)) continue;
    const chain = chainToMode(testEntries(f, text), mocked);
    if (chain) bad.push(`${rel(f)}:${chain.join(" → ")}`);
  }
  assert.deepEqual(bad, [], `这些单测会在 Node 里载到 mode.ts(import.meta.env 不存在,当场抛错):\n${bad.join("\n")}`);
});

test("C10A-MODE-02 守门自己管用:静态引了 mode.ts 的模块能被认出来", () => {
  const importers = walk(path.join(ROOT, "src"))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts"))
    .filter((f) => staticSpecs(read(f)).some((s) => rel(resolveFrom(f, s) ?? "") === MODE));
  assert.ok(importers.length >= 3, `静态引 mode.ts 的模块应当认得出来,实际 ${importers.map(rel).join(", ")}`);
  // 一个假单测:直接载 Preview.tsx(它静态引了 mode.ts),没换桩 → 该判红
  const fake = path.join(ROOT, "src", "editor", "fake.test.mjs");
  const chain = chainToMode(testEntries(fake, 'const P = await import("./Preview.tsx");'), new Set());
  assert.ok(chain && chain.at(-1) === MODE, `假单测应当走到 mode.ts:${JSON.stringify(chain)}`);
  // 换了桩就不算
  assert.equal(chainToMode(testEntries(fake, 'await import(srcUrl("online/mode.ts"))'), new Set([MODE])), null);
});
