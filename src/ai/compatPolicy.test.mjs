/**
 * Unit tests for the "parameter compatibility mode" toggle policy in modelOptions.ts.
 * Run: node --test src/ai/compatPolicy.test.mjs
 * Pins down: Claude / GPT are locked off, Gemini is locked on (regardless of which vendor's API
 * is used); only other providers let users adjust it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compatPolicy, compatToSend } from "./modelOptions.ts";

test("The three CLI paths: Claude Code / Codex locked off, Antigravity locked on", () => {
  assert.deepEqual(pick(compatPolicy("claude", "opus", undefined, "on")), [false, true]);
  assert.deepEqual(pick(compatPolicy("codex", "gpt-5.6-terra", undefined, "on")), [false, true]);
  assert.deepEqual(pick(compatPolicy("agy", "", undefined, "off")), [true, true]);
});

test("Direct API by model name: gemini locked on (even behind an openai-compatible interface), claude / gpt / o-series / codex locked off", () => {
  assert.deepEqual(pick(compatPolicy("api", "gemini-2.5-pro", "openai", "off")), [true, true]);
  assert.deepEqual(pick(compatPolicy("api", "gpt-5.6-terra", "openai", "on")), [false, true]);
  assert.deepEqual(pick(compatPolicy("api", "claude-opus-5", "anthropic", "on")), [false, true]);
  assert.deepEqual(pick(compatPolicy("api", "o3-mini", "openai", "on")), [false, true]);
  assert.deepEqual(pick(compatPolicy("api", "codex-mini", "openai", "on")), [false, true]);
});

test("Other vendors' models: the user adjusts it; auto falls back to the vendor field", () => {
  assert.deepEqual(pick(compatPolicy("api", "qwen3-max", "openai", "auto")), [false, false]);
  assert.deepEqual(pick(compatPolicy("api", "qwen3-max", "openai", "on")), [true, false]);
  assert.deepEqual(pick(compatPolicy("api", "deepseek-v4", "gemini", "auto")), [true, false]);
  assert.deepEqual(pick(compatPolicy("api", "deepseek-v4", "gemini", "off")), [false, false]);
});

/**
 * `applies` answers "whether this toggle is actually involved on this path", which is a different
 * thing from "whether it is on or off".
 *
 * It is not involved on the agy path: tools are exposed by the MCP service registered via
 * `agy mcp add promptcut`, routing through mcp-server.mjs, and never go through sanitizeSchema at
 * all: across the entire repository, schemaCompat is only read by runners/api.mjs.
 * Previously this returned "locked on", so the panel showed an active button that did nothing when
 * pressed. Having a fake toggle is more misleading than not having one at all, so the UI simply
 * does not display it based on this flag.
 */
test("applies: the agy path does not go through this switch, so do not show a fake one in the interface", () => {
  assert.equal(compatPolicy("agy", "", undefined, "off").applies, false);
  // Every other path is involved and should be displayed
  for (const [p, m, v] of [
    ["claude", "opus", undefined],
    ["codex", "gpt-5.6-terra", undefined],
    ["api", "gemini-2.5-pro", "openai"],
    ["api", "gpt-5.6-terra", "openai"],
    ["api", "qwen3-max", "openai"],
  ]) {
    assert.equal(compatPolicy(p, m, v, "auto").applies, true, `${p}/${m} should show this switch`);
  }
});

test("Gemini is still locked on: turning it off would send additionalProperties through unchanged, which is a real 400", () => {
  const g = compatPolicy("api", "gemini-3.1-pro", "openai", "off");
  assert.deepEqual([g.on, g.locked, g.applies], [true, true, true]);
  // This reason string will be displayed in the button's title; it must state the actual reason,
  // not "only recognizes the narrowest subset"
  assert.match(g.reason, /additionalProperties/);
});

test("compatToSend: a locked setting gives a fixed answer, an adjustable one passes the preference to the server unchanged", () => {
  assert.equal(compatToSend("api", "gemini-2.5-pro", "openai", "off"), "on");
  assert.equal(compatToSend("claude", "opus", undefined, "on"), "off");
  assert.equal(compatToSend("api", "qwen3-max", "openai", "auto"), "auto");
  assert.equal(compatToSend("api", "qwen3-max", "openai", "on"), "on");
});

function pick(p) { return [p.on, p.locked]; }
