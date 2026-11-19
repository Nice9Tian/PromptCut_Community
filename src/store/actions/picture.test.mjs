/**
 * The store side of the timeline's edit tools: splitClips, setClipsFlipX, cropClip, rotateClips.
 * Run: node --test src/store/actions/picture.test.mjs
 *
 * Pinned: each click is one undo step even across several clips; Split selects the second halves;
 * what is refused is refused without writing anything; mirror off and the whole-picture crop leave no
 * key behind (saved projects stay as before); a crop reshapes the box around the clip's center and
 * choosing the whole picture again gives the box back.
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { actions, getState } = await import(srcUrl("store/project.ts"));

const clip = (id, extra = {}) => ({ id, cardId: "", params: {}, start: 0, end: 10, ...extra });
function load({ tracks, cardNodes } = {}) {
  actions.loadProject({
    version: 1, id: "p-picture", name: "t", width: 1920, height: 1080, fps: 30, duration: 10, themeId: "midnight",
    media: [
      { id: "v", kind: "video", name: "v.mp4", url: "/media/v.mp4", duration: 20, width: 1920, height: 1080 },
      { id: "img", kind: "image", name: "p.png", url: "/media/p.png", width: 1000, height: 1000 },
      { id: "a", kind: "audio", name: "a.mp3", url: "/media/a.mp3", duration: 20 },
    ],
    ...(cardNodes ? { cardNodes } : null),
    tracks: tracks ?? [
      { id: "t1", name: "Track 1", clips: [clip("v1", { mediaId: "v" })] },
      { id: "t2", name: "Track 2", clips: [clip("i1", { mediaId: "img" })] },
      { id: "t3", name: "Track 3", clips: [clip("a1", { mediaId: "a" })] },
    ],
  });
}
const find = (id) => getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id);

test("splitClips: every selected clip under the playhead in one undo step; the second halves become the selection", () => {
  load();
  const rights = actions.splitClips(["v1", "i1", "missing"], 4);
  assert.equal(rights.length, 2);
  assert.deepEqual(getState().selection, rights.map((c) => c.id));
  assert.deepEqual(getState().project.tracks.map((t) => t.clips.length), [2, 2, 1]);
  assert.equal(find("v1").end, 4);
  assert.equal(rights[0].start, 4);
  assert.equal(rights[0].mediaOffset, 4, "the second half carries on in the media");
  actions.undo();
  assert.deepEqual(getState().project.tracks.map((t) => t.clips.length), [1, 1, 1], "one undo takes back both splits");
  assert.deepEqual(actions.splitClips(["v1"], 0.02), [], "too close to the start: nothing split");
  assert.deepEqual(actions.splitClips(["v1"], 12), []);
});

test("setClipsFlipX: video and image clips in one step; audio skipped; off removes the key", () => {
  load();
  assert.deepEqual(actions.setClipsFlipX(["v1", "i1", "a1"], true), ["v1", "i1"]);
  assert.equal(find("v1").flipX, true);
  assert.equal(find("a1").flipX, undefined);
  assert.deepEqual(actions.setClipsFlipX(["v1"], true), [], "already mirrored: nothing to do, no undo step");
  assert.deepEqual(actions.setClipsFlipX(["v1", "i1"], false), ["v1", "i1"]);
  assert.equal("flipX" in find("v1"), false, "not mirrored = no key at all");
  actions.undo();
  assert.equal(find("i1").flipX, true);
  actions.undo();
  assert.equal(find("v1").flipX, undefined, "the first click was a single undo step for both clips");
});

test("setClipsFlipX / cropClip: refused on a locked track and when a media effect card draws the picture", () => {
  load({
    cardNodes: [{ id: "n-fx", adapter: "card", cardId: "invert", kind: "filter", params: {}, inputs: {} }],
    tracks: [
      { id: "t1", name: "Track 1", locked: true, clips: [clip("v1", { mediaId: "v" })] },
      { id: "t2", name: "Track 2", clips: [clip("v2", { mediaId: "v", nodeId: "n-fx" })] },
    ],
  });
  assert.deepEqual(actions.setClipsFlipX(["v1", "v2"], true), []);
  const locked = actions.cropClip("v1", { x: 0, y: 0, w: 0.5, h: 0.5 });
  assert.equal(locked.ok, false);
  const effect = actions.cropClip("v2", { x: 0, y: 0, w: 0.5, h: 0.5 });
  assert.equal(effect.ok, false);
  assert.match(effect.error, /media effect card/);
  assert.equal(find("v2").crop, undefined);
});

test("cropClip: the box takes the cropped part's shape around the same center; the whole picture gives it back", () => {
  load();
  const r = actions.cropClip("v1", { x: 0.21875, y: 0, w: 0.5625, h: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(find("v1").crop, { x: 0.21875, y: 0, w: 0.5625, h: 1 });
  assert.deepEqual(find("v1").frame, { x: 960, y: 540, w: 1080, h: 1080, anchor: [0.5, 0.5] }, "a square crop of a 16:9 full-stage video: a centered 1080 square");
  const same = actions.cropClip("v1", { x: 0.21875, y: 0, w: 0.5625, h: 1 });
  assert.equal(same.ok, true);
  actions.undo();
  assert.equal(find("v1").crop, undefined, "asking for the crop it already had added no undo step");
  actions.redo();
  const back = actions.cropClip("v1", { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(back.ok, true);
  assert.equal("crop" in find("v1"), false, "whole picture = no crop key");
  assert.deepEqual(find("v1").frame, { x: 960, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5] });
  assert.equal(actions.cropClip("v1", { x: 0.9, y: 0, w: 0.5, h: 1 }).ok, false, "outside the picture");
  assert.equal(actions.cropClip("a1", { x: 0, y: 0, w: 0.5, h: 1 }).ok, false, "audio has no picture");
});

test("cropClip: without a known picture size, or with frame expressions, only the crop is stored", () => {
  load({
    tracks: [{ id: "t1", name: "Track 1", clips: [
      clip("v1", { mediaId: "v", frameExpr: { x: "100 + t * 10" } }),
    ] }],
  });
  assert.equal(actions.cropClip("v1", { x: 0, y: 0, w: 0.5, h: 0.5 }).ok, true);
  assert.equal(find("v1").frame, undefined, "the expressions own the box");
  load();
  assert.equal(actions.cropClip("i1", { x: 0, y: 0, w: 0.5, h: 1 }, { sourceAspect: 1 }).ok, true);
  assert.deepEqual(find("i1").frame, { x: 960, y: 540, w: 540, h: 1080, anchor: [0.5, 0.5] }, "the dialog's aspect ratio is used when given");
});

test("rotateClips: 90° about each clip's center in one step; audio and expression-driven boxes are skipped", () => {
  load({
    tracks: [
      { id: "t1", name: "Track 1", clips: [clip("v1", { mediaId: "v" }), clip("e1", { mediaId: "v", start: 10, end: 12, frameExpr: { rotate: "t * 90" } })] },
      { id: "t2", name: "Track 2", clips: [clip("c1", { cardId: "title", frame: { x: 0, y: 0, w: 400, h: 200 } })] },
      { id: "t3", name: "Track 3", clips: [clip("a1", { mediaId: "a" })] },
    ],
  });
  assert.deepEqual(actions.rotateClips(["v1", "c1", "a1", "e1"], 90), ["v1", "c1"]);
  assert.deepEqual(find("v1").frame, { x: 960, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5], rotate: 90 });
  assert.deepEqual(find("c1").frame, { x: 200, y: 100, w: 400, h: 200, anchor: [0.5, 0.5], rotate: 90 }, "a card turns about its own center, not its top-left anchor");
  assert.equal(find("e1").frame, undefined);
  actions.undo();
  assert.equal(find("v1").frame, undefined);
  assert.deepEqual(find("c1").frame, { x: 0, y: 0, w: 400, h: 200 }, "one undo step for both");
});
