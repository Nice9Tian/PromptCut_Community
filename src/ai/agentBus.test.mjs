/**
 * Unit tests for page-side multi-Agent bulletin board (agentBus). Run: node --test src/ai/agentBus.test.mjs
 *
 * The bulletin board itself moved to the editor process (server/agent/agent-board.mjs, unit tests in
 * server/test/multi-agent.test.mjs); page-side pins down: scope diffing (page and server share
 * src/kernel/agentScopes.mjs) calculates correctly; agent.board pushed via SSE updates tab name and
 * marks unread; tabs opened by spawn_agent include role name, chat ID matches the server-provided
 * one, driver inherits from parent chat; delivery message layout. Test cases MA-P1~MA-P5.
 */
import test from "node:test";
import assert from "node:assert/strict";

// Browser-only items: agentTabs reads localStorage, react useSyncExternalStore is only a reference
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
// fetch used by handleSpawn to reply: recorded, not actually sent
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
  assert.deepEqual(bus.diffScopes(before, after), ["Cut 1->Track 2"]);
  assert.deepEqual(bus.diffScopes(before, project(a, "c2")), ["Cut 2"]);
  assert.deepEqual(bus.diffScopes(before, project([a[0]])), ["Cut 1->Track 2(deleted)"]);
  assert.deepEqual(bus.diffScopes(before, project([a[1], a[0]])), ["Cut 1->track order"]);
  assert.deepEqual(bus.diffScopes(before, before), []);
});

test("MA-P2 agent.board: the tab name follows the scope and the tab shows unread; the number of auto-deliverable items determines hasAutoDeliverable", () => {
  // After manifests are split by project, only the start page placeholder page exists when there are no sessions; user must first "click send" to create the first session before opening a second tab
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
  // Second number for the same role; tab name after declaring scope is "role · scope"
  await bus.handleSpawn({ reqId: "s2", conversationId: "sub-def", role: "director", roleName: "Editing director", parent: "conv-main", provider: "claude", creativity: "high" });
  assert.equal(tabs.findTabByConversation("sub-def").title, "Editing director 2");
  tabs.setScopeByConversation("sub-abc", "Cut 1->Track 1");
  assert.equal(tabs.findTabByConversation("sub-abc").title, "Editing director · Cut 1->Track 1");
  tabs.setScopeByConversation("sub-abc", null);
  assert.equal(tabs.findTabByConversation("sub-abc").title, "Editing director");
  // Invalid chat ID: reply ok:false
  await bus.handleSpawn({ reqId: "s3", conversationId: "bad id!", role: "director", roleName: "Editing director" });
  assert.equal(posted.find((p) => p.body.reqId === "s3")?.body.ok, false);
});

test("MA-P4 formatInbound: each message is labeled with who sent it", () => {
  const text = bus.formatInbound([{ from: "conv-a", text: "I'll take Track 2", hops: 1 }, { from: null, fromLabel: "Agent x (on member bob's side)", text: "OK", hops: 1 }]);
  assert.equal(text, "[Message from Agent conv-a]\nI'll take Track 2\n\n[Message from Agent x (on member bob's side)]\nOK");
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
  assert.deepEqual(bus.diffScopes(before, mk([pk[0], { ...pk[1], clips: [{ id: "y" }] }])), ["Cut 2->Track B"]);
  assert.deepEqual(bus.diffScopes(before, mk([pk[0]])), ["Cut 2->Track B(deleted)"]);
  assert.deepEqual(bus.diffScopes(before, mk(pk)), []);
});
