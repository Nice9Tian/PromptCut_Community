/**
 * update_clip params is a delta patch (production, 2026-10-21: model brought back full parameters
 * from memory, overwriting the color that the user had just undone by clicking "Undo this step").
 * Pin down: only passed keys are modified, omitted keys retain current values (including values
 * after intermediate user undos); changedParams in response lists truly changed keys so the
 * moment an old value is brought back can be noticed; if params is too long, only key names are
 * returned. Run: node --test src/mcp/handlers/updateClipPatch.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

mock.module(srcUrl("ai/mcpExecutor.ts"), { exports: { EditorApi: undefined } });

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { registerCards } = await import(srcUrl("kernel/registry.ts"));
const { clipsHandlers } = await import(srcUrl("mcp/handlers/clips.ts"));
const { paramsEcho } = await import(srcUrl("mcp/tools/toolEcho.ts"));

registerCards([{
  id: "patch-card", name: "Patch card", description: "", source: "user",
  defaults: { color: "#ffd27f", count: 5, speed: 1, seed: 3, size: 10 },
  controls: [
    { key: "color", label: "Color", type: "text" }, { key: "count", label: "Count", type: "number" },
    { key: "speed", label: "Speed", type: "number" }, { key: "seed", label: "seed", type: "number" }, { key: "size", label: "Size", type: "number" },
  ],
  Component: () => null,
}]);

function load(params) {
  actions.loadProject({
    version: 1, id: "p-patch", name: "t", width: 1280, height: 720, fps: 30, duration: 10, themeId: "midnight", media: [],
    tracks: [{ id: "t1", name: "Track 1", clips: [{ id: "c1", cardId: "patch-card", start: 0, end: 4, params }] }],
  });
}
const paramsOf = () => getState().project.tracks[0].clips[0].params;

test("Pass only the keys to change: the other keys keep their current values and are not reset", () => {
  load({ color: "#ffd27f", count: 9, speed: 2, seed: 7, size: 10 });
  const r = clipsHandlers.updateClip({ clipId: "c1", params: { size: 24 } });
  assert.deepEqual(paramsOf(), { color: "#ffd27f", count: 9, speed: 2, seed: 7, size: 24 });
  assert.deepEqual(Object.keys(r.changedParams), ["size"]);
  assert.deepEqual(r.changedParams.size, { from: 10, to: 24 });
  assert.deepEqual(r.params, paramsOf(), "The response carries the full picture after the edit, so the next round need not rely on memory");
});

test("After the user undoes a step midway, a patch with only size does not write the undone color back", () => {
  load({ color: "#ffd27f", count: 5, speed: 1, seed: 3, size: 10 });
  clipsHandlers.updateClip({ clipId: "c1", params: { color: "#a8d8ff" } });
  assert.equal(paramsOf().color, "#a8d8ff");
  actions.undo(); // User clicks "Undo this step"
  assert.equal(paramsOf().color, "#ffd27f");
  const r = clipsHandlers.updateClip({ clipId: "c1", params: { size: 30 } });
  assert.equal(paramsOf().color, "#ffd27f", "The color keeps the value after the undo");
  assert.deepEqual(Object.keys(r.changedParams), ["size"]);
});

test("Opposite case: when the whole old parameter set is brought back, changedParams in the response points out the keys that were written back (from → to)", () => {
  load({ color: "#ffd27f", count: 5, speed: 1, seed: 3, size: 10 });
  clipsHandlers.updateClip({ clipId: "c1", params: { color: "#a8d8ff" } });
  // Model brings back full set from memory: color is a stale value older than the #a8d8ff it read
  // in the previous round
  actions.undo();
  const stale = { color: "#a8d8ff", count: 5, speed: 1, seed: 3, size: 30 };
  const r = clipsHandlers.updateClip({ clipId: "c1", params: stale });
  assert.deepEqual(Object.keys(r.changedParams).sort(), ["color", "size"]);
  assert.deepEqual(r.changedParams.color, { from: "#ffd27f", to: "#a8d8ff" });
  assert.equal("count" in r.changedParams, false, "Unchanged keys are not listed");
});

test("A call that does not change params (only start/end and opacity) carries no changedParams", () => {
  load({ color: "#ffd27f", count: 5, speed: 1, seed: 3, size: 10 });
  const r = clipsHandlers.updateClip({ clipId: "c1", opacity: 0.5 });
  assert.equal("changedParams" in r, false);
  assert.deepEqual(paramsOf(), { color: "#ffd27f", count: 5, speed: 1, seed: 3, size: 10 });
});

test("paramsEcho: long strings are truncated; when the whole set is too large, only key names are given", () => {
  const long = "x".repeat(3000);
  const e = paramsEcho({ a: 1, big: "" }, { a: 1, big: long });
  assert.deepEqual(Object.keys(e.changedParams), ["big"]);
  assert.match(e.changedParams.big.to, /3000 characters in total/);
  assert.equal("params" in e, false);
  assert.deepEqual(e.paramKeys, ["a", "big"]);
  const small = paramsEcho({ a: 1 }, { a: 2 });
  assert.deepEqual(small, { changedParams: { a: { from: 1, to: 2 } }, params: { a: 2 } });
  assert.deepEqual(paramsEcho(undefined, undefined), { changedParams: {}, params: {} });
});
