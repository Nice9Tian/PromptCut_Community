/**
 * 页面一侧的 see_frames(没有数据镜像、没绑项目副本时的兜底那条路,`handlers/vision.ts` 的 seePreview)认 cutId
 * (2026-10-21 用户定:看画面能指定剪辑,不用切换):
 *   - 带 cutId:发给预渲染的是那条剪辑当激活的项目视图,不给 t 取那条剪辑上次停下的位置;store 里的项目、激活剪辑、播放头都不动;
 *   - 不带:照旧发 store 里的项目、页面播放头;
 *   - cutId 不存在:明确报错,不发请求。
 * 另:页面执行器的入口两种名字都认(`mcpExecutor.ts` 进门 modelToolName);add_cut 只建不切。
 *
 * 跑:npm test -- src/mcp/handlers/seeFramesCut.test.mjs
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
  // 预渲染的地址(render/prerender.ts 先问 /api/prerender/info)
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

