/**
 * 在线浏览器模式下这台设备跑不了的卡(用户卡、素材效果卡、内容库同步来的用户卡)在父页一侧的判定(C10 契约第 9 节,2026-09-29 用户改语义)。
 * 跑:node --experimental-test-module-mocks --test src/editor/onlineUserCards.test.mjs
 *
 *   OU-01 `clipIdentityOf`:在线时不给它们身份(不测、查不到旧成本记录、查不到声明的帧模式);桌面照旧;同步表变了跟着变;
 *         两边都没有定义的未知卡片桌面与在线都不给身份
 *   OU-05 未知卡片:不测、不当重卡、不进预渲染集合(桌面与在线一致);定义到了(热更新 / 同步到了)就照常进表
 *   OU-02 `planDispatch`:它们一律判重、进预渲染集合(页面发布的清单计划据此含它们),哪怕 L2 里留着判轻的旧记录;
 *         同步表后到也重算;没有定义的同步卡不让算表崩
 *   OU-03 时间轴:标签依次取构建时名字 → 同步名字 →「未知卡片」;徽标只在「在线、本机跑不了、没覆盖整段」三者同时成立时出
 *   OU-04 卡片源码同步(`sync/onlineCardSources.ts`):列、取、解析进注册表;哈希没变不再取正文;连接换了清表;取不到时表不动
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;

mock.module(srcUrl("editor/stageBridge.ts"), { exports: { frontStage: () => null, backStage: () => null } });
mock.module(srcUrl("render/cardSourceFiles.mjs"), { exports: { builtinCardSourceFiles: {}, cardSourceFilesVersion: () => 0 } });
mock.module(srcUrl("render/cardSourceVersion.mjs"), { exports: { cardSourceVersion: (card) => `v-${card.id}` } });

const R = await import(srcUrl("kernel/registry.ts"));
const H = await import(srcUrl("render/placeholderHost.ts"));
const CI = await import(srcUrl("editor/costIdentity.ts"));
const D = await import(srcUrl("editor/planDispatch.ts"));
const B = await import(srcUrl("editor/timeline/localPcBadge.ts"));
const S = await import(srcUrl("editor/sync/onlineCardSources.ts"));

const FPS = 30;
const dom = (id, extra = {}) => ({ id, name: `名-${id}`, defaults: {}, controls: [], frameMode: "direct", Component: () => null, ...extra });
function setup() {
  R.resetCards();
  R.registerCards([dom("builtin"), dom("mine", { name: "构建时用户卡" }), dom("graphish", { Component: undefined, card: () => ({}) })]);
  R.setUserCardSources({ mine: "" }, { mine: "mine" });
  R.setSyncedUserCards([]);
  CI.resetClipIdentityCache();
}
const clip = (id, cardId, start = 0, end = 2) => ({ id, cardId, start, end, params: {} });
const project = () => ({ version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: FPS, duration: 10, media: [],
  tracks: [{ id: "t", name: "t", clips: [clip("b", "builtin"), clip("u", "mine", 2, 4), clip("g", "graphish", 4, 6), clip("s", "synced-card", 6, 8), clip("x", "nobody", 8, 10)] }] });
const settle = () => new Promise((r) => setTimeout(r, 0));

test("OU-01 clipIdentityOf:在线时本页运行不了的卡没有身份,能运行的用户卡有;桌面照旧;同步表、运行状态、档位变了跟着变", () => {
  setup();
  const p = project();
  try {
    const desk = CI.clipIdentityOf(p);
    for (const id of ["b", "u"]) assert.ok(desk.identityKeys[id], `桌面:${id} 有身份`);
    for (const id of ["s", "x"]) assert.equal(desk.identityKeys[id], undefined, `桌面:${id} 两边都没有定义(未知卡片),不给身份、不测`);
    assert.ok(desk.frameModes.b && desk.frameModes.u);
    H.setOnlineBrowserMode(true);
    const on1 = CI.clipIdentityOf(p);
    assert.notEqual(on1, desk, "模式变了不用旧的记忆");
    assert.ok(on1.identityKeys.b, "内置卡照旧有身份");
    assert.equal(on1.identityKeys.s, undefined, "同步表还没到:s 还是未知卡片,不给身份(不测)");
    assert.equal(on1.identityKeys.x, undefined, "未知卡片不给身份");
    // 2026-10-06(online-card-exec-contract.md 第 6 节):构建时就在在线包里的仓库用户卡是页面自己的代码,本页能运行,照内置卡给身份
    assert.equal(on1.identityKeys.u, desk.identityKeys.u, "构建时的用户卡:有身份(与桌面同一个键)");
    assert.equal(on1.frameModes.u, "direct");
    assert.equal(on1.capabilities.has("u"), true);
    assert.equal(on1.identityKeys.g, undefined, "素材效果卡:没有身份(素材效果卡的在线执行还没放开)");
    R.setSyncedUserCards([{ id: "synced-card", name: "同步卡", defaults: { n: 1 } }]);
    const on2 = CI.clipIdentityOf(p);
    assert.equal(on2.identityKeys.s, undefined, "同步表到了、还没有运行状态:同步卡没有身份");
    assert.equal(on2.identityKeys.x, undefined, "两边都没有的 id 照旧没有身份");
    assert.equal(CI.clipIdentityOf(p), on2, "没变就用记忆");
    // 运行状态:只有 ready 才有身份;源码版本取这一代的短签名,换代换键
    for (const state of ["loading", "unsupported-syntax", "missing-module", "load-error", "gpu", "media", "runtime-error", "not-isolated"]) {
      R.setCardRunStates([["synced-card", { state }]]);
      assert.equal(CI.clipIdentityOf(p).identityKeys.s, undefined, `${state}:本页运行不了,没有身份`);
    }
    R.setCardRunStates([["synced-card", { state: "ready", version: "g1" }]]);
    const ready1 = CI.clipIdentityOf(p);
    assert.equal(typeof ready1.identityKeys.s, "string", "ready:有身份,照内置卡测");
    assert.equal(ready1.capabilities.has("s"), true);
    R.setCardRunStates([["synced-card", { state: "ready", version: "g2" }]]);
    assert.notEqual(CI.clipIdentityOf(p).identityKeys.s, ready1.identityKeys.s, "源码换代:身份跟着换(重新测量)");
    // 2026-10-21 起不按档另挡用户卡:构建时的用户卡本页能运行,最低一档、按界限搜索判时都照内置卡有身份(停下追精确帧)
    D.setPlanLowest(true);
    D.setPlanSearch(true);
    const low = CI.clipIdentityOf(p);
    assert.ok(low.identityKeys.u, "最低一档:构建时的用户卡照旧有身份");
    assert.ok(low.identityKeys.b, "最低一档:内置卡照旧有身份");
    D.setPlanLowest(false);
    D.setPlanSearch(false);
    assert.ok(CI.clipIdentityOf(p).identityKeys.u, "两样都关:照旧有");
  } finally {
    H.setOnlineBrowserMode(false);
    R.setSyncedUserCards([]);
    R.setCardRunStates([]);
    D.resetPlanDispatch();
  }
});

test("OU-02 planDispatch:在线时本页运行不了的卡一律判重、进预渲染集合,旧的判轻记录不认;能运行的用户卡按记录判;同步表、运行状态后到也重算", async () => {
  setup();
  const p = project();
  // 桌面口径的身份键 → 每张都有一条很轻的成本记录(模拟 L2 里以前在后台舞台上测过的旧记录)
  const keys = CI.clipIdentityOf(p).identityKeys;
  const lightRec = (key) => ({ identityKey: key, fps: FPS, device: "d", measuredAt: 1, stepMs: 0.2, kind: "random", vtOk: true, seekOk: true, seekMs: 0.2, catchUpMs: 0.2 });
  D.resetPlanDispatch();
  D.setPlanCosts(Object.values(keys).map(lightRec), null);
  D.setPlanProject(p);
  await settle();
  const desk = D.currentPlan().prerenderSet;
  for (const id of ["b", "u", "s", "x"]) assert.equal(desk.has(id), false, `桌面:${id} 按旧记录判轻`);
  try {
    H.setOnlineBrowserMode(true);
    CI.resetClipIdentityCache();
    D.setPlanCosts(Object.values(keys).map(lightRec), null);
    await settle();
    assert.deepEqual([...D.currentPlan().prerenderSet], ["g"], "在线:素材效果卡判重;构建时的用户卡本页能运行,按它的记录判轻;同步表还没到");
    R.setSyncedUserCards([{ id: "synced-card", name: "同步卡" }]);
    await settle();
    assert.deepEqual([...D.currentPlan().prerenderSet], ["g", "s"], "同步表到了、还没载入:没有定义的同步卡判重,算表不崩");
    // 页面发布的清单计划按 prerenderSet 取卡片段(Preview 的 clips()):含运行不了的同步卡
    const byId = new Map(p.tracks[0].clips.map((c) => [c.id, c]));
    assert.deepEqual([...D.currentPlan().prerenderSet].filter((id) => !!byId.get(id)?.cardId), ["g", "s"]);
    // 载入成功(运行状态 ready):有身份;还没有记录时按声明兜底(同步卡没有声明,判重),记录到了按记录判
    let planNotifications = 0;
    const offPlan = D.onPlanUpdated(() => { planNotifications++; });
    try {
      R.setCardRunStates([["synced-card", { state: "ready", version: "g1" }]]);
      await settle();
      assert.deepEqual([...D.currentPlan().prerenderSet], ["g", "s"], "刚载入成功、还没测:按声明兜底");
      assert.equal(planNotifications, 1, "运行状态变成 ready 时通知分派表已更新");
      D.mergePlanCosts([lightRec(CI.clipIdentityOf(p).identityKeys.s)]);
      await settle();
      assert.deepEqual([...D.currentPlan().prerenderSet], ["g"], "测完判轻:不进预渲染集合,活渲");
      assert.equal(planNotifications, 2, "测量记录并入后再次通知分派表已更新(Preview 据此重新结算暂停帧)");
    } finally {
      offPlan();
    }
    // 运行不了了(新一代转译失败):回到一律按重,手里那条判轻的记录不认
    R.setCardRunStates([["synced-card", { state: "unsupported-syntax", detail: "namespace" }]]);
    await settle();
    assert.deepEqual([...D.currentPlan().prerenderSet], ["g", "s"], "运行不了:判重");
    // 只有一个舞台按界限搜索判时(2026-10-21 起不按档另挡用户卡):构建时的用户卡照内置卡按界限搜索的结果判
    D.setPlanSearch(true);
    D.setPlanSearchLight([keys.b, keys.u]);
    await settle();
    assert.equal(D.judgedPlan().prerenderSet.has("u"), false, "按界限搜索判:构建时的用户卡照界限搜索的结果判轻");
    assert.equal(D.judgedPlan().prerenderSet.has("b"), false, "按界限搜索判:内置卡照界限搜索的结果判轻");
  } finally {
    H.setOnlineBrowserMode(false);
    R.setSyncedUserCards([]);
    R.setCardRunStates([]);
    D.resetPlanDispatch();
  }
});

test("OU-05 未知卡片(两边都没有定义):桌面与在线都不测、不当重卡、不进预渲染集合;定义到了照常进表", async () => {
  setup();
  // x 声明 stateful:没有成本记录时按声明兜底会判重 —— 未知卡片不能走到这一步
  const p = { ...project(), tracks: [{ id: "t", name: "t", clips: [clip("b", "builtin"), clip("x", "nobody", 0, 2)] }] };
  assert.equal(R.isKnownCardId("builtin"), true);
  assert.equal(R.isKnownCardId("mine"), true);
  assert.equal(R.isKnownCardId("nobody"), false);
  assert.deepEqual([...R.unknownCardClipIds([...p.tracks[0].clips, { id: "n", nodeId: "node-n", start: 0, end: 2 }])], ["x"], "只看写了 cardId 的片段;只有 nodeId 的不算");
  assert.equal(D.knownCardsOnly(project()).tracks[0].clips.some((c) => c.id === "x"), false);
  const plain = { ...project(), tracks: [{ id: "t", name: "t", clips: [clip("b", "builtin")] }] };
  assert.equal(D.knownCardsOnly(plain), plain, "没有未知卡片时原样回同一个对象");
  for (const online of [false, true]) {
    H.setOnlineBrowserMode(online);
    try {
      CI.resetClipIdentityCache();
      D.resetPlanDispatch();
      D.setPlanCosts([], null);
      D.setPlanProject(p);
      await settle();
      const tag = online ? "在线" : "桌面";
      assert.equal(CI.clipIdentityOf(p).identityKeys.x, undefined, `${tag}:未知卡片没有身份(测量不挑它)`);
      assert.ok(CI.clipIdentityOf(p).identityKeys.b, `${tag}:内置卡照旧有身份`);
      assert.equal(D.currentPlan().prerenderSet.has("x"), false, `${tag}:不进预渲染集合(清单计划不含它)`);
      assert.ok(!D.currentPlan().segments.some((sg) => sg.heavy.has("x") || sg.light.has("x")), `${tag}:分派表里没有它`);
      D.setPlanLowest(true);
      D.setPlanSearch(true);
      await settle();
      assert.equal(D.currentPlan().prerenderSet.has("x"), false, `${tag}:最低一档全部判重的显示表里也没有它`);
      assert.equal(D.judgedPlan().prerenderSet.has("x"), false, `${tag}:按界限搜索判的判定表里也没有它`);
      D.setPlanLowest(false);
      D.setPlanSearch(false);
      await settle();
    } finally {
      H.setOnlineBrowserMode(false);
    }
  }
  // 定义到了(热更新装上这张卡):照常给身份、按声明兜底判重
  D.resetPlanDispatch();
  D.setPlanCosts([], null);
  D.setPlanProject(p);
  await settle();
  R.registerCards([dom("nobody", { frameMode: "stateful" })]);
  R.noteCardsUpdated(1);
  await settle();
  assert.ok(CI.clipIdentityOf(p).identityKeys.x, "定义到了:有身份");
  assert.equal(D.currentPlan().prerenderSet.has("x"), true, "定义到了:没有成本记录按声明 stateful 判重");
  D.resetPlanDispatch();
});

test("OU-03 时间轴:标签;不再有「需要本地 PC 渲染辅助」徽标(2026-10-21 用户定撤掉)", () => {
  setup();
  R.setSyncedUserCards([{ id: "synced-card", name: "探针同步卡" }, { id: "builtin", name: "撞内置" }]);
  try {
    assert.equal(B.clipCardLabel(R.knownCardName("mine")), "构建时用户卡");
    assert.equal(B.clipCardLabel(R.knownCardName("synced-card")), "探针同步卡");
    assert.equal(B.clipCardLabel(R.knownCardName("builtin")), "名-builtin", "撞车的同步条目忽略");
    assert.equal(B.clipCardLabel(R.knownCardName("nobody")), "未知卡片");
    assert.equal(B.showLocalPcBadge, undefined, "徽标的判定撤掉了");
  } finally {
    R.setSyncedUserCards([]);
  }
});

/** 假的内容库:card-source 一类的 list / get */
function fakeContent(items) {
  const store = new Map(Object.entries(items));
  const sent = [];
  let fail = false;
  return {
    sent, store,
    setFail(v) { fail = v; },
    request: async (msg) => {
      sent.push(msg);
      if (fail) throw new Error("没连上文档服务");
      if (msg.type === "content.list") {
        const keys = [...store.keys()].filter((k) => k.startsWith(msg.prefix)).sort();
        return { type: "content.listing", kind: msg.kind, items: keys.map((key) => ({ key, hash: `h:${store.get(key).length}:${store.get(key).slice(-12)}`, rev: 1 })), truncated: false };
      }
      if (msg.type === "content.get") {
        if (!store.has(msg.key)) return { type: "content.item", kind: msg.kind, key: msg.key, missing: true };
        const body = store.get(msg.key);
        return { type: "content.item", kind: msg.kind, key: msg.key, body, hash: `h:${body.length}:${body.slice(-12)}`, rev: 1 };
      }
      return { type: "error" };
    },
  };
}
const cardSrc = (id, name) => `import type { CardDef } from "../../kernel/types";\nexport const c: CardDef = { id: "${id}", name: "${name}", defaults: {}, controls: [], Component: () => null };\n`;

