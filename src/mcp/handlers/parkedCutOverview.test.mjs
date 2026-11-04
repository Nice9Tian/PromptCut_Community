/**
 * Let the model see clip ids in other cuts at first glance (production, 2026-10-21: tool
 * descriptions and system prompts both stated "editing clips in other cuts does not require
 * switch_cut", yet in new chats the model still did switch_cut -> update_clip -> switch_cut,
 * twice across two attempts; the get_project / timeline it reads first only had the active cut,
 * so switching over was its way of "looking into" cut 2). Pin down:
 *   - get_project includes parkedCuts at the very top (clip index for parked cuts, without
 *     params), while single-cut projects do not;
 *   - list_cuts without cutId also includes parkedCuts; with cutId it returns that cut's timeline
 *     without duplication;
 *   - Tool response timeline includes an otherCuts hint (only when other cuts have content);
 *     responses when editing a parked cut in place do not (the view would be inverted);
 *   - The switch_cut response note explains that switching flips the UI for all members, and
 *     editing existing clips does not require it;
 *   - A "model" acting strictly on tool responses (only reading parkedCuts from get_project to find
 *     clips) modifies clips in parked cuts without ever calling switch_cut.
 * Run: node --experimental-test-module-mocks --test src/mcp/handlers/parkedCutOverview.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

mock.module(srcUrl("ai/mcpExecutor.ts"), { exports: { EditorApi: undefined } });

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { registerCards } = await import(srcUrl("kernel/registry.ts"));
const { TOOL_ROUTES } = await import(srcUrl("mcp/routes.mjs"));
const { clipsHandlers } = await import(srcUrl("mcp/handlers/clips.ts"));
const { layoutHandlers } = await import(srcUrl("mcp/handlers/layout.ts"));
const { audioHandlers } = await import(srcUrl("mcp/handlers/audio.ts"));
const { effectsHandlers } = await import(srcUrl("mcp/handlers/effects.ts"));
const { projectHandlers } = await import(srcUrl("mcp/handlers/project.ts"));
const api = { ...clipsHandlers, ...layoutHandlers, ...audioHandlers, ...effectsHandlers, ...projectHandlers };
const call = (tool, args) => api[TOOL_ROUTES[tool].method](TOOL_ROUTES[tool].passArgs ? args : undefined);

registerCards([{
  id: "particles-pk", name: "Particle background", description: "", source: "user",
  defaults: { count: 50, color: "#ffffff" },
  controls: [{ key: "count", label: "Particle count", type: "number" }, { key: "color", label: "Color", type: "text" }],
  Component: () => null,
}]);

const proj = (extra = {}) => ({
  version: 1, id: "p-ov", name: "t", width: 1280, height: 720, fps: 30, duration: 10, themeId: "midnight",
  media: [],
  tracks: [{ id: "ta1", name: "Track 1", clips: [{ id: "a1", cardId: "particles-pk", start: 0, end: 4, params: { count: 10 } }] }],
  cuts: [
    { id: "A", name: "Cut 1" },
    { id: "B", name: "Cut 2", duration: 6, transitions: [], tracks: [
      { id: "tb1", name: "B track 1", clips: [
        { id: "b1", cardId: "particles-pk", label: "Particle background", start: 0, end: 6, params: { count: 50, color: "#abcdef" } },
        { id: "b2", cardId: "particles-pk", start: 1, end: 2, params: { count: 5 } },
      ] },
    ] },
  ],
  activeCutId: "A",
  ...extra,
});
const fresh = (extra) => { actions.loadProject(proj(extra)); return getState().project; };
const cutB = () => getState().project.cuts.find((c) => c.id === "B");

test("get_project: parkedCuts comes first and lists the clips of parked cuts (without params); the active cut is not in it", () => {
  fresh();
  const r = call("get_project");
  assert.equal(Object.keys(r)[0], "parkedCuts", "Placed first so the model reads it first");
  assert.equal(r.parkedCuts.activeCutId, "A");
  assert.deepEqual(r.parkedCuts.cuts.map((c) => c.cutId), ["B"]);
  assert.deepEqual(r.parkedCuts.cuts[0].clips, [
    { id: "b1", trackId: "tb1", cardId: "particles-pk", cardName: "Particle background", label: "Particle background", start: 0, end: 6 },
    { id: "b2", trackId: "tb1", cardId: "particles-pk", cardName: "Particle background", start: 1, end: 2 },
  ]);
  assert.match(r.parkedCuts.note, /do not use user_interface_switch_cut/);
  assert.deepEqual(r.tracks.map((t) => t.id), ["ta1"], "tracks is still the active cut's");
  assert.equal(getState().project.activeCutId, "A", "read-only");
});

test("get_project: a single-cut project has no parkedCuts (the response shape of old projects is unchanged)", () => {
  fresh({ cuts: [{ id: "A", name: "Cut 1" }], activeCutId: "A" });
  assert.equal("parkedCuts" in call("get_project"), false);
});

test("list_cuts: without cutId it carries parkedCuts; with cutId it gives that cut's timeline without listing the index again, and the timeline carries no otherCuts", () => {
  fresh();
  const plain = call("list_cuts", undefined);
  assert.deepEqual(plain.parkedCuts.cuts[0].clips.map((c) => c.id), ["b1", "b2"]);
  assert.equal("timeline" in plain, false);
  const one = call("list_cuts", { cutId: "B" });
  assert.equal("parkedCuts" in one, false);
  assert.equal(one.timeline.cutId, "B");
  assert.equal("otherCuts" in one.timeline, false);
});

test("timeline in tool responses: carries otherCuts when other cuts have content; the response of an in-place edit of a parked cut does not (the view there is inverted)", () => {
  fresh();
  const a = call("update_clip", { clipId: "a1", opacity: 0.8 });
  assert.deepEqual(a.timeline.otherCuts.cuts, [{ cutId: "B", name: "Cut 2", clipCount: 2 }]);
  assert.match(a.timeline.otherCuts.hint, /do not use user_interface_switch_cut/);
  const b = call("update_clip", { clipId: "b1", opacity: 0.8 });
  assert.equal(b.cut.id, "B");
  assert.equal("otherCuts" in b.timeline, false);
  fresh({ cuts: [{ id: "A", name: "Cut 1" }, { id: "B", name: "Cut 2", duration: 6, transitions: [], tracks: [] }] });
  const c = call("update_clip", { clipId: "a1", opacity: 0.5 });
  assert.equal("otherCuts" in c.timeline, false, "Not mentioned when the other cuts are empty");
});

test("The response of switch_cut carries a note: switching flips the interface of all members together, and editing existing clips does not need it", () => {
  fresh();
  const r = call("user_interface_switch_cut", { cutId: "B" });
  assert.equal(r.activeCutId, "B");
  assert.match(r.note, /Switched to "Cut 2"/);
  assert.match(r.note, /flips every member's interface together/);
  assert.match(r.note, /it is not needed/);
  assert.match(r.note, /parkedCuts/);
});

test("Tool descriptions: get_project / list_cuts / switch_cut point to parkedCuts, and switch_cut makes clear it is used only when adding, deleting, splitting or duplicating, or when the user says so explicitly", async () => {
  const { tools } = await import("../../../server/mcp-tools.mjs");
  const d = (n) => tools.find((t) => t.name === n).description;
  assert.match(d("get_project"), /parkedCuts/);
  assert.match(d("get_project"), /do not need user_interface_switch_cut/);
  assert.match(d("list_cuts"), /parkedCuts/);
  assert.match(d("list_cuts"), /do not user_interface_switch_cut/);
  assert.match(d("user_interface_switch_cut"), /Do not use it/);
  assert.match(d("user_interface_switch_cut"), /every member's interface/);
});

test("System prompt: the multi-cut section opens by saying not to use switch_cut and points to parkedCuts", async () => {
  const fs = await import("node:fs");
  const text = fs.readFileSync(new URL("../../../server/ai-system-prompt.md", import.meta.url), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.includes("A project can have several cuts"));
  assert.ok(line);
  assert.ok(line.indexOf("do not use `user_interface_switch_cut`") >= 0 && line.indexOf("do not use `user_interface_switch_cut`") < line.indexOf("add_clip, track"), "The \"do not switch\" part comes first");
  assert.match(line, /see_frames\(\{ cutId/, "To see the frames of other cuts, use the cutId of see_frames");
  assert.match(line, /parkedCuts/);
});

/**
 * A "model" acting strictly on tool responses: user says "change particle count of the "Particle
 * Background" card in cut 2 to 120", with cut 1 active.
 * It can only decide next steps based on the JSON it reads: first get_project, find the clip in
 * parkedCuts matching the label / card name, then update_clip.
 * Record the tools it invoked: switch_cut is not allowed to appear.
 */
