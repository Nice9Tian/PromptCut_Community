/**
 * node --test src/ai/rewind.test.mjs
 *
 * Pure logic for "Rewind to here": that user message and everything after it are removed, with the
 * original text and attachments put back into the input box.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { rewindAt } = await import("./rewind.ts");

const u = (id, text = id, extra = {}) => ({ id, role: "user", text, ...extra });
const a = (id, text = id, extra = {}) => ({ id, role: "assistant", text, ...extra });

const convo = () => [u("u1", "First question"), a("a1"), u("u2", "Second question"), a("a2"), u("u3", "Third question"), a("a3")];
const ids = (list) => list.map((m) => m.id);

test("Rewinding a middle round: earlier messages stay, this one and everything after it are removed, and the original text is put back", () => {
  const r = rewindAt(convo(), "u2");
  assert.deepEqual(ids(r.kept), ["u1", "a1"]);
  assert.deepEqual(ids(r.removed), ["u2", "a2", "u3", "a3"]);
  assert.equal(r.restored.text, "Second question");
  assert.deepEqual(r.restored.attachments, []);
});

test("Rewinding the first message: nothing is kept", () => {
  const r = rewindAt(convo(), "u1");
  assert.deepEqual(r.kept, []);
  assert.equal(r.removed.length, 6);
  assert.equal(r.restored.text, "First question");
});

test("Rewinding the last user message: equivalent to unsending and rewriting, only the last question and answer are removed", () => {
  const r = rewindAt(convo(), "u3");
  assert.deepEqual(ids(r.kept), ["u1", "a1", "u2", "a2"]);
  assert.deepEqual(ids(r.removed), ["u3", "a3"]);
});

test("It also works when the last user message has no reply yet (rewinding right after sending)", () => {
  const list = [u("u1"), a("a1"), u("u2", "Just sent")];
  const r = rewindAt(list, "u2");
  assert.deepEqual(ids(r.kept), ["u1", "a1"]);
  assert.deepEqual(ids(r.removed), ["u2"]);
});

test("One question, several answers: the Agent replies carrying roleId are removed together", () => {
  const list = [
    u("u1"), a("a1"),
    u("u2", "Break it into a few steps"),
    a("t-1", "", { roleId: "director", pending: true }),
    a("t-2", "", { roleId: "vfx" }),
    a("t-3", "All set", { roleId: "editor" }),
  ];
  const r = rewindAt(list, "u2");
  assert.deepEqual(ids(r.kept), ["u1", "a1"]);
  assert.deepEqual(ids(r.removed), ["u2", "t-1", "t-2", "t-3"]);
  assert.ok(r.removed.slice(1).every((m) => m.roleId), "All role replies are in the removed section");
});

test("Attachments are put back unchanged, but as a copy, not sharing the object with the original message", () => {
  const att = { id: "f1", name: "口播.mp4", kind: "video", url: "/x", status: "ready" };
  const list = [u("u1", "", { attachments: [att] }), a("a1")];
  const r = rewindAt(list, "u1");
  assert.equal(r.restored.text, "");
  assert.deepEqual(r.restored.attachments, [att]);
  assert.notEqual(r.restored.attachments[0], att);
});

test("Invalid id: nonexistent, or pointing to an Agent message, returns null", () => {
  assert.equal(rewindAt(convo(), "nope"), null);
  assert.equal(rewindAt(convo(), "a2"), null);
  assert.equal(rewindAt([], "u1"), null);
});
