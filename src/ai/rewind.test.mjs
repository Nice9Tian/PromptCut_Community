/**
 * node --test src/ai/rewind.test.mjs
 *
 * 「回退到这里」的纯逻辑:那条用户消息和它之后的全部移除,原文和附件放回输入框。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { rewindAt } = await import("./rewind.ts");

const u = (id, text = id, extra = {}) => ({ id, role: "user", text, ...extra });
const a = (id, text = id, extra = {}) => ({ id, role: "assistant", text, ...extra });

const convo = () => [u("u1", "第一问"), a("a1"), u("u2", "第二问"), a("a2"), u("u3", "第三问"), a("a3")];
const ids = (list) => list.map((m) => m.id);

test("回退中间一轮:之前的留下,这条和之后的全部移除,原文放回", () => {
  const r = rewindAt(convo(), "u2");
  assert.deepEqual(ids(r.kept), ["u1", "a1"]);
  assert.deepEqual(ids(r.removed), ["u2", "a2", "u3", "a3"]);
  assert.equal(r.restored.text, "第二问");
  assert.deepEqual(r.restored.attachments, []);
});

test("回退第一条:什么都不留", () => {
  const r = rewindAt(convo(), "u1");
  assert.deepEqual(r.kept, []);
  assert.equal(r.removed.length, 6);
  assert.equal(r.restored.text, "第一问");
});

test("回退最后一条用户消息:等于撤回重写,只移除最后一问一答", () => {
  const r = rewindAt(convo(), "u3");
  assert.deepEqual(ids(r.kept), ["u1", "a1", "u2", "a2"]);
  assert.deepEqual(ids(r.removed), ["u3", "a3"]);
});

test("最后一条用户消息后面还没有回复(刚发出去就回退)也行", () => {
  const list = [u("u1"), a("a1"), u("u2", "刚发的")];
  const r = rewindAt(list, "u2");
  assert.deepEqual(ids(r.kept), ["u1", "a1"]);
  assert.deepEqual(ids(r.removed), ["u2"]);
});

test("一问多答:带 roleId 的几条 Agent 回复一起移除", () => {
  const list = [
    u("u1"), a("a1"),
    u("u2", "拆成几步做"),
    a("t-1", "", { roleId: "director", pending: true }),
    a("t-2", "", { roleId: "vfx" }),
    a("t-3", "配好了", { roleId: "editor" }),
  ];
  const r = rewindAt(list, "u2");
  assert.deepEqual(ids(r.kept), ["u1", "a1"]);
  assert.deepEqual(ids(r.removed), ["u2", "t-1", "t-2", "t-3"]);
  assert.ok(r.removed.slice(1).every((m) => m.roleId), "角色回复都在被移除的那一段");
});

test("附件原样放回,但是拷贝,不和原消息共用对象", () => {
  const att = { id: "f1", name: "口播.mp4", kind: "video", url: "/x", status: "ready" };
  const list = [u("u1", "", { attachments: [att] }), a("a1")];
  const r = rewindAt(list, "u1");
  assert.equal(r.restored.text, "");
  assert.deepEqual(r.restored.attachments, [att]);
  assert.notEqual(r.restored.attachments[0], att);
});

test("非法 id:不存在、或者指向 Agent 消息,返回 null", () => {
  assert.equal(rewindAt(convo(), "nope"), null);
  assert.equal(rewindAt(convo(), "a2"), null);
  assert.equal(rewindAt([], "u1"), null);
});
