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
const dom = (id, extra = {}) => ({ id, name: `Name-${id}`, defaults: {}, controls: [], frameMode: "direct", Component: () => null, ...extra });
function setup() {
  R.resetCards();
  R.registerCards([dom("builtin"), dom("mine", { name: "Build-time user card" }), dom("graphish", { Component: undefined, card: () => ({}) })]);
  R.setUserCardSources({ mine: "" }, { mine: "mine" });
  R.setSyncedUserCards([]);
  CI.resetClipIdentityCache();
}
const clip = (id, cardId, start = 0, end = 2) => ({ id, cardId, start, end, params: {} });
const project = () => ({ version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: FPS, duration: 10, media: [],
  tracks: [{ id: "t", name: "t", clips: [clip("b", "builtin"), clip("u", "mine", 2, 4), clip("g", "graphish", 4, 6), clip("s", "synced-card", 6, 8), clip("x", "nobody", 8, 10)] }] });
const settle = () => new Promise((r) => setTimeout(r, 0));

test("OU-01 clipIdentityOf: when online, a card that cannot run on this page has no identity and a user card that can run has one; desktop as before; changes to the sync table, run state or tier change it accordingly", () => {
  setup();
  const p = project();
  try {
    const desk = CI.clipIdentityOf(p);
    for (const id of ["b", "u"]) assert.ok(desk.identityKeys[id], `Desktop: ${id} has an identity`);
    for (const id of ["s", "x"]) assert.equal(desk.identityKeys[id], undefined, `Desktop: ${id} is defined on neither side (unknown card), gets no identity and is not measured`);
    assert.ok(desk.frameModes.b && desk.frameModes.u);
    H.setOnlineBrowserMode(true);
    const on1 = CI.clipIdentityOf(p);
    assert.notEqual(on1, desk, "The old memo is not used after the mode changed");
    assert.ok(on1.identityKeys.b, "Built-in cards still have an identity");
    assert.equal(on1.identityKeys.s, undefined, "The sync table has not arrived: s is still an unknown card, no identity (not measured)");
    assert.equal(on1.identityKeys.x, undefined, "Unknown cards get no identity");
    // 2026-10-06(online-card-exec-contract.md 第 6 节):构建时就在在线包里的仓库用户卡是页面自己的代码,本页能运行,照内置卡给身份
    assert.equal(on1.identityKeys.u, desk.identityKeys.u, "Build-time user card: has an identity (same key as on desktop)");
    assert.equal(on1.frameModes.u, "direct");
    assert.equal(on1.capabilities.has("u"), true);
    assert.equal(on1.identityKeys.g, undefined, "Media effect card: no identity (online execution of media effect cards is not enabled yet)");
    R.setSyncedUserCards([{ id: "synced-card", name: "Synced card", defaults: { n: 1 } }]);
    const on2 = CI.clipIdentityOf(p);
    assert.equal(on2.identityKeys.s, undefined, "The sync table has arrived but there is no run state yet: the synced card has no identity");
    assert.equal(on2.identityKeys.x, undefined, "An id that exists on neither side still has no identity");
    assert.equal(CI.clipIdentityOf(p), on2, "Use the memo when nothing changed");
    // 运行状态:只有 ready 才有身份;源码版本取这一代的短签名,换代换键
    for (const state of ["loading", "unsupported-syntax", "missing-module", "load-error", "gpu", "media", "runtime-error", "not-isolated"]) {
      R.setCardRunStates([["synced-card", { state }]]);
      assert.equal(CI.clipIdentityOf(p).identityKeys.s, undefined, `${state}: cannot run on this page, no identity`);
    }
    R.setCardRunStates([["synced-card", { state: "ready", version: "g1" }]]);
    const ready1 = CI.clipIdentityOf(p);
    assert.equal(typeof ready1.identityKeys.s, "string", "ready: has an identity, measured like a built-in card");
    assert.equal(ready1.capabilities.has("s"), true);
    R.setCardRunStates([["synced-card", { state: "ready", version: "g2" }]]);
    assert.notEqual(CI.clipIdentityOf(p).identityKeys.s, ready1.identityKeys.s, "Source generation changed: the identity changes too (measure again)");
    // 2026-10-21 起不按档另挡用户卡:构建时的用户卡本页能运行,最低一档、按界限搜索判时都照内置卡有身份(停下追精确帧)
    D.setPlanLowest(true);
    D.setPlanSearch(true);
    const low = CI.clipIdentityOf(p);
    assert.ok(low.identityKeys.u, "Lowest tier: build-time user cards still have an identity");
    assert.ok(low.identityKeys.b, "Lowest tier: built-in cards still have an identity");
    D.setPlanLowest(false);
    D.setPlanSearch(false);
    assert.ok(CI.clipIdentityOf(p).identityKeys.u, "Both off: still has one");
  } finally {
    H.setOnlineBrowserMode(false);
    R.setSyncedUserCards([]);
    R.setCardRunStates([]);
    D.resetPlanDispatch();
  }
});

