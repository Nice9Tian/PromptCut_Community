/**
 * Actions operating on an overlay card (`overlayActions.ts`). Shared by the desktop menu and the
 * mobile app "Adjust" form.
 *
 * Ensure two things: when enabling, completely delete `off` (leaving neither `off: false` nor
 * `off: undefined`), and media effect cards accept neither.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detachOverlay, overlayQuoteId, setOverlayOff } from "./overlayActions.ts";

function fakeStore() {
  const calls = [];
  const rec = (name) => (clipId, value) => { calls.push({ name, clipId, value }); return true; };
  return { calls, setClipFilter: rec("filter"), setClipPixelMap: rec("pixelMap"), setClipAudioFx: rec("audioFx") };
}
const item = (kind, extra = {}) => ({ kind, refId: "x1", name: "Darken", value: "", upstream: false, off: false, canToggle: true, canDetach: true, ...extra });

test("Disable: the original attachment keeps every field, plus an extra off", () => {
  const s = fakeStore();
  const clip = { id: "c1", filter: { id: "f1", params: { amount: 0.4 } } };
  assert.equal(setOverlayOff(s, clip, item("filter"), true), true);
  assert.deepEqual(s.calls, [{ name: "filter", clipId: "c1", value: { id: "f1", params: { amount: 0.4 }, off: true } }]);
});

test("Enable: the off key is removed entirely, not set to false and not undefined", () => {
  const s = fakeStore();
  const clip = { id: "c1", filter: { id: "f1", params: { amount: 0.4 }, off: true } };
  setOverlayOff(s, clip, item("filter", { off: true }), false);
  const sent = s.calls[0].value;
  assert.deepEqual(sent, { id: "f1", params: { amount: 0.4 } });
  assert.equal("off" in sent, false, "If the key were still there, the document service's field-by-field comparison would see it");
});

test("Each of the three attachment kinds goes through its own action", () => {
  const s = fakeStore();
  const clip = { id: "c1", filter: { id: "f1" }, pixelMap: { id: "p1" }, audioFx: { id: "a1" } };
  setOverlayOff(s, clip, item("filter"), true);
  setOverlayOff(s, clip, item("pixelMap"), true);
  setOverlayOff(s, clip, item("audioFx"), true);
  assert.deepEqual(s.calls.map((c) => c.name), ["filter", "pixelMap", "audioFx"]);
});

test("Do nothing when nothing is attached to this clip at all", () => {
  const s = fakeStore();
  assert.equal(setOverlayOff(s, { id: "c1" }, item("filter"), true), false);
  assert.equal(s.calls.length, 0);
});

test("Media effect card: disable is not supported (bypassing a node has to be done in the graph)", () => {
  const s = fakeStore();
  const card = item("card", { canToggle: false });
  assert.equal(setOverlayOff(s, { id: "c1", nodeId: "n1" }, card, true), false);
  assert.equal(s.calls.length, 0);
});

test("Media effect card: detach goes through editCardProject to rewire the node graph, not by clearing a field", () => {
  const s = fakeStore();
  let edited = false;
  s.editCardProject = (fn) => { edited = true; assert.equal(typeof fn, "function"); };
  const card = item("card", { canToggle: false, canDetach: true });
  assert.equal(detachOverlay(s, { id: "c1", nodeId: "n1" }, card, () => undefined), true);
  assert.equal(edited, true);
  assert.equal(s.calls.length, 0, "None of the three clear actions should be called");
});

test("The kind that cannot be rewired back (canDetach is false) does nothing", () => {
  const s = fakeStore();
  s.editCardProject = () => { throw new Error("Should not get here"); };
  assert.equal(detachOverlay(s, { id: "c1", nodeId: "n1" }, item("card", { canToggle: false, canDetach: false })), false);
});

test("Detach: clear that one field and leave the definition in the library untouched", () => {
  const s = fakeStore();
  detachOverlay(s, { id: "c1", audioFx: { id: "a1" } }, item("audioFx"));
  assert.deepEqual(s.calls, [{ name: "audioFx", clipId: "c1", value: null }]);
});

test("The reference block's id carries which kind and which definition it is", () => {
  assert.equal(overlayQuoteId({ id: "c1" }, item("filter", { refId: "f1" })), "c1#filter:f1");
});
