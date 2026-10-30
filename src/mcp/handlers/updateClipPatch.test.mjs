/**
 * update_clip 的 params 是增量补丁(线上 2026-10-21:模型把凭记忆的整份参数带回来,把用户刚点「撤销这步」撤掉的颜色写了回去)。
 * 钉住:只传的键被改、没传的键保持当前值(含用户中途撤销后的值);回包的 changedParams 列出真正变了的键,
 * 带回旧值的那一刻能被看见;params 太长只给键名。跑:node --test src/mcp/handlers/updateClipPatch.test.mjs
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
  id: "patch-card", name: "补丁卡", description: "", source: "user",
  defaults: { color: "#ffd27f", count: 5, speed: 1, seed: 3, size: 10 },
  controls: [
    { key: "color", label: "颜色", type: "text" }, { key: "count", label: "数量", type: "number" },
    { key: "speed", label: "速度", type: "number" }, { key: "seed", label: "种子", type: "number" }, { key: "size", label: "大小", type: "number" },
  ],
  Component: () => null,
}]);

function load(params) {
  actions.loadProject({
    version: 1, id: "p-patch", name: "t", width: 1280, height: 720, fps: 30, duration: 10, themeId: "midnight", media: [],
    tracks: [{ id: "t1", name: "序列 1", clips: [{ id: "c1", cardId: "patch-card", start: 0, end: 4, params }] }],
  });
}
const paramsOf = () => getState().project.tracks[0].clips[0].params;

test("只传要改的键:其余键保持当前值,不被重置", () => {
  load({ color: "#ffd27f", count: 9, speed: 2, seed: 7, size: 10 });
  const r = clipsHandlers.updateClip({ clipId: "c1", params: { size: 24 } });
  assert.deepEqual(paramsOf(), { color: "#ffd27f", count: 9, speed: 2, seed: 7, size: 24 });
  assert.deepEqual(Object.keys(r.changedParams), ["size"]);
  assert.deepEqual(r.changedParams.size, { from: 10, to: 24 });
  assert.deepEqual(r.params, paramsOf(), "回包带改完后的全貌,下一轮不必靠记忆");
});

test("用户中途撤销了一步之后,只传 size 的补丁不会把撤销掉的颜色写回去", () => {
  load({ color: "#ffd27f", count: 5, speed: 1, seed: 3, size: 10 });
  clipsHandlers.updateClip({ clipId: "c1", params: { color: "#a8d8ff" } });
  assert.equal(paramsOf().color, "#a8d8ff");
  actions.undo(); // 用户点「撤销这步」
  assert.equal(paramsOf().color, "#ffd27f");
  const r = clipsHandlers.updateClip({ clipId: "c1", params: { size: 30 } });
  assert.equal(paramsOf().color, "#ffd27f", "颜色保持撤销之后的值");
  assert.deepEqual(Object.keys(r.changedParams), ["size"]);
});

test("反面:整份旧参数带回来时,回包的 changedParams 把被写回去的键点出来(from → to)", () => {
  load({ color: "#ffd27f", count: 5, speed: 1, seed: 3, size: 10 });
  clipsHandlers.updateClip({ clipId: "c1", params: { color: "#a8d8ff" } });
  // 模型凭记忆带回整份:color 是它上一轮读到的 #a8d8ff 之前的值之外的陈旧值
  actions.undo();
  const stale = { color: "#a8d8ff", count: 5, speed: 1, seed: 3, size: 30 };
  const r = clipsHandlers.updateClip({ clipId: "c1", params: stale });
  assert.deepEqual(Object.keys(r.changedParams).sort(), ["color", "size"]);
  assert.deepEqual(r.changedParams.color, { from: "#ffd27f", to: "#a8d8ff" });
  assert.equal("count" in r.changedParams, false, "没变的键不列");
});

test("不改 params 的调用(只改起止、不透明度)不带 changedParams", () => {
  load({ color: "#ffd27f", count: 5, speed: 1, seed: 3, size: 10 });
  const r = clipsHandlers.updateClip({ clipId: "c1", opacity: 0.5 });
  assert.equal("changedParams" in r, false);
  assert.deepEqual(paramsOf(), { color: "#ffd27f", count: 5, speed: 1, seed: 3, size: 10 });
});

test("paramsEcho:长字符串截短;整份太大只给键名", () => {
  const long = "x".repeat(3000);
  const e = paramsEcho({ a: 1, big: "" }, { a: 1, big: long });
  assert.deepEqual(Object.keys(e.changedParams), ["big"]);
  assert.match(e.changedParams.big.to, /共 3000 字/);
  assert.equal("params" in e, false);
  assert.deepEqual(e.paramKeys, ["a", "big"]);
  const small = paramsEcho({ a: 1 }, { a: 2 });
  assert.deepEqual(small, { changedParams: { a: { from: 1, to: 2 } }, params: { a: 2 } });
  assert.deepEqual(paramsEcho(undefined, undefined), { changedParams: {}, params: {} });
});
