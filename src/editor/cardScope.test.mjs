/**
 * 卡片三档可见性的单测。跑:node --test src/editor/cardScope.test.mjs
 *
 * 这段逻辑是「定制卡从上个项目串过来」那个 bug 的唯一修复点,而它错了**不报错** ——
 * 只是 Agent 的 list_cards 里多出或少了几张卡,要等成片做错了才发现。所以钉死:
 *   - 项目素材只在建它的那个项目里出现;
 *   - 老卡(表里没条目)**不许消失**,悄悄少几张比泄露更难查;
 *   - 拿不到归属表时一律放行,一次网络抖动不该让 Agent 突然无卡可用。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isCardVisible, usedCardIds, localCardImports } from "./cardScope.ts";

const V = { base: true, groups: { native: true, magicui: true, asset: true }, custom: true, project: true };
const card = (id, source) => ({ id, source, name: id, description: "", defaults: {}, controls: [], Component: () => null });

test("内置卡按组开关,和归属表无关", () => {
  const n = card("odometer", "native");
  const m = card("mu-x", "magicui");
  const a = card("lottie-x", "asset");
  assert.equal(isCardVisible(n, V, {}, "p1"), true);
  assert.equal(isCardVisible(m, V, {}, "p1"), true);
  assert.equal(isCardVisible(a, V, {}, "p1"), true);

  const noMagic = { ...V, groups: { ...V.groups, magicui: false } };
  assert.equal(isCardVisible(m, noMagic, {}, "p1"), false, "关掉第三方组之后 mu- 卡就不该出现");
  assert.equal(isCardVisible(n, noMagic, {}, "p1"), true, "别的组不受影响");

  assert.equal(isCardVisible(n, { ...V, base: false }, {}, "p1"), false, "基础总开关关掉就都不出现");
});

test("项目素材只在建它的那个项目里出现 —— 这就是那个泄露", () => {
  const logo = card("logo-3d-9tian", "user");
  const scopes = { "logo-3d-9tian": { scope: "project", projectId: "客户A" } };
  assert.equal(isCardVisible(logo, V, scopes, "客户A"), true, "在它自己的项目里要看得见");
  assert.equal(isCardVisible(logo, V, scopes, "客户B"), false, "换个项目就不该再出现");
  assert.equal(isCardVisible(logo, V, scopes, null), false, "没有当前项目时也不该漏出去");
});

test("标成自定义的定制卡跨项目可见,关掉那一档就全隐藏", () => {
  const brand = card("brand-logo", "user");
  const scopes = { "brand-logo": { scope: "custom", projectId: "客户A" } };
  assert.equal(isCardVisible(brand, V, scopes, "客户B"), true, "共享卡就是要能跨项目用");
  assert.equal(isCardVisible(brand, { ...V, custom: false }, scopes, "客户B"), false);
});

test("关掉项目素材那一档,本项目的定制卡也隐藏(用于「这轮只用现成的卡」)", () => {
  const c = card("x", "user");
  const scopes = { x: { scope: "project", projectId: "p1" } };
  assert.equal(isCardVisible(c, V, scopes, "p1"), true);
  assert.equal(isCardVisible(c, { ...V, project: false }, scopes, "p1"), false);
});

test("老卡(表里没条目)不许消失 —— 悄悄少几张比泄露更难查", () => {
  const old = card("vertical-trend", "user");
  assert.equal(isCardVisible(old, V, {}, "任何项目"), true);
  // 但它按「自定义」处理,所以关掉自定义那一档就能一次性清干净
  assert.equal(isCardVisible(old, { ...V, custom: false }, {}, "任何项目"), false);
});

test("归属表拿不到时一律放行:一次网络抖动不该让 Agent 突然无卡可用", () => {
  const c = card("whatever", "user");
  assert.equal(isCardVisible(c, V, {}, "p1"), true);
});

test("记了档位但没记项目 id 的老数据,按本项目算,不藏", () => {
  const c = card("y", "user");
  assert.equal(isCardVisible(c, V, { y: { scope: "project" } }, "p1"), true);
});

test("时间轴上正用着的定制卡算本项目的,不管归属表记的是哪个项目 id", () => {
  // 东京七日那份 .proc:卡记在草稿 20260910-wu2hng 名下,从桌面打开时根本没有草稿 id
  const map = card("tokyo7-map", "user");
  const scopes = { "tokyo7-map": { scope: "project", projectId: "20260910-wu2hng" } };
  const used = new Set(["tokyo7-map"]);
  assert.equal(isCardVisible(map, V, scopes, null), false, "不看用没用到时,它就是被藏起来的那张");
  assert.equal(isCardVisible(map, V, scopes, null, used), true, "片子里正用着,卡库里就得看得见");
  assert.equal(isCardVisible(map, V, scopes, "p-别的", used), true);
  assert.equal(isCardVisible(map, { ...V, project: false }, scopes, null, used), false, "关掉项目素材那一档照样藏");
  assert.equal(isCardVisible(card("other", "user"), V, { other: { scope: "project", projectId: "x" } }, null, used), false, "没用到的别人家的卡照旧不漏");
});

test("usedCardIds 扫所有剪辑:激活的在 tracks,停放的在 cuts[].tracks", () => {
  const p = {
    tracks: [{ clips: [{ cardId: "a" }, { mediaId: "m" }] }],
    cuts: [{ id: "cut-1" }, { id: "cut-2", tracks: [{ clips: [{ cardId: "b" }, { cardId: "a" }] }] }],
  };
  assert.deepEqual([...usedCardIds(p)].sort(), ["a", "b"]);
  assert.deepEqual([...usedCardIds({})], []);
});

test("localCardImports 只认同目录的文件,顺带把 .tsx 后缀去掉", () => {
  const src = `import { a } from "./shared-bits";\nimport x from "./logo.tsx";\nimport "./side";\nimport { m } from "motion/react";\nimport t from "../../kernel/types";`;
  assert.deepEqual(localCardImports(src).sort(), ["logo", "shared-bits", "side"]);
});
