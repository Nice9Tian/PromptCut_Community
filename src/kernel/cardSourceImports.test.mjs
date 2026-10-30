/**
 * 卡片源码解析跟着 import 找(`cardSourceParse.mjs`,C10 契约第 9 节「识别」〔裁〕2026-09-30)与 `select` / `asset` 缺字段的推断。跑:
 *   node --test src/kernel/cardSourceImports.test.mjs
 *
 *   CSI-01 同目录相对 import 的对象与数组:控件表、默认值展开进来,和写在同一文件里一样
 *   CSI-02 re-export:`export { a } from`、`export { a as b } from`、`export * from`、`export default`、先 import 再 export
 *   CSI-03 别名:`import { a as b }`、默认导入、`import * as ns` 的 `ns.x`、多级目录与 `index.ts`
 *   CSI-04 循环引用不死循环:互相引的两个文件、自己引自己;认得出的照常用,环上那一个说明是环
 *   CSI-05 引不到的文件照旧提示:内容库里没有、包名、内置模块不认得;`skippedControls` 写明是哪一条
 *   CSI-06 内置模块:用页面自己带着的值(纯数据);登记过的纯函数以字面量为参数调用时求值;函数、非纯数据不认
 *   CSI-07 select 缺字段:缺 options 跳过并说明;options 写成字符串数组、缺 label、`{ 值: 标签 }` 对象时补上;写法认不出跳过
 *   CSI-08 asset 缺字段:缺 kind 时按选项 / 默认值的素材目录地址推断;推断不了跳过并说明;kind 不认识跳过;缺 options 按空表
 *   CSI-09 仓库里的语料:给了文件读取器之后,内置卡里从 `./hud` 引进来的控件认得出了,结果与模块里的逐个相同
 *   CSI-10 在线页面要取哪几份:`resolveSpecifier` / `cardSourceImports` 的候选路径
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { parseCardSource, pureCall, resolveSpecifier, cardSourceImports, controlFix } from "./cardSourceParse.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const U = "src/cards/user/";
/** 假的内容库:键 → 源码 */
const lib = (files) => (k) => files[k] ?? null;
const parse = (files, entry = `${U}card.tsx`, builtins) => parseCardSource(files[entry], { key: entry, files: lib(files), ...(builtins ? { builtins } : {}) });
const card = (body, imports = "") => `${imports}
import type { CardDef } from "../../kernel/types";
export const c: CardDef = {
  id: "x", name: "卡",
  ${body},
  Component: () => null,
};
`;

test("CSI-01 同目录相对 import 的对象与数组", () => {
  const files = {
    [`${U}card.tsx`]: card(`defaults: { ...BASE, size: 10 },
  controls: [...SHARED, { key: "size", label: "字号", type: "number", min: 1 }]`, `import { SHARED, BASE } from "./shared";`),
    [`${U}shared.ts`]: `import type { Control } from "../../kernel/types";
const SIDES = [{ value: "l", label: "左" }, { value: "r", label: "右" }];
export const SHARED: Control[] = [
  { key: "text", label: "文字", type: "text" },
  { key: "side", label: "位置", type: "select", options: SIDES },
];
export const BASE = { text: "hi", side: "l", size: 48 } as const;
`,
  };
  const [c] = parse(files);
  assert.deepEqual(c.defaults, { text: "hi", side: "l", size: 10 });
  assert.deepEqual(c.controls, [
    { key: "text", label: "文字", type: "text" },
    { key: "side", label: "位置", type: "select", options: [{ value: "l", label: "左" }, { value: "r", label: "右" }] },
    { key: "size", label: "字号", type: "number", min: 1 },
  ]);
  assert.equal(c.controlsIncomplete, false);
  assert.deepEqual(c.skippedControls, []);
  // 没给 files:和以前一样认不出,并说明是哪一条
  const [bare] = parseCardSource(files[`${U}card.tsx`]);
  assert.equal(bare.controlsIncomplete, true);
  assert.deepEqual(bare.controls.map((x) => x.key), ["size"]);
  assert.equal(bare.skippedControls.length, 1);
  assert.match(bare.skippedControls[0].reason, /展开的 SHARED 取不到/);
});

