/**
 * 卡片源码解析(`cardSourceParse.mjs`,C10 契约第 9 节「识别」)的单测。跑:
 *   node --test src/kernel/cardSourceParse.test.mjs
 *
 * 夹具:
 *   1. 仓库里**每一个** `src/cards/user/*.tsx`:解析结果与注册表里那个文件的卡(`userCards` / `userCardFileOf`,经 vite 真的载入)逐个相同;
 *   2. 更宽的语料:`src/cards/` 下全部 `.tsx`(内置卡与用户卡同一种写法),解析结果与模块的具名导出里长得像 CardDef 的逐个相同;
 *   3. 手写的边角:注释 / 字符串 / 模板里写着的「卡」、JSX 文字里的撇号、正则、泛型、`export { a as b }`、默认导出、常量 id、
 *      展开、缺字段的对象、方法写法。
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
/** 只比 id 与名字(识别那一层;默认值与控件另有专门的用例) */
const idName = (a) => a.map(({ id, name }) => ({ id, name }));
const isCardDef = (c) => !!c && typeof c === "object" && typeof c.id === "string" && typeof c.name === "string" && typeof c.defaults === "object"
  && Array.isArray(c.controls) && (typeof c.Component === "function" || typeof c.card === "function" || typeof c.audio === "function");

async function withVite(fn) {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { return await fn(server); } finally { await server.close(); }
}

test("仓库里每一个 src/cards/user/*.tsx:解析结果与注册表里那个文件的卡逐个相同", async () => withVite(async (server) => {
  const user = await server.ssrLoadModule("/src/cards/user/index.ts");
  const dir = path.join(ROOT, "src/cards/user");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  assert.ok(files.length > 0, "仓库里至少有一张用户卡");
  let cards = 0;
  for (const f of files) {
    const base = f.replace(/\.tsx$/, "");
    const want = user.userCards.filter((c) => user.userCardFileOf[c.id] === base).map((c) => ({ id: c.id, name: c.name }));
    const got = parseCardSource(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.deepEqual(byId(idName(got)), byId(want), `${f} 的解析结果与注册表不一致`);
    // 用户卡的默认值、控件、说明:逐字相同(仓库里的用户卡都写成字面量)
    for (const g of got) {
      const real = user.userCards.find((c) => c.id === g.id);
      assert.deepEqual(g.defaults, real.defaults, `${f} ${g.id} 的 defaults`);
      assert.deepEqual(g.controls, real.controls, `${f} ${g.id} 的 controls`);
      assert.equal(g.controlsIncomplete, false, `${f} ${g.id} 的控件全认出`);
      assert.equal(g.description, typeof real.description === "string" ? real.description : undefined, `${f} ${g.id} 的 description`);
    }
    assert.ok(isUserCardEntryKey(`src/cards/user/${f}`));
    cards += want.length;
  }
  assert.equal(cards, user.userCards.length, "注册表里每一张用户卡都出自某个文件、都被解析到");
}));

test("更宽的语料:src/cards 下全部 .tsx 的解析结果与模块导出的 CardDef 逐个相同", async () => withVite(async (server) => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith(".tsx")) files.push(f); } };
  walk(path.join(ROOT, "src/cards"));
  assert.ok(files.length >= 20, `语料不该太少:${files.length}`);
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
    // 默认值与控件:认出来的与模块里的一致;没认出来的控件一定标了 controlsIncomplete
    for (const g of got) {
      const real = Object.values(mod).find((v) => isCardDef(v) && v.id === g.id);
      for (const [k, v] of Object.entries(g.defaults)) assert.deepEqual(v, real.defaults[k], `${rel} ${g.id} defaults.${k}`);
      for (const c of g.controls) {
        const rc = real.controls.find((x) => x.key === c.key);
        assert.ok(rc, `${rel} ${g.id} 多出来的控件 ${c.key}`);
        for (const [field, v] of Object.entries(c)) {
          if (field === "options" && c.type === "asset" && v.length === 0) continue; // asset 的选项认不出时按空表
          assert.deepEqual(v, rc[field], `${rel} ${g.id} controls.${c.key}.${field}`);
        }
      }
      if (g.controls.length < real.controls.length) assert.equal(g.controlsIncomplete, true, `${rel} ${g.id} 有控件没认出却没标`);
      if (typeof g.description === "string") assert.equal(g.description, real.description, `${rel} ${g.id} description`);
      stats.cards++;
      if (!g.controlsIncomplete && g.controls.length === real.controls.length) stats.complete++;
      stats.controls += real.controls.length;
      stats.parsed += g.controls.length;
    }
  }
  assert.ok(cards >= 20, `语料里的卡不该太少:${cards}`);
  /*
   * 防止解析器悄悄退化成什么都认不出。内置卡很多展开了从别的文件引进来的 `hudControls`(不是同文件的字面量,按规矩认不出,
   * 标 controlsIncomplete),所以这里只要求大头认得出(2026-09-29 实测:39 张卡、17 张全认出,166 个控件认出 125 个)。
   */
  assert.ok(stats.complete >= 10, `控件全认出的卡太少:${JSON.stringify(stats)}`);
  assert.ok(stats.parsed >= stats.controls * 0.6, `认出的控件太少:${JSON.stringify(stats)}`);
}));

