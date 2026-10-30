/**
 * 页面一侧的在场状态(src/editor/sync/presence.ts,计划 agent-workflow-plan.md A3 第二阶段)。用例 MA-P6～MA-P8。
 * 跑:node --test src/editor/sync/presence.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

const pres = await import("./presence.ts");

function fakeLink(replyFor) {
  const sent = [];
  return {
    sent,
    request: async (msg) => {
      sent.push(msg);
      return replyFor(msg);
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("MA-P6 发布正在编辑:非空 presence.set(15 秒过期、带会话号);空了 presence.clear;没发布过不发撤销", async () => {
  const link = fakeLink((m) => (m.type === "presence.list" ? { type: "presence.state", entries: [] } : { type: "presence.ok" }));
  pres.setPresenceLink(link, "p1", "bob@devB");
  await tick();
  pres.publishEditing("ue-1", []);
  assert.equal(link.sent.filter((m) => m.type !== "presence.list").length, 0, "没发布过就不发撤销");
  pres.publishEditing("ue-1", [{ clipId: "c2", kind: "drag" }]);
  const set = link.sent.at(-1);
  assert.deepEqual({ type: set.type, projectId: set.projectId, session: set.session, key: set.key, ttlMs: set.ttlMs, kind: set.data.kind, clip: set.data.entities[0].clipId }, { type: "presence.set", projectId: "p1", session: "ue-1", key: "editing", ttlMs: pres.EDITING_TTL_MS, kind: "editing", clip: "c2" });
  assert.equal(pres.EDITING_TTL_MS, 15_000);
  pres.publishEditing("ue-1", []);
  assert.equal(link.sent.at(-1).type, "presence.clear");
});

test("MA-P7 旧版文档服务回 unsupported:记下这条连接不支持,之后一概不发,不抛错", async () => {
  const link = fakeLink(() => ({ type: "error", reason: "unsupported" }));
  pres.setPresenceLink(link, "p1", "bob@devB");
  await tick();
  pres.publishEditing("ue-1", [{ clipId: "c2", kind: "drag" }]);
  await tick();
  const n = link.sent.length;
  pres.publishEditing("ue-1", [{ clipId: "c3", kind: "drag" }]);
  await tick();
  assert.equal(link.sent.length, n, "不再发");
  assert.equal(pres.presenceStatus().unsupported, true);
});

test("MA-P8 收别的成员那边 Agent 的范围:列出来;自己的(同一个 userId)与本机空间的不算;撤销与过期的去掉", async () => {
  const link = fakeLink((m) => (m.type === "presence.list"
    ? { type: "presence.state", projectId: "p1", entries: [{ key: "agent:conv-a", from: { userId: "alice@devA", role: "agent" }, data: { kind: "agent", scope: "剪辑1->序列2", vendor: "claude" }, expiresAt: Date.now() + 60_000 }] }
    : { type: "presence.ok" }));
  pres.setPresenceLink(link, "p1", "bob@devB");
  await tick();
  await tick();
  assert.deepEqual(pres.remoteAgents().map((a) => [a.id, a.member, a.vendor, a.scope]), [["conv-a", "alice", "claude", "剪辑1->序列2"]]);
  pres.receivePresence({ type: "presence.update", projectId: "p1", key: "agent:conv-mine", from: { userId: "bob@devB", role: "agent" }, data: { kind: "agent", scope: "剪辑1" }, expiresAt: Date.now() + 60_000 });
  pres.receivePresence({ type: "presence.update", projectId: "p1", key: "agent:conv-local", from: { userId: "local", role: "agent" }, data: { kind: "agent", scope: "剪辑1" }, expiresAt: Date.now() + 60_000 });
  pres.receivePresence({ type: "presence.update", projectId: "p2", key: "agent:conv-p2", from: { userId: "carol@devC" }, data: { kind: "agent", scope: "x" }, expiresAt: Date.now() + 60_000 });
  assert.deepEqual(pres.remoteAgents().map((a) => a.id), ["conv-a"], "自己的、本机空间的、别的项目的都不算");
  pres.receivePresence({ type: "presence.update", projectId: "p1", key: "agent:conv-old", from: { userId: "dan@devD" }, data: { kind: "agent", scope: "y" }, expiresAt: Date.now() - 1 });
  assert.deepEqual(pres.remoteAgents().map((a) => a.id), ["conv-a"], "过期的不列");
  pres.receivePresence({ type: "presence.update", projectId: "p1", key: "agent:conv-a", from: { userId: "alice@devA" }, data: null, expiresAt: 0 });
  assert.deepEqual(pres.remoteAgents(), []);
  pres.setPresenceLink(null, null, "");
  assert.equal(pres.presenceStatus().linked, false);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cloudFrom = (userId, extra = {}) => ({ userId, deviceId: userId.slice(userId.indexOf("@") + 1), role: "agent", conversation: "cc-1", service: "agent", session: "s-1", ...extra });
const runUpdate = (userId, over = {}) => ({ type: "presence.update", projectId: "p1", key: "cloud-run", from: cloudFrom(userId), data: { v: 1, kind: "cloud-run", runs: 1 }, expiresAt: Date.now() + 90_000, ...over });

test("CAU-MEM-03 云端 Agent「一轮在跑」表:认 cloud-run 条目(含自己那一行);撤掉、runs 为 0、不是服务连接发的、别的项目的都不算;换项目与断开清空", async () => {
  const link = fakeLink((m) => (m.type === "presence.list" ? { type: "presence.state", projectId: "p1", entries: [] } : { type: "presence.ok" }));
  pres.setPresenceLink(link, "p1", "bob@devB");
  await tick();
  await tick();
  assert.equal(pres.cloudRunning().size, 0);
  let notified = 0;
  const off = pres.subscribeCloudRunning(() => { notified += 1; });
  pres.receivePresence(runUpdate("alice@devA"));
  assert.deepEqual([...pres.cloudRunning()], ["alice@devA"], "别的成员的一轮在跑");
  assert.equal(notified, 1);
  pres.receivePresence(runUpdate("bob@devB"));
  assert.deepEqual([...pres.cloudRunning()].sort(), ["alice@devA", "bob@devB"], "自己的那一行也算(不套 agent: 条目「自己的不算」的过滤)");
  const snap = pres.cloudRunning();
  assert.equal(pres.cloudRunning(), snap, "没变化时是同一个对象(useSyncExternalStore 要求)");
  // 同一位成员的第二条(另一个对话的连接):撤掉其中一条,另一条还在,仍算在跑
  pres.receivePresence(runUpdate("alice@devA", { from: cloudFrom("alice@devA", { conversation: "cc-2", session: "s-2" }) }));
  pres.receivePresence(runUpdate("alice@devA", { data: null, expiresAt: 0 }));
  assert.ok(pres.cloudRunning().has("alice@devA"), "同一位成员还有一条没撤掉");
  pres.receivePresence(runUpdate("alice@devA", { from: cloudFrom("alice@devA", { conversation: "cc-2", session: "s-2" }), data: null, expiresAt: 0 }));
  assert.ok(!pres.cloudRunning().has("alice@devA"), "撤掉(data: null)后不算");
  // 不算的
  pres.receivePresence(runUpdate("carol@devC", { from: { userId: "carol@devC", deviceId: "devC", role: "page", session: "s-9" } }));
  assert.ok(!pres.cloudRunning().has("carol@devC"), "不是服务连接(没有 service: 'agent')发的,伪造不了");
  pres.receivePresence(runUpdate("carol@devC", { data: { v: 1, kind: "cloud-run", runs: 0 } }));
  assert.ok(!pres.cloudRunning().has("carol@devC"), "runs 为 0 不算");
  pres.receivePresence(runUpdate("carol@devC", { data: { v: 1, kind: "agent", scope: "x" } }));
  assert.ok(!pres.cloudRunning().has("carol@devC"), "data 不是 cloud-run 不算");
  pres.receivePresence(runUpdate("carol@devC", { projectId: "p2" }));
  assert.ok(!pres.cloudRunning().has("carol@devC"), "别的项目的不算");
  assert.deepEqual(pres.remoteAgents(), [], "cloud-run 不进「别的成员的 Agent」那一条");
  // presence.state(重连后取现有的)里的也认
  pres.receivePresence({ type: "presence.state", projectId: "p1", entries: [{ key: "cloud-run", from: cloudFrom("dan@devD"), data: { v: 1, kind: "cloud-run", runs: 2 }, expiresAt: Date.now() + 90_000 }] });
  assert.ok(pres.cloudRunning().has("dan@devD"));
  // 换项目 / 断开:清空并通知
  const before = notified;
  pres.setPresenceLink(link, "p9", "bob@devB");
  assert.equal(pres.cloudRunning().size, 0, "换项目清空");
  assert.ok(notified > before, "清空时通知订阅者");
  pres.receivePresence({ ...runUpdate("alice@devA"), projectId: "p9" });
  assert.ok(pres.cloudRunning().has("alice@devA"));
  pres.setPresenceLink(null, null, "");
  assert.equal(pres.cloudRunning().size, 0, "断开清空");
  assert.equal(pres.presenceStatus().cloudRunning, 0);
  off();
});

test("CAU-MEM-04 一轮在跑的条目过期后自动不算:读的时候按当前时间滤,并在到期时通知订阅者重画", async () => {
  const link = fakeLink((m) => (m.type === "presence.list" ? { type: "presence.state", projectId: "p1", entries: [] } : { type: "presence.ok" }));
  pres.setPresenceLink(link, "p1", "bob@devB");
  await tick();
  await tick();
  let notified = 0;
  const off = pres.subscribeCloudRunning(() => { notified += 1; });
  pres.receivePresence(runUpdate("alice@devA", { expiresAt: Date.now() + 120 }));
  assert.ok(pres.cloudRunning().has("alice@devA"));
  const n1 = notified;
  await wait(260);
  assert.ok(!pres.cloudRunning().has("alice@devA"), "过期后不算");
  assert.ok(notified > n1, "到期时通知了订阅者(不用等别的消息来重画)");
  // 已经过期的条目送来也不算
  pres.receivePresence(runUpdate("alice@devA", { expiresAt: Date.now() - 1 }));
  assert.ok(!pres.cloudRunning().has("alice@devA"));
  // 续期:过期前又来一条,时间往后推
  pres.receivePresence(runUpdate("dan@devD", { expiresAt: Date.now() + 120 }));
  await wait(60);
  pres.receivePresence(runUpdate("dan@devD", { expiresAt: Date.now() + 400 }));
  await wait(150);
  assert.ok(pres.cloudRunning().has("dan@devD"), "续期后还在");
  await wait(400);
  assert.ok(!pres.cloudRunning().has("dan@devD"));
  off();
  pres.setPresenceLink(null, null, "");
});
