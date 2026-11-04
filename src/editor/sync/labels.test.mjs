/**
 * Wording for "modified by whom" in tooltip bubble for account cloud projects (`writerLabel` in
 * `labels.ts`). Run: npm test -- src/editor/sync/labels.test.mjs
 *
 *   LBL-01 Write identity for account projects (userId is `account:<accountId>@<deviceId>`) looks
 *          up name in member list by account; same account on another device uses the same name
 *   LBL-02 Wording for this page and own other page unchanged; falls back to original path when
 *          absent from list
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const L = await import("./labels.ts");
const A = "acc_aaaaaaaaaaaaaaaaaaaaaaaa", B = "acc_bbbbbbbbbbbbbbbbbbbbbbbb";
const actor = (accountId, device, session) => ({ userId: `account:${accountId}@${device}`, deviceId: device, role: "page", session, identityVersion: 2, realm: "account", accountId });
const names = new Map([[L.accountNameKey(A), "alice"], [L.accountNameKey(B), "bob"]]);
const me = { session: "s-me", userId: `account:${A}@dev-1` };

test("LBL-01 in an account project members are shown by account name, not as account:…@device id", () => {
  assert.equal(L.writerLabel({ actor: actor(B, "dev-9", "s-b"), session: "s-b" }, me, names), "bob");
  assert.equal(L.writerLabel(actor(B, "dev-other", "s-b2"), me, names), "bob", "an actor given directly by the document service, another device");
  assert.equal(L.writerLabel({ actor: actor(A, "dev-2", "s-a2") }, me, names), "alice", "your own account on another device: referred to by name");
});

test("LBL-02 the wording for your own page is unchanged; when not in the list, the original fallback applies", () => {
  assert.equal(L.writerLabel({ actor: actor(A, "dev-1", "s-me"), session: "s-me" }, me, names), "You on this page");
  assert.equal(L.writerLabel({ actor: actor(A, "dev-1", "s-other") }, me, names), "You on another page");
  assert.equal(L.writerLabel({ actor: actor(B, "dev-9", "s-b") }, me, new Map()), `account:${B}@dev-9`);
  // Non-account projects remain as usual
  assert.equal(L.writerLabel({ actor: { userId: "alice@dev-a", role: "page", session: "s-p" } }, { session: "x", userId: "bob@d" }, new Map([["alice@dev-a", "alice"]])), "alice");
});

test("LBL-03 the history sequence number text is uniformly named \"History sequence number\"", () => {
  assert.equal(L.historySeqLabel(1), "History sequence number 1");
  assert.equal(L.historySeqLabel(15), "History sequence number 15");
  assert.equal(L.historySeqLabel(null), "History sequence number -");
});

