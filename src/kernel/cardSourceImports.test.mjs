/**
 * Card source parsing following imports (`cardSourceParse.mjs`, C10 contract Section 9
 * "Recognition" [ruling 2026-09-30]) and inference for missing fields in `select` / `asset`. Run:
 *   node --test src/kernel/cardSourceImports.test.mjs
 *
 *   CSI-01 Objects and arrays from same-directory relative imports: control tables and default
 *   values spread in, just like writing in the same file
 *   CSI-02 re-export: `export { a } from`, `export { a as b } from`, `export * from`,
 *   `export default`, import then export
 *   CSI-03 Aliases: `import { a as b }`, default import, `ns.x` of `import * as ns`,
 *   multi-level directories and `index.ts`
 *   CSI-04 Circular references do not infinite loop: two mutually importing files, self-import;
 *   recognized ones used as usual, cycle member states it is a cycle
 *   CSI-05 Unresolvable files prompt as before: missing from content store, package names,
 *   unrecognized built-in modules; `skippedControls` specifies which one
 *   CSI-06 Built-in modules: use values carried by page itself (pure data); registered pure
 *   functions evaluated when called with literals; functions and non-pure data ignored
 *   CSI-07 select missing fields: skip and explain if options missing; fill when options is
 *   string array, missing label, or `{ value: label }` object; skip unrecognized syntax
 *   CSI-08 asset missing fields: when kind missing, infer from options / default value asset
 *   catalog path; skip and explain if unable to infer; skip unrecognized kind; missing options
 *   treated as empty table
 *   CSI-09 Corpus in repository: with file reader provided, controls imported from `./hud` in
 *   built-in cards are recognized, results match module one by one
 *   CSI-10 Which files online page needs to fetch: candidate paths for `resolveSpecifier` /
 *   `cardSourceImports`
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
/** Fake content store: key → source code */
const lib = (files) => (k) => files[k] ?? null;
const parse = (files, entry = `${U}card.tsx`, builtins) => parseCardSource(files[entry], { key: entry, files: lib(files), ...(builtins ? { builtins } : {}) });
const card = (body, imports = "") => `${imports}
import type { CardDef } from "../../kernel/types";
export const c: CardDef = {
  id: "x", name: "Card",
  ${body},
  Component: () => null,
};
`;

test("CSI-01 Objects and arrays from same-directory relative imports", () => {
  const files = {
    [`${U}card.tsx`]: card(`defaults: { ...BASE, size: 10 },
  controls: [...SHARED, { key: "size", label: "Font size", type: "number", min: 1 }]`, `import { SHARED, BASE } from "./shared";`),
    [`${U}shared.ts`]: `import type { Control } from "../../kernel/types";
const SIDES = [{ value: "l", label: "Left" }, { value: "r", label: "Right" }];
export const SHARED: Control[] = [
  { key: "text", label: "Text", type: "text" },
  { key: "side", label: "Position", type: "select", options: SIDES },
];
export const BASE = { text: "hi", side: "l", size: 48 } as const;
`,
  };
  const [c] = parse(files);
  assert.deepEqual(c.defaults, { text: "hi", side: "l", size: 10 });
  assert.deepEqual(c.controls, [
    { key: "text", label: "Text", type: "text" },
    { key: "side", label: "Position", type: "select", options: [{ value: "l", label: "Left" }, { value: "r", label: "Right" }] },
    { key: "size", label: "Font size", type: "number", min: 1 },
  ]);
  assert.equal(c.controlsIncomplete, false);
  assert.deepEqual(c.skippedControls, []);
  // files not provided: unrecognized as before, and explains which one
  const [bare] = parseCardSource(files[`${U}card.tsx`]);
  assert.equal(bare.controlsIncomplete, true);
  assert.deepEqual(bare.controls.map((x) => x.key), ["size"]);
  assert.equal(bare.skippedControls.length, 1);
  assert.match(bare.skippedControls[0].reason, /spread SHARED could not be resolved/);
});

