/**
 * 操作图标的分组:每个图标最多叠 5 个、失败的自成一类、stt_install 单独、报告工具不出图标。
 * 跑:node --experimental-test-module-mocks --test src/editor/right/chat/iconRuns.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { iconRuns, toolKind, bareToolName, ICON_RUN_MAX } from "./iconRuns.ts";

test("带服务器前缀的工具名照样分类:Claude 报上来的是 mcp__promptcut__xxx", () => {
  assert.equal(bareToolName("mcp__promptcut__add_clip"), "add_clip");
  assert.equal(bareToolName("promptcut.remove_clip"), "remove_clip");
  assert.equal(bareToolName("see_frames"), "see_frames");
  assert.equal(toolKind("mcp__promptcut__add_clip"), "add");
  assert.equal(toolKind("mcp__promptcut__see_frames"), "look");
  assert.equal(toolKind("mcp__promptcut__list_media"), "read");
  assert.equal(toolKind("promptcut.remove_clip"), "remove");
  // 前缀不同、裸名同类的相邻操作照样合进一个图标;stt_install 带前缀也单独成一个
  assert.deepEqual(sizes(iconRuns([ok("mcp__promptcut__get_clip"), ok("get_clip")])), [2]);
  const runs = iconRuns([ok("mcp__promptcut__stt_install"), ok("mcp__promptcut__stt_install")]);
  assert.deepEqual(runs.map((r) => r.items), [[0], [1]]);
});

const ok = (name) => ({ name, ok: true });
const fail = (name) => ({ name, ok: false });
const running = (name) => ({ name });
const sizes = (runs) => runs.map((r) => r.items.length);

test("12 个同类 → 5、5、2:一个图标最多装 5 个", () => {
  const runs = iconRuns(Array.from({ length: 12 }, () => ok("get_clip")));
  assert.equal(ICON_RUN_MAX, 5);
  assert.deepEqual(sizes(runs), [5, 5, 2]);
  assert.deepEqual(runs[1].items, [5, 6, 7, 8, 9]);
  assert.ok(runs.every((r) => r.kind === "read" && r.state === "ok"));
});

test("key 取第一个操作的下标:往后追加操作时已有图标的 key 不变", () => {
  const tools = Array.from({ length: 6 }, () => ok("add_clip"));
  assert.deepEqual(iconRuns(tools.slice(0, 3)).map((r) => r.key), ["r0"]);
  assert.deepEqual(iconRuns(tools).map((r) => r.key), ["r0", "r5"]);
});

test("同类中间夹一个失败 → 断开,失败的自成一个红图标", () => {
  const runs = iconRuns([ok("add_clip"), ok("add_clip"), fail("add_clip"), ok("add_clip")]);
  assert.deepEqual(runs.map((r) => r.items), [[0, 1], [2], [3]]);
  assert.deepEqual(runs.map((r) => r.state), ["ok", "err", "ok"]);
});

test("相邻的失败合在一起,哪怕动作类型不同;类别取第一个", () => {
  const runs = iconRuns([fail("add_clip"), fail("remove_clip")]);
  assert.deepEqual(sizes(runs), [2]);
  assert.equal(runs[0].state, "err");
  assert.equal(runs[0].kind, "add");
});

test("不同动作类型不合并", () => {
  assert.deepEqual(sizes(iconRuns([ok("add_clip"), ok("remove_clip"), ok("remove_clip")])), [1, 2]);
});

test("stt_install 永远单独成一个,也不和前后同为收集类的操作合并", () => {
  assert.equal(toolKind("stt_install"), "download");
  const runs = iconRuns([ok("collect_web"), ok("stt_install"), ok("stt_install"), ok("collect_web")]);
  assert.deepEqual(runs.map((r) => r.items), [[0], [1], [2], [3]]);
});

test("还有没出结果的操作,整个图标算进行中", () => {
  const runs = iconRuns([ok("set_clip"), running("set_clip")]);
  assert.deepEqual(sizes(runs), [2]);
  assert.equal(runs[0].state, "run");
});

test("报告工具不出图标,也不打断前后的同类操作", () => {
  const runs = iconRuns([ok("add_clip"), ok("mcp__promptcut__report_progress"), ok("add_clip"), ok("report_progress")]);
  assert.deepEqual(runs.map((r) => r.items), [[0, 2]]);
});

test("空数组 / 只有报告工具 → 没有图标", () => {
  assert.deepEqual(iconRuns([]), []);
  assert.deepEqual(iconRuns([ok("report_progress")]), []);
});
