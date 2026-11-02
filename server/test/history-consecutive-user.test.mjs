/**
 * node --test server/test/history-consecutive-user.test.mjs
 *
 * 历史里**不许出现两条连着的 user 消息**。
 *
 * Anthropic 不收这种形状,而 anthropic / openai / gemini 三家转换里都没有合并
 * 同角色消息的逻辑 —— 也就是说这个形状一旦拼出来,就是一个直到发出去才炸的 400。
 *
 * 它不是理论问题,有两条真实路径会拼出来:
 *   1. 中断落盘会在末尾补一条 user(装 is_error 的 tool_result),下次接着说时
 *      run() 又要放一条用户的话;
 *   2. 撞到轮次上限时,刚放完 tool_result(user)紧接着就放收尾指令(也是 user)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageHistory } from "../harness/history.mjs";

/** 有没有两条挨着的同角色消息 */
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
   * 盘上那个文件只经过 JSON.parse,不校验形状(api.mjs),所以 content 是字符串的
   * 老格式历史真的读得回来。原来这里退回「新起一条」—— 可末尾本来就是 user,
   * 新起一条正好拼出这个方法要消灭的形状。
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
  // get() 是浅拷贝,同一批对象;这里要钉的是「历史自己真的变了」
  assert.equal(h.get()[0].content.length, 2);
  assert.equal(snapshotBefore.length, 1, "the length of the array that was copied out must not change");
});