test("CSI-02 Several ways of writing re-exports", () => {
  const files = {
    [`${U}card.tsx`]: card(`defaults: { ...D, ...E },
  controls: [...A, ...B, ...C, F, G]`, `import { A, B, C } from "./barrel"; import D from "./dflt"; import { E, F, G } from "./reexp";`),
    [`${U}barrel.ts`]: `export { A } from "./a";\nexport { A2 as B } from "./a";\nexport * from "./c";\n`,
    [`${U}a.ts`]: `export const A = [{ key: "a", label: "A", type: "text" }];
const A2 = [{ key: "b", label: "B", type: "color" }];
export { A2 };
`,
    [`${U}c.ts`]: `export const C = [{ key: "c", label: "C", type: "text" }];
export function helper() { return 1; }
`,
    [`${U}dflt.ts`]: `export default { a: "A", b: "#fff" };\n`,
    [`${U}reexp.ts`]: `import { F0 } from "./f";
const E = { c: "C" };
const G0 = { key: "g", label: "E", type: "number", step: 2 };
export { E, F0 as F, G0 as G };
`,
    [`${U}f.ts`]: `const F0 = { key: "f", label: "D", type: "text" };
export { F0 };
export default F0;
`,
  };
  const [c] = parse(files);
  assert.deepEqual(c.controls.map((x) => x.key), ["a", "b", "c", "f", "g"]);
  assert.equal(c.controls[4].step, 2);
  assert.deepEqual(c.defaults, { a: "A", b: "#fff", c: "C" });
  assert.equal(c.controlsIncomplete, false);
  // export default <identifier>
  const files2 = { ...files, [`${U}card.tsx`]: card(`defaults: {}, controls: [X]`, `import X from "./f";`) };
  assert.deepEqual(parse(files2)[0].controls.map((x) => x.key), ["f"]);
});

test("CSI-03 Aliases, default imports, namespaces, nested directories and index.ts", () => {
  const files = {
    [`${U}card.tsx`]: card(`defaults: ns.DEF,
  controls: [...LIST, ns.ONE, deep]`, `import { CONTROLS as LIST } from "./lib/controls";\nimport * as ns from "./lib";\nimport deep from "./lib/deep/index.ts";`),
    [`${U}lib/controls.ts`]: `export const CONTROLS = [{ key: "a", label: "A", type: "text" }];
`,
    [`${U}lib/index.ts`]: `export const DEF = { a: "x" };
export const ONE = { key: "one", label: "One", type: "color" };
`,
    [`${U}lib/deep/index.ts`]: `export default { key: "d", label: "Deep", type: "text" } as const;
`,
  };
  const [c] = parse(files);
  assert.deepEqual(c.controls.map((x) => x.key), ["a", "one", "d"]);
  assert.deepEqual(c.defaults, { a: "x" });
  assert.equal(c.controlsIncomplete, false);
  // Imported string constants can also serve as id / name / description
  const files2 = { [`${U}card.tsx`]: `import { ID, NAME, DESC } from "./meta";\nexport const c = { id: ID, name: NAME, description: DESC, defaults: {}, controls: [], Component: () => null };\n`,
    [`${U}meta.ts`]: `export const ID = "meta-card";
export const NAME = "Meta";
export const DESC = \`Description\`;
` };
  const [m] = parse(files2);
  assert.deepEqual([m.id, m.name, m.description], ["meta-card", "Meta", "Description"]);
});

test("CSI-04 Circular references do not loop forever", () => {
  const files = {
    [`${U}card.tsx`]: card(`defaults: {}, controls: [...P, ...Q, ...S]`, `import { P } from "./p"; import { Q } from "./q"; import { S } from "./self";`),
    [`${U}p.ts`]: `import { Q } from "./q";\nexport const P = [{ key: "p", label: "P", type: "text" }, ...Q];\n`,
    [`${U}q.ts`]: `import { P } from "./p";\nexport const Q = [...P, { key: "q", label: "Q", type: "text" }];\n`,
    [`${U}self.ts`]: `export { S } from "./self";\n`,
  };
  const t0 = Date.now();
  const [c] = parse(files);
  assert.ok(Date.now() - t0 < 2000, "Does not hang");
  assert.ok(c.controls.some((x) => x.key === "p"), "Recognized ones are used as usual");
  assert.equal(c.controlsIncomplete, true);
  assert.ok(c.skippedControls.some((s) => /circular reference/.test(s.reason)), JSON.stringify(c.skippedControls));
  // Looking up non-existent name across two mutually export * files: no infinite loop
  const files2 = { [`${U}card.tsx`]: card(`defaults: {}, controls: [...Z]`, `import { Z } from "./m1";`),
    [`${U}m1.ts`]: `export * from "./m2";\n`, [`${U}m2.ts`]: `export * from "./m1";\n` };
  const [z] = parse(files2);
  assert.equal(z.controlsIncomplete, true);
  assert.match(z.skippedControls[0].reason, /does not export Z/);
});