function mockModel(userText) {
  const calls = [];
  const run = (tool, args) => { calls.push(tool); return call(tool, args); };
  const wantCut = /Cut \d+/.exec(userText)[0];
  const wantCard = /"(.+?)"/.exec(userText)[1];
  const wantValue = Number(/to\s*(\d+)/.exec(userText)[1]);
  const project = run("get_project");
  let hit = null;
  for (const cut of project.parkedCuts?.cuts ?? []) {
    if (cut.name !== wantCut) continue;
    hit = cut.clips.find((c) => c.label === wantCard || c.cardName === wantCard) ?? null;
  }
  if (!hit) {
    // Only thinks of switching if not found: this path is the behavior observed in production,
    // which the test requires avoiding
    run("user_interface_switch_cut", { name: wantCut });
    throw new Error("The model did not find the parked cut's clip in get_project");
  }
  const r = run("update_clip", { clipId: hit.id, params: { count: wantValue } });
  return { calls, result: r, hit };
}

test("Model flow: reading only get_project is enough to find and edit \"Particle background\" in Cut 2, with no switch_cut at all and the active cut unchanged", () => {
  fresh();
  const before = getState().project;
  const { calls, result, hit } = mockModel("In Cut 2, change the particle count of the \"Particle background\" card to 120, and leave everything else untouched.");
  assert.deepEqual(calls, ["get_project", "update_clip"]);
  assert.equal(hit.id, "b1");
  assert.equal(result.ok, true);
  assert.equal(result.cut.id, "B");
  const after = getState().project;
  assert.equal(after.activeCutId, "A", "no switching");
  assert.equal(after.tracks, before.tracks, "The content of the active cut is unchanged");
  assert.deepEqual(cutB().tracks[0].clips[0].params, { count: 120, color: "#abcdef" }, "Only the count changes, nothing else is touched");
  assert.deepEqual(cutB().tracks[0].clips[1].params, { count: 5 });
});
