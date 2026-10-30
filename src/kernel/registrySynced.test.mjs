/**
 * 注册表里「已知但本机不能运行」的用户卡(C10 契约第 9 节「识别」)。跑:
 *   node --test src/kernel/registrySynced.test.mjs
 *
 * 钉的是:同步表不进主注册表(`allCards` / `getCard` 看不到);`isUserCardId` = 构建时的定制卡登记或同步表;
 * 和构建时卡片 id 撞车的同步条目忽略(内置赢);显示名依次取构建时定义 → 同步表 → null;变了才通知。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const R = await import(srcUrl("kernel/registry.ts"));
const def = (id, name) => ({ id, name, defaults: {}, controls: [], Component: () => null });

test("同步表:不进主注册表;isUserCardId 与显示名;撞车的忽略;变了才通知", () => {
  R.resetCards();
  R.registerCards([def("builtin-a", "内置甲"), def("mine", "构建时用户卡")]);
  R.setUserCardSources({ mine: "" }, { mine: "mine" });
  let calls = 0;
  const off = R.onSyncedUserCardsChanged(() => calls++);
  try {
    const gen0 = R.syncedUserCardsGen();
    assert.equal(R.setSyncedUserCards([
      { id: "synced-x", name: "同步甲", source: "src/cards/user/x.tsx" },
      { id: "synced-x", name: "重复的后一条", source: "src/cards/user/x2.tsx" },
      { id: "builtin-a", name: "撞内置", source: "src/cards/user/y.tsx" },
      { id: "mine", name: "撞构建时用户卡", source: "src/cards/user/mine.tsx" },
      { id: "", name: "空 id" },
    ]), true);
    assert.equal(calls, 1);
    assert.equal(R.syncedUserCardsGen(), gen0 + 1);
    // 不进主注册表
    assert.deepEqual(R.allCards().map((c) => c.id).sort(), ["builtin-a", "mine"]);
    assert.equal(R.getCard("synced-x"), undefined);
    // isUserCardId
    assert.equal(R.isUserCardId("synced-x"), true, "同步来的用户卡");
    assert.equal(R.isUserCardId("mine"), true, "构建时的用户卡");
    assert.equal(R.isUserCardId("builtin-a"), false, "和内置卡撞车的同步条目忽略:内置赢");
    assert.equal(R.isUserCardId("nobody"), false, "两边都没有");
    assert.equal(R.isUserCardId(undefined), false);
    assert.equal(R.isUserCardId(""), false);
    // 显示名
    assert.equal(R.knownCardName("synced-x"), "同步甲", "同 id 多条取第一条");
    assert.equal(R.knownCardName("mine"), "构建时用户卡", "构建时定义的名字优先");
    assert.equal(R.knownCardName("builtin-a"), "内置甲");
    assert.equal(R.knownCardName("nobody"), null, "未知卡片");
    // 同一份再设一次:不变、不通知
    assert.equal(R.setSyncedUserCards([{ id: "synced-x", name: "同步甲", source: "src/cards/user/x.tsx" },
      { id: "builtin-a", name: "撞内置", source: "src/cards/user/y.tsx" }, { id: "mine", name: "撞构建时用户卡", source: "src/cards/user/mine.tsx" }]), false);
    assert.equal(calls, 1);
    // 改名:通知
    assert.equal(R.setSyncedUserCards([{ id: "synced-x", name: "改名了", source: "src/cards/user/x.tsx" }]), true);
    assert.equal(calls, 2);
    assert.equal(R.knownCardName("synced-x"), "改名了");
    // 清空
    R.setSyncedUserCards([]);
    assert.equal(R.isUserCardId("synced-x"), false);
    assert.equal(R.knownCardName("synced-x"), null);
    assert.equal(R.syncedUserCards().size, 0);
  } finally {
    off();
    R.setSyncedUserCards([]);
    R.setUserCardSources({}, {});
    R.resetCards();
  }
});

test("syncedCardView:只读视图(名字、说明、默认值、控件,没有组件);不进主注册表;撞车的、没同步的回 undefined;没变回同一个对象", () => {
  R.resetCards();
  R.registerCards([def("builtin-a", "内置甲")]);
  R.setUserCardSources({}, {});
  try {
    const controls = [{ key: "text", label: "文字", type: "text" }, { key: "n", label: "数", type: "number", min: 0, max: 9, step: 1 }];
    R.setSyncedUserCards([
      { id: "s", name: "同步卡", source: "src/cards/user/s.tsx", description: "说明", defaults: { text: "hi", n: 3 }, controls },
      { id: "bare", name: "只有名字" },
      { id: "opaque", name: "控件认不出", controls: [], controlsIncomplete: true },
      { id: "builtin-a", name: "撞内置", controls },
    ]);
    const v = R.syncedCardView("s");
    assert.deepEqual({ ...v }, { id: "s", name: "同步卡", description: "说明", defaults: { text: "hi", n: 3 }, controls, controlsIncomplete: false, skippedControls: [], synced: true });
    assert.equal(v.Component, undefined, "没有组件");
    assert.ok(Object.isFrozen(v), "只读");
    assert.deepEqual({ ...R.syncedCardView("bare") }, { id: "bare", name: "只有名字", defaults: {}, controls: [], controlsIncomplete: false, skippedControls: [], synced: true });
    assert.equal(R.syncedCardView("opaque").controlsIncomplete, true);
    assert.equal(R.syncedCardView("builtin-a"), undefined, "和内置卡撞车:内置赢,不给视图");
    assert.equal(R.syncedCardView("nobody"), undefined);
    assert.equal(R.syncedCardView(undefined), undefined);
    assert.equal(R.getCard("s"), undefined, "getCard 照旧看不到");
    assert.ok(!R.allCards().some((c) => c.id === "s"), "allCards 照旧看不到");
    // 同一份再设:不变、同一个对象;别的卡变了,这张的视图仍是同一个对象
    assert.equal(R.setSyncedUserCards([
      { id: "s", name: "同步卡", source: "src/cards/user/s.tsx", description: "说明", defaults: { text: "hi", n: 3 }, controls },
      { id: "bare", name: "只有名字" }, { id: "opaque", name: "控件认不出", controls: [], controlsIncomplete: true }, { id: "builtin-a", name: "撞内置", controls },
    ]), false);
    assert.equal(R.syncedCardView("s"), v);
    R.setSyncedUserCards([{ id: "s", name: "同步卡", source: "src/cards/user/s.tsx", description: "说明", defaults: { text: "hi", n: 3 }, controls }, { id: "bare", name: "改了名" }]);
    assert.equal(R.syncedCardView("s"), v, "没变的卡视图不换");
    // 控件变了:通知、换新视图
    assert.equal(R.setSyncedUserCards([{ id: "s", name: "同步卡", source: "src/cards/user/s.tsx", description: "说明", defaults: { text: "hi", n: 4 }, controls }]), true);
    assert.notEqual(R.syncedCardView("s"), v);
    assert.equal(R.syncedCardView("s").defaults.n, 4);
    assert.equal(R.syncedCardView("bare"), undefined, "从表里去掉了");
  } finally {
    R.setSyncedUserCards([]);
    R.resetCards();
  }
});