test("CSI-05 Files that cannot be reached still produce a notice that says which entry it is", () => {
  const files = {
    [`${U}card.tsx`]: card(`defaults: {}, controls: [{ key: "ok", label: "OK", type: "text" }, ...MISSING, ...PKG, ...HUD, OPT]`,
      `import { MISSING } from "./nope";\nimport { PKG } from "some-package";\nimport { HUD } from "../native/nowhere";\nimport { OPT } from "./opt";`),
    [`${U}opt.ts`]: `export const OPT = makeControl("x");\n`,
  };
  const [c] = parse(files);
  assert.deepEqual(c.controls.map((x) => x.key), ["ok"]);
  assert.equal(c.controlsIncomplete, true);
  const reasons = c.skippedControls.map((s) => s.reason);
  assert.equal(reasons.length, 4, JSON.stringify(reasons));
  assert.match(reasons[0], /spread MISSING could not be resolved: the content store has no file \.\/nope/);
  assert.match(reasons[1], /spread PKG could not be resolved: imported from some-package/);
  assert.match(reasons[2], /spread HUD could not be resolved: \.\.\/native\/nowhere is not a built-in module the online page recognizes/);
  assert.match(reasons[3], /OPT could not be resolved: not a literal/);
  // Entire control table is imported and cannot be fetched
  const files2 = { [`${U}card.tsx`]: card(`defaults: {}, controls: CTRL`, `import { CTRL } from "./gone";`) };
  const [w] = parse(files2);
  assert.deepEqual(w.controls, []);
  assert.match(w.skippedControls[0].reason, /the whole controls table CTRL could not be resolved: the content store has no file \.\/gone/);
  // Shorthand `controls,` is also the same
  const files3 = { [`${U}card.tsx`]: `import { controls } from "./gone";
export const c = { id: "s", name: "Shorthand", defaults: {}, controls, Component: () => null };
` };
  assert.match(parse(files3)[0].skippedControls[0].reason, /the whole controls table controls could not be resolved/);
});

test("CSI-06 Built-in modules: values the page itself carries; pure functions called with literal arguments", () => {
  const calls = [];
  const builtins = (k) => ({
    "src/cards/native/hud.ts": {
      hudControls: [{ key: "position", label: "Position", type: "select", options: [{ value: "center", label: "Center" }] }],
      hudDefaults: { position: "center", accent: "" },
      notData: new Map(),
      fn: () => 1,
    },
    "src/cards/catalogAssets.ts": { assetOptions: pureCall((kind) => { calls.push(kind); return [{ value: `/catalog/${kind}/a.json`, label: "a" }]; }) },
  })[k] ?? null;
  const files = {
    [`${U}card.tsx`]: card(`defaults: { ...hudDefaults, src: "" },
  controls: [...hudControls, { key: "src", label: "Media", type: "asset", options: assetOptions("lottie") }, ...notData, ...fn]`,
      `import { hudControls, hudDefaults, notData, fn } from "../native/hud";\nimport { assetOptions } from "../catalogAssets";`),
  };
  const [c] = parse(files, undefined, builtins);
  assert.deepEqual(c.defaults, { position: "center", accent: "", src: "" });
  assert.deepEqual(c.controls.map((x) => x.key), ["position", "src"]);
  assert.equal(c.controls[1].kind, "lottie", "kind is inferred from the URLs that assetOptions provides");
  assert.deepEqual(c.controls[1].options, [{ value: "/catalog/lottie/a.json", label: "a" }]);
  assert.deepEqual(calls, ["lottie"]);
  const reasons = c.skippedControls.map((s) => s.reason);
  assert.match(reasons[0], /notData of built-in module \.\.\/native\/hud is not plain data/);
  assert.match(reasons[1], /fn of built-in module \.\.\/native\/hud is not plain data/);
  // Modifying values in page does not affect built-in module copy (handed out as copy)
  c.controls[0].options.push({ value: "x", label: "x" });
  assert.equal(builtins("src/cards/native/hud.ts").hudControls[0].options.length, 1);
  // Pure function arguments are not literals: do not call
  const files2 = { [`${U}card.tsx`]: card(`defaults: {}, controls: [{ key: "src", label: "Media", type: "asset", kind: "lottie", options: assetOptions(KIND) }]`,
    `import { assetOptions } from "../catalogAssets";\nimport { KIND } from "./nope";`) };
  const [c2] = parse(files2, undefined, builtins);
  assert.deepEqual(c2.controls[0].options, [], "Unrecognized options fall back to an empty list");
  assert.deepEqual(calls, ["lottie"]);
});

