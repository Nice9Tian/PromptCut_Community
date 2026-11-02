/**
 * Unit tests for card source parsing (`cardSourceParse.mjs`, C10 contract Section 9 "Recognition").
 * Run: node --test src/kernel/cardSourceParse.test.mjs
 *
 * Fixtures:
 *   1. **Every** `src/cards/user/*.tsx` in repository: parse results match cards for that
 *   file in registry (`userCards` / `userCardFileOf`, actually loaded via vite) one by one;
 *   2. Broader corpus: all `.tsx` under `src/cards/` (built-in cards and user cards share the
 *   same syntax), parse results match items resembling CardDef in module named exports one by one;
 *   3. Handwritten edge cases: "cards" written in comments / strings / templates, apostrophes in
 *   JSX text, regexes, generics, `export { a as b }`, default exports, constant id, spreads,
 *   objects missing fields, method syntax.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { parseCardSource, isUserCardEntryKey } from "./cardSourceParse.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const byId = (a) => [...a].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
/** Only compare id and name (identification layer; default values and controls have dedicated tests) */
const idName = (a) => a.map(({ id, name }) => ({ id, name }));
const isCardDef = (c) => !!c && typeof c === "object" && typeof c.id === "string" && typeof c.name === "string" && typeof c.defaults === "object"
  && Array.isArray(c.controls) && (typeof c.Component === "function" || typeof c.card === "function" || typeof c.audio === "function");

async function withVite(fn) {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { return await fn(server); } finally { await server.close(); }
}

test("Every src/cards/user/*.tsx in the repository: the parse result matches, card by card, the cards in the registry for that file", async () => withVite(async (server) => {
  const user = await server.ssrLoadModule("/src/cards/user/index.ts");
  const dir = path.join(ROOT, "src/cards/user");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  assert.ok(files.length > 0, "The repository has at least one user card");
  let cards = 0;
  for (const f of files) {
    const base = f.replace(/\.tsx$/, "");
    const want = user.userCards.filter((c) => user.userCardFileOf[c.id] === base).map((c) => ({ id: c.id, name: c.name }));
    const got = parseCardSource(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.deepEqual(byId(idName(got)), byId(want), `Parse result of ${f} does not match the registry`);
    // Default values, controls, descriptions of user cards: verbatim identical (user cards in
    // repository are all written as literals)
    for (const g of got) {
      const real = user.userCards.find((c) => c.id === g.id);
      assert.deepEqual(g.defaults, real.defaults, `defaults of ${f} ${g.id}`);
      assert.deepEqual(g.controls, real.controls, `controls of ${f} ${g.id}`);
      assert.equal(g.controlsIncomplete, false, `All controls of ${f} ${g.id} are recognized`);
      assert.equal(g.description, typeof real.description === "string" ? real.description : undefined, `description of ${f} ${g.id}`);
    }
    assert.ok(isUserCardEntryKey(`src/cards/user/${f}`));
    cards += want.length;
  }
  assert.equal(cards, user.userCards.length, "Every user card in the registry comes from some file and was parsed");
}));

test("Wider corpus: the parse result of every .tsx under src/cards matches, one by one, the CardDef exported by the module", async () => withVite(async (server) => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith(".tsx")) files.push(f); } };
  walk(path.join(ROOT, "src/cards"));
  assert.ok(files.length >= 20, `The corpus should not be too small: ${files.length}`);
  let cards = 0;
  const stats = { cards: 0, complete: 0, controls: 0, parsed: 0 };
  for (const f of files) {
    const rel = "/" + path.relative(ROOT, f).split(path.sep).join("/");
    const mod = await server.ssrLoadModule(rel);
    const seen = new Set();
    const want = [];
    for (const v of Object.values(mod)) if (isCardDef(v) && !seen.has(v.id)) { seen.add(v.id); want.push({ id: v.id, name: v.name }); }
    const got = parseCardSource(fs.readFileSync(f, "utf8"));
    assert.deepEqual(byId(idName(got)), byId(want), rel);
    cards += want.length;
    // Default values and controls: recognized ones match those in module; unrecognized controls
    // must be marked controlsIncomplete
    for (const g of got) {
      const real = Object.values(mod).find((v) => isCardDef(v) && v.id === g.id);
      for (const [k, v] of Object.entries(g.defaults)) assert.deepEqual(v, real.defaults[k], `${rel} ${g.id} defaults.${k}`);
      for (const c of g.controls) {
        const rc = real.controls.find((x) => x.key === c.key);
        assert.ok(rc, `${rel} ${g.id} has an extra control ${c.key}`);
        for (const [field, v] of Object.entries(c)) {
          if (field === "options" && c.type === "asset" && v.length === 0) continue; // When asset options are not recognized, treat as an empty list
          assert.deepEqual(v, rc[field], `${rel} ${g.id} controls.${c.key}.${field}`);
        }
      }
      if (g.controls.length < real.controls.length) assert.equal(g.controlsIncomplete, true, `${rel} ${g.id} has a control that was not recognized but not flagged`);
      if (typeof g.description === "string") assert.equal(g.description, real.description, `${rel} ${g.id} description`);
      stats.cards++;
      if (!g.controlsIncomplete && g.controls.length === real.controls.length) stats.complete++;
      stats.controls += real.controls.length;
      stats.parsed += g.controls.length;
    }
  }
  assert.ok(cards >= 20, `Too few cards in the corpus: ${cards}`);
  /*
   * Prevent parser from silently degrading into recognizing nothing. Many built-in cards spread
   * `hudControls` imported from other files (not literals in same file, unrecognized by rule,
   * marked controlsIncomplete), so here we only require majority to be recognized (measured
   * 2026-09-29: 39 cards, 17 fully recognized; 125 of 166 controls recognized).
   */
  assert.ok(stats.complete >= 10, `Too few cards with all controls recognized: ${JSON.stringify(stats)}`);
  assert.ok(stats.parsed >= stats.controls * 0.6, `Too few controls recognized: ${JSON.stringify(stats)}`);
}));

