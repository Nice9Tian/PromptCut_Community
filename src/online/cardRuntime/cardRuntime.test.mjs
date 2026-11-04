/**
 * Online browser execution of user cards and media effect cards: transpilation integration
 * (`docs/plan/online-card-exec-contract.md` sections 1, 2, 5, 8).
 * Run: node --experimental-test-module-mocks --test src/online/cardRuntime/cardRuntime.test.mjs
 *
 *   OCE-T-01 Syntax preflight: recognizes each of the six unsupported syntax forms;
 *     occurrences of these words in comments, strings, JSX text, or types do not count
 *   OCE-T-02 Transpile a single file: TSX → CommonJS (automatic JSX runtime), extract require
 *     specifiers; return status on syntax errors or oversized files
 *   OCE-T-03 Import resolution: package allowlist, synced source, page built-in modules, styles;
 *     out-of-scope, aliases, queries, and assets are not supported
 *   OCE-T-04 Bundle a card: collect closure following relative imports; return status and
 *     identify which one on missing files or unsupported modules; generation signature changes
 *     with hash; use cache
 *   OCE-T-05 Loader: execute, collect card definitions, components render with page React;
 *     relative imports, cycles, style callbacks
 *   OCE-T-06 Loader failure states: module not in page, top-level throws, runtime syntax errors,
 *     missing card definition, runtime version mismatch
 *   OCE-T-07 Generation switch: unchanged packages are not re-executed; when changed, re-execute
 *     the entire card; tear down old generation on new failure; tear down cards not in this
 *     group; clear
 *   OCE-T-08 Run state: spread loader results to cards; precedence of ten states on editor page;
 *     panel description for each state
 *   OCE-T-09 Tailwind supplementary generation: extract candidate classes; generate utility
 *     classes and used theme variables, without base layer; compile each card independently
 *   OCE-T-10 Code identity: page algorithm and desktop `cardCodeIdentity` compute the same value
 *     for every card in repository; content store hash uses same algorithm as dynamic hash
 *   OCE-T-11 Transpilation cache: by "runtime version + key + hash"; cache miss on runtime
 *     version change; failure results are also cached
 *   OCE-T-12 Registry: runtime-loaded cards retrieved by `getCard`, omitted from `allCards`, and
 *     build-time card wins on id collision; validation of run states
 *   OCE-T-13 Prerequisites for execution: do not execute by default; site master switch is off
 *     only on explicit false; execute only after isolation is ready
 *   OCE-T-14 Transpilation in card source sync: do not transpile or fetch styles when execution
 *     is disabled (verbatim identical to before); transpile and fetch styles when enabled; skip if
 *     inputs unchanged; clear if disabled again
 *   OCE-T-15 All existing card and part files in repository can be transpiled, every import
 *     resolves (packages or page built-in modules)
 *   OCE-T-16 Gatekeeper: editor page and export page source do not import loader, stage wiring,
 *     or page module table; package names in page module table match allowlist; shape of runtime
 *     version
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const require = createRequire(import.meta.url);

const P = await import(srcUrl("online/cardRuntime/precheck.ts"));
const T = await import(srcUrl("online/cardRuntime/transpile.ts"));
const RS = await import(srcUrl("online/cardRuntime/resolve.ts"));
const L = await import(srcUrl("online/cardRuntime/loader.ts"));
const TW = await import(srcUrl("online/cardRuntime/tailwind.ts"));
const TC = await import(srcUrl("online/cardRuntime/transpileCache.ts"));
const CI = await import(srcUrl("online/cardRuntime/codeIdentity.ts"));
const G = await import(srcUrl("online/cardRuntime/gate.ts"));
const V = await import(srcUrl("online/cardRuntime/version.ts"));
const PR = await import(srcUrl("online/cardRuntime/protocol.ts"));
const R = await import(srcUrl("kernel/registry.ts"));
const ERS = await import(srcUrl("editor/sync/cardRunStates.ts"));
const S = await import(srcUrl("editor/sync/onlineCardSources.ts"));
const SHARED = await import(srcUrl("render/cardCodeIdentity.mjs"));

const RUNTIME = "ocr1:sucrase@test:tailwindcss@test";
const sha256 = async (text) => createHash("sha256").update(text, "utf8").digest("hex");
const hashOf = (body) => createHash("sha256").update(JSON.stringify(body.replace(/\r\n/g, "\n")), "utf8").digest("hex");
/** A set of "files in the content store" */
const lib = (files) => {
  const m = new Map(Object.entries(files).map(([k, body]) => [k, { body, hash: hashOf(body) }]));
  return { read: (k) => m.get(k) ?? null, set: (k, body) => m.set(k, { body, hash: hashOf(body) }), map: m };
};
const U = "src/cards/user/";
const CARD = (id, extra = "") => `import type { CardDef } from "../../kernel/types";
${extra}
export const card: CardDef<{ text: string }> = {
  id: "${id}", name: "卡 ${id}", defaults: { text: "你好" }, controls: [{ key: "text", label: "文字", type: "text" }],
  Component: ({ params }) => <div className="absolute inset-0 text-[137px]">{params.text}</div>,
};
`;
const hostOf = (extra = {}) => ({
  packages: { react: () => require("react"), "react/jsx-runtime": () => require("react/jsx-runtime"), ...extra },
  builtin: (p) => (p === "src/kernel/clock.ts" ? async () => ({ now: () => 42 }) : null),
});
const bundle = async (files, entry, opts = {}) => T.bundleCard({ runtime: RUNTIME, entry, read: files.read, hasBuiltin: (p) => p === "src/kernel/clock.ts" || p === "src/cards/native/hud.tsx", ...opts });

test("OCE-T-01 syntax precheck: unsupported syntax is recognized; anything in comments, strings, JSX text or types does not count", () => {
  const what = (src) => P.unsupportedSyntax(src).map((x) => x.what);
  assert.deepEqual(what("export namespace N { export const x = 1 }"), ["namespace"]);
  assert.deepEqual(what("module M { export const x = 1 }"), ["module block"]);
  assert.deepEqual(what("function d(t: any) {}\n@d class C {}"), ["decorator"]);
  assert.deepEqual(what("class C { accessor x = 1 }"), ["accessor field"]);
  assert.deepEqual(what("export const u = import.meta.url"), ["import.meta"]);
  assert.deepEqual(what("export const m = import('./x')"), ["dynamic import()"]);
  assert.deepEqual(what("export const x = await Promise.resolve(1)"), ["top-level await"]);
  assert.equal(P.unsupportedSyntax("const a = 1;\n\nexport const b = await a")[0].line, 3, "has line number");
  assert.deepEqual(what(`
    // namespace N { } @d accessor x import.meta await
    /* import('./x') */
    import { useMemo } from "react";
    import type { CardDef } from "../../kernel/types";
    declare module "x" { export const y: number }
    declare namespace D { const q: number }
    type T = { namespace: 1; module: 2; accessor: 3 };
    const s = "namespace N { } import.meta @d";
    const accessor = 1, namespace = 2, module = { exports: 3 };
    async function f() { await 1; for await (const x of []) {} }
    const g = async () => await f();
    export const el = <div title="@d">hi @bob accessor zz namespace Q import.meta await</div>;
    export const v = accessor + namespace + module.exports;
  `), [], "should not be reported");
  assert.throws(() => P.unsupportedSyntax("const = ;"), "throws on a source syntax error (the caller treats it as a transpile failure)");
});

