/**
 * Which clips the timeline's edit tools act on, and what a greyed-out button says (editToolStates.ts).
 * Run: node --test src/editor/timeline/editToolStates.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { editToolStates } = await import(srcUrl("editor/timeline/editToolStates.ts"));

const clip = (id, extra = {}) => ({ id, cardId: "", params: {}, start: 0, end: 10, ...extra });
const project = (tracks, extra = {}) => ({
  version: 1, name: "t", width: 1920, height: 1080, fps: 30, duration: 20, themeId: "midnight",
  media: [
    { id: "v", kind: "video", name: "v.mp4", url: "/v.mp4" },
    { id: "a", kind: "audio", name: "a.mp3", url: "/a.mp3" },
  ],
  tracks,
  ...extra,
});

test("nothing selected: every tool is off and says to select something first", () => {
  const s = editToolStates(project([{ id: "t1", name: "1", clips: [clip("v1", { mediaId: "v" })] }]), [], 5);
  for (const k of ["split", "mirror", "rotate", "crop"]) {
    assert.deepEqual(s[k].targets, [], k);
    assert.match(s[k].title, /select/i, k);
  }
  assert.match(s.split.title, /Ctrl\+B/);
});

test("a selected video under the playhead: all four tools act on it", () => {
  const p = project([{ id: "t1", name: "1", clips: [clip("v1", { mediaId: "v" })] }]);
  const s = editToolStates(p, ["v1"], 5);
  assert.deepEqual(s.split.targets, ["v1"]);
  assert.deepEqual(s.mirror.targets, ["v1"]);
  assert.equal(s.mirror.on, false);
  assert.deepEqual(s.rotate.targets, ["v1"]);
  assert.deepEqual(s.crop.targets, ["v1"]);
  assert.match(s.split.title, /Split at the playhead \(Ctrl\+B\)/);
});

test("split: only clips the playhead is inside; the reason when none is", () => {
  const p = project([
    { id: "t1", name: "1", clips: [clip("v1", { mediaId: "v" }), clip("v2", { mediaId: "v", start: 10, end: 20 })] },
    { id: "t2", name: "2", locked: true, clips: [clip("l1", { mediaId: "v" })] },
  ]);
  assert.deepEqual(editToolStates(p, ["v1", "v2"], 5).split.targets, ["v1"]);
  assert.match(editToolStates(p, ["v2"], 5).split.title, /Move the playhead inside/);
  assert.match(editToolStates(p, ["l1"], 5).split.title, /locked/);
  const both = editToolStates(project([
    { id: "t1", name: "1", clips: [clip("v1", { mediaId: "v" })] },
    { id: "t2", name: "2", clips: [clip("c1", { cardId: "title" })] },
  ]), ["v1", "c1"], 5);
  assert.match(both.split.title, /Split 2 clips/);
});

test("mirror: pressed only when every target is mirrored; cards, audio and media effect cards are not targets", () => {
  const p = project([
    { id: "t1", name: "1", clips: [clip("v1", { mediaId: "v", flipX: true }), clip("v2", { mediaId: "v", start: 10, end: 20 })] },
    { id: "t2", name: "2", clips: [clip("c1", { cardId: "title" }), clip("fx", { mediaId: "v", start: 10, end: 20, nodeId: "n-fx" })] },
    { id: "t3", name: "3", clips: [clip("a1", { mediaId: "a" })] },
  ], { cardNodes: [{ id: "n-fx", adapter: "card", kind: "filter" }] });
  assert.equal(editToolStates(p, ["v1"], 5).mirror.on, true);
  assert.equal(editToolStates(p, ["v1", "v2"], 5).mirror.on, false, "mixed: a click mirrors the rest");
  assert.deepEqual(editToolStates(p, ["v1", "c1", "a1"], 5).mirror.targets, ["v1"]);
  assert.match(editToolStates(p, ["c1"], 5).mirror.title, /Only video and image/);
  assert.match(editToolStates(p, ["fx"], 15).mirror.title, /media effect card/);
  assert.match(editToolStates(p, ["fx"], 15).crop.title, /media effect card/);
});

test("rotate: cards and media turn, audio and expression-driven boxes do not", () => {
  const p = project([
    { id: "t1", name: "1", clips: [clip("c1", { cardId: "title" }), clip("e1", { cardId: "title", start: 10, end: 20, frameExpr: { x: "t" } })] },
    { id: "t2", name: "2", clips: [clip("a1", { mediaId: "a" })] },
  ]);
  assert.deepEqual(editToolStates(p, ["c1", "a1"], 5).rotate.targets, ["c1"]);
  assert.match(editToolStates(p, ["a1"], 5).rotate.title, /Audio clips/);
  assert.match(editToolStates(p, ["e1"], 15).rotate.title, /Frame expressions/);
});

test("crop: exactly one selected video or image clip", () => {
  const p = project([{ id: "t1", name: "1", clips: [clip("v1", { mediaId: "v" }), clip("v2", { mediaId: "v", start: 10, end: 20 })] }]);
  assert.deepEqual(editToolStates(p, ["v1", "v2"], 5).crop.targets, []);
  assert.match(editToolStates(p, ["v1", "v2"], 5).crop.title, /single clip/);
  assert.deepEqual(editToolStates(p, ["v2"], 5).crop.targets, ["v2"], "the playhead does not matter for crop");
});