test("OU-04 卡片源码同步:列、取、解析进注册表;哈希没变不取正文;只认 src/cards/user/ 下一层的 .tsx;连接换了清表;取不到时表不动", async () => {
  setup();
  const content = fakeContent({
    "src/cards/user/a.tsx": cardSrc("synced-a", "同步甲"),
    "src/cards/user/b.tsx": cardSrc("synced-b", "同步乙") + cardSrc("synced-b2", "同步乙二").replace("export const c", "export const c2"),
    "src/cards/user/lib/helper.tsx": cardSrc("not-entry", "不是入口"),
    "src/cards/user/_scopes.json": "{}",
  });
  let link = { id: 1 };
  let changes = 0;
  const sources = new S.OnlineCardSources({ request: content.request, linkKey: () => link, onChange: () => changes++ });
  try {
    await sources.sync();
    assert.deepEqual([...R.syncedUserCards().keys()].sort(), ["synced-a", "synced-b", "synced-b2"]);
    assert.equal(R.knownCardName("synced-b2"), "同步乙二");
    assert.equal(R.syncedUserCards().get("synced-a").source, "src/cards/user/a.tsx");
    assert.equal(R.isUserCardId("not-entry"), false, "子目录里的不是入口文件");
    assert.equal(content.sent.filter((m) => m.type === "content.get").length, 2);
    assert.deepEqual(content.sent[0], { type: "content.list", kind: "card-source", prefix: "src/cards/user/" });
    assert.equal(changes, 1);
    // 再来一轮:哈希没变,不再取正文,不通知
    await sources.sync();
    assert.equal(content.sent.filter((m) => m.type === "content.get").length, 2);
    assert.equal(changes, 1);
    // 改名:只取那一条
    content.store.set("src/cards/user/a.tsx", cardSrc("synced-a", "同步甲改名"));
    await sources.sync();
    assert.equal(content.sent.filter((m) => m.type === "content.get").length, 3);
    assert.equal(R.knownCardName("synced-a"), "同步甲改名");
    // 取不到:表不动
    content.setFail(true);
    await sources.sync();
    assert.equal(R.syncedUserCards().size, 3);
    assert.ok(sources.debug().errors > 0);
    content.setFail(false);
    // 连接换了(换项目):先清表,再按新连接重取
    content.store.delete("src/cards/user/b.tsx");
    link = { id: 2 };
    await sources.sync();
    assert.deepEqual([...R.syncedUserCards().keys()], ["synced-a"]);
    // 离开共享项目:清空
    link = null;
    await sources.sync();
    assert.equal(R.syncedUserCards().size, 0);
  } finally {
    sources.stop();
    R.setSyncedUserCards([]);
  }
});

