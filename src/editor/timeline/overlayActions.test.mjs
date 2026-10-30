/**
 * 对一张叠加卡动手的那几个动作(`overlayActions.ts`)。桌面菜单和手机版「调整」表单共用它。
 *
 * 守两件事:启用时把 `off` 整个删掉(不留 `off: false` 也不留 `off: undefined`),
 * 以及素材效果卡两样都不接。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detachOverlay, overlayQuoteId, setOverlayOff } from "./overlayActions.ts";

function fakeStore() {
  const calls = [];
  const rec = (name) => (clipId, value) => { calls.push({ name, clipId, value }); return true; };
  return { calls, setClipFilter: rec("filter"), setClipPixelMap: rec("pixelMap"), setClipAudioFx: rec("audioFx") };
}
const item = (kind, extra = {}) => ({ kind, refId: "x1", name: "压暗", value: "", upstream: false, off: false, canToggle: true, canDetach: true, ...extra });

test("停用:原来的挂载一个字段不少,多一个 off", () => {
  const s = fakeStore();
  const clip = { id: "c1", filter: { id: "f1", params: { amount: 0.4 } } };
  assert.equal(setOverlayOff(s, clip, item("filter"), true), true);
  assert.deepEqual(s.calls, [{ name: "filter", clipId: "c1", value: { id: "f1", params: { amount: 0.4 }, off: true } }]);
});

test("启用:off 这个键整个删掉,不是 false、也不是 undefined", () => {
  const s = fakeStore();
  const clip = { id: "c1", filter: { id: "f1", params: { amount: 0.4 }, off: true } };
  setOverlayOff(s, clip, item("filter", { off: true }), false);
  const sent = s.calls[0].value;
  assert.deepEqual(sent, { id: "f1", params: { amount: 0.4 } });
  assert.equal("off" in sent, false, "键还在的话,文档服务的逐字段比对会看见它");
});

test("三种挂载各走各的 action", () => {
  const s = fakeStore();
  const clip = { id: "c1", filter: { id: "f1" }, pixelMap: { id: "p1" }, audioFx: { id: "a1" } };
  setOverlayOff(s, clip, item("filter"), true);
  setOverlayOff(s, clip, item("pixelMap"), true);
  setOverlayOff(s, clip, item("audioFx"), true);
  assert.deepEqual(s.calls.map((c) => c.name), ["filter", "pixelMap", "audioFx"]);
});

test("这一段上根本没挂时什么都不做", () => {
  const s = fakeStore();
  assert.equal(setOverlayOff(s, { id: "c1" }, item("filter"), true), false);
  assert.equal(s.calls.length, 0);
});

test("素材效果卡:停用不接(绕过一个节点要在图上改)", () => {
  const s = fakeStore();
  const card = item("card", { canToggle: false });
  assert.equal(setOverlayOff(s, { id: "c1", nodeId: "n1" }, card, true), false);
  assert.equal(s.calls.length, 0);
});

test("素材效果卡:摘掉走 editCardProject 重接节点图,不是置空一个字段", () => {
  const s = fakeStore();
  let edited = false;
  s.editCardProject = (fn) => { edited = true; assert.equal(typeof fn, "function"); };
  const card = item("card", { canToggle: false, canDetach: true });
  assert.equal(detachOverlay(s, { id: "c1", nodeId: "n1" }, card, () => undefined), true);
  assert.equal(edited, true);
  assert.equal(s.calls.length, 0, "三个置空 action 一个都不该被叫到");
});

test("接不回去的那种(canDetach 为假)什么都不做", () => {
  const s = fakeStore();
  s.editCardProject = () => { throw new Error("不该走到这儿"); };
  assert.equal(detachOverlay(s, { id: "c1", nodeId: "n1" }, item("card", { canToggle: false, canDetach: false })), false);
});

test("摘掉:把那一个字段置空,库里的定义不动", () => {
  const s = fakeStore();
  detachOverlay(s, { id: "c1", audioFx: { id: "a1" } }, item("audioFx"));
  assert.deepEqual(s.calls, [{ name: "audioFx", clipId: "c1", value: null }]);
});

test("引用块的 id 带上是哪一种、哪一条定义", () => {
  assert.equal(overlayQuoteId({ id: "c1" }, item("filter", { refId: "f1" })), "c1#filter:f1");
});