test("OU-02 planDispatch: when online, cards that cannot run on this page are always classified as heavy and go into the prerender set, and old classify-as-light records are ignored; user cards that can run are classified by their record; a late sync table or run state also triggers a recompute", async () => {
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
  for (const id of ["b", "u", "s", "x"]) assert.equal(desk.has(id), false, `Desktop: ${id} classified as light by the old record`);
  try {
    H.setOnlineBrowserMode(true);
    CI.resetClipIdentityCache();
    D.setPlanCosts(Object.values(keys).map(lightRec), null);
    await settle();
    assert.deepEqual([...D.currentPlan().prerenderSet], ["g"], "Online: media effect card classified as heavy; build-time user cards can run on this page and are classified as light by their record; sync table has not arrived");
    R.setSyncedUserCards([{ id: "synced-card", name: "Synced card" }]);
    await settle();
    assert.deepEqual([...D.currentPlan().prerenderSet], ["g", "s"], "Sync table has arrived but is not loaded yet: synced cards with no definition are classified as heavy, and building the table does not crash");
    // 页面发布的清单计划按 prerenderSet 取卡片段(Preview 的 clips()):含运行不了的同步卡
    const byId = new Map(p.tracks[0].clips.map((c) => [c.id, c]));
    assert.deepEqual([...D.currentPlan().prerenderSet].filter((id) => !!byId.get(id)?.cardId), ["g", "s"]);
    // 载入成功(运行状态 ready):有身份;还没有记录时按声明兜底(同步卡没有声明,判重),记录到了按记录判
    let planNotifications = 0;
    const offPlan = D.onPlanUpdated(() => { planNotifications++; });
    try {
      R.setCardRunStates([["synced-card", { state: "ready", version: "g1" }]]);
      await settle();
      assert.deepEqual([...D.currentPlan().prerenderSet], ["g", "s"], "Just loaded successfully, not measured yet: fall back to what the card declares");
      assert.equal(planNotifications, 1, "When the run state becomes ready, notify that the dispatch table has been updated");
      D.mergePlanCosts([lightRec(CI.clipIdentityOf(p).identityKeys.s)]);
      await settle();
      assert.deepEqual([...D.currentPlan().prerenderSet], ["g"], "Measured and classified as light: not in the prerender set, live rendered");
      assert.equal(planNotifications, 2, "After the measurement record is merged in, notify again that the dispatch table has been updated (Preview recomputes the paused frame from this)");
    } finally {
      offPlan();
    }
    // 运行不了了(新一代转译失败):回到一律按重,手里那条判轻的记录不认
    R.setCardRunStates([["synced-card", { state: "unsupported-syntax", detail: "namespace" }]]);
    await settle();
    assert.deepEqual([...D.currentPlan().prerenderSet], ["g", "s"], "Cannot run: classified as heavy");
    // 只有一个舞台按界限搜索判时(2026-10-21 起不按档另挡用户卡):构建时的用户卡照内置卡按界限搜索的结果判
    D.setPlanSearch(true);
    D.setPlanSearchLight([keys.b, keys.u]);
    await settle();
    assert.equal(D.judgedPlan().prerenderSet.has("u"), false, "Judged by bounds search: build-time user cards are classified as light according to the bounds search result");
    assert.equal(D.judgedPlan().prerenderSet.has("b"), false, "Judged by bounds search: built-in cards are classified as light according to the bounds search result");
  } finally {
    H.setOnlineBrowserMode(false);
    R.setSyncedUserCards([]);
    R.setCardRunStates([]);
    D.resetPlanDispatch();
  }
});