test("OU-04b entriesOf:按键排序,同一 id 取第一条", () => {
  const parsed = new Map([["src/cards/user/b.tsx", [{ id: "x", name: "乙里的 x" }]], ["src/cards/user/a.tsx", [{ id: "x", name: "甲里的 x" }, { id: "y", name: "y" }]]]);
  assert.deepEqual(S.entriesOf(["src/cards/user/b.tsx", "src/cards/user/a.tsx"], parsed), [
    { id: "x", name: "甲里的 x", source: "src/cards/user/a.tsx" },
    { id: "y", name: "y", source: "src/cards/user/a.tsx" },
  ]);
});

test("OU-04c 同步来的卡带上说明、默认值与控件:参数面板经 syncedCardView 看得到;主注册表照旧看不到", async () => {
  setup();
  const src = `import type { CardDef } from "../../kernel/types";
const OPTS = [{ value: "l", label: "左" }, { value: "r", label: "右" }];
export const c: CardDef = {
  id: "synced-p", name: "带参数的同步卡", description: "说明",
  defaults: { text: "hi", size: 48, side: "l", tint: "#ff0000" },
  controls: [
    { key: "text", label: "文字", type: "text" },
    { key: "size", label: "字号", type: "number", min: 12, max: 200, step: 2 },
    { key: "side", label: "位置", type: "select", options: OPTS },
    { key: "tint", label: "颜色", type: "color" },
  ],
  Component: () => null,
};
export const opaque: CardDef = { id: "synced-o", name: "控件认不出", defaults: {}, controls: makeControls(), Component: () => null };
`;
  const content = fakeContent({ "src/cards/user/p.tsx": src });
  const link = { id: 1 };
  const sources = new S.OnlineCardSources({ request: content.request, linkKey: () => link });
  try {
    await sources.sync();
    const v = R.syncedCardView("synced-p");
    assert.equal(v.name, "带参数的同步卡");
    assert.equal(v.description, "说明");
    assert.deepEqual(v.defaults, { text: "hi", size: 48, side: "l", tint: "#ff0000" });
    assert.deepEqual(v.controls.map((c) => c.type), ["text", "number", "select", "color"]);
    assert.deepEqual(v.controls[2].options, [{ value: "l", label: "左" }, { value: "r", label: "右" }]);
    assert.equal(v.controlsIncomplete, false);
    assert.equal(R.syncedCardView("synced-o").controlsIncomplete, true);
    assert.deepEqual(R.syncedCardView("synced-o").controls, []);
    assert.equal(R.getCard("synced-p"), undefined);
  } finally {
    sources.stop();
    R.setSyncedUserCards([]);
  }
});