test("OCE-T-02 transpile one file: TSX → CommonJS; extract specifiers; syntax errors and oversized files give a status", () => {
  const ok = T.transpileCardFile(`${U}a.tsx`, CARD("a", `import { useMemo } from "react";\nimport { helper } from "./a-util";\nimport "./a.css";\nexport const used = helper();\nexport type ThreeMod = typeof import("three");`));
  assert.equal(ok.ok, true);
  assert.match(ok.js, /require\(['"]react\/jsx-runtime['"]\)/, "JSX uses the automatic runtime");
  assert.doesNotMatch(ok.js, /CardDef|: \{ text: string \}/, "types are stripped");
  assert.deepEqual([...ok.specifiers].sort(), ["./a-util", "./a.css", "react/jsx-runtime"].sort(), "type-only imports and unused named imports leave no require (same as TypeScript's elision rule)");
  assert.doesNotThrow(() => new Function("require", "module", "exports", ok.js), "the output is a compilable script");
  const bad = T.transpileCardFile(`${U}b.tsx`, "export const x = <div>;");
  assert.equal(bad.ok, false);
  assert.equal(bad.state.state, "unsupported-syntax");
  assert.equal(bad.state.file, `${U}b.tsx`);
  const ns = T.transpileCardFile(`${U}c.tsx`, "export namespace N { export const x = 1 }");
  assert.deepEqual(ns.state, { state: "unsupported-syntax", detail: "namespace (line 1)", file: `${U}c.tsx` });
  const big = T.transpileCardFile(`${U}d.tsx`, `export const s = "${"x".repeat(T.MAX_SOURCE_CHARS)}";`);
  assert.equal(big.state.state, "unsupported-syntax");
  assert.match(big.state.detail, /File too large/);
  assert.deepEqual(T.requireSpecifiers(`var a = require('x'); var b = _interop(require("./y")); const t = "not require(here"`), ["x", "./y"]);
});

test("OCE-T-03 import resolution: packages, synced source, built-in modules, styles; everything else is unsupported", () => {
  const synced = new Set([`${U}util.ts`, `${U}lib/index.tsx`, `${U}look.css`, `${U}sub/deep.ts`]);
  const builtin = new Set(["src/cards/native/hud.tsx", "src/kernel/clock.ts", "src/kernel/types.ts", "src/render/cards/graphValues.ts", "src/parts/lib/x.tsx", "src/editor/Preview.tsx", "src/render/Stage.tsx", "src/cards/fit.ts"]);
  const env = { hasSynced: (k) => synced.has(k), hasBuiltin: (p) => builtin.has(p) };
  const r = (spec, from = `${U}card.tsx`) => RS.resolveCardImport(from, spec, env);
  for (const name of PR.CARD_PACKAGES) assert.deepEqual(r(name), { ok: true, to: { kind: "package", name } });
  assert.deepEqual(r("./util"), { ok: true, to: { kind: "synced", key: `${U}util.ts` } });
  assert.deepEqual(r("./util.ts"), { ok: true, to: { kind: "synced", key: `${U}util.ts` } });
  assert.deepEqual(r("./lib"), { ok: true, to: { kind: "synced", key: `${U}lib/index.tsx` } });
  assert.deepEqual(r("../util", `${U}sub/deep.ts`), { ok: true, to: { kind: "synced", key: `${U}util.ts` } });
  assert.deepEqual(r("./look.css"), { ok: true, to: { kind: "style", key: `${U}look.css` } });
  assert.deepEqual(r("../native/hud"), { ok: true, to: { kind: "builtin", path: "src/cards/native/hud.tsx" } });
  assert.deepEqual(r("../fit"), { ok: true, to: { kind: "builtin", path: "src/cards/fit.ts" } });
  assert.deepEqual(r("../../kernel/clock"), { ok: true, to: { kind: "builtin", path: "src/kernel/clock.ts" } });
  assert.deepEqual(r("../../render/cards/graphValues"), { ok: true, to: { kind: "builtin", path: "src/render/cards/graphValues.ts" } });
  assert.deepEqual(r("../../parts/lib/x"), { ok: true, to: { kind: "builtin", path: "src/parts/lib/x.tsx" } });
  for (const spec of ["lodash", "three/examples/jsm/controls/OrbitControls.js", "three/addons", "@/lib/utils", "react-dom/client", "node:fs", "",
    "../../editor/Preview", "../../render/Stage", "./nope", "./util?raw", "./data.json", "./pic.png", "../../../package.json", "../../../../etc/passwd", "./nope.css", "../native/hud.css"]) {
    const out = r(spec);
    assert.equal(out.ok, false, `should not be supported: ${spec}`);
  }
  assert.equal(RS.isBuiltinModulePath(`${U}x.tsx`), false, "the user card directory does not count as built into the page");
  assert.equal(RS.isBuiltinModulePath("src/kernel/x.test.mjs"), false);
});

test("OCE-T-04 bundle one card: closure, missing files, unsupported modules, generation signature, cache", async () => {
  const files = lib({
    [`${U}a.tsx`]: CARD("a", `import { helper } from "./a-util";\nimport { now } from "../../kernel/clock";\nimport "./a.css";\nexport const used = helper() + now();`),
    [`${U}a-util.ts`]: `import { deep } from "./lib/deep";\nexport const helper = () => deep + 1;`,
    [`${U}lib/deep.ts`]: `export const deep: number = 1;`,
    [`${U}a.css`]: `.a-look { color: red }`,
    [`${U}other.tsx`]: CARD("other"),
  });
  const out = await bundle(files, `${U}a.tsx`);
  assert.equal(out.ok, true);
  const b = out.bundle;
  assert.deepEqual(b.modules.map((m) => m.key), [`${U}a.tsx`, `${U}a-util.ts`, `${U}lib/deep.ts`], "entry comes first; only collects what it imports");
  assert.deepEqual(b.styles.map((s) => s.key), [`${U}a.css`]);
  assert.equal(b.styles[0].css, ".a-look { color: red }");
  assert.deepEqual(b.modules[0].imports["../../kernel/clock"], { kind: "builtin", path: "src/kernel/clock.ts" });
  assert.deepEqual(b.modules[0].imports["./a-util"], { kind: "synced", key: `${U}a-util.ts` });
  assert.equal(b.runtime, RUNTIME);
  assert.equal(b.tailwind, "", "nothing is generated when no compiler is given");
  assert.ok(b.generation.startsWith(`${RUNTIME}|`));
  // When dependency hashes change, the generation changes accordingly; unchanged ones stay the same
  const again = await bundle(files, `${U}a.tsx`);
  assert.equal(again.bundle.generation, b.generation);
  files.set(`${U}lib/deep.ts`, `export const deep: number = 2;`);
  assert.notEqual((await bundle(files, `${U}a.tsx`)).bundle.generation, b.generation);
  files.set(`${U}a.css`, `.a-look { color: blue }`);
  const c3 = await bundle(files, `${U}a.tsx`);
  assert.equal(c3.bundle.styles[0].css, ".a-look { color: blue }");
  assert.notEqual(c3.bundle.generation, again.bundle.generation, "a style change also bumps the generation");
  assert.notEqual((await T.bundleCard({ runtime: "ocr2:x", entry: `${U}other.tsx`, read: files.read, hasBuiltin: () => false })).bundle.generation,
    (await bundle(files, `${U}other.tsx`)).bundle.generation, "the runtime version goes into the generation signature");
  // Failure: identify which module and which file
  const f2 = lib({ [`${U}m.tsx`]: CARD("m", `import _ from "lodash";\nexport const z = _;`) });
  assert.deepEqual((await bundle(f2, `${U}m.tsx`)).state, { state: "missing-module", detail: "lodash", file: `${U}m.tsx` });
  const f3 = lib({ [`${U}n.tsx`]: CARD("n", `import { x } from "./gone";\nexport const z = x;`) });
  assert.deepEqual((await bundle(f3, `${U}n.tsx`)).state, { state: "missing-module", detail: "./gone", file: `${U}n.tsx` });
  const f4 = lib({ [`${U}p.tsx`]: CARD("p", `import { x } from "./p-bad";\nexport const z = x;`), [`${U}p-bad.ts`]: `export namespace X { export const x = 1 }\nexport const x = 1;` });
  assert.deepEqual((await bundle(f4, `${U}p.tsx`)).state, { state: "unsupported-syntax", detail: "namespace (line 1)", file: `${U}p-bad.ts` });
  assert.equal((await bundle(lib({}), `${U}none.tsx`)).state.state, "missing-module");
  // Cache: do not transpile a second time (switching to a read that throws still producing
  // results is invalid, so count set calls)
  let sets = 0, gets = 0;
  const mem = new Map();
  const cache = { get: (k, h) => { gets++; return mem.get(`${k}@${h}`); }, set: (k, h, v) => { sets++; mem.set(`${k}@${h}`, v); } };
  await bundle(files, `${U}a.tsx`, { cache });
  assert.equal(sets, 3);
  await bundle(files, `${U}a.tsx`, { cache });
  assert.equal(sets, 3, "an unchanged hash is not transpiled again");
  assert.ok(gets >= 6);
});

test("OCE-T-05 loader: executes, collects card definitions, components render; relative imports, cycles, style callbacks", async () => {
  const files = lib({
    [`${U}a.tsx`]: `import { useMemo } from "react";
import { label } from "./a-util";
import { now } from "../../kernel/clock";
import "./a.css";
export const notACard = { id: "x" };
export const card = {
  id: "a", name: "卡 a", defaults: { text: "你好" }, controls: [],
  Component: ({ params }: { params: { text: string } }) => { const t = useMemo(() => label(params.text), [params.text]); return <div className="a-look">{t}<b>{now()}</b></div>; },
};
export const second = { id: "a2", name: "第二张", defaults: {}, controls: [], audio: () => new Float32Array(2) };
`,
    [`${U}a-util.ts`]: `import { suffix } from "./a-loop";\nexport const prefix = "〔";\nexport const label = (s: string): string => prefix + s + suffix();`,
    [`${U}a-loop.ts`]: `import * as util from "./a-util";\nexport const suffix = () => (util.prefix === "〔" ? "〕" : "?");`,
    [`${U}a.css`]: `.a-look { color: red }`,
  });
  const out = await bundle(files, `${U}a.tsx`);
  assert.equal(out.ok, true, JSON.stringify(out.state));
  const styles = [], cardEvents = [], resultEvents = [];
  const loader = L.createCardLoader({ runtime: RUNTIME, host: hostOf(), onStyle: (e, css) => styles.push([e, css]), onCards: (d) => cardEvents.push(d.map((x) => x.id)), onResults: (r) => resultEvents.push([...r.keys()]) });
  const res = await loader.setBundles([out.bundle]);
  assert.deepEqual(res, [{ ok: true, entry: `${U}a.tsx`, generation: out.bundle.generation, cardIds: ["a", "a2"] }]);
  assert.deepEqual(loader.cards().map((d) => d.id), ["a", "a2"], "Export everything that looks like a card definition, skip what does not");
  assert.deepEqual(styles, [[`${U}a.tsx`, ".a-look { color: red }"]], "Styles are injected before execution");
  assert.deepEqual(cardEvents, [["a", "a2"]]);
  assert.deepEqual(resultEvents, [[`${U}a.tsx`]]);
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(loader.cards()[0].Component, { params: { text: "online" } }));
  assert.equal(html, `<div class="a-look">〔online〕<b>42</b></div>`, "The page's own React renders it; relative imports, cycles and the page's built-in modules are all wired up");
  assert.equal(L.isCardDef({ id: "x", name: "n", defaults: {}, controls: [] }), false, "Without Component / card / audio it does not count");
  assert.equal(L.isCardDef({ id: "x", name: "n", defaults: {}, controls: [], card: () => ({}) }), true);
});

test("OCE-T-06 loader failure states", async () => {
  const one = async (source, host = hostOf(), extra = {}) => {
    const files = lib({ [`${U}c.tsx`]: source, ...extra });
    const out = await T.bundleCard({ runtime: RUNTIME, entry: `${U}c.tsx`, read: files.read, hasBuiltin: (p) => p === "src/kernel/clock.ts" || p === "src/kernel/gone.ts" });
    assert.equal(out.ok, true, JSON.stringify(out.state));
    const loader = L.createCardLoader({ runtime: RUNTIME, host });
    const [r] = await loader.setBundles([out.bundle]);
    assert.deepEqual(loader.cards(), []);
    return r.state;
  };
  // During transpilation the page reports it exists, but the stage table does not have it (the
  // sound thread table is smaller than the stage table)
  assert.deepEqual(await one(`import { animate } from "motion";\nexport const card = { id: "c", name: "c", defaults: {}, controls: [], Component: () => animate };`),
    { state: "missing-module", detail: "motion", file: `${U}c.tsx` });
  assert.deepEqual(await one(`import { x } from "../../kernel/gone";\nexport const card = { id: "c", name: "c", defaults: {}, controls: [], Component: () => x };`),
    { state: "missing-module", detail: "src/kernel/gone.ts", file: `${U}c.tsx` });
  assert.deepEqual(await one(`import { lazy } from "three";\nexport const card = { id: "c", name: "c", defaults: {}, controls: [], Component: () => lazy };`, hostOf({ three: async () => { throw new Error("chunk 404"); } })),
    { state: "missing-module", detail: "three", file: `${U}c.tsx` }, "A failed on-demand load also counts as missing from the page");
  const thrown = await one(`throw new Error("Top level blew up\\nSecond line");`);
  assert.deepEqual(thrown, { state: "load-error", detail: "Top level blew up", file: `${U}c.tsx` }, "Keep only the first line of the error");
  const syntax = await one(`if (true) { await Promise.resolve(1); }\nexport const card = { id: "c", name: "c", defaults: {}, controls: [], Component: () => null };`);
  assert.equal(syntax.state, "unsupported-syntax", "An await inside a top-level block the precheck cannot recognize: a syntax error at load time is likewise classified as unsupported syntax");
  assert.deepEqual(await one(`export const nothing = 1;`), { state: "load-error", detail: "This file does not export a card definition", file: `${U}c.tsx` });
  // Runtime version mismatch
  const files = lib({ [`${U}c.tsx`]: CARD("c") });
  const out = await bundle(files, `${U}c.tsx`);
  const other = L.createCardLoader({ runtime: "ocr9:other", host: hostOf() });
  assert.equal((await other.setBundles([out.bundle]))[0].state.state, "load-error");
  // A dynamically concatenated require in card code is not in the transpilation table: throws,
  // will not touch other modules
  const sneaky = await one(`const r = require;\nconst fs = r("node:fs");\nexport const card = { id: "c", name: "c", defaults: {}, controls: [], Component: () => fs };`);
  assert.equal(sneaky.state, "load-error");
  assert.match(sneaky.detail, /The online page has no such module/);
});

test("OCE-T-07 generation change: unchanged is not re-executed; changed is re-executed; failure withdraws the old one; ones not in the group are withdrawn; clear", async () => {
  globalThis.__oceRuns = [];
  const src = (id, n) => `import { v } from "./${id}-dep";\n(globalThis as any).__oceRuns.push("${id}:" + v);\nexport const card = { id: "${id}", name: "n", defaults: {}, controls: [], Component: () => ${n} };`;
  const files = lib({ [`${U}a.tsx`]: src("a", 1), [`${U}a-dep.ts`]: `export const v = 1;`, [`${U}b.tsx`]: src("b", 1), [`${U}b-dep.ts`]: `export const v = 1;` });
  const both = async () => [(await bundle(files, `${U}a.tsx`)).bundle, (await bundle(files, `${U}b.tsx`)).bundle];
  const styles = [];
  let cardEvents = 0;
  const loader = L.createCardLoader({ runtime: RUNTIME, host: hostOf(), onStyle: (e, css) => styles.push([e, css]), onCards: () => { cardEvents++; } });
  await loader.setBundles(await both());
  assert.deepEqual(globalThis.__oceRuns, ["a:1", "b:1"]);
  const defA = loader.cards()[0];
  await loader.setBundles(await both());
  assert.deepEqual(globalThis.__oceRuns, ["a:1", "b:1"], "The same generation is not re-executed");
  assert.equal(loader.cards()[0], defA, "The definition object is also the original one");
  assert.equal(cardEvents, 1, "No notification when nothing changed");
  files.set(`${U}a-dep.ts`, `export const v = 2;`);
  await loader.setBundles(await both());
  assert.deepEqual(globalThis.__oceRuns, ["a:1", "b:1", "a:2"], "Only the card whose closure changed is re-executed, and it gets the new dependency");
  assert.notEqual(loader.cards()[0], defA);
  assert.equal(cardEvents, 2);
  // New generation fails: tear down the old generation, do not draw the new version with old code
  files.set(`${U}a-dep.ts`, `throw new Error("Broke");`);
  const r = await loader.setBundles(await both());
  assert.equal(r[0].ok, false);
  assert.deepEqual(loader.cards().map((d) => d.id), ["b"]);
  assert.equal(loader.results().get(`${U}a.tsx`).state.state, "load-error");
  // Restored once fixed
  files.set(`${U}a-dep.ts`, `export const v = 3;`);
  await loader.setBundles(await both());
  assert.deepEqual(loader.cards().map((d) => d.id), ["a", "b"]);
  // Tear down those not in this group, and remove styles as well
  await loader.setBundles([(await both())[1]]);
  assert.deepEqual(loader.cards().map((d) => d.id), ["b"]);
  assert.deepEqual(styles.at(-1), [`${U}a.tsx`, ""]);
  loader.clear();
  assert.deepEqual(loader.cards(), []);
  assert.equal(loader.results().size, 0);
  // Two cards importing the same synced file: each has its own instance (unlike desktop; see
  // loader.ts file header for scope description)
  globalThis.__oceRuns = [];
  const shared = lib({ [`${U}x.tsx`]: `import "./s";\nexport const card = { id: "x", name: "n", defaults: {}, controls: [], Component: () => null };`,
    [`${U}y.tsx`]: `import "./s";\nexport const card = { id: "y", name: "n", defaults: {}, controls: [], Component: () => null };`, [`${U}s.ts`]: `(globalThis as any).__oceRuns.push("s");` });
  await loader.setBundles([(await bundle(shared, `${U}x.tsx`)).bundle, (await bundle(shared, `${U}y.tsx`)).bundle]);
  assert.deepEqual(globalThis.__oceRuns, ["s", "s"]);
  delete globalThis.__oceRuns;
});

test("OCE-T-08 run states: spread onto cards; order on the editor page side; panel description", () => {
  const results = new Map([
    [`${U}a.tsx`, { ok: true, entry: `${U}a.tsx`, generation: "g", cardIds: ["a", "a2"] }],
    [`${U}b.tsx`, { ok: false, entry: `${U}b.tsx`, generation: "g", state: { state: "load-error", detail: "boom" } }],
  ]);
  const states = L.runStatesOf(results, (entry) => (entry === `${U}b.tsx` ? ["b"] : []));
  assert.deepEqual([...states], [["a", { state: "ready" }], ["a2", { state: "ready" }], ["b", { state: "load-error", detail: "boom" }]]);
  const cards = [{ id: "a", name: "a", source: `${U}a.tsx` }, { id: "b", name: "b", source: `${U}b.tsx` }, { id: "c", name: "c", source: `${U}c.tsx` }, { id: "d", name: "d", source: `${U}d.tsx` }];
  const bundles = [{ ok: true, entry: `${U}a.tsx`, bundle: { generation: "gen-a-1" } }, { ok: false, entry: `${U}b.tsx`, state: { state: "missing-module", detail: "lodash" } }, { ok: true, entry: `${U}c.tsx`, bundle: { generation: "gen-c-1" } }];
  const st = (extra) => Object.fromEntries([...ERS.editorRunStates({ cards, available: true, bundles, ...extra })].map(([id, s]) => [id, s.state]));
  assert.deepEqual(st({ available: false }), { a: "not-isolated", b: "not-isolated", c: "not-isolated", d: "not-isolated" });
  assert.deepEqual(st({}), { a: "loading", b: "missing-module", c: "loading", d: "loading" }, "Those that fail to transpile use the transpiler's state; those the stage has not reported on and that are not yet transpiled are loading");
  const A = new Map([["a", { state: "ready" }], ["c", { state: "ready" }]]), B = new Map([["a", { state: "ready" }], ["c", { state: "gpu" }]]);
  assert.deepEqual(st({ stages: [A, null, B] }), { a: "ready", b: "missing-module", c: "gpu", d: "loading" }, "When the two stages differ, take the one that cannot run");
  // Runnable cards carry this generation's short signature (used by source version in cost
  // identity): identical within the same generation, changes on generation switch
  const verOf = (gen) => ERS.editorRunStates({ cards, available: true, stages: [A], bundles: [{ ok: true, entry: `${U}a.tsx`, bundle: { generation: gen } }] }).get("a").version;
  assert.equal(typeof verOf("gen-a-1"), "string");
  assert.equal(verOf("gen-a-1"), verOf("gen-a-1"));
  assert.notEqual(verOf("gen-a-1"), verOf("gen-a-2"));
  assert.equal(ERS.editorRunStates({ cards, available: false, blockedDetail: "This site does not have online running of user cards and media effect cards enabled", bundles: [] }).get("a").detail, "This site does not have online running of user cards and media effect cards enabled");
  // Each of the nine states has an explanation (ready and loading are not shown; the original tenth
  // was deleted on 2026-10-22 along with the old tier)
  const msg = (s) => ERS.runStateMessage(s);
  assert.equal(msg({ state: "ready" }), null);
  assert.equal(msg({ state: "loading" }), null);
  assert.equal(msg(undefined), null);
  assert.equal(msg({ state: "unsupported-syntax", detail: "namespace (line 3)", file: `${U}x.tsx` }), "The online browser cannot run this card: it uses syntax the online page does not support (namespace (line 3), x.tsx). The picture is provided by a render node.");
  assert.equal(msg({ state: "missing-module", detail: "lodash" }), "The online browser cannot run this card: it references a module that is not available on the online page: lodash. The picture is provided by a render node.");
  assert.equal(msg({ state: "load-error", detail: "boom" }), "The online browser cannot run this card: error while loading (boom).");
  assert.equal(msg({ state: "gpu" }), "This device's graphics capability is not enough, so the picture of media effect cards is provided by a render node.");
  assert.equal(msg({ state: "media" }), "This device cannot decode this media clip, so the picture of media effect cards is provided by a render node.");
  assert.equal(msg({ state: "runtime-error" }), "This card failed to run in the online browser, so a render node provides the picture this time.");
  assert.equal(msg({ state: "not-isolated" }), "This page has no isolated runtime environment, so the picture of user cards and media effect cards is provided by a render node.");
  assert.equal(msg({ state: "not-isolated", detail: "This site does not have online running of user cards and media effect cards enabled" }), "This site does not have online running of user cards and media effect cards enabled, so the picture of user cards and media effect cards is provided by a render node.");
  assert.equal(R.CARD_RUN_STATES.length, 9);
  for (const s of R.CARD_RUN_STATES) if (s !== "ready" && s !== "loading") assert.ok(msg({ state: s }), s);
});

test("OCE-T-09 Tailwind supplementary generation: candidate class names; utility classes and theme variables, no base layer; each card compiles on its own", async () => {
  const c = TW.classCandidates([`<div className={cn("absolute inset-0 text-[137px]", on && 'bg-fuchsia-300 hover:scale-110')} data-x="[&>*]:p-2">\n  {\`md:grid-cols-3 \${x}\`}</div>;`]);
  for (const want of ["absolute", "inset-0", "text-[137px]", "bg-fuchsia-300", "hover:scale-110", "[&>*]:p-2", "md:grid-cols-3"]) assert.ok(c.includes(want), `Candidates should include ${want}: ${c.join(" ")}`);
  assert.equal(TW.classCandidates(["a b c d"], 2).length, 2, "Has a limit");
  const dir = path.dirname(require.resolve("tailwindcss/package.json"));
  const compile = TW.createCardCssCompiler({ theme: fs.readFileSync(path.join(dir, "theme.css"), "utf8"), utilities: fs.readFileSync(path.join(dir, "utilities.css"), "utf8") });
  const css = await compile(c);
  assert.match(css, /\.text-\\\[137px\\\]\s*\{\s*font-size: 137px/);
  assert.match(css, /--color-fuchsia-300:/, "Theme variables that are used are provided too (color variables never used in the online bundle are absent by default)");
  assert.match(css, /@layer utilities/);
  assert.doesNotMatch(css, /box-sizing: border-box|@layer base \{/, "No base layer");
  assert.equal(await compile(["notaclass", "also not"]), "", "None of them is a class name: empty string");
  assert.equal(await compile([]), "");
  const other = await compile(["flex"]);
  assert.doesNotMatch(other, /137px|fuchsia/, "A card compiled later does not carry the styles of a card compiled earlier");
  assert.equal(await compile(c), css, "Same input, same output");
  // Integrate into bundling
  const files = lib({ [`${U}a.tsx`]: CARD("a") });
  const out = await bundle(files, `${U}a.tsx`, { css: compile });
  assert.match(out.bundle.tailwind, /137px/);
  const broken = await bundle(files, `${U}a.tsx`, { css: async () => { throw new Error("x"); } });
  assert.equal(broken.ok, true, "A failure to generate styles does not block execution");
  assert.equal(broken.bundle.tailwind, "");
});

test("OCE-T-10 code identity: the page algorithm and the desktop cardCodeIdentity compute the same value for every card in the repo", async () => {
  const cards = await import(srcUrl("../server/vite-plugin-cards.ts"));
  const { sourceHash } = await import(srcUrl("../server/card-sync.mjs"));
  const text = (rel) => { try { const f = path.join(ROOT, rel); return fs.statSync(f).isFile() ? fs.readFileSync(f, "utf8") : null; } catch { return null; } };
  assert.equal(await CI.sourceHashOf("a\r\nb", sha256), sourceHash("a\r\nb"), "Content hash uses the same algorithm as the content store and the desktop app (line endings are normalized to LF first)");
  assert.equal(await CI.sourceHashOf("a\r\nb"), sourceHash("a\nb"), "Defaults to WebCrypto, same result");
  const ids = new Set();
  for (const dir of ["src/cards/native", "src/cards/magicui", "src/cards/user"]) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith(".tsx")) continue;
      for (const m of fs.readFileSync(path.join(ROOT, dir, f), "utf8").matchAll(/\bid:\s*["'`]([a-z][a-z0-9]*(?:-[a-z0-9]+)*)["'`]/g)) ids.add(m[1]);
    }
  }
  let compared = 0, multi = 0;
  for (const id of ids) {
    const want = cards.cardCodeIdentity(ROOT, id);
    if (!want) continue;
    const entry = want.files[0];
    // Two sources for page: entry point and files under user card directory count as "synced" (hash
    // provided by content store); the rest count as page built-in (computed dynamically)
    const isSynced = (rel) => rel === entry || rel.startsWith("src/cards/user/");
    const got = await CI.cardCodeIdentityOf(entry, {
      synced: (rel) => { const body = isSynced(rel) ? text(rel) : null; return body == null ? null : { body, hash: sourceHash(body) }; },
      builtin: (rel) => (isSynced(rel) ? null : text(rel)),
    }, { sha256 });
    assert.deepEqual(got, { version: want.version, files: want.files }, `Card ${id}`);
    compared++;
    if (want.files.length > 1) multi++;
  }
  assert.ok(compared >= 50, `Compared ${compared} cards`);
  assert.ok(multi >= 10, `${multi} of them have a closure spanning more than one file`);
  assert.equal(await CI.cardCodeIdentityOf("src/cards/user/none.tsx", { synced: () => null, builtin: () => null }, { sha256 }), null);
  // Rules for shared modules
  assert.equal(SHARED.isCardCodePath("src/cards/native/hud.tsx"), true);
  for (const bad of ["src/kernel/types.ts", "src/cards/x.test.ts", "../src/cards/a.ts", "/src/cards/a.ts", "C:/src/cards/a.ts", "src/cards/a.json", ""]) assert.equal(SHARED.isCardCodePath(bad), false, bad);
  assert.deepEqual(SHARED.localImportCandidates("src/cards/user/a.tsx", `import x from "./b";\nexport * from "../native/hud";\nconst y = import("./c.tsx");\nimport "react";\nimport z from "../../../../up";`),
    [["src/cards/user/b", "src/cards/user/b.tsx", "src/cards/user/b.ts", "src/cards/user/b/index.tsx", "src/cards/user/b/index.ts"],
      ["src/cards/native/hud", "src/cards/native/hud.tsx", "src/cards/native/hud.ts", "src/cards/native/hud/index.tsx", "src/cards/native/hud/index.ts"],
      ["src/cards/user/c.tsx", "src/cards/user/c.tsx.tsx", "src/cards/user/c.tsx.ts", "src/cards/user/c.tsx/index.tsx", "src/cards/user/c.tsx/index.ts"]]);
  assert.equal(SHARED.cardCodePreimage(["a", "b"], (r) => (r === "a" ? "h" : null)), "a\nh\nb\nmissing\n");
});

test("OCE-T-11 transpile cache: keyed by runtime version, key and hash; a different version misses; failed results are cached too", async () => {
  const a = TC.createTranspileCache("rt1", null);
  const ok = { ok: true, js: "x", specifiers: [] }, bad = { ok: false, state: { state: "unsupported-syntax" } };
  assert.equal(a.get("k", "h"), undefined);
  a.set("k", "h", ok);
  a.set("k2", "h", bad);
  assert.equal(a.get("k", "h"), ok);
  assert.equal(a.get("k2", "h"), bad);
  assert.equal(a.get("k", "h2"), undefined, "A changed hash misses");
  a.set("k", "", ok);
  assert.equal(a.get("k", ""), undefined, "Entries without a hash are not stored");
  await a.warm();
  assert.equal(a.size, 2, "Without IndexedDB it is just an in-memory table");
  for (let i = 0; i < TC.TRANSPILE_CACHE_LIMIT + 5; i++) a.set(`f${i}`, "h", ok);
  assert.equal(a.size, TC.TRANSPILE_CACHE_LIMIT, "Has a size limit, evicts the oldest");
  assert.equal(a.get("k", "h"), undefined);
  // Mock IndexedDB: stored keys include runtime version; warm accepts only this version with
  // matching shape
  const rows = new Map([["rt1\nold\nh", ok], ["rt0\nstale\nh", ok], ["rt1\nbroken\nh", { ok: true }]]);
  const fakeIdb = { open: () => {
    const req = {};
    const store = {
      put: (v, k) => rows.set(k, v),
      openCursor: () => { const r = {}; const keys = [...rows.keys()]; let i = 0;
        const step = () => { r.result = i < keys.length ? { key: keys[i], value: rows.get(keys[i]), delete: () => rows.delete(keys[i]), continue: () => { i++; queueMicrotask(step); } } : null; if (!r.result) queueMicrotask(() => tx.oncomplete?.()); r.onsuccess?.(); };
        queueMicrotask(step); return r; },
    };
    const tx = { objectStore: () => store };
    const db = { transaction: () => tx, objectStoreNames: { contains: () => true } };
    queueMicrotask(() => { req.result = db; req.onsuccess?.(); });
    return req;
  } };
  const b = TC.createTranspileCache("rt1", fakeIdb);
  await b.warm();
  assert.equal(b.get("old", "h"), ok);
  assert.deepEqual([...rows.keys()], ["rt1\nold\nh"], "Entries from other runtime versions or with a wrong shape are deleted along the way");
  b.set("new", "h", bad);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(rows.get("rt1\nnew\nh"), bad);
});

test("OCE-T-12 registry: cards loaded at runtime and their run state", () => {
  R.resetCards();
  R.resetRuntimeCardsForTest();
  const def = (id, extra = {}) => ({ id, name: `Name-${id}`, defaults: {}, controls: [], Component: () => null, ...extra });
  R.registerCards([def("built")]);
  const gen0 = R.cardsRegistryGen(), rgen0 = R.runtimeCardsGen();
  let notified = 0;
  const off = R.onRuntimeCardsChanged(() => { notified++; });
  const a = def("rt-a"), clash = def("built", { name: "Pretends to be a built-in card" });
  assert.equal(R.setRuntimeCards([a, clash]), true);
  assert.equal(R.getCard("rt-a").name, "Name-rt-a");
  assert.equal(typeof R.getCard("rt-a").need_prerendering, "boolean", "Like registering a built-in card, capabilities are overlaid from the review table (entries missing from the table get defaults)");
  assert.equal(R.getCard("built").name, "Name-built", "Id clash with a build-time card: the build-time one wins");
  assert.equal(R.isRuntimeCard("rt-a"), true);
  assert.equal(R.isRuntimeCard("built"), false);
  assert.deepEqual(R.allCards().map((c) => c.id), ["built"], "allCards does not include runtime-loaded cards");
  assert.equal(R.cardsRegistryGen(), gen0 + 1);
  assert.equal(R.runtimeCardsGen(), rgen0 + 1);
  assert.equal(notified, 1);
  assert.equal(R.setRuntimeCards([a, clash]), false, "Same batch of definition objects: unchanged");
  assert.equal(notified, 1);
  assert.equal(R.setRuntimeCards([]), true);
  assert.equal(R.getCard("rt-a"), undefined);
  off();
  // Run state
  let s = 0;
  const offS = R.onCardRunStatesChanged(() => { s++; });
  assert.equal(R.setCardRunStates([["x", { state: "ready" }], ["y", { state: "load-error", detail: "d".repeat(500), file: "f" }], ["z", { state: "made-up" }], ["", { state: "ready" }], ["w", null]]), true);
  assert.deepEqual(R.cardRunState("x"), { state: "ready" });
  assert.equal(R.cardRunState("y").detail.length, 300, "Detail is truncated");
  assert.equal(R.cardRunState("z"), undefined, "Unrecognized states are dropped (what the stage reports is treated as untrusted input)");
  assert.equal(R.cardRunState("w"), undefined);
  assert.equal(R.cardRunnableHere("x"), true);
  assert.equal(R.cardRunnableHere("y"), false);
  assert.equal(R.cardRunnableHere("built"), true, "Cards defined at build time can always run");
  assert.equal(R.cardRunnableHere("nobody"), false);
  assert.equal(s, 1);
  assert.equal(R.setCardRunStates({ x: { state: "ready" }, y: { state: "load-error", detail: "d".repeat(300), file: "f" } }), false, "No notification when the content is unchanged (plain objects are accepted too)");
  assert.equal(R.setCardRunStates([]), true);
  assert.equal(s, 2);
  offS();
  R.resetCards();
  R.resetRuntimeCardsForTest();
});

test("OCE-T-13 preconditions for execution: off by default; the master switch is only off when explicitly set to false", () => {
  G.resetCardExecGateForTest();
  assert.equal(G.cardExecAvailable(), false, "No execution until the isolated environment's verdict arrives (a setup without nginx stays here forever)");
  let n = 0;
  const off = G.subscribeCardExecGate(() => { n++; });
  G.setCardExecGate({ isolated: true });
  assert.equal(G.cardExecAvailable(), true);
  assert.equal(G.cardExecGate().reason, null);
  G.setCardExecGate({ isolated: true });
  assert.equal(n, 1, "No notification when nothing changed");
  G.setCardExecGate({ site: false });
  assert.equal(G.cardExecAvailable(), false, "Site disabled: no execution however good the isolation is");
  assert.equal(G.cardExecBlockedDetail(), "This site does not have online running of user cards and media effect cards enabled");
  G.setCardExecGate({ site: true, isolated: false, reason: "Policy not in effect" });
  assert.equal(G.cardExecAvailable(), false);
  assert.equal(G.cardExecBlockedDetail(), null);
  assert.equal(G.cardExecGate().reason, "Policy not in effect");
  off();
  for (const on of [null, undefined, "", "{", {}, { v: 1, stageOrigins: [] }, { onlineCardExec: true }, { onlineCardExec: "false" }, { onlineCardExec: 0 }, '{"onlineCardExec":true}']) assert.equal(G.siteCardExecOf(on), true, JSON.stringify(on));
  for (const offv of [{ onlineCardExec: false }, '{"v":1,"onlineCardExec":false}']) assert.equal(G.siteCardExecOf(offv), false);
  G.resetCardExecGateForTest();
});

test("OCE-T-14 transpile during card source sync: identical to before when execution is unavailable; transpile and fetch styles when available; no re-transpile if unchanged; clear again when unavailable", async () => {
  const store = lib({
    [`${U}a.tsx`]: `import { n } from "./a-util";
import "./a.css";
export const card = { id: "sync-a", name: "Sync A", defaults: {}, controls: [], Component: () => n };`,
    [`${U}a-util.ts`]: `export const n = 1;`,
    [`${U}a.css`]: `.x { color: red }`,
    [`${U}unused.css`]: `.y { color: red }`,
  });
  const gets = [];
  const request = async (msg) => {
    if (msg.type === "content.list") return { type: "content.listing", items: [...store.map].map(([key, v]) => ({ key, hash: v.hash })) };
    gets.push(msg.key);
    const hit = store.read(msg.key);
    return hit ? { type: "content.item", key: msg.key, body: hit.body, hash: hit.hash } : { type: "content.item", missing: true };
  };
  let on = false;
  const runs = [], seen = [];
  const link = {};
  const src = new S.OnlineCardSources({
    request, linkKey: () => link, apply: () => true,
    bundling: {
      enabled: () => on,
      run: async (job) => { runs.push([...job.entries]); return job.entries.map((entry) => ({ ok: true, entry, bundle: { runtime: RUNTIME, entry, modules: [], styles: [], tailwind: "", generation: JSON.stringify([job.read(entry)?.hash, job.read(`${U}a-util.ts`)?.hash, job.read(`${U}a.css`)?.hash ?? null]) } })); },
      onBundles: (r) => seen.push(r.map((x) => x.entry)),
    },
  });
  await src.sync();
  assert.deepEqual(gets.sort(), [`${U}a-util.ts`, `${U}a.tsx`], "Execution unavailable: style files are not fetched");
  assert.deepEqual(runs, [], "No transpile");
  assert.deepEqual(seen, []);
  assert.deepEqual(src.debug().bundles, []);
  on = true;
  await src.sync();
  assert.deepEqual(runs, [[`${U}a.tsx`]]);
  assert.ok(gets.includes(`${U}a.css`), "Execution available: style files imported by the card are fetched too");
  assert.ok(!gets.includes(`${U}unused.css`), "Styles nobody imports are not fetched");
  assert.deepEqual(seen, [[`${U}a.tsx`]]);
  assert.equal(src.debug().bundles[0].ok, true);
  assert.equal(JSON.parse(src.debug().bundles[0].generation)[2], store.read(`${U}a.css`).hash, "The style's content and hash are readable during transpile");
  await src.sync();
  assert.equal(runs.length, 1, "No re-transpile when the input is unchanged");
  store.set(`${U}a-util.ts`, `export const n = 2;`);
  await src.sync();
  assert.equal(runs.length, 2, "Re-transpile when a file in the closure changes");
  store.set(`${U}a.css`, `.x { color: blue }`);
  await src.sync();
  assert.equal(runs.length, 3, "Re-transpile when the style changes too");
  on = false;
  await src.sync();
  assert.deepEqual(seen.at(-1), [], "Execution unavailable again: bundles cleared");
  assert.equal(runs.length, 3);
  on = true;
  await src.sync();
  assert.equal(runs.length, 4, "Re-transpile when execution becomes available again");
  src.stop();
  assert.deepEqual(seen.at(-1), []);
  assert.deepEqual(S.cardSourceStyleImports(`import "./a.css";\nimport "../b.css";\nimport "../../../x.css";\nimport s from "./c.css?raw";\n// import "./no.css"`, `${U}sub/k.tsx`), [`${U}sub/a.css`, `${U}b.css`]);
});

test("OCE-T-15 all existing card and part files in the repo transpile, and every import resolves", () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
  const all = new Set(["src/cards", "src/parts", "src/kernel", "src/render/cards"].flatMap((d) => walk(path.join(ROOT, d))).map(rel));
  // Treat repository user cards as "synced", and the rest as page built-in
  const env = { hasSynced: (k) => all.has(k) && k.startsWith(U), hasBuiltin: (p) => all.has(p) };
  // Index files using import.meta.glob and files reading directory manifests at build time cannot
  // be imported by cards
  const skip = /(^|\/)index\.ts$|\/catalogAssets\.ts$|\/userOverlay\.ts$|\/builtinSourceExports\.ts$|\/demoClips\.ts$/;
  const files = [...all].filter((f) => (f.startsWith("src/cards/") || f.startsWith("src/parts/")) && /\.tsx?$/.test(f) && !/\.test\.|\.d\.ts$/.test(f) && !skip.test(f));
  const failed = [], unresolved = [];
  for (const f of files) {
    const out = T.transpileCardFile(f, fs.readFileSync(path.join(ROOT, f), "utf8"));
    if (!out.ok) { failed.push(`${f}:${out.state.detail}`); continue; }
    for (const spec of out.specifiers) {
      const r = RS.resolveCardImport(f, spec, env);
      // Styles: built-in cards import styles bundled with the page (already in page), not going
      // through this path
      if (!r.ok && !(spec.endsWith(".css") && !f.startsWith(U))) unresolved.push(`${f} → ${spec}`);
    }
  }
  assert.ok(files.length >= 70, `File count ${files.length}`);
  assert.deepEqual(failed, [], "All transpile");
  // The only place in built-in cards importing an out-of-scope page module (render layer); synced
  // cards written this way report "module not in page"
  assert.deepEqual(unresolved, ["src/cards/native/caption-track.tsx → ../../render/captionFrame.mjs"], "Except this one, every import resolves");
});

test("OCE-T-16 gatekeeper: the editor page and the export page do not import the loader; package names match the allowlist; shape of the runtime version", () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const forbidden = /cardRuntime\/(loader|stageRuntime|hostModules)\b/;
  const offenders = [];
  for (const dir of ["src/editor", "src/export", "src/store", "src/ai", "src/mcp"]) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      if (!/\.(ts|tsx|mjs)$/.test(f) || /\.test\./.test(f)) continue;
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) if (forbidden.test(m[1])) offenders.push(`${path.relative(ROOT, f)} → ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], "The editor page's source does not create the loader (transpile only, no execution)");
  for (const f of ["src/ExportView.tsx", "src/Shell.tsx", "src/App.tsx"]) {
    if (fs.existsSync(path.join(ROOT, f))) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), forbidden, f);
  }
  // The transpilation module on the editor page side itself contains no execution mechanism
  for (const f of ["transpile.ts", "transpile.browser.ts", "precheck.ts", "remotionLock.mjs", "resolve.ts", "tailwind.ts", "transpileCache.ts", "codeIdentity.ts", "gate.ts"]) {
    const text = fs.readFileSync(path.join(ROOT, "src/online/cardRuntime", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(text, /new Function|\beval\(|\bimport\(\s*[^)\s]/,`${f} must not contain any means of executing code`);
  }
  const host = fs.readFileSync(path.join(ROOT, "src/online/cardRuntime/hostModules.ts"), "utf8");
  const names = [...host.matchAll(/^\s*"([^"]+)": \(\) => import\("([^"]+)"\),$/gm)].map((m) => { assert.equal(m[1], m[2]); return m[1]; });
  assert.deepEqual(names, [...PR.CARD_PACKAGES], "The package names in the page module table match the allowlist one to one");
  assert.equal(V.CARD_RUNTIME_VERSION, "ocr2:sucrase@dev:tailwindcss@dev", "Unit tests have no build-injected version");
  assert.equal(V.cardRuntimeVersionOf("ocr1", { sucrase: "3.35.1", tailwindcss: "4.3.3" }), "ocr1:sucrase@3.35.1:tailwindcss@4.3.3");
  assert.equal(require("sucrase/package.json").version, "3.35.1", "The transpiler is pinned to the version written in the contract");
});

test('OCE-T-05 Multiple CSS files call back per file, Tailwind last; on generation-change failure/unmount/clear, styles are fully removed, and the old string callback is kept', async () => {
  const entry = `${U}parts.tsx`;
  const original = {runtime:RUNTIME,entry,generation:'1',modules:[{key:entry,imports:{},js:'exports.probe={id:"parts",name:"parts",defaults:{},controls:[],Component:()=>null};'}],styles:[{key:'first.css',css:'.first {color:red}'},{key:'later.css',css:'@import "https://example.invalid/public.css";'}],tailwind:'.last {color:blue}'};
  const calls=[];
  const loader=L.createCardLoader({runtime:RUNTIME,host:hostOf(),onStyles:(entry,files)=>calls.push([entry,[...files]]),onStyle:()=>assert.fail('Multi-file callback takes priority')});
  assert.equal((await loader.setBundles([original]))[0].ok,true);
  assert.deepEqual(calls.at(-1),[entry,[original.styles[0].css,original.styles[1].css,original.tailwind]]);
  const count=calls.length;await loader.setBundles([original]);assert.equal(calls.length,count,'Same generation does not re-inject styles');
  assert.equal((await loader.setBundles([{...original,generation:'2',runtime:'bad'}]))[0].ok,false);
  assert.deepEqual(calls.at(-1),[entry,[]],'Generation-change failure removes the old styles');
  await loader.setBundles([original]);await loader.setBundles([]);assert.deepEqual(calls.at(-1),[entry,[]],'Unmount removes styles');
  await loader.setBundles([original]);loader.clear();assert.deepEqual(calls.at(-1),[entry,[]],'clear removes everything');
  const legacy=[];const older=L.createCardLoader({runtime:RUNTIME,host:hostOf(),onStyle:(e,css)=>legacy.push([e,css])});
  await older.setBundles([original]);assert.deepEqual(legacy.at(-1),[entry,[...original.styles.map(s=>s.css),original.tailwind].join('\n')]);older.clear();assert.deepEqual(legacy.at(-1),[entry,'']);
});