test("CSI-02 re-export 的几种写法", () => {
  const files = {
    [`${U}card.tsx`]: card(`defaults: { ...D, ...E },
  controls: [...A, ...B, ...C, F, G]`, `import { A, B, C } from "./barrel"; import D from "./dflt"; import { E, F, G } from "./reexp";`),
    [`${U}barrel.ts`]: `export { A } from "./a";\nexport { A2 as B } from "./a";\nexport * from "./c";\n`,
    [`${U}a.ts`]: `export const A = [{ key: "a", label: "甲", type: "text" }];\nconst A2 = [{ key: "b", label: "乙", type: "color" }];\nexport { A2 };\n`,
    [`${U}c.ts`]: `export const C = [{ key: "c", label: "丙", type: "text" }];\nexport function helper() { return 1; }\n`,
    [`${U}dflt.ts`]: `export default { a: "A", b: "#fff" };\n`,
    [`${U}reexp.ts`]: `import { F0 } from "./f";\nconst E = { c: "C" };\nconst G0 = { key: "g", label: "戊", type: "number", step: 2 };\nexport { E, F0 as F, G0 as G };\n`,
    [`${U}f.ts`]: `const F0 = { key: "f", label: "丁", type: "text" };\nexport { F0 };\nexport default F0;\n`,
  };
  const [c] = parse(files);
  assert.deepEqual(c.controls.map((x) => x.key), ["a", "b", "c", "f", "g"]);
  assert.equal(c.controls[4].step, 2);
  assert.deepEqual(c.defaults, { a: "A", b: "#fff", c: "C" });
  assert.equal(c.controlsIncomplete, false);
  // export default <标识符>
  const files2 = { ...files, [`${U}card.tsx`]: card(`defaults: {}, controls: [X]`, `import X from "./f";`) };
  assert.deepEqual(parse(files2)[0].controls.map((x) => x.key), ["f"]);
});

test("CSI-03 别名、默认导入、命名空间、多级目录与 index.ts", () => {
  const files = {
    [`${U}card.tsx`]: card(`defaults: ns.DEF,
  controls: [...LIST, ns.ONE, deep]`, `import { CONTROLS as LIST } from "./lib/controls";\nimport * as ns from "./lib";\nimport deep from "./lib/deep/index.ts";`),
    [`${U}lib/controls.ts`]: `export const CONTROLS = [{ key: "a", label: "甲", type: "text" }];\n`,
    [`${U}lib/index.ts`]: `export const DEF = { a: "x" };\nexport const ONE = { key: "one", label: "一", type: "color" };\n`,
    [`${U}lib/deep/index.ts`]: `export default { key: "d", label: "深", type: "text" } as const;\n`,
  };
  const [c] = parse(files);
  assert.deepEqual(c.controls.map((x) => x.key), ["a", "one", "d"]);
  assert.deepEqual(c.defaults, { a: "x" });
  assert.equal(c.controlsIncomplete, false);
  // 引进来的字符串常量也能当 id / name / description
  const files2 = { [`${U}card.tsx`]: `import { ID, NAME, DESC } from "./meta";\nexport const c = { id: ID, name: NAME, description: DESC, defaults: {}, controls: [], Component: () => null };\n`,
    [`${U}meta.ts`]: `export const ID = "meta-card";\nexport const NAME = "元";\nexport const DESC = \`说明\`;\n` };
  const [m] = parse(files2);
  assert.deepEqual([m.id, m.name, m.description], ["meta-card", "元", "说明"]);
});

test("CSI-04 循环引用不死循环", () => {
  const files = {
    [`${U}card.tsx`]: card(`defaults: {}, controls: [...P, ...Q, ...S]`, `import { P } from "./p"; import { Q } from "./q"; import { S } from "./self";`),
    [`${U}p.ts`]: `import { Q } from "./q";\nexport const P = [{ key: "p", label: "P", type: "text" }, ...Q];\n`,
    [`${U}q.ts`]: `import { P } from "./p";\nexport const Q = [...P, { key: "q", label: "Q", type: "text" }];\n`,
    [`${U}self.ts`]: `export { S } from "./self";\n`,
  };
  const t0 = Date.now();
  const [c] = parse(files);
  assert.ok(Date.now() - t0 < 2000, "不卡死");
  assert.ok(c.controls.some((x) => x.key === "p"), "认得出的照常用");
  assert.equal(c.controlsIncomplete, true);
  assert.ok(c.skippedControls.some((s) => /循环引用/.test(s.reason)), JSON.stringify(c.skippedControls));
  // 互相 export * 的两个文件找不存在的名字:不死循环
  const files2 = { [`${U}card.tsx`]: card(`defaults: {}, controls: [...Z]`, `import { Z } from "./m1";`),
    [`${U}m1.ts`]: `export * from "./m2";\n`, [`${U}m2.ts`]: `export * from "./m1";\n` };
  const [z] = parse(files2);
  assert.equal(z.controlsIncomplete, true);
  assert.match(z.skippedControls[0].reason, /没有导出 Z/);
});