const CARD = (id, name, extra = "") => `export const c_${id.replace(/\W/g, "_")}: CardDef<P> = {
  id: "${id}",
  name: "${name}",${extra}
  defaults: { text: "x" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: View,
};`;

test("边角:注释、字符串、模板里的「卡」不算;JSX 文字里的撇号、正则、泛型不打乱后面的解析", () => {
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
${CARD("real-card", "真卡")}
`;
  assert.deepEqual(idName(parseCardSource(src)), [{ id: "real-card", name: "真卡" }]);
});

test("边角:export { a as b }、默认导出、常量 id、展开、方法写法、多张卡、同 id 只留第一张", () => {
  const src = `
const ID = "const-id";
const NAME: string = "常量名";
const base = { id: "base-card", name: "底卡", defaults: {}, controls: [], Component: V };
const hidden = { id: "hidden-card", name: "没导出", defaults: {}, controls: [], Component: V };
const aliased = { id: "alias-card", name: "别名导出", defaults: {}, controls: [], card(sources) { return sources; } };
export const fromConst = { id: ID, name: NAME, defaults: {}, controls: [], audio: (s) => s };
export const spreadCard = { ...base, id: "spread-card", name: "展开卡" };
export const dup = { id: "const-id", name: "重复", defaults: {}, controls: [], Component: V };
export { aliased as renamed, base };
export default { id: "default-card", name: \`默认\`, defaults: {}, controls: [], Component };
`;
  assert.deepEqual(byId(idName(parseCardSource(src))), byId([
    { id: "const-id", name: "常量名" },
    { id: "spread-card", name: "展开卡" },
    { id: "alias-card", name: "别名导出" },
    { id: "base-card", name: "底卡" },
    { id: "default-card", name: "默认" },
  ]));
});

test("边角:缺字段、值不是字面量、坏源码 → 不算卡,不抛", () => {
  assert.deepEqual(parseCardSource(`export const a = { id: "a", name: "x", controls: [], Component: V };`), [], "缺 defaults");
  assert.deepEqual(parseCardSource(`export const a = { id: "a", name: "x", defaults: {} , Component: V };`), [], "缺 controls");
  assert.deepEqual(parseCardSource(`export const a = { id: "a", name: "x", defaults: {}, controls: [] };`), [], "缺组件");
  assert.deepEqual(parseCardSource(`export const a = { id: makeId(), name: "x", defaults: {}, controls: [], Component: V };`), [], "id 不是字面量");
  assert.deepEqual(parseCardSource(`export const a = { id: \`a-\${n}\`, name: "x", defaults: {}, controls: [], Component: V };`), [], "带替换的模板");
  assert.deepEqual(parseCardSource(`export const a = defineCard({ id: "a", name: "x", defaults: {}, controls: [], Component: V });`), [], "包在函数里");
  assert.deepEqual(idName(parseCardSource(`export const a = { id: "a", name: "x", defaults: {}, controls: [], Component: V`)), [{ id: "a", name: "x" }], "截断的源码尽量认");
  for (const junk of ["", "{{{{", "`${", "/*", "<div>", "export const", "export {"]) assert.deepEqual(parseCardSource(junk), [], JSON.stringify(junk));
  assert.deepEqual(parseCardSource(null), []);
  assert.deepEqual(idName(parseCardSource(`export const a = { "id": 'q\\'s', 'name': "转义\\u4e2d\\n", defaults: {}, controls: [], Component: V } as const;`)), [{ id: "q's", name: "转义中\n" }], "引号键与转义");
});

test("没闭合的 \\u{ 转义:不卡死,余下原样留下(以前会从头重扫、无限循环,在线页面卡死)", () => {
  const t0 = Date.now();
  assert.deepEqual(idName(parseCardSource(`export const a = { id: "a", name: "坏\\u{41", defaults: {}, controls: [], Component: V };`)), [{ id: "a", name: "坏u{41" }]);
  assert.deepEqual(idName(parseCardSource(`export const a = { id: "a", name: "好\\u{41}", defaults: {}, controls: [], Component: V };`)), [{ id: "a", name: "好A" }], "闭合的照常解");
  assert.ok(Date.now() - t0 < 1000, `解析用了 ${Date.now() - t0} ms`);
});

test("默认值与控件:各种字面量、同文件常量的引用与展开;认不出的键、字段、控件按规矩丢", () => {
  const src = `
import type { CardDef } from "../../kernel/types";
import { LOTTIE_OPTIONS } from "../catalogAssets";
const W = 200
const NEG = -3.5;
const OPTS = [{ value: "a", label: "甲" }, { value: "b", label: \`乙\` }] as const;
const BASE = { size: 12, color: "#fff" };
const TEXT_CTRL = { key: "text", label: "文字", type: "text" };
const DESC = "常量说明";
function View() { return <div>{"x"}</div>; }
export const card: CardDef<P> = {
  id: "lit-card",
  name: "字面量卡",
  description: DESC,
  defaults: {
    ...BASE,
    text: "hi", tpl: \`模板\`, width: W, neg: NEG, minus: -0.25, plus: +2, hex: 0x10, big: 1_000, exp: 1e3,
    on: true, off: false, nil: null, list: [1, "二", [3]], nested: { a: [1, { b: "c" }], "quoted-key": 1, 7: "seven" },
    paren: (5),
    cast: "x" as string,
    bad: foo(), bad2: \`a\${b}\`, bad3: W + 1, bad4: BASE.size, bad5: undefined, bad6: [1, foo()], bad7: { ok: 1, no: bar },
    [computed]: 1,
    method() { return 1; },
    color: "#000",
  },
  controls: [
    TEXT_CTRL,
    { key: "width", label: "宽", type: "number", min: -10, max: W, step: 0.5, extra: "丢掉", required: false, hint: "提示" },
    { key: "mode", label: "模式", type: "select", options: OPTS },
    { key: "c", label: "色", type: "color", required: true, hint: tr("动态提示") },
    { key: "l", label: "动画", type: "asset", kind: "lottie", options: LOTTIE_OPTIONS },
    { key: "p", label: "粒子", type: "asset", kind: "particles", options: [{ value: "/a.json", label: "甲" }] },
    { key: labelKey, label: "key 不是字面量", type: "text" },
    { key: "s2", label: t("x"), type: "text" },
    { key: "s3", label: "type 不是字面量", type: T },
    { key: "s4", label: "未知类型", type: "slider" },
    { key: "s5", label: "选项有坏的", type: "select", options: [{ value: "a", label: tr("a") }] },
    { key: "s6", label: "asset 没有 kind", type: "asset", options: [] },
    { label: "缺 key", type: "text" },
    { key: "n2", label: "min 不是字面量", type: "number", min: calc(), max: 9 },
    makeControl("z"),
  ],
  Component: View,
};
export const second = {
  id: "second", name: "第二张",
  defaults: DEFAULTS_FROM_ELSEWHERE,
  controls: buildControls(),
  Component: View,
};
export const third = { id: "third", name: "第三张", defaults: {}, controls: [], Component: View };
const SHARED_CONTROLS = [{ key: "a", label: "甲", type: "text" }];
export const fourth = { id: "fourth", name: "第四张", defaults: { a: "x" }, controls: [...SHARED_CONTROLS, { key: "b", label: "乙", type: "color" }], Component: View };
`;
  const got = parseCardSource(src);
  assert.deepEqual(got.map((c) => c.id), ["lit-card", "second", "third", "fourth"]);
  const [lit, second, third, fourth] = got;
  assert.equal(lit.description, "常量说明", "说明认同文件常量");
  assert.deepEqual(lit.defaults, {
    size: 12, color: "#000", text: "hi", tpl: "模板", width: 200, neg: -3.5, minus: -0.25, plus: 2, hex: 16, big: 1000, exp: 1000,
    on: true, off: false, nil: null, list: [1, "二", [3]], nested: { a: [1, { b: "c" }], "quoted-key": 1, 7: "seven" }, paren: 5, cast: "x",
  }, "认不出的键丢掉;展开先铺、后写的覆盖");
  assert.deepEqual(lit.controls, [
    { key: "text", label: "文字", type: "text" },
    { key: "width", label: "宽", type: "number", required: false, hint: "提示", min: -10, max: 200, step: 0.5 },
    { key: "mode", label: "模式", type: "select", options: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }] },
    { key: "c", label: "色", type: "color", required: true },
    { key: "l", label: "动画", type: "asset", kind: "lottie", options: [] },
    { key: "p", label: "粒子", type: "asset", kind: "particles", options: [{ value: "/a.json", label: "甲" }] },
    { key: "n2", label: "min 不是字面量", type: "number", max: 9 },
  ], "逐个控件:key/type/label 认不出的跳过;个别字段认不出丢掉那个字段");
  assert.equal(lit.controlsIncomplete, true);
  assert.deepEqual({ defaults: second.defaults, controls: second.controls, controlsIncomplete: second.controlsIncomplete }, { defaults: {}, controls: [], controlsIncomplete: true },
    "整个 defaults / controls 不是字面量:没有控件、标 controlsIncomplete");
  assert.equal(second.description, undefined);
  assert.deepEqual({ defaults: third.defaults, controls: third.controls, controlsIncomplete: third.controlsIncomplete }, { defaults: {}, controls: [], controlsIncomplete: false }, "真没有控件");
  assert.deepEqual(fourth.controls, [{ key: "a", label: "甲", type: "text" }, { key: "b", label: "乙", type: "color" }], "数组里展开同文件的常量");
  assert.equal(fourth.controlsIncomplete, false);
  // 常量互相引用成环:不死循环,当认不出
  const loop = parseCardSource(`const A = B; const B = A; export const c = { id: "c", name: "环", defaults: { a: A, ok: 1 }, controls: [], Component: V };`);
  assert.deepEqual(loop[0].defaults, { ok: 1 });
  // 简写属性引用同名常量
  const short = parseCardSource(`const defaults = { k: 1 }; const controls = [{ key: "k", label: "k", type: "number" }]; export const c = { id: "c", name: "简写", defaults, controls, Component: V };`);
  assert.deepEqual({ d: short[0].defaults, c: short[0].controls }, { d: { k: 1 }, c: [{ key: "k", label: "k", type: "number" }] });
});

test("isUserCardEntryKey:只认 src/cards/user/ 下一层的 .tsx", () => {
  assert.equal(isUserCardEntryKey("src/cards/user/a.tsx"), true);
  assert.equal(isUserCardEntryKey("src/cards/user/index.ts"), false);
  assert.equal(isUserCardEntryKey("src/cards/user/lib/b.tsx"), false);
  assert.equal(isUserCardEntryKey("src/cards/native/c.tsx"), false);
  assert.equal(isUserCardEntryKey(undefined), false);
});

test('声画同片段源码只读识别embeddedAudio，Component与audio可共存', () => {
  const [card] = parseCardSource('export const av = { id:"av", name:"声画", defaults:{}, controls:[], Component:()=>null, audio:()=>new Float32Array(4) };');
  assert.equal(card.embeddedAudio, true);
  const [sound] = parseCardSource('export const audio = { id:"sound", name:"声音", defaults:{}, controls:[], audio:()=>new Float32Array(4) };');
  assert.equal(sound.embeddedAudio, undefined);
});
