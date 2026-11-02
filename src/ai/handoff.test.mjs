/**
 * node --test src/ai/handoff.test.mjs
 *
 * 换模型接手时要把前面几轮摘给新模型。来自诊断报告 对话诊断-20260910-204342:
 * 前半段 Gemini 被用户骂「根本没有视频和图片」,换成 Opus 后它只收到一句「你来接替继续」,
 * 看不到那句不满,于是按项目现状自己找活干,还去磁盘上翻交接笔记。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { buildHandoff } = await import("./handoff.ts");

const u = (text) => ({ id: text, role: "user", text });
const a = (provider, text, extra = {}) => ({ id: `${provider}-${text}`, role: "assistant", text, runtime: { provider }, ...extra });

test("New model has no session: excerpt the whole chat, leaving out none of the user's own words", () => {
  const h = [u("Make a Tokyo travel promo video"), a("agy", "Added 10 cards"), u("There are no videos or images at all"), a("agy", "I'll go look for images")];
  const s = buildHandoff(h, "claude", false);
  assert.match(s, /^\[Background:/);
  assert.match(s, /\[\/Background\]$/);
  assert.match(s, /User: 做个东京旅游宣传片/);
  assert.match(s, /User: 根本没有视频和图片/);
  assert.match(s, /Assistant \(Antigravity\): 我去找图/);
});

test("With a session: excerpt only the rounds that other providers spoke after this provider's last reply", () => {
  const h = [u("One"), a("claude", "C1"), u("Two"), a("agy", "G1"), u("three")];
  const s = buildHandoff(h, "claude", true);
  assert.doesNotMatch(s, /User: 一/, "What claude itself has already seen is not repeated");
  assert.doesNotMatch(s, /C1/);
  assert.match(s, /User: 二/);
  assert.match(s, /G1/);
});

test("With a session and no other provider speaking in between: no recap added", () => {
  const h = [u("One"), a("claude", "C1"), u("Two"), a("claude", "", { error: "Quota circuit breaker tripped" })];
  assert.equal(buildHandoff(h, "claude", true), "");
});

test("Empty chat, or only the user's own words: no recap added", () => {
  assert.equal(buildHandoff([], "claude", false), "");
  assert.equal(buildHandoff([u("Hello")], "claude", false), "");
});

test("Messages still running do not count", () => {
  const h = [u("One"), a("agy", "partial", { pending: true })];
  assert.equal(buildHandoff(h, "claude", false), "");
});

// 改版后 Agent 可能一个字不写、只交 report_progress。回退后要靠前情把做过的事带给新会话
const report = (input, name = "mcp__promptcut__report_progress") => ({ kind: "tool", name, input });

test("When the text is empty, use the progress report instead: join only the non-empty groups, with the stage name", () => {
  const h = [
    u("Add captions to the narration"),
    a("agy", "", { parts: [report({ final: true, stage: "Place captions", done: ["Added 3 caption segments"], todo: [], problems: ["Segment 2 has background noise"] })] }),
  ];
  const s = buildHandoff(h, "claude", false);
  assert.match(s, /Assistant \(Antigravity\): \[铺字幕\] Done: 加了 3 段字幕; Issues: 第 2 段有底噪/);
  assert.doesNotMatch(s, /To do/, "Empty groups are not joined");
});

test("A reply that only delivered a report also counts as having spoken: anySpoke (no session) and othersSpoke (with a session) both recognize it", () => {
  const onlyReport = [u("One"), a("agy", "", { parts: [report({ final: false, done: ["Finished splitting shots"] })] })];
  assert.notEqual(buildHandoff(onlyReport, "claude", false), "", "anySpoke");
  const h = [u("One"), a("claude", "C1"), u("Two"), a("agy", "  ", { parts: [report({ final: true, todo: ["Background music"] })] })];
  const s = buildHandoff(h, "claude", true);
  assert.match(s, /To do: 配乐/, "othersSpoke");
  assert.doesNotMatch(s, /C1/);
});

test("When the text is non-empty, use the text as before; when old history has no parts, read the report from tools; several reports are joined in order", () => {
  const withText = [u("One"), a("agy", "I said something", { parts: [report({ final: true, done: ["Should not appear"] })] })];
  const s1 = buildHandoff(withText, "claude", false);
  assert.match(s1, /I said something/);
  assert.doesNotMatch(s1, /Should not appear/);

  const legacy = [u("One"), a("agy", "", { tools: [{ name: "report_progress", input: { final: true, done: ["From old history"] } }] })];
  assert.match(buildHandoff(legacy, "claude", false), /Done: 旧历史里的/);

  const two = [u("One"), a("agy", "", { parts: [report({ final: false, done: ["First segment"] }), report({ final: true, done: ["Second segment"] })] })];
  assert.match(buildHandoff(two, "claude", false), /Done: 第一段 \/ Done: 第二段/);
});

test("A report that is empty (or not from the report tool) still counts as not having spoken", () => {
  const h = [u("One"), a("agy", "", { parts: [report({ final: true, done: [], todo: [], problems: [] }), report({ final: true, done: ["x"] }, "add_clip")] })];
  assert.equal(buildHandoff(h, "claude", false), "");
});

test("Too long: truncate each entry, cap the total, keep the most recent", () => {
  const h = [];
  for (let i = 0; i < 40; i++) { h.push(u(`Sentence ${i} ` + "x".repeat(300))); h.push(a("agy", `Reply ${i} ` + "A".repeat(3000))); }
  const s = buildHandoff(h, "claude", false, { maxChars: 4000, perMessage: 500 });
  assert.ok(s.length < 6000, `Total length should be capped, actual ${s.length}`);
  assert.match(s, /Sentence 39/, "The most recent must be included");
  assert.doesNotMatch(s, /Sentence 0/, "The earliest yields");
  assert.match(s, /\(\d+ earlier items omitted\)/);
  assert.match(s, /\(rest omitted\)/);
});
