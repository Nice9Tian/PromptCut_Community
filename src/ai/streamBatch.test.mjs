/**
 * Batched application of streaming deltas. 跑:node --test src/ai/streamBatch.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendTextPart, appendThinkingPart, applyDeltas, isDeltaEvent } from "./streamBatch.ts";

const base = { id: "a", role: "assistant", text: "开头", parts: [{ kind: "text", text: "开头" }] };
const events = [
  { type: "text", delta: "第一" },
  { type: "text", delta: "句。" },
  { type: "thinking", delta: "想一想" },
  { type: "thinking", delta: "再想" },
  { type: "text", delta: "第二句" },
];

test("applying a batch equals applying each delta on its own, in order", () => {
  const recorded = [];
  const record = (m, ev) => { recorded.push(ev.delta); return { ...m, traced: (m.traced || 0) + 1 }; };
  const batched = applyDeltas(base, events, record);

  let sequential = base;
  for (const ev of events) sequential = applyDeltas(sequential, [ev], (m) => ({ ...m, traced: (m.traced || 0) + 1 }));

  assert.deepEqual(batched, sequential);
  assert.equal(batched.text, "开头第一句。第二句");
  assert.deepEqual(batched.parts, [
    { kind: "text", text: "开头第一句。" },
    { kind: "thinking", text: "想一想再想" },
    { kind: "text", text: "第二句" },
  ]);
  assert.deepEqual(recorded, ["第一", "句。", "想一想", "再想", "第二句"]);
  assert.equal(batched.traced, 5);
});

test("only text and thinking events with content are deltas", () => {
  assert.equal(isDeltaEvent({ type: "text", delta: "x" }), true);
  assert.equal(isDeltaEvent({ type: "thinking", delta: "x" }), true);
  assert.equal(isDeltaEvent({ type: "text", delta: "" }), false);
  assert.equal(isDeltaEvent({ type: "tool_call", name: "get_project" }), false);
  assert.equal(isDeltaEvent({ type: "done" }), false);
});

test("part helpers append to the trailing part of the same kind and never mutate", () => {
  const parts = [{ kind: "text", text: "a" }];
  assert.deepEqual(appendTextPart(parts, "b"), [{ kind: "text", text: "ab" }]);
  assert.deepEqual(appendThinkingPart(parts, "c"), [{ kind: "text", text: "a" }, { kind: "thinking", text: "c" }]);
  assert.deepEqual(parts, [{ kind: "text", text: "a" }]);
  assert.deepEqual(appendTextPart(undefined, "x"), [{ kind: "text", text: "x" }]);
});
