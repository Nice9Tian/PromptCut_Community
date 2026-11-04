/**
 * Batched application of streaming deltas. Run: node --test src/ai/streamBatch.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendTextPart, appendThinkingPart, applyDeltas, isDeltaEvent } from "./streamBatch.ts";

const base = { id: "a", role: "assistant", text: "Start", parts: [{ kind: "text", text: "Start" }] };
const events = [
  { type: "text", delta: "First" },
  { type: "text", delta: "Sentence." },
  { type: "thinking", delta: "Think" },
  { type: "thinking", delta: "Again" },
  { type: "text", delta: "SecondSentence" },
];

test("applying a batch equals applying each delta on its own, in order", () => {
  const recorded = [];
  const record = (m, ev) => { recorded.push(ev.delta); return { ...m, traced: (m.traced || 0) + 1 }; };
  const batched = applyDeltas(base, events, record);

  let sequential = base;
  for (const ev of events) sequential = applyDeltas(sequential, [ev], (m) => ({ ...m, traced: (m.traced || 0) + 1 }));

  assert.deepEqual(batched, sequential);
  assert.equal(batched.text, "StartFirstSentence.SecondSentence");
  assert.deepEqual(batched.parts, [
    { kind: "text", text: "StartFirstSentence." },
    { kind: "thinking", text: "ThinkAgain" },
    { kind: "text", text: "SecondSentence" },
  ]);
  assert.deepEqual(recorded, ["First", "Sentence.", "Think", "Again", "SecondSentence"]);
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
