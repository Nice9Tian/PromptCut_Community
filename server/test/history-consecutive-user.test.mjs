/**
 * node --test server/test/history-consecutive-user.test.mjs
 *
 * In history, **two consecutive user messages are not allowed**.
 *
 * Anthropic does not accept this shape, and none of the conversions for anthropic / openai / gemini
 * have logic to merge messages of the same role: meaning once this shape is formed, it is a 400
 * that will not blow up until sent.
 *
 * This is not a theoretical issue; two real paths can produce it:
 *   1. Persistence on interrupt appends a user message at the end (containing tool_result with
 *      is_error); when continuing next time, run() puts another user message;
 *   2. When hitting the round limit, right after placing tool_result (user), it immediately
 *      places the wrap-up instruction (also user).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageHistory } from "../harness/history.mjs";

/** Whether there are two adjacent messages of the same role */
function consecutiveSameRole(msgs) {
  for (let i = 1; i < msgs.length; i++) if (msgs[i].role === msgs[i - 1].role) return i;
  return -1;
}

test("when the last entry is user, merge into it rather than starting a new one", () => {
  const h = new MessageHistory();
  h.append({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Interrupted" }] });
  h.appendUserText("Continue");

  const msgs = h.get();
  assert.equal(msgs.length, 1, "no extra user entry allowed");
  assert.deepEqual(msgs[0].content.map((b) => b.type), ["tool_result", "text"]);
  assert.equal(msgs[0].content[1].text, "Continue");
  assert.equal(consecutiveSameRole(msgs), -1);
});

test("when the last entry is assistant, start a new one as usual", () => {
  const h = new MessageHistory();
  h.append({ role: "assistant", content: [{ type: "text", text: "OK" }] });
  h.appendUserText("One more");

  const msgs = h.get();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].role, "user");
  assert.equal(consecutiveSameRole(msgs), -1);
});

test("with an empty history it is just a normal first entry", () => {
  const h = new MessageHistory();
  h.appendUserText("Hello");
  assert.deepEqual(h.get(), [{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
});

test("even after merging twice in a row there is only one user entry", () => {
  const h = new MessageHistory();
  h.appendUserText("One");
  h.appendUserText("Two");
  const msgs = h.get();
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0].content.map((b) => b.text), ["One", "Two"]);
});

test("when the last user entry is an old-format string, it must also be merged into rather than starting a new one", () => {
  /*
   * The file on disk only goes through JSON.parse without validating shape (api.mjs), so old-format
   * history where content is a string can indeed be read back. Previously this fell back to "start
   * a new one": but the end was already user, so starting a new one happened to construct the exact
   * shape this method is meant to eliminate.
   */
  const h = new MessageHistory();
  h.append({ role: "user", content: "Old format, plain string" });
  h.appendUserText("Continue");

  const msgs = h.get();
  assert.equal(msgs.length, 1, "no extra user entry allowed");
  assert.deepEqual(msgs[0].content, [
    { type: "text", text: "Old format, plain string" },
    { type: "text", text: "Continue" },
  ], "the string must be normalized in place into a block array, and the original text must not be lost");
  assert.equal(consecutiveSameRole(msgs), -1);
});

test("must not crash when the content of the last user entry is something odd", () => {
  const h = new MessageHistory();
  h.append({ role: "user", content: 42 });
  assert.doesNotThrow(() => h.appendUserText("Continue"));
  assert.equal(h.get().length, 2, "if it cannot be salvaged, the only option is to start a new entry: at least it must not crash");
});
test("it modifies the entry in the history, not the copy returned by get()", () => {
  const h = new MessageHistory();
  h.append({ role: "user", content: [{ type: "text", text: "First" }] });
  const snapshotBefore = h.get();
  h.appendUserText("Then");
  // get() is a shallow copy with the same objects; what needs to be verified here is that
  // "history itself actually changed"
  assert.equal(h.get()[0].content.length, 2);
  assert.equal(snapshotBefore.length, 1, "the length of the array that was copied out must not change");
});
