/**
 * 分层的静态检查。跑:node --test src/layering.test.mjs
 *
 * 期望的层序(下层不许 import 上层):
 *
 *   src/kernel(数据模型、纯计算)
 *     ← src/render(舞台渲染、帧管线)
 *       ← src/editor(编辑台界面)/ src/mcp / src/ai
 *
 * 为什么要钉死:在线浏览器模式和本地模式共用同一套渲染代码(docs/semantics/mechanism/platforms.md)。kernel / render 一旦反向
 * 摸到编辑台,浏览器那边就得连整个编辑台一起打包 —— 而这种依赖是悄悄长出来的,
 * 加一行 import 就成立,不报错也不掉帧,只有这里拦得住。
 *
 * 运行时 import 和**类型** import 都算:类型边编译后虽然不留下 import,但它一样
 * 表达「这一层认识上一层的概念」,而且改起来最容易顺手把运行时也拖进来。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** 每一层不许 import 哪些层(目录名,src 的直接子目录) */
const FORBIDDEN = {
  kernel: ["render", "editor", "mcp", "ai", "store", "cards", "parts"],
  render: ["editor", "mcp", "ai"],
  // c10a:在线浏览器模式的判定(`src/online/`)与 render 同层:只引 kernel、render 与同目录(主会话裁定)
  online: ["editor", "mcp", "ai"],
};

/**
 * 明确放过的边。每一条都要写清为什么 —— 这张表只该变短。
 *
 * `src/kernel/clock.ts` 里是 `declare global { interface Window { … } }`:
 * 页面上那些 `window.__pc*` 全局钩子由渲染层安装(solid / stageRpc / frameWindow /
 * createSnapshot),声明却必须集中在一处,不然每个用到 window.__pcSolid 的文件都要
 * 自己 declare 一遍、还会互相冲突。它是**纯类型**的 `import('…')`,编译后一行代码
 * 都不剩;真要拆,得把这些全局的类型也一起搬进 kernel,而那些类型描述的就是渲染
 * 层对象本身,搬下来等于把渲染层的接口抄一份。代价大于收益,先留着。
 */
const ALLOWED = new Set([
  "src/kernel/clock.ts -> src/render/frameWindow.mjs",
  "src/kernel/clock.ts -> src/render/createSnapshot.ts",
  "src/kernel/clock.ts -> src/render/solid.ts",
  "src/kernel/clock.ts -> src/render/stageRpc.ts",
]);

const CODE = /\.(ts|tsx|mts|mjs|js|jsx)$/;

function listSources(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listSources(full, out);
    else if (CODE.test(ent.name)) out.push(full);
  }
  return out;
}

/** 注释里出现的 `import('…')`(说明文字、@deprecated 备注)不是依赖,先剔掉 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 一个文件里所有 import 目标(运行时的和纯类型的都要) */
function importSpecs(raw) {
  const src = stripComments(raw);
  const out = [];
  for (const m of src.matchAll(/\bimport\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/g)) out.push(m[1]);
  // 纯副作用 import "x"
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["'];?\s*$/gm)) out.push(m[1]);
  // 行内的 import('x').Foo(类型位置)和动态 import('x')
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

const EXTS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", ".d.mts", ".d.ts"];

/** 把相对说明符解析成 src 下的绝对路径;解析不到(外部包、非代码资源)返回 null */
function resolve(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [...EXTS.map((e) => base + e)];
  // `./x.mjs` 可能指向 `./x.mts`,`./x.js` 可能指向 `./x.ts` / `./x.tsx`
  if (base.endsWith(".mjs")) cands.push(base.slice(0, -4) + ".mts");
  if (base.endsWith(".js")) cands.push(base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx");
  for (const e of ["index.ts", "index.tsx", "index.mjs", "index.js"]) cands.push(path.join(base, e));
  for (const c of cands) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

const rel = (f) => "src/" + path.relative(SRC, f).replace(/\\/g, "/");
/** 取 src 下的第一级目录名 */
const layerOf = (r) => r.slice("src/".length).split("/")[0];

/** src/** 里所有跨层的反向边,`src/a/b.ts -> src/c/d.ts` 形式 */
function reverseEdges() {
  const found = [];
  for (const file of listSources(SRC)) {
    const from = rel(file);
    const forbidden = FORBIDDEN[layerOf(from)];
    if (!forbidden) continue;
    for (const spec of importSpecs(fs.readFileSync(file, "utf8"))) {
      // 数据文件(审阅表 capabilities.json 之类)是素材不是模块,不算层间依赖
      if (/\.(json|css|svg|png|txt|md)$/.test(spec)) continue;
      const target = resolve(file, spec);
      if (!target) continue;
      const to = rel(target);
      if (forbidden.includes(layerOf(to))) found.push(`${from} -> ${to}`);
    }
  }
  return [...new Set(found)].sort();
}

test("src/kernel 不 import render / editor / mcp / ai / store / cards / parts", () => {
  const offenders = reverseEdges().filter((e) => layerOf(e.split(" -> ")[0]) === "kernel" && !ALLOWED.has(e));
  assert.deepEqual(offenders, [], `kernel 反向依赖上层:\n${offenders.join("\n")}`);
});

test("src/render 不 import editor / mcp / ai", () => {
  const offenders = reverseEdges().filter((e) => layerOf(e.split(" -> ")[0]) === "render" && !ALLOWED.has(e));
  assert.deepEqual(offenders, [], `render 反向依赖上层:\n${offenders.join("\n")}`);
});

test("白名单里的边还在(修好了就把它从 ALLOWED 删掉)", () => {
  const live = new Set(reverseEdges());
  const stale = [...ALLOWED].filter((e) => !live.has(e));
  assert.deepEqual(stale, [], `这些边已经不存在了,白名单该收短:\n${stale.join("\n")}`);
});
