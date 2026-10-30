/**
 * AI 栏 Agent 标签按项目分开(2026-10-22 用户定,原话:「不同项目的不共用一份，用户界面看到的是Agent1，Agent2.。。
 * 实际上代码标记的是"项目ID_AgentID"。」)。跑:node --test src/ai/agentTabsProjects.test.mjs
 * 用例 AT-P1～AT-P6:每个项目一份清单、分页 id 与存储键是「项目ID_AgentID」、编号在本项目内取最小空号、
 * 「手动关光过」按项目记、旧的全局清单不读不动、老项目自带的对话补一个页接住、开始页上设的创造力等级点发送时带过去。
 */
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

let n = 0;
async function fresh(prep) {
  store.clear();
  prep?.();
  return import(`./agentTabs.ts?case=${++n}`);
}
const send = (t) => t.commitDraft(t.getActiveTabId());

test("AT-P1 每个项目一份清单:项目 A 开两个分页,项目 B 看到的是自己的(开始页);切回 A 还在;分页 id 是「项目ID_AgentID」,存储键按项目分", async () => {
  const t = await fresh();
  t.setAgentProject("projA");
  const a1 = send(t);
  const a2 = t.addTab();
  assert.ok(a1.id.startsWith("projA_") && a2.id.startsWith("projA_"), "内部 id 是 项目ID_AgentID");
  assert.notEqual(a1.id, a2.id);
  assert.deepEqual(t.getTabs().map((x) => x.title), ["Agent 1", "Agent 2"], "界面上叫 Agent 1、Agent 2");
  t.setAgentProject("projB");
  assert.equal(t.getAgentProjectId(), "projB");
  assert.equal(t.hasRealTabs(), false, "项目 B 没有会话");
  assert.equal(t.getTabs()[0].draft, true);
  assert.ok(t.getTabs()[0].id.startsWith("projB_"));
  const b1 = send(t);
  assert.equal(b1.title, "Agent 1", "编号在本项目内取最小空号,不受 A 里已有 Agent 1、2 影响");
  assert.deepEqual(t.getTabs().map((x) => x.id), [b1.id]);
  t.setAgentProject("projA");
  assert.deepEqual(t.getTabs().map((x) => x.id), [a1.id, a2.id]);
  assert.equal(t.getActiveTabId(), a2.id, "每个项目记自己的激活页");
  // 存储:每个项目一个键,里面的页 id 都带着项目 id
  assert.deepEqual(JSON.parse(store.get("pc.agentTabs:projA")).tabs.map((x) => x.id), [a1.id, a2.id]);
  assert.deepEqual(JSON.parse(store.get("pc.agentTabs:projB")).tabs.map((x) => x.id), [b1.id]);
});

test("AT-P2 「手动关光过」按项目记:A 关光过,B 还没有;各自的开始页有没有引导动画由此定", async () => {
  const t = await fresh();
  t.setAgentProject("projA");
  const a1 = send(t);
  t.closeTab(a1.id);
  assert.equal(t.isCleared(), true);
  t.setAgentProject("projB");
  assert.equal(t.isCleared(), false, "B 刚进来,开始页带引导动画");
  t.setAgentProject("projA");
  assert.equal(t.isCleared(), true);
  // B 点发送建了第一个会话之后再关光,也算手动关光
  t.setAgentProject("projB");
  const b = send(t);
  assert.equal(t.isCleared(), false, "建了会话不算关光");
  t.closeTab(b.id);
  assert.equal(t.isCleared(), true);
});

test("AT-P3 旧的全局清单(pc.agentTabs)不读也不动:新项目一律从开始页起,对话本身在会话归档里,历史里找得到", async () => {
  const legacy = JSON.stringify([{ id: "main", title: "Agent 1" }, { id: "tx", title: "Agent 2", conversationId: "conv-old" }]);
  const t = await fresh(() => { store.set("pc.agentTabs", legacy); store.set("pc.agentTabs.active", "tx"); });
  t.setAgentProject("projA");
  assert.equal(t.hasRealTabs(), false);
  assert.equal(t.getTabs()[0].draft, true);
  assert.equal(store.get("pc.agentTabs"), legacy, "旧键原样留着(回滚版本还能用)");
  assert.equal(store.get("pc.agentTabs.active"), "tx");
});

