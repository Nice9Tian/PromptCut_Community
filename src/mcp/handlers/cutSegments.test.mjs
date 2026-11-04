/**
 * Agent tools for cut segments: list_cuts includes reference relationships, add_cut_segment
 * placement and cycle rejection, set_cut_segment, remove_cut requires force + reason for
 * referenced cuts, get_clip includes cutSegment. Run: npm test -- src/mcp/handlers/cutSegments.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

// In handlers, `import { EditorApi } from "../../ai/mcpExecutor"` is type-only; in node, replace
// that module with a stub
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
    tracks: [{ id: "ta", name: "Track 1", clips: [] }],
    cuts: [
      { id: "A", name: "Cut A" },
      { id: "B", name: "Cut B", tracks: [{ id: "tb", name: "Track 1", clips: [{ id: "b1", cardId: "x", start: 0, end: 6, params: {} }] }], duration: 6, transitions: [] },
    ],
    activeCutId: "A",
  });
}

test("add_cut_segment: places a cut segment by name; placing a cut in itself is rejected; list_cuts carries the reference relations", () => {
  load();
  const r = call("add_cut_segment", { name: "Cut B", start: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.segment.cutId, r.segment.start, r.segment.end, r.segment.cutOffset], ["B", 1, 7, 0]);
  assert.throws(() => call("add_cut_segment", { cutId: "A", start: 0 }), /inside itself/);
  const list = call("list_cuts");
  assert.deepEqual(list.cuts.find((c) => c.id === "B").referencedBy.map((x) => x.cutId), ["A"]);
  assert.deepEqual(list.cuts.find((c) => c.id === "A").references, ["B"]);
});

test("A→B→A is rejected; set_cut_segment changes the offset and shortens the out point; get_clip carries cutSegment", () => {
  load();
  const seg = call("add_cut_segment", { cutId: "B", start: 0 }).segment;
  actions.switchCut("B");
  assert.throws(() => call("add_cut_segment", { cutId: "A", start: 7 }), /circular reference/);
  actions.switchCut("A");
  const r = call("set_cut_segment", { clipId: seg.clipId, cutOffset: 2 });
  assert.deepEqual([r.segment.cutOffset, r.segment.end], [2, 4]);
  assert.throws(() => call("set_cut_segment", { clipId: seg.clipId, cutOffset: 9 }), /exceeds the total duration/);
  const env = call("get_clip", { clipId: seg.clipId });
  assert.equal(env.cutSegment.cutId, "B");
  assert.equal(env.cutSegment.cutDuration, 6);
});

test("remove_cut: a referenced cut is rejected without force and the references are listed; with force + reason it is deleted together with its cut segments", () => {
  load();
  call("add_cut_segment", { cutId: "B", start: 0 });
  assert.throws(() => call("remove_cut", { cutId: "B" }), /is referenced by these cuts: "Cut A"/);
  assert.throws(() => call("remove_cut", { cutId: "B", force: true }), /reason/);
  const r = call("remove_cut", { cutId: "B", force: true, reason: "User wants it deleted" });
  assert.equal(r.ok, true);
  assert.equal(r.removedSegments[0].cutId, "A");
  assert.equal(getState().project.tracks[0].clips.length, 0);
});

test("The two tools call EditorApi's own methods directly instead of borrowing addClip / updateClip; update_clip no longer changes a cut segment's reference", () => {
  assert.equal(TOOL_ROUTES.add_cut_segment.method, "addCutSegment");
  assert.equal(TOOL_ROUTES.set_cut_segment.method, "setCutSegment");
  load();
  const seg = call("add_cut_segment", { cutId: "B", start: 0 }).segment;
  assert.throws(() => call("add_clip", { start: 0, cutId: "B" }));
  call("update_clip", { clipId: seg.clipId, cutOffset: 2 });
  assert.equal(call("get_clip", { clipId: seg.clipId }).cutSegment.cutOffset, 0, "update_clip does not recognize cutOffset");
  assert.equal(call("set_cut_segment", { clipId: seg.clipId, cutOffset: 1 }).segment.cutOffset, 1);
});

test("Which cut a cut segment references cannot be changed (user decision, 2026-10-21): set_cut_segment with cutId / name is rejected, and the store action cannot change it either", () => {
  load();
  const seg = call("add_cut_segment", { cutId: "B", start: 0 }).segment;
  const before = getState().project;
  assert.throws(() => call("set_cut_segment", { clipId: seg.clipId, cutId: "B" }), /The cut referenced by a cut segment cannot be changed; to replace it, delete this segment and place a new one with add_cut_segment/);
  assert.throws(() => call("set_cut_segment", { clipId: seg.clipId, name: "Cut B", cutOffset: 1 }), /cannot be changed/);
  assert.equal(getState().project, before, "When rejected, nothing at all was written to the project");
  assert.throws(() => actions.setCutSegment(seg.clipId, { cutId: "B" }), /cannot be changed/);
  assert.equal(call("get_clip", { clipId: seg.clipId }).cutSegment.cutId, "B");
  const schema = tools.find((t) => t.name === "set_cut_segment").inputSchema.properties;
  assert.deepEqual(Object.keys(schema).sort(), ["clipId", "cutOffset"], "The tool description no longer has cutId / name");
});
