/**
 * 多 Agent 公告板的页面一侧(agentBus)的单测。跑:node --test src/ai/agentBus.test.mjs
 *
 * 公告板本身搬到了编辑器进程(server/agent/agent-board.mjs,单测在 server/test/multi-agent.test.mjs);
 * 页面这边钉死:范围差分(页面与服务端共用 src/kernel/agentScopes.mjs)算得对;SSE 推来的 agent.board 改页签名、标未读;
 * spawn_agent 开的页签带角色名、对话 ID 是服务端给的那个、驱动沿用父对话;投递消息的排版。用例 MA-P1～MA-P5。
 */
import test from "node:test";
import assert from "node:assert/strict";

// 浏览器里才有的东西:agentTabs 读 localStorage、react 的 useSyncExternalStore 只是引用
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
// handleSpawn 回话用的 fetch:记下来,不真的发
const posted = [];
globalThis.fetch = async (url, init) => { posted.push({ url, body: JSON.parse(init.body) }); return { json: async () => ({ ok: true, messages: [] }) }; };

const bus = await import("./agentBus.ts");
const tabs = await import("./agentTabs.ts");

function project(tracks, activeCutId = "c1") {
  return {
    name: "p", width: 1080, height: 1920, fps: 30, duration: 10, media: [],
    tracks,
    cuts: [{ id: "c1", name: "Cut 1" }, { id: "c2", name: "Cut 2" }],
    activeCutId,
  };
}
const track = (id, name, clips = []) => ({ id, name, clips });

test("MA-P1 diffScopes: only reports tracks whose clips array changed reference, in the format \"cut->track\"; switching cuts counts the whole cut; a deleted track is flagged; only reordering is recorded as track order", () => {
  const a = [track("t1", "Track 1", []), track("t2", "Track 2", [])];
  const before = project(a);
  const after = project([a[0], { ...a[1], clips: [{ id: "x" }] }]);
  assert.deepEqual(bus.diffScopes(before, after), ["cut 1->track 2"]);
  assert.deepEqual(bus.diffScopes(before, project(a, "c2")), ["Cut 2"]);
  assert.deepEqual(bus.diffScopes(before, project([a[0]])), ["cut 1->track 2 (deleted)"]);
  assert.deepEqual(bus.diffScopes(before, project([a[1], a[0]])), ["cut 1->track order"]);
  assert.deepEqual(bus.diffScopes(before, before), []);
});

test("MA-P2 agent.board: the tab name follows the scope and the tab shows unread; the number of auto-deliverable items determines hasAutoDeliverable", () => {
  // 清单按项目分开之后,没有会话时只有开始页占位页;先让用户「点发送」建出第一个会话,再开第二页
  tabs.commitDraft(tabs.getActiveTabId());
  const t = tabs.addTab();
  tabs.setTabConversation(t.id, "conv-p2");
  bus.applyBoard([{ id: "conv-p2", scope: "Cut 1->Track 2", unread: 2, deliverable: 1, busy: false }]);
  const now = tabs.findTabByConversation("conv-p2");
  assert.equal(now.title, "Cut 1->Track 2");
  assert.equal(now.unread, 2);
  assert.equal(bus.hasAutoDeliverable("conv-p2"), true);
  bus.applyBoard([{ id: "conv-p2", scope: null, unread: 0, deliverable: 0, busy: false }]);
  assert.equal(bus.hasAutoDeliverable("conv-p2"), false);
  assert.equal(tabs.findTabByConversation("conv-p2").unread, 0);
});

test("MA-P3 agent.spawn: opens a tab with the role name, the chat ID is given by the server, the driver and level are inherited from the parent chat, it does not steal focus, and it replies to the server", async () => {
  const active = tabs.getActiveTabId();
  await bus.handleSpawn({ reqId: "s1", conversationId: "sub-abc", role: "director", roleName: "Editing director", parent: "conv-main", provider: "claude", creativity: "medium" });
  const t = tabs.findTabByConversation("sub-abc");
  assert.ok(t, "A tab was opened");
  assert.equal(t.title, "Editing director");
  assert.equal(t.role, "director");
  assert.equal(t.parent, "conv-main");
  assert.equal(t.provider, "claude");
  assert.equal(t.creativity, "medium");
  assert.equal(tabs.getTabProvider(t.id), "claude");
  assert.equal(localStorage.getItem(`pcChatId:${t.id}`), "sub-abc", "When the page mounts, useChatHistory reads this chat ID");
  assert.equal(tabs.getActiveTabId(), active, "Does not steal focus from the current tab");
  assert.deepEqual(posted.find((p) => p.url === "/api/agent/spawned")?.body, { reqId: "s1", ok: true });
  // 同角色第二个编号;声明范围后页签名是「角色 · 范围」
  await bus.handleSpawn({ reqId: "s2", conversationId: "sub-def", role: "director", roleName: "Editing director", parent: "conv-main", provider: "claude", creativity: "high" });
  assert.equal(tabs.findTabByConversation("sub-def").title, "Cut director 2");
  tabs.setScopeByConversation("sub-abc", "Cut 1->Track 1");
  assert.equal(tabs.findTabByConversation("sub-abc").title, "Cut director · cut 1->track 1");
  tabs.setScopeByConversation("sub-abc", null);
  assert.equal(tabs.findTabByConversation("sub-abc").title, "Editing director");
  // 对话 ID 不合法:回话 ok:false
  await bus.handleSpawn({ reqId: "s3", conversationId: "bad id!", role: "director", roleName: "Editing director" });
  assert.equal(posted.find((p) => p.body.reqId === "s3")?.body.ok, false);
});

test("MA-P4 formatInbound: each message is labeled with who sent it", () => {
  const text = bus.formatInbound([{ from: "conv-a", text: "I'll take Track 2", hops: 1 }, { from: null, fromLabel: "Agent x (on member bob's side)", text: "OK", hops: 1 }]);
  assert.equal(text, "[Message from Agent conv-a]\n序列2 我来\n\n[Message from Agent x(成员 bob 那边)]\n好");
});

test("MA-P5 taken away and then busy again: the stash is put back on the page side and delivered first next time", async () => {
  bus.stash("conv-p5", [{ from: "a", text: "t", hops: 1 }]);
  assert.equal(bus.hasAutoDeliverable("conv-p5"), true);
  const got = await bus.takeInbox("conv-p5");
  assert.deepEqual(got.map((m) => m.text), ["t"]);
  assert.equal(bus.hasAutoDeliverable("conv-p5"), false);
});

test("MA-P1b diffScopes: without switching cuts, modifying a track in a parked cut in place is also recorded as \"that cut->track\"", () => {
  const act = [track("t1", "Track 1", [])];
  const pk = [track("p1", "Track A", []), track("p2", "Track B", [])];
  const mk = (parked) => ({ ...project(act), cuts: [{ id: "c1", name: "Cut 1" }, { id: "c2", name: "Cut 2", tracks: parked, duration: 5 }], activeCutId: "c1" });
  const before = mk(pk);
  assert.deepEqual(bus.diffScopes(before, mk([pk[0], { ...pk[1], clips: [{ id: "y" }] }])), ["cut 2->track B"]);
  assert.deepEqual(bus.diffScopes(before, mk([pk[0]])), ["cut 2->track B (deleted)"]);
  assert.deepEqual(bus.diffScopes(before, mk(pk)), []);
});
