/**
 * Page-side see_frames (the fallback path when there is no data mirror and no bound project
 * replica, seePreview in `handlers/vision.ts`) recognizes cutId
 * (user decision, 2026-10-21: viewing frames can specify a cut without switching):
 *   - With cutId: sends project view with that cut as active to prerender; if t is omitted, takes
 *     the position where that cut last stopped; project in store, active cut, and playhead remain
 *     unchanged;
 *   - Without: sends project in store and page playhead as before;
 *   - cutId does not exist: returns explicit error without sending a request.
 * Also: page executor entry point recognizes both names (incoming modelToolName in
 * `mcpExecutor.ts`); add_cut creates only, does not switch.
 *
 * Run: npm test -- src/mcp/handlers/seeFramesCut.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

mock.module(srcUrl("ai/mcpExecutor.ts"), { exports: { EditorApi: undefined } });
mock.module(srcUrl("ai/shots.ts"), { exports: { startShotDetection: async () => "", waitForShots: async () => null } });
mock.module(srcUrl("ai/sequences.ts"), { exports: { scenesOf: () => ({ scenes: [] }), planSequences: () => ({}), frameTimes: () => [], transcriptFor: () => "" } });
mock.module(srcUrl("ai/mediaRef.ts"), { exports: { mediaCardUrl: () => "", isImageMedia: () => false } });
mock.module(srcUrl("ai/perceptionMedia.ts"), { exports: { mediaReadyForServer: () => true, perceptionMediaRef: () => null } });

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { visionHandlers } = await import(srcUrl("mcp/handlers/vision.ts"));
const { effectsHandlers } = await import(srcUrl("mcp/handlers/effects.ts"));

function load() {
  actions.loadProject({
    version: 1, id: "p-look", name: "t", width: 640, height: 360, fps: 30, duration: 4, themeId: "midnight", media: [],
    tracks: [{ id: "t1", name: "Track 1", clips: [{ id: "red", cardId: "x", start: 0, end: 4, params: {} }] }],
    cuts: [
      { id: "A", name: "Cut 1" },
      { id: "B", name: "Cut 2", t: 2.5, duration: 6, transitions: [], tracks: [{ id: "t2", name: "Track 1", clips: [{ id: "blue", cardId: "x", start: 0, end: 6, params: {} }] }] },
    ],
    activeCutId: "A",
  });
  actions.seek(1);
}

const sent = [];
globalThis.fetch = async (url, init) => {
  // Prerender address (render/prerender.ts first queries /api/prerender/info)
  if (String(url) === "/api/prerender/info") return { ok: true, status: 200, json: async () => ({ ready: true, url: "http://prerender.test" }) };
  sent.push({ url: String(url), body: JSON.parse(init.body) });
  return { ok: true, status: 200, json: async () => ({ ok: true, t: 0, __image: { mime: "image/png", base64: "AA" } }) };
};

test("Page seePreview with cutId: sends the view of that cut without touching the store; without it, behavior is as before; a nonexistent cut throws an error", async () => {
  load();
  const before = getState().project;
  const tBefore = getState().t;
  const r = await visionHandlers.seePreview({ cutId: "B" });
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/api\/vision\/snapshot$/);
  assert.equal(sent[0].body.project.activeCutId, "B");
  assert.equal(sent[0].body.project.tracks[0].clips[0].id, "blue");
  assert.equal(sent[0].body.t, 2.5, "Without t, use the position where Cut 2 last stopped");
  assert.deepEqual(r.cut, { id: "B", name: "Cut 2" });
  assert.equal(getState().project, before, "The project in the store is still the same object");
  assert.equal(getState().project.activeCutId, "A");
  assert.equal(getState().t, tBefore, "The playhead did not move");

  sent.length = 0;
  const r2 = await visionHandlers.seePreview({ cutId: "B", times: [0, 3] });
  assert.deepEqual(sent[0].body.times, [0, 3]);
  assert.equal(sent[0].body.project.activeCutId, "B");
  assert.deepEqual(r2.cut, { id: "B", name: "Cut 2" });

  sent.length = 0;
  const r1 = await visionHandlers.seePreview({});
  assert.equal(sent[0].body.project.activeCutId, "A");
  assert.equal(sent[0].body.t, 1, "Page playhead");
  assert.deepEqual(r1.cut, { id: "A", name: "Cut 1" });

  sent.length = 0;
  await assert.rejects(() => visionHandlers.seePreview({ cutId: "Z" }), /Cut "Z" not found/);
  assert.equal(sent.length, 0);
});

test("add_cut only creates and does not switch: the active cut and the interface stay as they are, and the response says it did not switch over", () => {
  load();
  const r = effectsHandlers.addCut({ name: "Cut 3" });
  assert.equal(r.ok, true);
  assert.equal(getState().project.activeCutId, "A", "Not switched");
  assert.equal(r.activeCutId, "A");
  assert.ok(getState().project.cuts.some((c) => c.id === r.cut.id && c.name === "Cut 3"));
  assert.match(r.note, /without switching to it/);
  const r2 = effectsHandlers.addCut({ name: "Cut 4", switch: true });
  assert.equal(getState().project.activeCutId, "A", "The old parameter switch:true no longer switches either");
  assert.ok(r2.cut.id);
});

test("The page executor accepts both names at the door, and the web takeover with the new name also lands in runWebTool", () => {
  const src = fs.readFileSync(new URL("../../ai/mcpExecutor.ts", import.meta.url), "utf8");
  assert.match(src, /const tool = modelToolName\(ev\.tool\);/);
  assert.match(src, /tool === "user_interface_web_handoff"\) result = await runWebTool\(pageToolName\(tool\), args\)/);
});

