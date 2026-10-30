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
    cuts: [{ id: "c1", name: "剪辑 1" }, { id: "c2", name: "剪辑 2" }],
    activeCutId,
  };
}
const track = (id, name, clips = []) => ({ id, name, clips });

test("MA-P1 diffScopes:只报 clips 数组换了引用的那几条序列,格式是「剪辑->序列」;切剪辑整条算;删序列标出来;只调顺序记序列顺序", () => {
  const a = [track("t1", "序列 1", []), track("t2", "序列 2", [])];
  const before = project(a);
  const after = project([a[0], { ...a[1], clips: [{ id: "x" }] }]);
  assert.deepEqual(bus.diffScopes(before, after), ["剪辑 1->序列 2"]);
  assert.deepEqual(bus.diffScopes(before, project(a, "c2")), ["剪辑 2"]);
  assert.deepEqual(bus.diffScopes(before, project([a[0]])), ["剪辑 1->序列 2(已删)"]);
  assert.deepEqual(bus.diffScopes(before, project([a[1], a[0]])), ["剪辑 1->序列顺序"]);
  assert.deepEqual(bus.diffScopes(before, before), []);
});

test("MA-P2 agent.board:页签名跟着范围改,页签上标未读;可自动投递的条数决定 hasAutoDeliverable", () => {
  // 清单按项目分开之后,没有会话时只有开始页占位页;先让用户「点发送」建出第一个会话,再开第二页
  tabs.commitDraft(tabs.getActiveTabId());
  const t = tabs.addTab();
  tabs.setTabConversation(t.id, "conv-p2");
  bus.applyBoard([{ id: "conv-p2", scope: "剪辑1->序列2", unread: 2, deliverable: 1, busy: false }]);
  const now = tabs.findTabByConversation("conv-p2");
  assert.equal(now.title, "剪辑1->序列2");
  assert.equal(now.unread, 2);
  assert.equal(bus.hasAutoDeliverable("conv-p2"), true);
  bus.applyBoard([{ id: "conv-p2", scope: null, unread: 0, deliverable: 0, busy: false }]);
  assert.equal(bus.hasAutoDeliverable("conv-p2"), false);
  assert.equal(tabs.findTabByConversation("conv-p2").unread, 0);
});

test("MA-P3 agent.spawn:开一页带角色名、对话 ID 是服务端给的、驱动与等级沿用父对话,不抢焦点;回话给服务端", async () => {
  const active = tabs.getActiveTabId();
  await bus.handleSpawn({ reqId: "s1", conversationId: "sub-abc", role: "director", roleName: "剪辑导演", parent: "conv-main", provider: "claude", creativity: "medium" });
  const t = tabs.findTabByConversation("sub-abc");
  assert.ok(t, "开了页");
  assert.equal(t.title, "剪辑导演");
  assert.equal(t.role, "director");
  assert.equal(t.parent, "conv-main");
  assert.equal(t.provider, "claude");
  assert.equal(t.creativity, "medium");
  assert.equal(tabs.getTabProvider(t.id), "claude");
  assert.equal(localStorage.getItem(`pcChatId:${t.id}`), "sub-abc", "页面挂上时 useChatHistory 读到这个对话 ID");
  assert.equal(tabs.getActiveTabId(), active, "不抢当前页的焦点");
  assert.deepEqual(posted.find((p) => p.url === "/api/agent/spawned")?.body, { reqId: "s1", ok: true });
  // 同角色第二个编号;声明范围后页签名是「角色 · 范围」
  await bus.handleSpawn({ reqId: "s2", conversationId: "sub-def", role: "director", roleName: "剪辑导演", parent: "conv-main", provider: "claude", creativity: "high" });
  assert.equal(tabs.findTabByConversation("sub-def").title, "剪辑导演 2");
  tabs.setScopeByConversation("sub-abc", "剪辑1->序列1");
  assert.equal(tabs.findTabByConversation("sub-abc").title, "剪辑导演 · 剪辑1->序列1");
  tabs.setScopeByConversation("sub-abc", null);
  assert.equal(tabs.findTabByConversation("sub-abc").title, "剪辑导演");
  // 对话 ID 不合法:回话 ok:false
  await bus.handleSpawn({ reqId: "s3", conversationId: "bad id!", role: "director", roleName: "剪辑导演" });
  assert.equal(posted.find((p) => p.body.reqId === "s3")?.body.ok, false);
});

test("MA-P4 formatInbound:每条标出是谁发的", () => {
  const text = bus.formatInbound([{ from: "conv-a", text: "序列2 我来", hops: 1 }, { from: null, fromLabel: "Agent x(成员 bob 那边)", text: "好", hops: 1 }]);
  assert.equal(text, "【来自 Agent conv-a 的消息】\n序列2 我来\n\n【来自 Agent x(成员 bob 那边) 的消息】\n好");
});

test("MA-P5 取走又忙了:stash 放回页面这边,下次先送它们", async () => {
  bus.stash("conv-p5", [{ from: "a", text: "t", hops: 1 }]);
  assert.equal(bus.hasAutoDeliverable("conv-p5"), true);
  const got = await bus.takeInbox("conv-p5");
  assert.deepEqual(got.map((m) => m.text), ["t"]);
  assert.equal(bus.hasAutoDeliverable("conv-p5"), false);
});

test("MA-P1b diffScopes:不切换剪辑、就地改了停放剪辑里的序列,也记「那条剪辑->序列」", () => {
  const act = [track("t1", "序列 1", [])];
  const pk = [track("p1", "序列 A", []), track("p2", "序列 B", [])];
  const mk = (parked) => ({ ...project(act), cuts: [{ id: "c1", name: "剪辑 1" }, { id: "c2", name: "剪辑 2", tracks: parked, duration: 5 }], activeCutId: "c1" });
  const before = mk(pk);
  assert.deepEqual(bus.diffScopes(before, mk([pk[0], { ...pk[1], clips: [{ id: "y" }] }])), ["剪辑 2->序列 B"]);
  assert.deepEqual(bus.diffScopes(before, mk([pk[0]])), ["剪辑 2->序列 B(已删)"]);
  assert.deepEqual(bus.diffScopes(before, mk(pk)), []);
});
