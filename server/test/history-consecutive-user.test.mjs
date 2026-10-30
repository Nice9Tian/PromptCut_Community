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

test("末尾是 user 时并进那一条,而不是新起一条", () => {
  const h = new MessageHistory();
  h.append({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "已中断" }] });
  h.appendUserText("继续");

  const msgs = h.get();
  assert.equal(msgs.length, 1, "不许多出一条 user");
  assert.deepEqual(msgs[0].content.map((b) => b.type), ["tool_result", "text"]);
  assert.equal(msgs[0].content[1].text, "继续");
  assert.equal(consecutiveSameRole(msgs), -1);
});

test("末尾是 assistant 时正常新起一条", () => {
  const h = new MessageHistory();
  h.append({ role: "assistant", content: [{ type: "text", text: "好的" }] });
  h.appendUserText("再来一个");

  const msgs = h.get();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].role, "user");
  assert.equal(consecutiveSameRole(msgs), -1);
});

test("空历史时就是普通的第一条", () => {
  const h = new MessageHistory();
  h.appendUserText("你好");
  assert.deepEqual(h.get(), [{ role: "user", content: [{ type: "text", text: "你好" }] }]);
});

test("连着并两次也只有一条 user", () => {
  const h = new MessageHistory();
  h.appendUserText("一");
  h.appendUserText("二");
  const msgs = h.get();
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0].content.map((b) => b.text), ["一", "二"]);
});

test("末尾那条 user 是老格式字符串时,也要并进去而不是新起一条", () => {
  /*
   * 盘上那个文件只经过 JSON.parse,不校验形状(api.mjs),所以 content 是字符串的
   * 老格式历史真的读得回来。原来这里退回「新起一条」—— 可末尾本来就是 user,
   * 新起一条正好拼出这个方法要消灭的形状。
   */
  const h = new MessageHistory();
  h.append({ role: "user", content: "纯字符串的老格式" });
  h.appendUserText("继续");

  const msgs = h.get();
  assert.equal(msgs.length, 1, "不许多出一条 user");
  assert.deepEqual(msgs[0].content, [
    { type: "text", text: "纯字符串的老格式" },
    { type: "text", text: "继续" },
  ], "字符串要就地规范成块数组,原话不能丢");
  assert.equal(consecutiveSameRole(msgs), -1);
});

test("末尾那条 user 的 content 是个怪东西时不许崩", () => {
  const h = new MessageHistory();
  h.append({ role: "user", content: 42 });
  assert.doesNotThrow(() => h.appendUserText("继续"));
  assert.equal(h.get().length, 2, "救不回来就只能新起一条 —— 至少不能崩");
});
test("改的是历史里那一条,不是 get() 返回的拷贝", () => {
  const h = new MessageHistory();
  h.append({ role: "user", content: [{ type: "text", text: "先" }] });
  const snapshotBefore = h.get();
  h.appendUserText("后");
  // get() 是浅拷贝,同一批对象;这里要钉的是「历史自己真的变了」
  assert.equal(h.get()[0].content.length, 2);
  assert.equal(snapshotBefore.length, 1, "拷贝出去的数组长度不该被改");
});