test("OU-06 跟着 import 取同目录下被引的文件:只取被引到的;被引文件改了重取重解析;有环不重取;引不到的说明是哪一条;内置模块经 builtins", async () => {
  setup();
  const entry = `import type { CardDef } from "../../kernel/types";
import { SHARED } from "./shared";
import { MORE } from "./lib/more";
import { GONE } from "./gone";
import { hudControls } from "../native/hud";
export const c: CardDef = { id: "synced-i", name: "引控件的同步卡", defaults: { text: "t" },
  controls: [...SHARED, ...MORE, ...GONE, ...hudControls], Component: () => null };
`;
  const content = fakeContent({
    "src/cards/user/i.tsx": entry,
    "src/cards/user/shared.ts": `import { MORE } from "./lib/more";\nexport const SHARED = [{ key: "text", label: "文字", type: "text" }];\nexport const ECHO = MORE;\n`,
    "src/cards/user/lib/more.ts": `import { ECHO } from "../shared";\nexport const MORE = [{ key: "side", label: "位置", type: "select", options: ["l", "r"] }];\n`,
    "src/cards/user/unused.ts": `export const X = 1;\n`,
  });
  const link = { id: 1 };
  const builtins = (k) => (k === "src/cards/native/hud.ts" ? { hudControls: [{ key: "accent", label: "主色", type: "color" }] } : null);
  const sources = new S.OnlineCardSources({ request: content.request, linkKey: () => link, builtins });
  const gets = () => content.sent.filter((m) => m.type === "content.get").map((m) => m.key);
  try {
    await sources.sync();
    assert.deepEqual(gets().sort(), ["src/cards/user/i.tsx", "src/cards/user/lib/more.ts", "src/cards/user/shared.ts"], "没被引到的 unused.ts 不取;环上的不重取");
    const v = R.syncedCardView("synced-i");
    assert.deepEqual(v.controls.map((c) => c.key), ["text", "side", "accent"]);
    assert.deepEqual(v.controls[1].options, [{ value: "l", label: "l" }, { value: "r", label: "r" }]);
    assert.equal(v.controlsIncomplete, true);
    assert.equal(v.skippedControls.length, 1);
    assert.match(v.skippedControls[0].reason, /展开的 GONE 取不到:内容库里没有 \.\/gone 这个文件/);
    assert.deepEqual(sources.debug().deps, ["src/cards/user/lib/more.ts", "src/cards/user/shared.ts"]);
    // 再来一轮:都没变,不取
    await sources.sync();
    assert.equal(gets().length, 3);
    // 被引文件改了:只重取它,入口重解析
    content.store.set("src/cards/user/shared.ts", `export const SHARED = [{ key: "text", label: "文字改了", type: "text" }, { key: "n", label: "数", type: "number" }];\n`);
    await sources.sync();
    assert.deepEqual(gets().slice(3), ["src/cards/user/shared.ts"]);
    assert.deepEqual(R.syncedCardView("synced-i").controls.map((c) => c.label), ["文字改了", "数", "位置", "主色"]);
    // 缺的文件后来同步上来了:取到、补上,提示撤掉
    content.store.set("src/cards/user/gone.ts", `export const GONE = [];\n`);
    await sources.sync();
    assert.equal(R.syncedCardView("synced-i").controlsIncomplete, false);
    assert.deepEqual(R.syncedCardView("synced-i").skippedControls, []);
    // 被引文件从内容库里删了:回到提示
    content.store.delete("src/cards/user/lib/more.ts");
    await sources.sync();
    const v2 = R.syncedCardView("synced-i");
    assert.deepEqual(v2.controls.map((c) => c.key), ["text", "n", "accent"]);
    assert.match(v2.skippedControls[0].reason, /MORE 取不到/);
  } finally {
    sources.stop();
    R.setSyncedUserCards([]);
  }
});
