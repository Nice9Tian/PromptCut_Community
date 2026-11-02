/**
 * modelOptions.ts 里「参数兼容模式」开关策略的单测。跑:node --test src/ai/compatPolicy.test.mjs
 * 钉住的是:Claude / GPT 锁关、Gemini 锁开(不管走哪个厂商的接口),别家才让用户调。
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
 * `applies` 回答的是「这条路上这个开关到底经不经手」,和「开着还是关着」是两回事。
 *
 * agy 那条路上它不经手:工具是 `agy mcp add promptcut` 注册的 MCP 服务暴露的,走 mcp-server.mjs,
 * 根本不过 sanitizeSchema —— schemaCompat 全仓库只有 runners/api.mjs 会读。
 * 以前这里返回「锁死开启」,面板上于是亮着一个按下去什么也不会发生的按钮。
 * 摆一个假开关比没有这个开关更误导,所以界面按这个标记直接不显示它。
 */
test("applies: the agy path does not go through this switch, so do not show a fake one in the interface", () => {
  assert.equal(compatPolicy("agy", "", undefined, "off").applies, false);
  // 其余每一条路都经手,该显示
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
  // 理由这句会显示在按钮的 title 上,得说的是真正的原因,不是「只认最窄的子集」
  assert.match(g.reason, /additionalProperties/);
});

test("compatToSend: a locked setting gives a fixed answer, an adjustable one passes the preference to the server unchanged", () => {
  assert.equal(compatToSend("api", "gemini-2.5-pro", "openai", "off"), "on");
  assert.equal(compatToSend("claude", "opus", undefined, "on"), "off");
  assert.equal(compatToSend("api", "qwen3-max", "openai", "auto"), "auto");
  assert.equal(compatToSend("api", "qwen3-max", "openai", "on"), "on");
});

function pick(p) { return [p.on, p.locked]; }
