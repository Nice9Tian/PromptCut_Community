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

test("AT-P1 One manifest per project: project A opens two tabs, project B sees its own (the start page); switching back to A they are still there; the tab id is \"projectID_AgentID\", and storage keys are split by project", async () => {
  const t = await fresh();
  t.setAgentProject("projA");
  const a1 = send(t);
  const a2 = t.addTab();
  assert.ok(a1.id.startsWith("projA_") && a2.id.startsWith("projA_"), "The internal id is projectID_AgentID");
  assert.notEqual(a1.id, a2.id);
  assert.deepEqual(t.getTabs().map((x) => x.title), ["Agent 1", "Agent 2"], "Shown in the interface as Agent 1, Agent 2");
  t.setAgentProject("projB");
  assert.equal(t.getAgentProjectId(), "projB");
  assert.equal(t.hasRealTabs(), false, "Project B has no sessions");
  assert.equal(t.getTabs()[0].draft, true);
  assert.ok(t.getTabs()[0].id.startsWith("projB_"));
  const b1 = send(t);
  assert.equal(b1.title, "Agent 1", "Numbering takes the smallest free number within this project, unaffected by Agent 1 and 2 already in A");
  assert.deepEqual(t.getTabs().map((x) => x.id), [b1.id]);
  t.setAgentProject("projA");
  assert.deepEqual(t.getTabs().map((x) => x.id), [a1.id, a2.id]);
  assert.equal(t.getActiveTabId(), a2.id, "Each project remembers its own active tab");
  // 存储:每个项目一个键,里面的页 id 都带着项目 id
  assert.deepEqual(JSON.parse(store.get("pc.agentTabs:projA")).tabs.map((x) => x.id), [a1.id, a2.id]);
  assert.deepEqual(JSON.parse(store.get("pc.agentTabs:projB")).tabs.map((x) => x.id), [b1.id]);
});

test("AT-P2 \"Manually closed all\" is recorded per project: A had everything closed, B has not yet; whether each start page shows the onboarding animation is decided by this", async () => {
  const t = await fresh();
  t.setAgentProject("projA");
  const a1 = send(t);
  t.closeTab(a1.id);
  assert.equal(t.isCleared(), true);
  t.setAgentProject("projB");
  assert.equal(t.isCleared(), false, "B was just entered, and its start page has the onboarding animation");
  t.setAgentProject("projA");
  assert.equal(t.isCleared(), true);
  // B 点发送建了第一个会话之后再关光,也算手动关光
  t.setAgentProject("projB");
  const b = send(t);
  assert.equal(t.isCleared(), false, "Creating a session does not count as closing everything");
  t.closeTab(b.id);
  assert.equal(t.isCleared(), true);
});

test("AT-P3 The old global manifest (pc.agentTabs) is neither read nor touched: new projects always start from the start page, the chats themselves are in the session archive and can be found in the history", async () => {
  const legacy = JSON.stringify([{ id: "main", title: "Agent 1" }, { id: "tx", title: "Agent 2", conversationId: "conv-old" }]);
  const t = await fresh(() => { store.set("pc.agentTabs", legacy); store.set("pc.agentTabs.active", "tx"); });
  t.setAgentProject("projA");
  assert.equal(t.hasRealTabs(), false);
  assert.equal(t.getTabs()[0].draft, true);
  assert.equal(store.get("pc.agentTabs"), legacy, "The old key is left as it was (a rolled-back version can still use it)");
  assert.equal(store.get("pc.agentTabs.active"), "tx");
});

test("AT-P4 The project comes with a chat (ai.messages in .proc) but has no manifest yet: add a tab \"projectID_main\" to take it over; a project that already has a manifest is not patched; patched only once", async () => {
  const t = await fresh(() => store.set("pcChatId", "chat-old"));
  t.noteProjectChatApplied(true);
  t.setAgentProject("projA");
  assert.deepEqual(t.getTabs().map((x) => [x.id, x.title, !!x.draft]), [["projA_main", "Agent 1", false]]);
  assert.equal(store.get("pcChatId:projA_main"), "chat-old", "The old main chat's archive id is carried over, so the part in the archive can be linked up");
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
  assert.equal(t.hasRealTabs(), false, "A project where everything was closed has a manifest and is not patched again");
  // 标记只管紧接着的一次切换
  t.noteProjectChatApplied(true);
  t.setAgentProject("projD");
  assert.equal(t.getTabs()[0].id, "projD_main");
  t.setAgentProject("projE");
  assert.equal(t.hasRealTabs(), false);
});

test("AT-P5 The start page is not stored; the creativity level set on the start page is carried into the first session on send; a chat id and busy state written on the start page are ignored", async () => {
  const t = await fresh();
  t.setAgentProject("projA");
  const d = t.getTabs()[0];
  t.setTabCreativity(d.id, "high");
  assert.equal(t.getTabCreativity(d.id), "high");
  assert.equal([...store.keys()].filter((k) => k.startsWith("pc.agentTabs:")).length, 0, "The start page writes nothing to storage");
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

test("AT-P5b The \"projectID_main\" tab and the old main share the same chat store; closing it clears that store", async () => {
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

test("AT-P6 Subagent tabs are also per project: the id of a tab opened by spawn carries the current project, and after switching projects it is not in the other project's manifest", async () => {
  const t = await fresh();
  t.setAgentProject("projA");
  send(t);
  const sp = t.addSpawnedTab({ conversationId: "sub-1", role: "director", roleName: "Editing director", parent: "conv-main", provider: "claude", creativity: null });
  assert.ok(sp.id.startsWith("projA_"));
  assert.equal(store.get(`pcChatId:${sp.id}`), "sub-1");
  t.setAgentProject("projB");
  assert.equal(t.findTabByConversation("sub-1"), null);
  t.setAgentProject("projA");
  assert.equal(t.findTabByConversation("sub-1")?.id, sp.id);
});
