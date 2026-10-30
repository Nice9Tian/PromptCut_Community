/**
 * Tool result outputs stay out of the chat trace. 跑:node --test src/ai/traceOutput.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { recordTrace } from "./debug.ts";

const message = () => ({ id: "a", role: "assistant", text: "" });

test("a tool result keeps its summary but not its output", () => {
  const output = { ok: true, project: { tracks: Array.from({ length: 50 }, (_, i) => ({ id: "t" + i, note: "x".repeat(2000) })) } };
  const event = { type: "tool_result", name: "get_project", ok: true, callId: "c1", summary: "拿到工程", output };
  const traced = recordTrace(message(), event);
  const stored = traced.trace[0].event;
  assert.equal(stored.summary, "拿到工程");
  assert.equal(stored.output, undefined);
  assert.equal(stored.outputOmitted, true);
  assert.ok(traced.traceBytes < 1000, `trace grew by ${traced.traceBytes} bytes`);
  assert.equal(event.output, output, "the live event must not be modified");
});

test("other events are still redacted and recorded unchanged", () => {
  const traced = recordTrace(message(), { type: "status", text: "Bearer abcdefghijklmnop" });
  assert.equal(traced.trace[0].event.text, "Bearer [REDACTED]");
  const call = recordTrace(message(), { type: "tool_call", name: "see_frames", input: { t: 1 }, callId: "c2" });
  assert.deepEqual(call.trace[0].event, { type: "tool_call", name: "see_frames", input: { t: 1 }, callId: "c2" });
});
