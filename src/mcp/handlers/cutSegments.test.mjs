/**
 * 剪辑段的 Agent 工具:list_cuts 带引用关系、add_cut_segment 放置与拒绝循环、set_cut_segment、
 * remove_cut 对被引用剪辑要 force + reason、get_clip 带 cutSegment。跑:npm test -- src/mcp/handlers/cutSegments.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

// handlers 里 `import { EditorApi } from "../../ai/mcpExecutor"` 只是类型;node 里把那个模块换成空壳
mock.module(srcUrl("ai/mcpExecutor.ts"), { exports: { EditorApi: undefined } });

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { TOOL_ROUTES } = await import(srcUrl("mcp/routes.mjs"));
const { clipsHandlers } = await import(srcUrl("mcp/handlers/clips.ts"));
const { effectsHandlers } = await import(srcUrl("mcp/handlers/effects.ts"));
const { cutSegmentHandlers } = await import(srcUrl("mcp/handlers/cutSegments.ts"));
const { tools } = await import("../../../server/mcp-tools.mjs");
const api = { ...clipsHandlers, ...effectsHandlers, ...cutSegmentHandlers };
const call = (tool, args) => api[TOOL_ROUTES[tool].method](args);

function load() {
  actions.loadProject({
    version: 1, id: "p-agent", name: "t", width: 1280, height: 720, fps: 30, duration: 20, themeId: "midnight", media: [],
    tracks: [{ id: "ta", name: "序列 1", clips: [] }],
    cuts: [
      { id: "A", name: "剪辑A" },
      { id: "B", name: "剪辑B", tracks: [{ id: "tb", name: "序列 1", clips: [{ id: "b1", cardId: "x", start: 0, end: 6, params: {} }] }], duration: 6, transitions: [] },
    ],
    activeCutId: "A",
  });
}

test("add_cut_segment:按名字放剪辑段;放自己被拒;list_cuts 带引用关系", () => {
  load();
  const r = call("add_cut_segment", { name: "剪辑B", start: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.segment.cutId, r.segment.start, r.segment.end, r.segment.cutOffset], ["B", 1, 7, 0]);
  assert.throws(() => call("add_cut_segment", { cutId: "A", start: 0 }), /放进它自己/);
  const list = call("list_cuts");
  assert.deepEqual(list.cuts.find((c) => c.id === "B").referencedBy.map((x) => x.cutId), ["A"]);
  assert.deepEqual(list.cuts.find((c) => c.id === "A").references, ["B"]);
});

test("A→B→A 被拒;set_cut_segment 改偏移并截短出点;get_clip 带 cutSegment", () => {
  load();
  const seg = call("add_cut_segment", { cutId: "B", start: 0 }).segment;
  actions.switchCut("B");
  assert.throws(() => call("add_cut_segment", { cutId: "A", start: 7 }), /循环引用/);
  actions.switchCut("A");
  const r = call("set_cut_segment", { clipId: seg.clipId, cutOffset: 2 });
  assert.deepEqual([r.segment.cutOffset, r.segment.end], [2, 4]);
  assert.throws(() => call("set_cut_segment", { clipId: seg.clipId, cutOffset: 9 }), /超出/);
  const env = call("get_clip", { clipId: seg.clipId });
  assert.equal(env.cutSegment.cutId, "B");
  assert.equal(env.cutSegment.cutDuration, 6);
});

test("remove_cut:被引用的剪辑不带 force 被拒并列出引用;带 force + reason 连同剪辑段一起删", () => {
  load();
  call("add_cut_segment", { cutId: "B", start: 0 });
  assert.throws(() => call("remove_cut", { cutId: "B" }), /正被这些剪辑引用:「剪辑A」/);
  assert.throws(() => call("remove_cut", { cutId: "B", force: true }), /reason/);
  const r = call("remove_cut", { cutId: "B", force: true, reason: "用户要删" });
  assert.equal(r.ok, true);
  assert.equal(r.removedSegments[0].cutId, "A");
  assert.equal(getState().project.tracks[0].clips.length, 0);
});

test("两个工具直连 EditorApi 自己的方法,不再借 addClip / updateClip;update_clip 不再改剪辑段的引用", () => {
  assert.equal(TOOL_ROUTES.add_cut_segment.method, "addCutSegment");
  assert.equal(TOOL_ROUTES.set_cut_segment.method, "setCutSegment");
  load();
  const seg = call("add_cut_segment", { cutId: "B", start: 0 }).segment;
  assert.throws(() => call("add_clip", { start: 0, cutId: "B" }));
  call("update_clip", { clipId: seg.clipId, cutOffset: 2 });
  assert.equal(call("get_clip", { clipId: seg.clipId }).cutSegment.cutOffset, 0, "update_clip 不认 cutOffset");
  assert.equal(call("set_cut_segment", { clipId: seg.clipId, cutOffset: 1 }).segment.cutOffset, 1);
});

test("剪辑段引用哪条剪辑不能改(2026-10-21 用户定):set_cut_segment 带 cutId / name 被拒,store 动作也换不了", () => {
  load();
  const seg = call("add_cut_segment", { cutId: "B", start: 0 }).segment;
  const before = getState().project;
  assert.throws(() => call("set_cut_segment", { clipId: seg.clipId, cutId: "B" }), /剪辑段引用的剪辑不能改，要换就删掉这段，用 add_cut_segment 放一段新的/);
  assert.throws(() => call("set_cut_segment", { clipId: seg.clipId, name: "剪辑B", cutOffset: 1 }), /不能改/);
  assert.equal(getState().project, before, "被拒时项目一个字都没写");
  assert.throws(() => actions.setCutSegment(seg.clipId, { cutId: "B" }), /不能改/);
  assert.equal(call("get_clip", { clipId: seg.clipId }).cutSegment.cutId, "B");
  const schema = tools.find((t) => t.name === "set_cut_segment").inputSchema.properties;
  assert.deepEqual(Object.keys(schema).sort(), ["clipId", "cutOffset"], "工具说明里不再有 cutId / name");
});
