// node --test src/ai/thinkingSteps.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { thinkingSteps, stepsOfThinking, currentStep } from "./thinkingSteps.ts";

test("A bold sentence is one step: the real shape seen in a user's diagnostic report", () => {
  assert.deepEqual(
    thinkingSteps("**Clarifying article link and scope**\n\n"),
    ["Clarifying article link and scope"],
  );
});

test("Each bold item in a paragraph is one step: the model often emits two or three at a time", () => {
  assert.deepEqual(
    thinkingSteps("**Planning non-destructive timeline design**\n\n**Requesting placeholder asset details**\n\n"),
    ["Planning non-destructive timeline design", "Requesting placeholder asset details"],
  );
});

test("Real chain of thought is not a step: multi-line text is never accepted; a truncated fragment is worse than showing nothing", () => {
  assert.deepEqual(thinkingSteps("First check what is on the timeline\nThen decide how to arrange it"), []);
});

test("Real chain of thought is not a step: a single line that is very long is not accepted either", () => {
  assert.deepEqual(thinkingSteps("x".repeat(80)), []);
});

test("Short single-line text without bold counts as a step: that shape can only be a title", () => {
  assert.deepEqual(thinkingSteps("Checking the timeline"), ["Checking the timeline"]);
});

test("A bold title that is too long is truncated, otherwise it would stretch the bubble out of shape", () => {
  const [s] = thinkingSteps("**" + "x".repeat(80) + "**");
  assert.ok(s.length <= 48, `Actual ${s.length}`);
  assert.ok(s.endsWith("…"));
});

test("Blank input yields no steps", () => {
  assert.deepEqual(thinkingSteps(""), []);
  assert.deepEqual(thinkingSteps("   \n\n  "), []);
  assert.deepEqual(thinkingSteps(undefined), []);
});

test("Newlines and extra spaces are flattened: the step name must fit on one line", () => {
  assert.deepEqual(thinkingSteps("**Checking   the\nproject**"), ["Checking the project"]);
});

test("stepsOfThinking: joined in order, adjacent duplicates merged", () => {
  assert.deepEqual(
    stepsOfThinking(["**A**", "**A**", "**B**\n\n**C**"]),
    ["A", "B", "C"],
  );
});

test("stepsOfThinking: empty paragraphs are skipped, no empty steps are produced", () => {
  assert.deepEqual(stepsOfThinking(["", "**Only this step**", "  "]), ["Only this step"]);
});

test("currentStep: take the last step across all thinking parts; bold inside text, tool and status parts does not count", () => {
  const parts = [
    { kind: "thinking", text: "**Checking the timeline**" },
    { kind: "text", text: "**This is bold inside the reply, not a step**" },
    { kind: "tool", name: "get_timeline", ok: true },
    { kind: "thinking", text: "**Planning captions**\n\n**Writing captions**" },
    { kind: "status", text: "**Not a step either**" },
  ];
  assert.equal(currentStep(parts), "Writing captions");
});

test("currentStep: returns null when there is no thinking or the thinking is one block of reasoning, leaving the caller to fall back to \"which tool is running\"", () => {
  assert.equal(currentStep([]), null);
  assert.equal(currentStep([{ kind: "text", text: "Hello" }]), null);
  assert.equal(currentStep([{ kind: "thinking", text: "First check what is on the timeline\nThen decide how to arrange it" }]), null);
});

test("currentStep: when later thinking parts have no steps, stay on the last step from the earlier ones", () => {
  const parts = [
    { kind: "thinking", text: "**Reading project**" },
    { kind: "thinking", text: "First check what is on the timeline\nThen decide how to arrange it" },
  ];
  assert.equal(currentStep(parts), "Reading project");
});