test("CSI-07 Several ways a select can be missing fields", () => {
  const src = card(`defaults: {}, controls: [
    { key: "a", label: "Missing options", type: "select" },
    { key: "b", label: "String array", type: "select", options: ["x", "y"] },
    { key: "c", label: "Missing label", type: "select", options: [{ value: "p" }, { value: "q", label: "Q" }] },
    { key: "d", label: "Object", type: "select", options: { l: "Left", r: "Right" } },
    { key: "e", label: "Options not a literal", type: "select", options: makeOptions() },
    { key: "f", label: "Notation not recognized", type: "select", options: [1, 2] },
    { key: "g", label: "Empty object", type: "select", options: {} },
    { label: "Missing key", type: "select", options: ["x"] },
  ]`);
  const [c] = parseCardSource(src);
  assert.deepEqual(c.controls, [
    { key: "b", label: "String array", type: "select", options: [{ value: "x", label: "x" }, { value: "y", label: "y" }] },
    { key: "c", label: "Missing label", type: "select", options: [{ value: "p", label: "p" }, { value: "q", label: "Q" }] },
    { key: "d", label: "Object", type: "select", options: [{ value: "l", label: "Left" }, { value: "r", label: "Right" }] },
  ]);
  assert.equal(c.controlsIncomplete, true);
  assert.deepEqual(c.skippedControls, [
    { key: "a", label: "Missing options", type: "select", reason: "dropdown: missing options (options)" },
    { key: "e", label: "Options not a literal", type: "select", reason: "dropdown: options (options) is not a literal" },
    { key: "f", label: "Notation not recognized", type: "select", reason: "Can't recognize how the dropdown options (options) are written" },
    { key: "g", label: "Empty object", type: "select", reason: "Can't recognize how the dropdown options (options) are written" },
    { label: "Missing key", type: "select", reason: "missing key" },
  ]);
});

test("CSI-08 Several ways an asset can be missing fields", () => {
  const src = card(`defaults: { d: "/catalog/particles/snow.json", m: "/catalog/lottie/a.json" }, controls: [
    { key: "a", label: "Inferred from options", type: "asset", options: [{ value: "/catalog/lottie/a.json", label: "a" }, { value: "/catalog/lottie/b.json", label: "b" }] },
    { key: "d", label: "Inferred from default value", type: "asset" },
    { key: "m", label: "Both kinds mixed", type: "asset", options: [{ value: "/catalog/particles/x.json", label: "x" }] },
    { key: "n", label: "Cannot be inferred", type: "asset", options: [{ value: "https://x.io/a.json", label: "a" }] },
    { key: "k", label: "kind is not a literal", type: "asset", kind: KIND },
    { key: "z", label: "Unknown kind", type: "asset", kind: "video" },
    { key: "o", label: "Missing options", type: "asset", kind: "particles" },
  ]`);
  const [c] = parseCardSource(src);
  assert.deepEqual(c.controls, [
    { key: "a", label: "Inferred from options", type: "asset", kind: "lottie", options: [{ value: "/catalog/lottie/a.json", label: "a" }, { value: "/catalog/lottie/b.json", label: "b" }] },
    { key: "d", label: "Inferred from default value", type: "asset", kind: "particles", options: [] },
    { key: "o", label: "Missing options", type: "asset", kind: "particles", options: [] },
  ]);
  assert.deepEqual(c.skippedControls.map((s) => [s.key, s.reason]), [
    ["m", "media control: missing kind (kind); also cannot infer whether it is lottie or particles"],
    ["n", "media control: missing kind (kind); also cannot infer whether it is lottie or particles"],
    ["k", "media control: kind (kind) is not a literal; also cannot infer whether it is lottie or particles"],
    ["z", "unknown media kind (kind) (video)"],
  ]);
  // controlFix used standalone: default value provides inference
  assert.equal(controlFix({ key: "s", label: "s", type: "asset" }, { defaultValue: "/catalog/lottie/q.json" }).control.kind, "lottie");
});

