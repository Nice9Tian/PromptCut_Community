/**
 * Frontend parsing of report_progress: tool names match prefixes, input supports strings, old
 * history is looked up from tools, and summary only concatenates non-empty groups.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isReportTool, parseProgressReport, reportsOf, reportText } from "./progressReport.ts";
import { validateProgressReport } from "../../server/progress-report.mjs";

test("Parsing rules match the server-side validation: a call the server rejects is not drawn as a card", () => {
  const cases = [
    { final: true, has_done: true, has_todo: false, has_problem: false, done: ["a"], todo: [], problems: [] },
    { final: true },
    { done: ["Items only"] },
    { final: null, stage: null, done: null, todo: ["b"], problems: null },
    { final: false, stage: "  A very long stage name, surely over twelve characters  ", done: Array(10).fill("x".repeat(80)) },
    { final: true, done: ["", "  "] },
    {},
    { has_done: true },
    { final: "yes", done: ["a"] },
    { final: true, stage: 3 },
    { final: true, done: "a" },
    { final: true, done: ["a", 1] },
    // blocked: stop and wait for the user to reply. Implicitly final, using the same rules on both sides
    { final: true, blocked: true, done: ["a"], todo: ["Do this step in PromptCut on the computer"] },
    { blocked: true, todo: ["Please scan the QR code to sign in"] },
    { final: false, blocked: true, problems: ["Cannot read the media"] },
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

test("blocked: implies final; when false / omitted, this flag does not appear at all", () => {
  const blocked = parseProgressReport({ blocked: true, todo: ["Please scan the QR code to sign in"] });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.final, true, "Stopping to wait for the user means this round is over");
  assert.equal(validateProgressReport({ blocked: true, todo: ["Please scan the QR code to sign in"] }).value.final, true);

  for (const input of [{ final: true, done: ["a"] }, { final: true, blocked: false, done: ["a"] }]) {
    assert.equal("blocked" in parseProgressReport(input), false, JSON.stringify(input));
    assert.equal("blocked" in validateProgressReport(input).value, false, JSON.stringify(input));
  }
});

test("In the recap summary of blocked, \"waiting for the user\" must be kept, otherwise after a model switch it will assume it can carry on by itself", () => {
  assert.equal(reportText({ final: true, blocked: true, done: [], todo: ["Do this step on the computer"], problems: ["The cloud cannot read the media"] }),
    "To do: Do this step on the computer; Issues: The cloud cannot read the media (stopped, waiting for the user to reply)");
  assert.equal(reportText({ final: true, done: ["Added captions"], todo: [], problems: [] }), "Done: Added captions");
  assert.equal(reportText({ final: true, blocked: true, done: [], todo: [], problems: [] }), "", "An empty report must not leave behind just a parenthetical remark");
});

test("Tool names: the bare name and each provider's prefix are accepted, near-miss names are not", () => {
  assert.equal(isReportTool("report_progress"), true);
  assert.equal(isReportTool("mcp__promptcut__report_progress"), true);
  assert.equal(isReportTool("promptcut.report_progress"), true);
  assert.equal(isReportTool("my_report_progress"), false);
  assert.equal(isReportTool("report_progress_v2"), false);
  assert.equal(isReportTool(undefined), false);
});

test("Parsing: both objects and JSON strings work, entries are trimmed and empty strings dropped", () => {
  const input = { final: true, stage: " Captions ", has_done: true, done: [" Added captions ", ""], todo: [], problems: ["Background noise"] };
  const want = { final: true, stage: "Captions", done: ["Added captions"], todo: [], problems: ["Background noise"] };
  assert.deepEqual(parseProgressReport(input), want);
  assert.deepEqual(parseProgressReport(JSON.stringify(input)), want);
});

test("Parsing: returns null when the arguments have not finished streaming or are not a report", () => {
  assert.equal(parseProgressReport(undefined), null);
  assert.equal(parseProgressReport("{\"final\": tr"), null);
  assert.equal(parseProgressReport([]), null);
  assert.equal(parseProgressReport({}), null);
  // All three groups are empty but final was explicitly given: a "nothing to report" report
  assert.deepEqual(parseProgressReport({ final: false }), { final: false, done: [], todo: [], problems: [] });
});

test("reportsOf: in parts order, skipping other tools; when there are no parts, read tools", () => {
  const parts = [
    { kind: "text", text: "Start" },
    { kind: "tool", name: "mcp__promptcut__report_progress", input: { final: false, done: ["a"] } },
    { kind: "tool", name: "add_clip", input: { final: true, done: ["Not a report"] } },
    { kind: "tool", name: "report_progress", input: { final: true, problems: ["b"] } },
  ];
  assert.deepEqual(reportsOf({ parts }).map((r) => r.final), [false, true]);
  assert.deepEqual(reportsOf({ tools: [{ name: "report_progress", input: { final: true, todo: ["c"] } }] })[0].todo, ["c"]);
});

test("reportText: join only the non-empty groups, include the stage name when there is one", () => {
  assert.equal(
    reportText({ final: true, stage: "Background music", done: ["Added background music", "Lowered the vocals"], todo: [], problems: ["The ending is too abrupt"] }),
    "[Background music] Done: Added background music, Lowered the vocals; Issues: The ending is too abrupt",
  );
  assert.equal(reportText({ final: true, done: [], todo: [], problems: [] }), "");
});
