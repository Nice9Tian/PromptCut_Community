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

test("ACC-MEM-01 创建者离线、他的云端 Agent 在跑:不计人数、计 Agent,行标「离线，Agent 在跑」", () => {
  const devices = [dev(bob, "b-page", [{ role: "page" }]), dev(alice, "run:run_1", [{ role: "agent", service: "agent" }])];
  const snap = { members, devices };
  assert.equal(H.accountMemberCountLabel(snap), "成员：1 人 · Agent：1 个");
  const a = H.accountMemberState(alice, devices);
  assert.deepEqual({ online: a.online, cloudRunning: a.cloudRunning, offlineAgent: a.offlineAgent, local: a.localAgents.length },
    { online: false, cloudRunning: true, offlineAgent: true, local: 0 });
  assert.equal(H.accountMemberState(bob, devices).offlineAgent, false);
  assert.equal(H.accountMemberState(carol, devices).online, false);
  assert.equal(H.accountMemberState(carol, devices).offlineAgent, false, "没有连接的成员只是离线");
});

test("ACC-MEM-02 本机 Agent 逐条算;云端 Agent 每位成员最多算一个;本人在线时不标离线", () => {
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
  assert.equal(H.accountMemberState(carol, devices).online, false, "只有渲染连接不算真人在线");
});

test("ACC-MEM-03 不在成员名单里的账号的连接不计", () => {
  const stranger = "acc_" + "d".repeat(24);
  const devices = [dev(bob, "b", [{ role: "page" }]), dev(stranger, "run:x", [{ role: "agent", service: "agent" }])];
  assert.equal(H.accountMemberCountLabel({ members, devices }), "成员：1 人 · Agent：0 个");
});
