/**
 * AI 栏 Agent 标签的关闭与编号(2026-10-20 用户定;2026-10-22 起最后一个也能关、没有会话时是开始页,
 * 见 docs/semantics/workflow/editing.md「AI 栏的 Agent 标签」)。跑:node --test src/ai/agentTabsClose.test.mjs
 * 用例 AT-C1～AT-C6:没有会话时是开始页占位页、点发送才建第一个会话、最后一个也能关(回到开始页)、关当前页后的激活、
 * 新建取最小空号、刷新后从持久化恢复。分项目的用例在 agentTabsProjects.test.mjs。
 */
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

let n = 0;
/** 每个用例重新载入一份模块,等于刷新页面;prep 先往 localStorage 里放点东西;再打开项目 p1(清单按项目分开) */
async function fresh(prep, project = "p1") {
  store.clear();
  prep?.();
  const t = await import(`./agentTabs.ts?case=${++n}`);
  t.setAgentProject(project);
  return t;
}
/** 在开始页点发送:占位页变成第一个会话 */
function send(t) {
  return t.commitDraft(t.getActiveTabId());
}

test("AT-C1 项目里还没有会话:只有一个开始页占位页(draft),没有可关的页,「+」回到它;点发送才变成 Agent 1", async () => {
  const t = await fresh();
  const [d] = t.getTabs();
  assert.equal(t.getTabs().length, 1);
  assert.equal(d.draft, true);
  assert.equal(d.title, "Agent 1");
  assert.equal(t.getActiveTabId(), d.id);
  assert.equal(t.hasRealTabs(), false);
  assert.equal(t.canCloseTab(d.id), false);
  t.closeTab(d.id);
  assert.equal(t.isDraftTab(d.id), true, "占位页关不掉");
  assert.equal(t.addTab().id, d.id, "没有会话时「+」不建真页,回到开始页");
  assert.equal(t.hasRealTabs(), false);
  // 没点发送之前不进存储
  assert.equal(store.has("pc.agentTabs:p1"), false);
  // 点发送:同一个 id 变成真页
  const real = send(t);
  assert.equal(real.id, d.id, "占位页变真页,id 不换(rail 项、页面节点都不用换)");
  assert.equal(real.draft, undefined);
  assert.deepEqual(t.getTabs().map((x) => x.title), ["Agent 1"]);
  assert.equal(t.hasRealTabs(), true);
  assert.equal(JSON.parse(store.get("pc.agentTabs:p1")).tabs.length, 1);
});

test("AT-C2 最后一个会话也能关:关光后回到开始页(新的占位页 id),并记下「用户手动关光过」", async () => {
  const t = await fresh();
  const first = send(t);
  assert.equal(t.canCloseTab(first.id), true, "最后一个也能关");
  assert.equal(t.isCleared(), false);
  t.closeTab(first.id);
  assert.equal(t.hasRealTabs(), false);
  const [d] = t.getTabs();
  assert.equal(d.draft, true);
  assert.notEqual(d.id, first.id, "关光后的开始页是新的 id,不复用旧会话留下的键");
  assert.equal(t.getActiveTabId(), d.id);
  assert.equal(t.isCleared(), true);
  const saved = JSON.parse(store.get("pc.agentTabs:p1"));
  assert.deepEqual([saved.tabs.length, saved.cleared], [0, true]);
});

test("AT-C3 每个页都能关(含 Agent 1);关的是当前页就切到左边那页,在最左就切到右边那页;关的不是当前页,当前页不变", async () => {
  const t = await fresh();
  const first = send(t); // Agent 1
  const a = t.addTab(); // Agent 2,激活
  const b = t.addTab(); // Agent 3,激活
  t.activateTab(first.id);
  assert.equal(t.canCloseTab(first.id), true);
  t.closeTab(first.id);
  assert.deepEqual(t.getTabs().map((x) => x.title), ["Agent 2", "Agent 3"]);
  assert.equal(t.getActiveTabId(), a.id);
  t.activateTab(b.id);
  t.closeTab(b.id);
  assert.equal(t.getActiveTabId(), a.id);
  const c = t.addTab();
  t.activateTab(c.id);
  t.closeTab(a.id);
  assert.equal(t.getActiveTabId(), c.id);
});

test("AT-C4 新建标签取当前最小的空号:关掉 2 号后再新建得到 2 号;关掉 1 号后再新建得到 1 号", async () => {
  const t = await fresh();
  const first = send(t);
  const a = t.addTab();
  t.addTab();
  assert.deepEqual(t.getTabs().map((x) => x.title), ["Agent 1", "Agent 2", "Agent 3"]);
  t.closeTab(a.id);
  assert.equal(t.addTab().title, "Agent 2");
  t.closeTab(first.id);
  assert.equal(t.addTab().title, "Agent 1");
});

test("AT-C5 刷新后:列表、编号、激活页原样恢复;关光过的项目刷新后仍是开始页且仍记着关光过", async () => {
  const t = await fresh();
  const first = send(t);
  const a = t.addTab();
  t.closeTab(first.id);
  assert.equal(t.getActiveTabId(), a.id);
  const saved = new Map(store);
  const t2 = await fresh(() => saved.forEach((v, k) => store.set(k, v)));
  assert.deepEqual(t2.getTabs().map((x) => [x.id, x.title]), [[a.id, "Agent 2"]]);
  assert.equal(t2.getActiveTabId(), a.id);
  assert.equal(t2.addTab().title, "Agent 1");
  // 再关光,刷新
  for (const x of [...t2.getTabs()]) t2.closeTab(x.id);
  const saved2 = new Map(store);
  const t3 = await fresh(() => saved2.forEach((v, k) => store.set(k, v)));
  assert.equal(t3.hasRealTabs(), false);
  assert.equal(t3.getTabs()[0].draft, true);
  assert.equal(t3.isCleared(), true);
});

test("AT-C6 存的激活页已不存在就落到第一个页;存坏了的清单当没存过", async () => {
  const t = await fresh(() => {
    store.set("pc.agentTabs:p1", JSON.stringify({ v: 2, tabs: [{ id: "p1_x1", title: "Agent 1" }, { id: "p1_x2", title: "Agent 3" }], active: "gone", cleared: false }));
  });
  assert.equal(t.getActiveTabId(), "p1_x1");
  assert.equal(t.addTab().title, "Agent 2");
  const bad = await fresh(() => store.set("pc.agentTabs:p1", "{不是 json"));
  assert.equal(bad.hasRealTabs(), false);
  assert.equal(bad.getTabs()[0].draft, true);
});