test("AT-P4 项目自带对话(.proc 的 ai.messages)而这个项目还没有清单:补一个页「项目ID_main」接住;已有清单的项目不补;只补一次", async () => {
  const t = await fresh(() => store.set("pcChatId", "chat-old"));
  t.noteProjectChatApplied(true);
  t.setAgentProject("projA");
  assert.deepEqual(t.getTabs().map((x) => [x.id, x.title, !!x.draft]), [["projA_main", "Agent 1", false]]);
  assert.equal(store.get("pcChatId:projA_main"), "chat-old", "老的主对话归档 id 接过来,归档里的那段接得上");
  // 对话为空的项目:开始页
  t.noteProjectChatApplied(false);
  t.setAgentProject("projB");
  assert.equal(t.hasRealTabs(), false);
  // 已有清单的项目(用户关光过)不补
  t.setAgentProject("projC");
  const x = send(t);
  t.closeTab(x.id);
  t.setAgentProject("projA");
  t.noteProjectChatApplied(true);
  t.setAgentProject("projC");
  assert.equal(t.hasRealTabs(), false, "关光过的项目有清单,不再补");
  // 标记只管紧接着的一次切换
  t.noteProjectChatApplied(true);
  t.setAgentProject("projD");
  assert.equal(t.getTabs()[0].id, "projD_main");
  t.setAgentProject("projE");
  assert.equal(t.hasRealTabs(), false);
});

test("AT-P5 开始页不进存储;在开始页上设的创造力等级点发送时带到第一个会话;开始页上写的对话 id、忙碌被忽略", async () => {
  const t = await fresh();
  t.setAgentProject("projA");
  const d = t.getTabs()[0];
  t.setTabCreativity(d.id, "high");
  assert.equal(t.getTabCreativity(d.id), "high");
  assert.equal([...store.keys()].filter((k) => k.startsWith("pc.agentTabs:")).length, 0, "开始页不写存储");
  const real = send(t);
  assert.equal(real.creativity, "high");
  assert.equal(JSON.parse(store.get("pc.agentTabs:projA")).tabs[0].creativity, "high");
  t.closeTab(real.id);
  const d2 = t.getTabs()[0];
  t.setTabConversation(d2.id, "conv-x");
  t.setTabBusy(d2.id, true);
  assert.equal(t.getTabs()[0].conversationId, null);
  assert.equal(t.getTabs()[0].busy, false);
});

test("AT-P5b 「项目ID_main」页和老的 main 共用同一份对话 store;关它清空这份 store", async () => {
  const t = await fresh();
  const chat = await import("./liveChat.ts");
  chat.getChatStore("main").replace([{ id: "m1", role: "user", text: "hi" }]);
  t.noteProjectChatApplied(true);
  t.setAgentProject("projM");
  assert.equal(chat.getChatStore("projM_main").get().length, 1);
  assert.equal(chat.isMainTab("projM_main"), true);
  assert.equal(chat.isMainTab("projM_a1b2c"), false);
  t.closeTab("projM_main");
  assert.equal(chat.getChatStore("main").get().length, 0);
});

test("AT-P6 子 Agent 页也按项目:spawn 开的页 id 带当前项目,换项目后不在另一个项目的清单里", async () => {
  const t = await fresh();
  t.setAgentProject("projA");
  send(t);
  const sp = t.addSpawnedTab({ conversationId: "sub-1", role: "director", roleName: "剪辑导演", parent: "conv-main", provider: "claude", creativity: null });
  assert.ok(sp.id.startsWith("projA_"));
  assert.equal(store.get(`pcChatId:${sp.id}`), "sub-1");
  t.setAgentProject("projB");
  assert.equal(t.findTabByConversation("sub-1"), null);
  t.setAgentProject("projA");
  assert.equal(t.findTabByConversation("sub-1")?.id, sp.id);
});