const CARD = (id, name, extra = "") => `export const c_${id.replace(/\W/g, "_")}: CardDef<P> = {
  id: "${id}",
  name: "${name}",${extra}
  defaults: { text: "x" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: View,
};`;

test("Edge cases: a \"card\" inside comments, strings and templates does not count; apostrophes in JSX text, regexes and generics do not disturb the parsing that follows", () => {
  const src = `
import type { CardDef } from "../../kernel/types";
// export const fake1 = { id: "no-1", name: "x", defaults: {}, controls: [], Component: V };
/* export const fake2 = { id: "no-2", name: "x", defaults: {}, controls: [], Component: V }; */
const s = "export const fake3 = { id: 'no-3', name: 'x', defaults: {}, controls: [], Component: V }";
const t = \`
export const fake4 = { id: "no-4", name: "x", defaults: {}, controls: [], Component: V };
\${ "{" } }\`;
const re = /[{"'\`]+/g;
const glob = "src/**/*.tsx";
function View({ params }: CardProps<P>) {
  const [n] = useState<number>(0);
  const pick = <T,>(xs: T[]) => xs[0];
  return <div className="a" data-x={"}"}>Don't {params.text} it's <b>ok</b> {n > 1 ? <i>y</i> : "z"}</div>;
}
${CARD("real-card", "Real card")}
`;
  assert.deepEqual(idName(parseCardSource(src)), [{ id: "real-card", name: "Real card" }]);
});

test("Edge cases: export { a as b }, default export, constant id, spread, method notation, multiple cards, only the first card is kept for the same id", () => {
  const src = `
const ID = "const-id";
const NAME: string = "Constant name";
const base = { id: "base-card", name: "Base card", defaults: {}, controls: [], Component: V };
const hidden = { id: "hidden-card", name: "Not exported", defaults: {}, controls: [], Component: V };
const aliased = { id: "alias-card", name: "Alias export", defaults: {}, controls: [], card(sources) { return sources; } };
export const fromConst = { id: ID, name: NAME, defaults: {}, controls: [], audio: (s) => s };
export const spreadCard = { ...base, id: "spread-card", name: "Spread card" };
export const dup = { id: "const-id", name: "Duplicate", defaults: {}, controls: [], Component: V };
export { aliased as renamed, base };
export default { id: "default-card", name: \`Default\`, defaults: {}, controls: [], Component };
`;
  assert.deepEqual(byId(idName(parseCardSource(src))), byId([
    { id: "const-id", name: "Constant name" },
    { id: "spread-card", name: "Spread card" },
    { id: "alias-card", name: "Alias export" },
    { id: "base-card", name: "Base card" },
    { id: "default-card", name: "Default" },
  ]));
});

