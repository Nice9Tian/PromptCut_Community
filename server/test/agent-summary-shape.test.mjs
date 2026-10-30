/**
 * node --test server/test/agent-summary-shape.test.mjs
 *
 * 收尾那一轮(撞到轮次上限 / 重复操作检测)落进历史的形状。
 *
 * 这里钉的和 history-consecutive-user 是同一条不变量的另一半:那边治两条连着的
 * **user**,这边治两条连着的 **assistant**。
 *
 * 为什么这半更狠:收尾轮的产物会被 saveHistory 原样写进 harness-sessions 里那个
 * 文件,而后续没有任何一步会把它合并回去 —— 角色不交替的历史读回来照样发出去,
 * **这个会话从此每次都 400 而且不自愈**,用户根本不知道有这么个文件可以删。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../harness/agent.mjs";

/**
 * 一个假模型:第一轮调一次工具(好让轮次上限触发),之后只说话。
 * 事件名要和真 provider 一致(text_delta / tool_use / stop),不然测的就不是同一条路。
 */
function scripted(finalText) {
  let round = 0;
  return {
    async *stream() {
      round++;
      if (round === 1) {
        yield { type: "tool_use", id: "c1", name: "noop", input: {} };
      } else if (finalText) {
        yield { type: "text_delta", text: finalText };
      }
      yield { type: "stop", reason: "end_turn" };
    },
  };
}

const NOOP_TOOL = { name: "noop", inputSchema: {}, execute: async () => ({ ok: true }) };

function consecutiveSameRole(msgs) {
  for (let i = 1; i < msgs.length; i++) if (msgs[i].role === msgs[i - 1].role) return i;
  return -1;
}

test("撞到轮次上限时,收尾那句要并进同一条 assistant", async () => {
  // maxIterations = 1:第一轮调完工具就触发上限,第二轮进 summarizing
  const agent = new Agent({ provider: scripted("我做了一半"), system: "", tools: [NOOP_TOOL], maxIterations: 1 });
  const out = await agent.run("开始");
  assert.equal(out.outcome, "round_limit", "得真的走到收尾轮,不然这条测试什么也没测");

  const msgs = agent.history.get();
  assert.equal(consecutiveSameRole(msgs), -1, `不许有连着的同角色:${msgs.map((m) => m.role).join(",")}`);

  const last = msgs.at(-1);
  assert.equal(last.role, "assistant");
  const text = last.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  assert.match(text, /我做了一半/, "模型说的话要在");
  assert.match(text, /本次执行已暂停/, "收尾那句也要在同一条里,不能另起一条 assistant");
});

test("收尾轮模型一个字都没说时,那句自己成一条 assistant —— 仍然不连排", async () => {
  const agent = new Agent({ provider: scripted(""), system: "", tools: [NOOP_TOOL], maxIterations: 1 });
  await agent.run("开始");

  const msgs = agent.history.get();
  assert.equal(consecutiveSameRole(msgs), -1);
  assert.match(msgs.at(-1).content.map((b) => b.text || "").join(""), /本次执行已暂停/);
});

test("整段历史从头到尾角色都交替 —— 这才是发出去不会 400 的前提", async () => {
  const agent = new Agent({ provider: scripted("收工"), system: "", tools: [NOOP_TOOL], maxIterations: 1 });
  await agent.run("开始");
  assert.deepEqual(
    agent.history.get().map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
    "提问 → 调工具 → 工具结果+收尾指令 → 汇总",
  );
});
