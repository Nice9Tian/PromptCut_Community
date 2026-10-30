/**
 * report_progress 的前端解析:工具名认前缀、input 兼容字符串、旧历史从 tools 里找、摘要只拼非空组。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isReportTool, parseProgressReport, reportsOf, reportText } from "./progressReport.ts";
import { validateProgressReport } from "../../server/progress-report.mjs";

test("解析规则和服务端校验一致:服务端拒收的调用不画成卡片", () => {
  const cases = [
    { final: true, has_done: true, has_todo: false, has_problem: false, done: ["a"], todo: [], problems: [] },
    { final: true },
    { done: ["只有条目"] },
    { final: null, stage: null, done: null, todo: ["b"], problems: null },
    { final: false, stage: "  很长的阶段名字超过十二个字了吧  ", done: Array(10).fill("x".repeat(80)) },
    { final: true, done: ["", "  "] },
    {},
    { has_done: true },
    { final: "yes", done: ["a"] },
    { final: true, stage: 3 },
    { final: true, done: "a" },
    { final: true, done: ["a", 1] },
    // blocked:停下来等用户回话。隐含 final,两边同一套规则
    { final: true, blocked: true, done: ["a"], todo: ["到电脑上的 PromptCut 里做这一步"] },
    { blocked: true, todo: ["请扫码登录"] },
    { final: false, blocked: true, problems: ["读不了素材"] },
    { final: true, blocked: false, done: ["a"] },
    { final: true, blocked: null, done: ["a"] },
    { final: true, blocked: "yes", done: ["a"] },
    [],
    null,
  ];
  for (const input of cases) {
    const server = validateProgressReport(input);
    const client = parseProgressReport(input);
    assert.equal(!!client, server.ok, JSON.stringify(input));
    if (server.ok) {
      const { final, blocked, stage, done, todo, problems } = server.value;
      assert.deepEqual(client, { final, ...(blocked ? { blocked } : {}), ...(stage ? { stage } : {}), done, todo, problems }, JSON.stringify(input));
    }
  }
});

test("blocked:隐含 final;false / 缺省时这一位根本不出现", () => {
  const blocked = parseProgressReport({ blocked: true, todo: ["请扫码登录"] });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.final, true, "停下来等用户就是这一轮结束了");
  assert.equal(validateProgressReport({ blocked: true, todo: ["请扫码登录"] }).value.final, true);

  for (const input of [{ final: true, done: ["a"] }, { final: true, blocked: false, done: ["a"] }]) {
    assert.equal("blocked" in parseProgressReport(input), false, JSON.stringify(input));
    assert.equal("blocked" in validateProgressReport(input).value, false, JSON.stringify(input));
  }
});

test("blocked 的前情摘要里要留住「在等用户」,不然换模型之后它会以为可以接着自己做", () => {
  assert.equal(reportText({ final: true, blocked: true, done: [], todo: ["到电脑上做这一步"], problems: ["云端读不了素材"] }),
    "待办:到电脑上做这一步;问题:云端读不了素材(停下等用户回话)");
  assert.equal(reportText({ final: true, done: ["加了字幕"], todo: [], problems: [] }), "已完成:加了字幕");
  assert.equal(reportText({ final: true, blocked: true, done: [], todo: [], problems: [] }), "", "空报告不要只剩一句括号");
});

test("工具名:裸名和各家前缀都认,近似名不认", () => {
  assert.equal(isReportTool("report_progress"), true);
  assert.equal(isReportTool("mcp__promptcut__report_progress"), true);
  assert.equal(isReportTool("promptcut.report_progress"), true);
  assert.equal(isReportTool("my_report_progress"), false);
  assert.equal(isReportTool("report_progress_v2"), false);
  assert.equal(isReportTool(undefined), false);
});

test("解析:对象和 JSON 字符串都行,条目 trim 并去掉空串", () => {
  const input = { final: true, stage: " 铺字幕 ", has_done: true, done: [" 加了字幕 ", ""], todo: [], problems: ["底噪"] };
  const want = { final: true, stage: "铺字幕", done: ["加了字幕"], todo: [], problems: ["底噪"] };
  assert.deepEqual(parseProgressReport(input), want);
  assert.deepEqual(parseProgressReport(JSON.stringify(input)), want);
});

test("解析:参数没流完整或不是报告时返回 null", () => {
  assert.equal(parseProgressReport(undefined), null);
  assert.equal(parseProgressReport("{\"final\": tr"), null);
  assert.equal(parseProgressReport([]), null);
  assert.equal(parseProgressReport({}), null);
  // 三组全空但明确给了 final:是一份「没什么可报」的报告
  assert.deepEqual(parseProgressReport({ final: false }), { final: false, done: [], todo: [], problems: [] });
});

test("reportsOf:按 parts 先后顺序,跳过别的工具;没有 parts 时读 tools", () => {
  const parts = [
    { kind: "text", text: "开始" },
    { kind: "tool", name: "mcp__promptcut__report_progress", input: { final: false, done: ["a"] } },
    { kind: "tool", name: "add_clip", input: { final: true, done: ["不是报告"] } },
    { kind: "tool", name: "report_progress", input: { final: true, problems: ["b"] } },
  ];
  assert.deepEqual(reportsOf({ parts }).map((r) => r.final), [false, true]);
  assert.deepEqual(reportsOf({ tools: [{ name: "report_progress", input: { final: true, todo: ["c"] } }] })[0].todo, ["c"]);
});

test("reportText:只拼非空的组,有阶段名时带上", () => {
  assert.equal(
    reportText({ final: true, stage: "配乐", done: ["加了配乐", "压了人声"], todo: [], problems: ["结尾太突兀"] }),
    "[配乐] 已完成:加了配乐、压了人声;问题:结尾太突兀",
  );
  assert.equal(reportText({ final: true, done: [], todo: [], problems: [] }), "");
});