test("Edge cases: missing fields, non-literal values, broken source → not a card, no throw", () => {
  assert.deepEqual(parseCardSource(`export const a = { id: "a", name: "x", controls: [], Component: V };`), [], "Missing defaults");
  assert.deepEqual(parseCardSource(`export const a = { id: "a", name: "x", defaults: {} , Component: V };`), [], "Missing controls");
  assert.deepEqual(parseCardSource(`export const a = { id: "a", name: "x", defaults: {}, controls: [] };`), [], "Missing component");
  assert.deepEqual(parseCardSource(`export const a = { id: makeId(), name: "x", defaults: {}, controls: [], Component: V };`), [], "id is not a literal");
  assert.deepEqual(parseCardSource(`export const a = { id: \`a-\${n}\`, name: "x", defaults: {}, controls: [], Component: V };`), [], "Template with substitutions");
  assert.deepEqual(parseCardSource(`export const a = defineCard({ id: "a", name: "x", defaults: {}, controls: [], Component: V });`), [], "Wrapped in a function");
  assert.deepEqual(idName(parseCardSource(`export const a = { id: "a", name: "x", defaults: {}, controls: [], Component: V`)), [{ id: "a", name: "x" }], "Truncated source is parsed as far as possible");
  for (const junk of ["", "{{{{", "`${", "/*", "<div>", "export const", "export {"]) assert.deepEqual(parseCardSource(junk), [], JSON.stringify(junk));
  assert.deepEqual(parseCardSource(null), []);
  assert.deepEqual(idName(parseCardSource(`export const a = { "id": 'q\\'s', 'name': "转义\\u4e2d\\n", defaults: {}, controls: [], Component: V } as const;`)), [{ id: "q's", name: "转义中\n" }], "Quoted keys and escapes");
});

test("Unclosed \\u{ escape: no hang, the remainder is left as is (it used to rescan from the start and loop forever, hanging the online page)", () => {
  const t0 = Date.now();
  assert.deepEqual(idName(parseCardSource(`export const a = { id: "a", name: "bad\\u{41", defaults: {}, controls: [], Component: V };`)), [{ id: "a", name: "badu{41" }]);
  assert.deepEqual(idName(parseCardSource(`export const a = { id: "a", name: "good\\u{41}", defaults: {}, controls: [], Component: V };`)), [{ id: "a", name: "goodA" }], "Closed ones are parsed as usual");
  assert.ok(Date.now() - t0 < 1000, `Parsing took ${Date.now() - t0} ms`);
});