async function withVite(fn) {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { return await fn(server); } finally { await server.close(); }
}
const isCardDef = (c) => !!c && typeof c === "object" && typeof c.id === "string" && typeof c.name === "string" && typeof c.defaults === "object"
  && Array.isArray(c.controls) && (typeof c.Component === "function" || typeof c.card === "function" || typeof c.audio === "function");

test("CSI-09 Repository corpus: given a file reader, controls imported from ./hud in built-in cards are now recognized", async () => withVite(async (server) => {
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
    assert.deepEqual(after.map((c) => c.id), before.map((c) => c.id), `Cards recognized in ${key} are unchanged`);
    for (const g of after) {
      const real = Object.values(mod).find((v) => isCardDef(v) && v.id === g.id);
      const b = before.find((x) => x.id === g.id);
      for (const [k, v] of Object.entries(g.defaults)) assert.deepEqual(v, real.defaults[k], `${key} ${g.id} defaults.${k}`);
      for (const c of g.controls) {
        const rc = real.controls.find((x) => x.key === c.key);
        assert.ok(rc, `${key} ${g.id} has an extra control ${c.key}`);
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
  assert.ok(stats.completeAfter > stats.completeBefore, `Fully recognized cards should increase after following imports: ${JSON.stringify(stats)}`);
  assert.ok(stats.parsedAfter > stats.parsedBefore, JSON.stringify(stats));
}));

test("CSI-10 Candidate paths", () => {
  assert.deepEqual(resolveSpecifier(`${U}a.tsx`, "./b"), [`${U}b.ts`, `${U}b.tsx`, `${U}b.mjs`, `${U}b.js`, `${U}b/index.ts`, `${U}b/index.tsx`]);
  assert.deepEqual(resolveSpecifier(`${U}a.tsx`, "../native/hud.ts"), ["src/cards/native/hud.ts", "src/cards/native/hud.tsx", "src/cards/native/hud.mjs", "src/cards/native/hud.js"]);
  assert.deepEqual(resolveSpecifier(`${U}sub/a.ts`, "../x.js")?.[0], `${U}x.js`);
  assert.ok(resolveSpecifier(`${U}sub/a.ts`, "../x.js").includes(`${U}x.ts`), ".js also tries .ts");
  assert.equal(resolveSpecifier(`${U}a.tsx`, "react"), null);
  assert.equal(resolveSpecifier(`${U}a.tsx`, "./x?raw"), null);
  assert.equal(resolveSpecifier("a.tsx", "../../x"), null);
  const imports = cardSourceImports(`import { a } from "./a"; // import { z } from "./z"
export { b } from "./b"; export * from "../native/hud"; import type { T } from "./types"; const s = "import x from './s'";
import "./side.css";`, `${U}card.tsx`);
  assert.ok(imports.includes(`${U}a.ts`) && imports.includes(`${U}b.tsx`) && imports.includes("src/cards/native/hud.ts") && imports.includes(`${U}types.ts`));
  assert.ok(!imports.some((k) => k.includes("/z.") || k.includes("/s.")), "Those in comments and strings do not count");
});
