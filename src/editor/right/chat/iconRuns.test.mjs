/**
 * Grouping of action icons: up to 5 stacked per icon, failed ones form their own group,
 * stt_install is standalone, reporting tools do not display icons.
 * Run: node --experimental-test-module-mocks --test src/editor/right/chat/iconRuns.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { iconRuns, toolKind, bareToolName, ICON_RUN_MAX } from "./iconRuns.ts";

test("Tool names with a server prefix are still classified: Claude reports mcp__promptcut__xxx", () => {
  assert.equal(bareToolName("mcp__promptcut__add_clip"), "add_clip");
  assert.equal(bareToolName("promptcut.remove_clip"), "remove_clip");
  assert.equal(bareToolName("see_frames"), "see_frames");
  assert.equal(toolKind("mcp__promptcut__add_clip"), "add");
  assert.equal(toolKind("mcp__promptcut__see_frames"), "look");
  assert.equal(toolKind("mcp__promptcut__list_media"), "read");
  assert.equal(toolKind("promptcut.remove_clip"), "remove");
  // Adjacent actions with different prefixes but same bare-name category still merge into one icon;
  // stt_install remains separate even with a prefix
  assert.deepEqual(sizes(iconRuns([ok("mcp__promptcut__get_clip"), ok("get_clip")])), [2]);
  const runs = iconRuns([ok("mcp__promptcut__stt_install"), ok("mcp__promptcut__stt_install")]);
  assert.deepEqual(runs.map((r) => r.items), [[0], [1]]);
});

const ok = (name) => ({ name, ok: true });
const fail = (name) => ({ name, ok: false });
const running = (name) => ({ name });
const sizes = (runs) => runs.map((r) => r.items.length);

test("12 of the same kind → 5, 5, 2: one icon holds at most 5", () => {
  const runs = iconRuns(Array.from({ length: 12 }, () => ok("get_clip")));
  assert.equal(ICON_RUN_MAX, 5);
  assert.deepEqual(sizes(runs), [5, 5, 2]);
  assert.deepEqual(runs[1].items, [5, 6, 7, 8, 9]);
  assert.ok(runs.every((r) => r.kind === "read" && r.state === "ok"));
});

test("key takes the index of the first operation: when operations are appended later, the key of an existing icon does not change", () => {
  const tools = Array.from({ length: 6 }, () => ok("add_clip"));
  assert.deepEqual(iconRuns(tools.slice(0, 3)).map((r) => r.key), ["r0"]);
  assert.deepEqual(iconRuns(tools).map((r) => r.key), ["r0", "r5"]);
});

test("A failure in the middle of same-kind operations → the run breaks, and the failure becomes its own red icon", () => {
  const runs = iconRuns([ok("add_clip"), ok("add_clip"), fail("add_clip"), ok("add_clip")]);
  assert.deepEqual(runs.map((r) => r.items), [[0, 1], [2], [3]]);
  assert.deepEqual(runs.map((r) => r.state), ["ok", "err", "ok"]);
});

test("Adjacent failures merge together even if their action types differ; the category is taken from the first", () => {
  const runs = iconRuns([fail("add_clip"), fail("remove_clip")]);
  assert.deepEqual(sizes(runs), [2]);
  assert.equal(runs[0].state, "err");
  assert.equal(runs[0].kind, "add");
});

test("Different action types are not merged", () => {
  assert.deepEqual(sizes(iconRuns([ok("add_clip"), ok("remove_clip"), ok("remove_clip")])), [1, 2]);
});

test("stt_install always stands alone and is not merged with neighboring operations of the collection kind", () => {
  assert.equal(toolKind("stt_install"), "download");
  const runs = iconRuns([ok("collect_web"), ok("stt_install"), ok("stt_install"), ok("collect_web")]);
  assert.deepEqual(runs.map((r) => r.items), [[0], [1], [2], [3]]);
});

test("If any operation has no result yet, the whole icon counts as in progress", () => {
  const runs = iconRuns([ok("set_clip"), running("set_clip")]);
  assert.deepEqual(sizes(runs), [2]);
  assert.equal(runs[0].state, "run");
});

test("Report tools produce no icon and do not interrupt same-kind operations before and after them", () => {
  const runs = iconRuns([ok("add_clip"), ok("mcp__promptcut__report_progress"), ok("add_clip"), ok("report_progress")]);
  assert.deepEqual(runs.map((r) => r.items), [[0, 2]]);
});

test("Empty array / report tools only → no icon", () => {
  assert.deepEqual(iconRuns([]), []);
  assert.deepEqual(iconRuns([ok("report_progress")]), []);
});