test("OU-05 unknown cards (defined on neither side): desktop and online both skip measuring them, do not treat them as heavy cards and do not put them in the prerender set; once a definition arrives they enter the table as usual", async () => {
  setup();
  // x 声明 stateful:没有成本记录时按声明兜底会判重 —— 未知卡片不能走到这一步
  const p = { ...project(), tracks: [{ id: "t", name: "t", clips: [clip("b", "builtin"), clip("x", "nobody", 0, 2)] }] };
  assert.equal(R.isKnownCardId("builtin"), true);
  assert.equal(R.isKnownCardId("mine"), true);
  assert.equal(R.isKnownCardId("nobody"), false);
  assert.deepEqual([...R.unknownCardClipIds([...p.tracks[0].clips, { id: "n", nodeId: "node-n", start: 0, end: 2 }])], ["x"], "Only clips that have a cardId are considered; those with only a nodeId do not count");
  assert.equal(D.knownCardsOnly(project()).tracks[0].clips.some((c) => c.id === "x"), false);
  const plain = { ...project(), tracks: [{ id: "t", name: "t", clips: [clip("b", "builtin")] }] };
  assert.equal(D.knownCardsOnly(plain), plain, "With no unknown cards, the same object is returned as is");
  for (const online of [false, true]) {
    H.setOnlineBrowserMode(online);
    try {
      CI.resetClipIdentityCache();
      D.resetPlanDispatch();
      D.setPlanCosts([], null);
      D.setPlanProject(p);
      await settle();
      const tag = online ? "online" : "Desktop";
      assert.equal(CI.clipIdentityOf(p).identityKeys.x, undefined, `${tag}: unknown cards have no identity (measurement does not pick them)`);
      assert.ok(CI.clipIdentityOf(p).identityKeys.b, `${tag}: built-in cards still have an identity`);
      assert.equal(D.currentPlan().prerenderSet.has("x"), false, `${tag}: not in the prerender set (the manifest plan does not include it)`);
      assert.ok(!D.currentPlan().segments.some((sg) => sg.heavy.has("x") || sg.light.has("x")), `${tag}: not in the dispatch table`);
      D.setPlanLowest(true);
      D.setPlanSearch(true);
      await settle();
      assert.equal(D.currentPlan().prerenderSet.has("x"), false, `${tag}: not in the display table that classifies everything as heavy at the lowest tier either`);
      assert.equal(D.judgedPlan().prerenderSet.has("x"), false, `${tag}: not in the decision table judged by bounds search either`);
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
  assert.ok(CI.clipIdentityOf(p).identityKeys.x, "Definition arrived: has an identity");
  assert.equal(D.currentPlan().prerenderSet.has("x"), true, "Definition arrived: with no cost record, classified as heavy per the declared stateful");
  D.resetPlanDispatch();
});

test("OU-03 timeline: label; no more \"Needs local PC render assistance\" badge (removed by user decision, 2026-10-21)", () => {
  setup();
  R.setSyncedUserCards([{ id: "synced-card", name: "Probe synced card" }, { id: "builtin", name: "Collides with built-in" }]);
  try {
    assert.equal(B.clipCardLabel(R.knownCardName("mine")), "Build-time user card");
    assert.equal(B.clipCardLabel(R.knownCardName("synced-card")), "Probe synced card");
    assert.equal(B.clipCardLabel(R.knownCardName("builtin")), "Name-builtin", "A colliding synced entry is ignored");
    assert.equal(B.clipCardLabel(R.knownCardName("nobody")), "Unknown card");
    assert.equal(B.showLocalPcBadge, undefined, "The badge decision was removed");
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
      if (fail) throw new Error("Not connected to the document service");
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

test("OU-04 card source sync: list, fetch and parse into the registry; no body fetch when the hash is unchanged; only .tsx files one level under src/cards/user/ count; a changed connection clears the table; the table is left untouched when fetching fails", async () => {
  setup();
  const content = fakeContent({
    "src/cards/user/a.tsx": cardSrc("synced-a", "Synced A"),
    "src/cards/user/b.tsx": cardSrc("synced-b", "Synced B") + cardSrc("synced-b2", "Synced B2").replace("export const c", "export const c2"),
    "src/cards/user/lib/helper.tsx": cardSrc("not-entry", "Not an entry"),
    "src/cards/user/_scopes.json": "{}",
  });
  let link = { id: 1 };
  let changes = 0;
  const sources = new S.OnlineCardSources({ request: content.request, linkKey: () => link, onChange: () => changes++ });
  try {
    await sources.sync();
    assert.deepEqual([...R.syncedUserCards().keys()].sort(), ["synced-a", "synced-b", "synced-b2"]);
    assert.equal(R.knownCardName("synced-b2"), "Synced B2");
    assert.equal(R.syncedUserCards().get("synced-a").source, "src/cards/user/a.tsx");
    assert.equal(R.isUserCardId("not-entry"), false, "Files in subdirectories are not entry files");
    assert.equal(content.sent.filter((m) => m.type === "content.get").length, 2);
    assert.deepEqual(content.sent[0], { type: "content.list", kind: "card-source", prefix: "src/cards/user/" });
    assert.equal(changes, 1);
    // 再来一轮:哈希没变,不再取正文,不通知
    await sources.sync();
    assert.equal(content.sent.filter((m) => m.type === "content.get").length, 2);
    assert.equal(changes, 1);
    // 改名:只取那一条
    content.store.set("src/cards/user/a.tsx", cardSrc("synced-a", "Synced A renamed"));
    await sources.sync();
    assert.equal(content.sent.filter((m) => m.type === "content.get").length, 3);
    assert.equal(R.knownCardName("synced-a"), "Synced A renamed");
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

test("OU-04b entriesOf: sorted by key, the first entry is taken for the same id", () => {
  const parsed = new Map([["src/cards/user/b.tsx", [{ id: "x", name: "x in B" }]], ["src/cards/user/a.tsx", [{ id: "x", name: "x in A" }, { id: "y", name: "y" }]]]);
  assert.deepEqual(S.entriesOf(["src/cards/user/b.tsx", "src/cards/user/a.tsx"], parsed), [
    { id: "x", name: "x in A", source: "src/cards/user/a.tsx" },
    { id: "y", name: "y", source: "src/cards/user/a.tsx" },
  ]);
});

test("OU-04c synced cards carry the description, defaults and controls: the parameters panel can see them via syncedCardView; the main registry still cannot", async () => {
  setup();
  const src = `import type { CardDef } from "../../kernel/types";
const OPTS = [{ value: "l", label: "Left" }, { value: "r", label: "Right" }];
export const c: CardDef = {
  id: "synced-p", name: "Synced card with parameters", description: "Description",
  defaults: { text: "hi", size: 48, side: "l", tint: "#ff0000" },
  controls: [
    { key: "text", label: "Text", type: "text" },
    { key: "size", label: "Font size", type: "number", min: 12, max: 200, step: 2 },
    { key: "side", label: "Position", type: "select", options: OPTS },
    { key: "tint", label: "Color", type: "color" },
  ],
  Component: () => null,
};
export const opaque: CardDef = { id: "synced-o", name: "Control not recognized", defaults: {}, controls: makeControls(), Component: () => null };
`;
  const content = fakeContent({ "src/cards/user/p.tsx": src });
  const link = { id: 1 };
  const sources = new S.OnlineCardSources({ request: content.request, linkKey: () => link });
  try {
    await sources.sync();
    const v = R.syncedCardView("synced-p");
    assert.equal(v.name, "Synced card with parameters");
    assert.equal(v.description, "Description");
    assert.deepEqual(v.defaults, { text: "hi", size: 48, side: "l", tint: "#ff0000" });
    assert.deepEqual(v.controls.map((c) => c.type), ["text", "number", "select", "color"]);
    assert.deepEqual(v.controls[2].options, [{ value: "l", label: "Left" }, { value: "r", label: "Right" }]);
    assert.equal(v.controlsIncomplete, false);
    assert.equal(R.syncedCardView("synced-o").controlsIncomplete, true);
    assert.deepEqual(R.syncedCardView("synced-o").controls, []);
    assert.equal(R.getCard("synced-p"), undefined);
  } finally {
    sources.stop();
    R.setSyncedUserCards([]);
  }
});

test("OU-06 follow imports to fetch referenced files under the same directory: only fetch what is referenced; re-fetch and re-parse when a referenced file changes; do not re-fetch on a cycle; unresolvable references say which one; built-in modules go through builtins", async () => {
  setup();
  const entry = `import type { CardDef } from "../../kernel/types";
import { SHARED } from "./shared";
import { MORE } from "./lib/more";
import { GONE } from "./gone";
import { hudControls } from "../native/hud";
export const c: CardDef = { id: "synced-i", name: "Synced card that imports controls", defaults: { text: "t" },
  controls: [...SHARED, ...MORE, ...GONE, ...hudControls], Component: () => null };
`;
  const content = fakeContent({
    "src/cards/user/i.tsx": entry,
    "src/cards/user/shared.ts": `import { MORE } from "./lib/more";
export const SHARED = [{ key: "text", label: "Text", type: "text" }];
export const ECHO = MORE;
`,
    "src/cards/user/lib/more.ts": `import { ECHO } from "../shared";
export const MORE = [{ key: "side", label: "Position", type: "select", options: ["l", "r"] }];
`,
    "src/cards/user/unused.ts": `export const X = 1;\n`,
  });
  const link = { id: 1 };
  const builtins = (k) => (k === "src/cards/native/hud.ts" ? { hudControls: [{ key: "accent", label: "Primary color", type: "color" }] } : null);
  const sources = new S.OnlineCardSources({ request: content.request, linkKey: () => link, builtins });
  const gets = () => content.sent.filter((m) => m.type === "content.get").map((m) => m.key);
  try {
    await sources.sync();
    assert.deepEqual(gets().sort(), ["src/cards/user/i.tsx", "src/cards/user/lib/more.ts", "src/cards/user/shared.ts"], "unused.ts, which is not referenced, is not fetched; ones on a cycle are not fetched again");
    const v = R.syncedCardView("synced-i");
    assert.deepEqual(v.controls.map((c) => c.key), ["text", "side", "accent"]);
    assert.deepEqual(v.controls[1].options, [{ value: "l", label: "l" }, { value: "r", label: "r" }]);
    assert.equal(v.controlsIncomplete, true);
    assert.equal(v.skippedControls.length, 1);
    assert.match(v.skippedControls[0].reason, /spread GONE could not be resolved: the content store has no file \.\/gone/);
    assert.deepEqual(sources.debug().deps, ["src/cards/user/lib/more.ts", "src/cards/user/shared.ts"]);
    // 再来一轮:都没变,不取
    await sources.sync();
    assert.equal(gets().length, 3);
    // 被引文件改了:只重取它,入口重解析
    content.store.set("src/cards/user/shared.ts", `export const SHARED = [{ key: "text", label: "Text changed", type: "text" }, { key: "n", label: "Number", type: "number" }];
`);
    await sources.sync();
    assert.deepEqual(gets().slice(3), ["src/cards/user/shared.ts"]);
    assert.deepEqual(R.syncedCardView("synced-i").controls.map((c) => c.label), ["Text changed", "Number", "Position", "Primary color"]);
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
    assert.match(v2.skippedControls[0].reason, /MORE could not be resolved/);
  } finally {
    sources.stop();
    R.setSyncedUserCards([]);
  }
});