test("CSI-05 引不到的文件照旧提示,并说明是哪一条", () => {
  const files = {
    [`${U}card.tsx`]: card(`defaults: {}, controls: [{ key: "ok", label: "好", type: "text" }, ...MISSING, ...PKG, ...HUD, OPT]`,
      `import { MISSING } from "./nope";\nimport { PKG } from "some-package";\nimport { HUD } from "../native/nowhere";\nimport { OPT } from "./opt";`),
    [`${U}opt.ts`]: `export const OPT = makeControl("x");\n`,
  };
  const [c] = parse(files);
  assert.deepEqual(c.controls.map((x) => x.key), ["ok"]);
  assert.equal(c.controlsIncomplete, true);
  const reasons = c.skippedControls.map((s) => s.reason);
  assert.equal(reasons.length, 4, JSON.stringify(reasons));
  assert.match(reasons[0], /展开的 MISSING 取不到:内容库里没有 \.\/nope 这个文件/);
  assert.match(reasons[1], /展开的 PKG 取不到:引自 some-package/);
  assert.match(reasons[2], /展开的 HUD 取不到:\.\.\/native\/nowhere 不是在线页面认得的内置模块/);
  assert.match(reasons[3], /OPT 取不到:不是字面量/);
  // 整个控件表是引进来的、又取不到
  const files2 = { [`${U}card.tsx`]: card(`defaults: {}, controls: CTRL`, `import { CTRL } from "./gone";`) };
  const [w] = parse(files2);
  assert.deepEqual(w.controls, []);
  assert.match(w.skippedControls[0].reason, /整个控件表 CTRL 取不到:内容库里没有 \.\/gone/);
  // 简写 `controls,` 也一样
  const files3 = { [`${U}card.tsx`]: `import { controls } from "./gone";\nexport const c = { id: "s", name: "简写", defaults: {}, controls, Component: () => null };\n` };
  assert.match(parse(files3)[0].skippedControls[0].reason, /整个控件表 controls 取不到/);
});

test("CSI-06 内置模块:页面自己带着的值;纯函数以字面量为参数调用", () => {
  const calls = [];
  const builtins = (k) => ({
    "src/cards/native/hud.ts": {
      hudControls: [{ key: "position", label: "位置", type: "select", options: [{ value: "center", label: "居中" }] }],
      hudDefaults: { position: "center", accent: "" },
      notData: new Map(),
      fn: () => 1,
    },
    "src/cards/catalogAssets.ts": { assetOptions: pureCall((kind) => { calls.push(kind); return [{ value: `/catalog/${kind}/a.json`, label: "a" }]; }) },
  })[k] ?? null;
  const files = {
    [`${U}card.tsx`]: card(`defaults: { ...hudDefaults, src: "" },
  controls: [...hudControls, { key: "src", label: "素材", type: "asset", options: assetOptions("lottie") }, ...notData, ...fn]`,
      `import { hudControls, hudDefaults, notData, fn } from "../native/hud";\nimport { assetOptions } from "../catalogAssets";`),
  };
  const [c] = parse(files, undefined, builtins);
  assert.deepEqual(c.defaults, { position: "center", accent: "", src: "" });
  assert.deepEqual(c.controls.map((x) => x.key), ["position", "src"]);
  assert.equal(c.controls[1].kind, "lottie", "kind 从 assetOptions 给的地址推断");
  assert.deepEqual(c.controls[1].options, [{ value: "/catalog/lottie/a.json", label: "a" }]);
  assert.deepEqual(calls, ["lottie"]);
  const reasons = c.skippedControls.map((s) => s.reason);
  assert.match(reasons[0], /notData 不是纯数据/);
  assert.match(reasons[1], /fn 不是纯数据/);
  // 页面里的值被改也不影响内置模块那一份(交出去的是拷贝)
  c.controls[0].options.push({ value: "x", label: "x" });
  assert.equal(builtins("src/cards/native/hud.ts").hudControls[0].options.length, 1);
  // 纯函数的参数不是字面量:不调
  const files2 = { [`${U}card.tsx`]: card(`defaults: {}, controls: [{ key: "src", label: "素材", type: "asset", kind: "lottie", options: assetOptions(KIND) }]`,
    `import { assetOptions } from "../catalogAssets";\nimport { KIND } from "./nope";`) };
  const [c2] = parse(files2, undefined, builtins);
  assert.deepEqual(c2.controls[0].options, [], "选项认不出按空表");
  assert.deepEqual(calls, ["lottie"]);
});

