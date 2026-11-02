/**
 * Page-side presence (src/editor/sync/presence.ts, plan agent-workflow-plan.md A3 Phase 2). Test cases MA-P6~MA-P8.
 * Run: node --test src/editor/sync/presence.test.mjs
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

test("MA-P6 publish what is being edited: non-empty sends presence.set (expires after 15 seconds, carries the session id); empty sends presence.clear; nothing is sent to revoke if nothing was ever published", async () => {
  const link = fakeLink((m) => (m.type === "presence.list" ? { type: "presence.state", entries: [] } : { type: "presence.ok" }));
  pres.setPresenceLink(link, "p1", "bob@devB");
  await tick();
  pres.publishEditing("ue-1", []);
  assert.equal(link.sent.filter((m) => m.type !== "presence.list").length, 0, "nothing is sent to revoke if nothing was ever published");
  pres.publishEditing("ue-1", [{ clipId: "c2", kind: "drag" }]);
  const set = link.sent.at(-1);
  assert.deepEqual({ type: set.type, projectId: set.projectId, session: set.session, key: set.key, ttlMs: set.ttlMs, kind: set.data.kind, clip: set.data.entities[0].clipId }, { type: "presence.set", projectId: "p1", session: "ue-1", key: "editing", ttlMs: pres.EDITING_TTL_MS, kind: "editing", clip: "c2" });
  assert.equal(pres.EDITING_TTL_MS, 15_000);
  pres.publishEditing("ue-1", []);
  assert.equal(link.sent.at(-1).type, "presence.clear");
});

test("MA-P7 an old document service replies unsupported: record that this connection does not support it, send nothing from then on, and do not throw", async () => {
  const link = fakeLink(() => ({ type: "error", reason: "unsupported" }));
  pres.setPresenceLink(link, "p1", "bob@devB");
  await tick();
  pres.publishEditing("ue-1", [{ clipId: "c2", kind: "drag" }]);
  await tick();
  const n = link.sent.length;
  pres.publishEditing("ue-1", [{ clipId: "c3", kind: "drag" }]);
  await tick();
  assert.equal(link.sent.length, n, "no longer sent");
  assert.equal(pres.presenceStatus().unsupported, true);
});

test("MA-P8 receive the ranges of Agents on other members' side: list them; your own (same userId) and those from the local space do not count; revoked and expired ones are removed", async () => {
  const link = fakeLink((m) => (m.type === "presence.list"
    ? { type: "presence.state", projectId: "p1", entries: [{ key: "agent:conv-a", from: { userId: "alice@devA", role: "agent" }, data: { kind: "agent", scope: "Cut 1->Track 2", vendor: "claude" }, expiresAt: Date.now() + 60_000 }] }
    : { type: "presence.ok" }));
  pres.setPresenceLink(link, "p1", "bob@devB");
  await tick();
  await tick();
  assert.deepEqual(pres.remoteAgents().map((a) => [a.id, a.member, a.vendor, a.scope]), [["conv-a", "alice", "claude", "Cut 1->Track 2"]]);
  pres.receivePresence({ type: "presence.update", projectId: "p1", key: "agent:conv-mine", from: { userId: "bob@devB", role: "agent" }, data: { kind: "agent", scope: "Cut 1" }, expiresAt: Date.now() + 60_000 });
  pres.receivePresence({ type: "presence.update", projectId: "p1", key: "agent:conv-local", from: { userId: "local", role: "agent" }, data: { kind: "agent", scope: "Cut 1" }, expiresAt: Date.now() + 60_000 });
  pres.receivePresence({ type: "presence.update", projectId: "p2", key: "agent:conv-p2", from: { userId: "carol@devC" }, data: { kind: "agent", scope: "x" }, expiresAt: Date.now() + 60_000 });
  assert.deepEqual(pres.remoteAgents().map((a) => a.id), ["conv-a"], "your own, the local space's, and other projects' do not count");
  pres.receivePresence({ type: "presence.update", projectId: "p1", key: "agent:conv-old", from: { userId: "dan@devD" }, data: { kind: "agent", scope: "y" }, expiresAt: Date.now() - 1 });
  assert.deepEqual(pres.remoteAgents().map((a) => a.id), ["conv-a"], "expired ones are not listed");
  pres.receivePresence({ type: "presence.update", projectId: "p1", key: "agent:conv-a", from: { userId: "alice@devA" }, data: null, expiresAt: 0 });
  assert.deepEqual(pres.remoteAgents(), []);
  pres.setPresenceLink(null, null, "");
  assert.equal(pres.presenceStatus().linked, false);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cloudFrom = (userId, extra = {}) => ({ userId, deviceId: userId.slice(userId.indexOf("@") + 1), role: "agent", conversation: "cc-1", service: "agent", session: "s-1", ...extra });
const runUpdate = (userId, over = {}) => ({ type: "presence.update", projectId: "p1", key: "cloud-run", from: cloudFrom(userId), data: { v: 1, kind: "cloud-run", runs: 1 }, expiresAt: Date.now() + 90_000, ...over });

test("CAU-MEM-03 Cloud Agent \"round running\" table: recognizes cloud-run entries (including your own row); revoked ones, runs of 0, ones not sent by a service connection, and other projects' do not count; switching projects and disconnecting clear it", async () => {
  const link = fakeLink((m) => (m.type === "presence.list" ? { type: "presence.state", projectId: "p1", entries: [] } : { type: "presence.ok" }));
  pres.setPresenceLink(link, "p1", "bob@devB");
  await tick();
  await tick();
  assert.equal(pres.cloudRunning().size, 0);
  let notified = 0;
  const off = pres.subscribeCloudRunning(() => { notified += 1; });
  pres.receivePresence(runUpdate("alice@devA"));
  assert.deepEqual([...pres.cloudRunning()], ["alice@devA"], "another member's round is running");
  assert.equal(notified, 1);
  pres.receivePresence(runUpdate("bob@devB"));
  assert.deepEqual([...pres.cloudRunning()].sort(), ["alice@devA", "bob@devB"], "your own row counts too (the \"your own don't count\" filter for agent: entries does not apply)");
  const snap = pres.cloudRunning();
  assert.equal(pres.cloudRunning(), snap, "Same object when nothing changed (required by useSyncExternalStore)");
  // Second entry for the same member (connection from another chat): revoke one, the other remains,
  // still counts as running
  pres.receivePresence(runUpdate("alice@devA", { from: cloudFrom("alice@devA", { conversation: "cc-2", session: "s-2" }) }));
  pres.receivePresence(runUpdate("alice@devA", { data: null, expiresAt: 0 }));
  assert.ok(pres.cloudRunning().has("alice@devA"), "The same member still has one entry that was not withdrawn");
  pres.receivePresence(runUpdate("alice@devA", { from: cloudFrom("alice@devA", { conversation: "cc-2", session: "s-2" }), data: null, expiresAt: 0 }));
  assert.ok(!pres.cloudRunning().has("alice@devA"), "Does not count after withdrawal (data: null)");
  // Does not count
  pres.receivePresence(runUpdate("carol@devC", { from: { userId: "carol@devC", deviceId: "devC", role: "page", session: "s-9" } }));
  assert.ok(!pres.cloudRunning().has("carol@devC"), "Not sent by a service connection (no service: 'agent'), so it cannot be forged");
  pres.receivePresence(runUpdate("carol@devC", { data: { v: 1, kind: "cloud-run", runs: 0 } }));
  assert.ok(!pres.cloudRunning().has("carol@devC"), "Does not count when runs is 0");
  pres.receivePresence(runUpdate("carol@devC", { data: { v: 1, kind: "agent", scope: "x" } }));
  assert.ok(!pres.cloudRunning().has("carol@devC"), "Does not count when data is not cloud-run");
  pres.receivePresence(runUpdate("carol@devC", { projectId: "p2" }));
  assert.ok(!pres.cloudRunning().has("carol@devC"), "Entries from other projects do not count");
  assert.deepEqual(pres.remoteAgents(), [], "cloud-run does not go into the \"other members' Agents\" list");
  // Entries in presence.state (fetched existing after reconnect) are also recognized
  pres.receivePresence({ type: "presence.state", projectId: "p1", entries: [{ key: "cloud-run", from: cloudFrom("dan@devD"), data: { v: 1, kind: "cloud-run", runs: 2 }, expiresAt: Date.now() + 90_000 }] });
  assert.ok(pres.cloudRunning().has("dan@devD"));
  // Switch project / disconnect: clear and notify
  const before = notified;
  pres.setPresenceLink(link, "p9", "bob@devB");
  assert.equal(pres.cloudRunning().size, 0, "Cleared when switching projects");
  assert.ok(notified > before, "Subscribers are notified on clear");
  pres.receivePresence({ ...runUpdate("alice@devA"), projectId: "p9" });
  assert.ok(pres.cloudRunning().has("alice@devA"));
  pres.setPresenceLink(null, null, "");
  assert.equal(pres.cloudRunning().size, 0, "Cleared on disconnect");
  assert.equal(pres.presenceStatus().cloudRunning, 0);
  off();
});

test("CAU-MEM-04 An entry for a round in progress automatically stops counting after it expires: it is filtered by the current time on read, and subscribers are notified to redraw when it expires", async () => {
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
  assert.ok(!pres.cloudRunning().has("alice@devA"), "Does not count after expiry");
  assert.ok(notified > n1, "Subscribers were notified at expiry (no need to wait for another message to redraw)");
  // Already expired items do not count even if delivered
  pres.receivePresence(runUpdate("alice@devA", { expiresAt: Date.now() - 1 }));
  assert.ok(!pres.cloudRunning().has("alice@devA"));
  // Renew: another item arrives before expiration, extends time
  pres.receivePresence(runUpdate("dan@devD", { expiresAt: Date.now() + 120 }));
  await wait(60);
  pres.receivePresence(runUpdate("dan@devD", { expiresAt: Date.now() + 400 }));
  await wait(150);
  assert.ok(pres.cloudRunning().has("dan@devD"), "Still present after renewal");
  await wait(400);
  assert.ok(!pres.cloudRunning().has("dan@devD"));
  off();
  pres.setPresenceLink(null, null, "");
});
