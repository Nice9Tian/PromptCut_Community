/**
 * node --test server/test/agent-summary-shape.test.mjs
 *
 * The shape of the final round (hitting round limit / repeat detection) written into history.
 *
 * What is pinned here is the other half of the same invariant as history-consecutive-user: that
 * side handles two consecutive **user** messages, this side handles two consecutive **assistant**
 * messages.
 *
 * Why this half is harsher: the artifact of the final round is written as-is by saveHistory into
 * that file in harness-sessions, and no subsequent step ever merges it back: reading back history
 * without alternating roles is still sent out, **this session will 400 every time from then on and
 * never heal itself**, and the user has no idea such a file exists to delete.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../harness/agent.mjs";

/**
 * A fake model: calls a tool once in round 1 (to trigger round limit), and only talks afterward.
 * Event names must match real provider (text_delta / tool_use / stop), otherwise it tests a
 * different path.
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

test("When the round limit is hit, the closing sentence must be merged into the same assistant message", async () => {
  // maxIterations = 1: triggers limit right after calling tool in round 1, enters summarizing in round 2
  const agent = new Agent({ provider: scripted("I did half of it"), system: "", tools: [NOOP_TOOL], maxIterations: 1 });
  const out = await agent.run("Start");
  assert.equal(out.outcome, "round_limit", "It must really reach the wrap-up round, otherwise this test checks nothing");

  const msgs = agent.history.get();
  assert.equal(consecutiveSameRole(msgs), -1, `No consecutive messages with the same role: ${msgs.map((m) => m.role).join(",")}`);

  const last = msgs.at(-1);
  assert.equal(last.role, "assistant");
  const text = last.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  assert.match(text, /I did half of it/, "What the model said must be present");
  assert.match(text, /This run was paused/, "The closing sentence must also be in the same message and must not start a separate assistant message");
});

test("When the model says nothing at all in the wrap-up round, that sentence becomes an assistant message of its own, still with no consecutive same-role messages", async () => {
  const agent = new Agent({ provider: scripted(""), system: "", tools: [NOOP_TOOL], maxIterations: 1 });
  await agent.run("Start");

  const msgs = agent.history.get();
  assert.equal(consecutiveSameRole(msgs), -1);
  assert.match(msgs.at(-1).content.map((b) => b.text || "").join(""), /This run was paused/);
});

test("Roles alternate through the whole history from start to end: that is the precondition for a request that will not get a 400", async () => {
  const agent = new Agent({ provider: scripted("All done"), system: "", tools: [NOOP_TOOL], maxIterations: 1 });
  await agent.run("Start");
  assert.deepEqual(
    agent.history.get().map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
    "Question → tool call → tool result + wrap-up instruction → summary",
  );
});
