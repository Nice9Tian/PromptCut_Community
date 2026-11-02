/**
 * 账号云端项目的成员列表计数(语义 `product/agent.md`「成员列表怎么数」;`hostedServices.ts` 的 `accountMemberState` 等)。
 * 回归:创建者离线、他的云端 Agent 在跑时,别的成员看到的是「成员：1 人 · Agent：1 个」,创建者那一行标「离线，Agent 在跑」(探针 B1)。
 *
 *   node --test src/editor/sync/accountMemberCounts.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const H = await import(srcUrl("editor/sync/hostedServices.ts"));

const alice = "acc_" + "a".repeat(24), bob = "acc_" + "b".repeat(24), carol = "acc_" + "c".repeat(24);
const members = [alice, bob, carol].map((accountId) => ({ accountId }));
const dev = (accountId, deviceId, conns) => ({ accountId, deviceId, conns });

test("ACC-MEM-01 creator offline, their Cloud Agent running: not counted as a member but counted as an Agent, row labeled \"Offline, Agent running\"", () => {
  const devices = [dev(bob, "b-page", [{ role: "page" }]), dev(alice, "run:run_1", [{ role: "agent", service: "agent" }])];
  const snap = { members, devices };
  assert.equal(H.accountMemberCountLabel(snap), "Members: 1 · Agents: 1");
  const a = H.accountMemberState(alice, devices);
  assert.deepEqual({ online: a.online, cloudRunning: a.cloudRunning, offlineAgent: a.offlineAgent, local: a.localAgents.length },
    { online: false, cloudRunning: true, offlineAgent: true, local: 0 });
  assert.equal(H.accountMemberState(bob, devices).offlineAgent, false);
  assert.equal(H.accountMemberState(carol, devices).online, false);
  assert.equal(H.accountMemberState(carol, devices).offlineAgent, false, "a member with no connection is just offline");
});

test("ACC-MEM-02 local Agents are counted one by one; Cloud Agents count at most one per member; no offline label while the member is online", () => {
  const devices = [
    dev(alice, "a-page", [{ role: "page" }, { role: "agent", conversation: 1 }, { role: "agent", conversation: 2 }]),
    dev(alice, "run:run_1", [{ role: "agent", service: "agent" }]),
    dev(alice, "run:run_2", [{ role: "agent", service: "agent" }]),
    dev(bob, "b-page", [{ role: "page" }]),
    dev(carol, "c-render", [{ role: "render", service: "render" }]),
  ];
  assert.deepEqual(H.accountMemberCounts({ members, devices }), { people: 2, agents: 3 });
  const a = H.accountMemberState(alice, devices);
  assert.equal(a.offlineAgent, false);
  assert.equal(a.cloudRunning, true);
  assert.equal(H.accountMemberState(carol, devices).online, false, "a render-only connection does not count as a person being online");
});

test("ACC-MEM-03 connections of accounts that are not on the member list are not counted", () => {
  const stranger = "acc_" + "d".repeat(24);
  const devices = [dev(bob, "b", [{ role: "page" }]), dev(stranger, "run:x", [{ role: "agent", service: "agent" }])];
  assert.equal(H.accountMemberCountLabel({ members, devices }), "Members: 1 · Agents: 0");
});