test("CSI-07 select 缺字段的几种写法", () => {
  const src = card(`defaults: {}, controls: [
    { key: "a", label: "缺选项", type: "select" },
    { key: "b", label: "字符串数组", type: "select", options: ["x", "y"] },
    { key: "c", label: "缺 label", type: "select", options: [{ value: "p" }, { value: "q", label: "Q" }] },
    { key: "d", label: "对象", type: "select", options: { l: "左", r: "右" } },
    { key: "e", label: "选项不是字面量", type: "select", options: makeOptions() },
    { key: "f", label: "写法认不出", type: "select", options: [1, 2] },
    { key: "g", label: "空对象", type: "select", options: {} },
    { label: "缺 key", type: "select", options: ["x"] },
  ]`);
  const [c] = parseCardSource(src);
  assert.deepEqual(c.controls, [
    { key: "b", label: "字符串数组", type: "select", options: [{ value: "x", label: "x" }, { value: "y", label: "y" }] },
    { key: "c", label: "缺 label", type: "select", options: [{ value: "p", label: "p" }, { value: "q", label: "Q" }] },
    { key: "d", label: "对象", type: "select", options: [{ value: "l", label: "左" }, { value: "r", label: "右" }] },
  ]);
  assert.equal(c.controlsIncomplete, true);
  assert.deepEqual(c.skippedControls, [
    { key: "a", label: "缺选项", type: "select", reason: "下拉缺选项(options)" },
    { key: "e", label: "选项不是字面量", type: "select", reason: "下拉选项(options)不是字面量" },
    { key: "f", label: "写法认不出", type: "select", reason: "下拉选项(options)的写法认不出" },
    { key: "g", label: "空对象", type: "select", reason: "下拉选项(options)的写法认不出" },
    { label: "缺 key", type: "select", reason: "缺 key" },
  ]);
});

test("CSI-08 asset 缺字段的几种写法", () => {
  const src = card(`defaults: { d: "/catalog/particles/snow.json", m: "/catalog/lottie/a.json" }, controls: [
    { key: "a", label: "按选项推断", type: "asset", options: [{ value: "/catalog/lottie/a.json", label: "a" }, { value: "/catalog/lottie/b.json", label: "b" }] },
    { key: "d", label: "按默认值推断", type: "asset" },
    { key: "m", label: "两种混着", type: "asset", options: [{ value: "/catalog/particles/x.json", label: "x" }] },
    { key: "n", label: "推断不了", type: "asset", options: [{ value: "https://x.io/a.json", label: "a" }] },
    { key: "k", label: "kind 不是字面量", type: "asset", kind: KIND },
    { key: "z", label: "kind 不认识", type: "asset", kind: "video" },
    { key: "o", label: "缺选项", type: "asset", kind: "particles" },
  ]`);
  const [c] = parseCardSource(src);
  assert.deepEqual(c.controls, [
    { key: "a", label: "按选项推断", type: "asset", kind: "lottie", options: [{ value: "/catalog/lottie/a.json", label: "a" }, { value: "/catalog/lottie/b.json", label: "b" }] },
    { key: "d", label: "按默认值推断", type: "asset", kind: "particles", options: [] },
    { key: "o", label: "缺选项", type: "asset", kind: "particles", options: [] },
  ]);
  assert.deepEqual(c.skippedControls.map((s) => [s.key, s.reason]), [
    ["m", "素材控件缺类别(kind),也推断不了是 lottie 还是 particles"],
    ["n", "素材控件缺类别(kind),也推断不了是 lottie 还是 particles"],
    ["k", "素材控件类别(kind)不是字面量,也推断不了是 lottie 还是 particles"],
    ["z", "素材类别(kind)不认识(video)"],
  ]);
  // controlFix 单独用:默认值给推断
  assert.equal(controlFix({ key: "s", label: "s", type: "asset" }, { defaultValue: "/catalog/lottie/q.json" }).control.kind, "lottie");
});