test("Defaults and controls: various literals, references to and spreads of same-file constants; unrecognized keys, fields and controls are dropped by the rules", () => {
  const src = `
import type { CardDef } from "../../kernel/types";
import { LOTTIE_OPTIONS } from "../catalogAssets";
const W = 200
const NEG = -3.5;
const OPTS = [{ value: "a", label: "A" }, { value: "b", label: \`B\` }] as const;
const BASE = { size: 12, color: "#fff" };
const TEXT_CTRL = { key: "text", label: "Text", type: "text" };
const DESC = "Constant description";
function View() { return <div>{"x"}</div>; }
export const card: CardDef<P> = {
  id: "lit-card",
  name: "Literal card",
  description: DESC,
  defaults: {
    ...BASE,
    text: "hi", tpl: \`template\`, width: W, neg: NEG, minus: -0.25, plus: +2, hex: 0x10, big: 1_000, exp: 1e3,
    on: true, off: false, nil: null, list: [1, "two", [3]], nested: { a: [1, { b: "c" }], "quoted-key": 1, 7: "seven" },
    paren: (5),
    cast: "x" as string,
    bad: foo(), bad2: \`a\${b}\`, bad3: W + 1, bad4: BASE.size, bad5: undefined, bad6: [1, foo()], bad7: { ok: 1, no: bar },
    [computed]: 1,
    method() { return 1; },
    color: "#000",
  },
  controls: [
    TEXT_CTRL,
    { key: "width", label: "Width", type: "number", min: -10, max: W, step: 0.5, extra: "dropped", required: false, hint: "Hint" },
    { key: "mode", label: "Mode", type: "select", options: OPTS },
    { key: "c", label: "Color", type: "color", required: true, hint: tr("Dynamic hint") },
    { key: "l", label: "Animation", type: "asset", kind: "lottie", options: LOTTIE_OPTIONS },
    { key: "p", label: "Particles", type: "asset", kind: "particles", options: [{ value: "/a.json", label: "A" }] },
    { key: labelKey, label: "key is not a literal", type: "text" },
    { key: "s2", label: t("x"), type: "text" },
    { key: "s3", label: "type is not a literal", type: T },
    { key: "s4", label: "Unknown type", type: "slider" },
    { key: "s5", label: "Bad option", type: "select", options: [{ value: "a", label: tr("a") }] },
    { key: "s6", label: "asset has no kind", type: "asset", options: [] },
    { label: "Missing key", type: "text" },
    { key: "n2", label: "min is not a literal", type: "number", min: calc(), max: 9 },
    makeControl("z"),
  ],
  Component: View,
};
export const second = {
  id: "second", name: "Second card",
  defaults: DEFAULTS_FROM_ELSEWHERE,
  controls: buildControls(),
  Component: View,
};
export const third = { id: "third", name: "Third card", defaults: {}, controls: [], Component: View };
const SHARED_CONTROLS = [{ key: "a", label: "A", type: "text" }];
export const fourth = { id: "fourth", name: "Fourth card", defaults: { a: "x" }, controls: [...SHARED_CONTROLS, { key: "b", label: "B", type: "color" }], Component: View };
`;
  const got = parseCardSource(src);
  assert.deepEqual(got.map((c) => c.id), ["lit-card", "second", "third", "fourth"]);
  const [lit, second, third, fourth] = got;
  assert.equal(lit.description, "Constant description", "Description accepts a file-level constant");
  assert.deepEqual(lit.defaults, {
    size: 12, color: "#000", text: "hi", tpl: "template", width: 200, neg: -3.5, minus: -0.25, plus: 2, hex: 16, big: 1000, exp: 1000,
    on: true, off: false, nil: null, list: [1, "two", [3]], nested: { a: [1, { b: "c" }], "quoted-key": 1, 7: "seven" }, paren: 5, cast: "x",
  }, "Unrecognized keys are dropped; spread goes first, later writes override");
  assert.deepEqual(lit.controls, [
    { key: "text", label: "Text", type: "text" },
    { key: "width", label: "Width", type: "number", required: false, hint: "Hint", min: -10, max: 200, step: 0.5 },
    { key: "mode", label: "Mode", type: "select", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { key: "c", label: "Color", type: "color", required: true },
    { key: "l", label: "Animation", type: "asset", kind: "lottie", options: [] },
    { key: "p", label: "Particles", type: "asset", kind: "particles", options: [{ value: "/a.json", label: "A" }] },
    { key: "n2", label: "min is not a literal", type: "number", max: 9 },
  ], "Per control: skip those whose key/type/label is unrecognized; if an individual field is unrecognized, drop that field");
  assert.equal(lit.controlsIncomplete, true);
  assert.deepEqual({ defaults: second.defaults, controls: second.controls, controlsIncomplete: second.controlsIncomplete }, { defaults: {}, controls: [], controlsIncomplete: true },
    "Whole defaults / controls is not a literal: no controls, flag controlsIncomplete");
  assert.equal(second.description, undefined);
  assert.deepEqual({ defaults: third.defaults, controls: third.controls, controlsIncomplete: third.controlsIncomplete }, { defaults: {}, controls: [], controlsIncomplete: false }, "Really no controls");
  assert.deepEqual(fourth.controls, [{ key: "a", label: "A", type: "text" }, { key: "b", label: "B", type: "color" }], "Spread a same-file constant inside an array");
  assert.equal(fourth.controlsIncomplete, false);
  // Constants mutually referencing into a cycle: no infinite loop, treated as unrecognized
  const loop = parseCardSource(`const A = B; const B = A; export const c = { id: "c", name: "Cycle", defaults: { a: A, ok: 1 }, controls: [], Component: V };`);
  assert.deepEqual(loop[0].defaults, { ok: 1 });
  // Shorthand properties referencing constants of the same name
  const short = parseCardSource(`const defaults = { k: 1 }; const controls = [{ key: "k", label: "k", type: "number" }]; export const c = { id: "c", name: "Shorthand", defaults, controls, Component: V };`);
  assert.deepEqual({ d: short[0].defaults, c: short[0].controls }, { d: { k: 1 }, c: [{ key: "k", label: "k", type: "number" }] });
});

test("isUserCardEntryKey: only accepts a .tsx one level under src/cards/user/", () => {
  assert.equal(isUserCardEntryKey("src/cards/user/a.tsx"), true);
  assert.equal(isUserCardEntryKey("src/cards/user/index.ts"), false);
  assert.equal(isUserCardEntryKey("src/cards/user/lib/b.tsx"), false);
  assert.equal(isUserCardEntryKey("src/cards/native/c.tsx"), false);
  assert.equal(isUserCardEntryKey(undefined), false);
});

test('Same-clip audio-visual source: read-only detection of embeddedAudio, Component and audio can coexist', () => {
  const [card] = parseCardSource('export const av = { id:"av", name:"Audio-visual", defaults:{}, controls:[], Component:()=>null, audio:()=>new Float32Array(4) };');
  assert.equal(card.embeddedAudio, true);
  const [sound] = parseCardSource('export const audio = { id:"sound", name:"Sound", defaults:{}, controls:[], audio:()=>new Float32Array(4) };');
  assert.equal(sound.embeddedAudio, undefined);
});
