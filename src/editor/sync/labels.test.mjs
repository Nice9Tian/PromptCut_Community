/**
 * 提示气泡里「谁改的」在账号云端项目里的说法(`labels.ts` 的 `writerLabel`)。跑:npm test -- src/editor/sync/labels.test.mjs
 *
 *   LBL-01 账号项目的写入身份(userId 是 `account:<账号号>@<设备号>`)按账号查成员名单里的名字;同一个账号在别的设备上也是这个名字
 *   LBL-02 自己这个页面、自己的另一个页面的说法不变;名单里没有时照原来的退路
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const L = await import("./labels.ts");
const A = "acc_aaaaaaaaaaaaaaaaaaaaaaaa", B = "acc_bbbbbbbbbbbbbbbbbbbbbbbb";
const actor = (accountId, device, session) => ({ userId: `account:${accountId}@${device}`, deviceId: device, role: "page", session, identityVersion: 2, realm: "account", accountId });
const names = new Map([[L.accountNameKey(A), "alice"], [L.accountNameKey(B), "bob"]]);
const me = { session: "s-me", userId: `account:${A}@dev-1` };

test("LBL-01 账号项目里按账号显示成员名字,不显示 account:…@设备号", () => {
  assert.equal(L.writerLabel({ actor: actor(B, "dev-9", "s-b"), session: "s-b" }, me, names), "bob");
  assert.equal(L.writerLabel(actor(B, "dev-other", "s-b2"), me, names), "bob", "文档服务直接给的 actor、别的设备");
  assert.equal(L.writerLabel({ actor: actor(A, "dev-2", "s-a2") }, me, names), "alice", "自己的账号在另一台设备上:按名字说");
});

test("LBL-02 自己的页面说法不变;名单里没有时照原来的退路", () => {
  assert.equal(L.writerLabel({ actor: actor(A, "dev-1", "s-me"), session: "s-me" }, me, names), "你在这个页面");
  assert.equal(L.writerLabel({ actor: actor(A, "dev-1", "s-other") }, me, names), "你在另一个页面");
  assert.equal(L.writerLabel({ actor: actor(B, "dev-9", "s-b") }, me, new Map()), `account:${B}@dev-9`);
  // 非账号项目照旧
  assert.equal(L.writerLabel({ actor: { userId: "alice@dev-a", role: "page", session: "s-p" } }, { session: "x", userId: "bob@d" }, new Map([["alice@dev-a", "alice"]])), "alice");
});

test("LBL-03 历史序号文字统一命名为「历史序号」", () => {
  assert.equal(L.historySeqLabel(1), "历史序号 1");
  assert.equal(L.historySeqLabel(15), "历史序号 15");
  assert.equal(L.historySeqLabel(null), "历史序号 -");
});