async function withVite(fn) {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { return await fn(server); } finally { await server.close(); }
}
const isCardDef = (c) => !!c && typeof c === "object" && typeof c.id === "string" && typeof c.name === "string" && typeof c.defaults === "object"
  && Array.isArray(c.controls) && (typeof c.Component === "function" || typeof c.card === "function" || typeof c.audio === "function");

test("CSI-09 仓库语料:给了文件读取器,内置卡里从 ./hud 引进来的控件认得出了", async () => withVite(async (server) => {
  const readRepo = (k) => { try { return fs.readFileSync(path.join(ROOT, k), "utf8"); } catch { return null; } };
  const dir = path.join(ROOT, "src/cards/native");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  const stats = { cards: 0, completeBefore: 0, completeAfter: 0, controls: 0, parsedBefore: 0, parsedAfter: 0 };
  for (const f of files) {
    const key = `src/cards/native/${f}`;
    const src = readRepo(key);
    const mod = await server.ssrLoadModule(`/${key}`);
    const before = parseCardSource(src);
    const after = parseCardSource(src, { key, files: readRepo });
    assert.deepEqual(after.map((c) => c.id), before.map((c) => c.id), `${key} 认出的卡不变`);
    for (const g of after) {
      const real = Object.values(mod).find((v) => isCardDef(v) && v.id === g.id);
      const b = before.find((x) => x.id === g.id);
      for (const [k, v] of Object.entries(g.defaults)) assert.deepEqual(v, real.defaults[k], `${key} ${g.id} defaults.${k}`);
      for (const c of g.controls) {
        const rc = real.controls.find((x) => x.key === c.key);
        assert.ok(rc, `${key} ${g.id} 多出来的控件 ${c.key}`);
        for (const [field, v] of Object.entries(c)) {
          if (field === "options" && c.type === "asset" && v.length === 0) continue;
          assert.deepEqual(v, rc[field], `${key} ${g.id} controls.${c.key}.${field}`);
        }
      }
      stats.cards++;
      stats.controls += real.controls.length;
      stats.parsedBefore += b.controls.length;
      stats.parsedAfter += g.controls.length;
      if (!b.controlsIncomplete) stats.completeBefore++;
      if (!g.controlsIncomplete) stats.completeAfter++;
    }
  }
  console.log("CSI-09", JSON.stringify(stats));
  assert.ok(stats.completeAfter > stats.completeBefore, `跟着 import 之后全认出的卡应当变多:${JSON.stringify(stats)}`);
  assert.ok(stats.parsedAfter > stats.parsedBefore, JSON.stringify(stats));
}));

test("CSI-10 候选路径", () => {
  assert.deepEqual(resolveSpecifier(`${U}a.tsx`, "./b"), [`${U}b.ts`, `${U}b.tsx`, `${U}b.mjs`, `${U}b.js`, `${U}b/index.ts`, `${U}b/index.tsx`]);
  assert.deepEqual(resolveSpecifier(`${U}a.tsx`, "../native/hud.ts"), ["src/cards/native/hud.ts", "src/cards/native/hud.tsx", "src/cards/native/hud.mjs", "src/cards/native/hud.js"]);
  assert.deepEqual(resolveSpecifier(`${U}sub/a.ts`, "../x.js")?.[0], `${U}x.js`);
  assert.ok(resolveSpecifier(`${U}sub/a.ts`, "../x.js").includes(`${U}x.ts`), ".js 也试 .ts");
  assert.equal(resolveSpecifier(`${U}a.tsx`, "react"), null);
  assert.equal(resolveSpecifier(`${U}a.tsx`, "./x?raw"), null);
  assert.equal(resolveSpecifier("a.tsx", "../../x"), null);
  const imports = cardSourceImports(`import { a } from "./a"; // import { z } from "./z"
export { b } from "./b"; export * from "../native/hud"; import type { T } from "./types"; const s = "import x from './s'";
import "./side.css";`, `${U}card.tsx`);
  assert.ok(imports.includes(`${U}a.ts`) && imports.includes(`${U}b.tsx`) && imports.includes("src/cards/native/hud.ts") && imports.includes(`${U}types.ts`));
  assert.ok(!imports.some((k) => k.includes("/z.") || k.includes("/s.")), "注释与字符串里的不算");
});
