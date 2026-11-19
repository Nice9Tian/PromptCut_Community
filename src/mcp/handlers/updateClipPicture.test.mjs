/**
 * update_clip's flipX / crop: the Agent writes the same crop and mirror as the timeline toolbar.
 * Pinned: a bad crop is refused before anything is written; clips that are not video / image, or whose
 * picture a media effect card draws, are refused with a reason; a crop reshapes the box and the reply
 * says so. Run: node --test src/mcp/handlers/updateClipPicture.test.mjs
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

mock.module(srcUrl("ai/mcpExecutor.ts"), { exports: { EditorApi: undefined } });

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { clipsHandlers } = await import(srcUrl("mcp/handlers/clips.ts"));

function load() {
  actions.loadProject({
    version: 1, id: "p-picture-mcp", name: "t", width: 1920, height: 1080, fps: 30, duration: 10, themeId: "midnight",
    media: [{ id: "v", kind: "video", name: "v.mp4", url: "/v.mp4", width: 1920, height: 1080 }],
    cardNodes: [{ id: "n-fx", adapter: "card", cardId: "invert", kind: "filter", params: {}, inputs: {} }],
    tracks: [{ id: "t1", name: "Track 1", clips: [
      { id: "v1", cardId: "", params: {}, mediaId: "v", start: 0, end: 4 },
      { id: "fx", cardId: "", params: {}, mediaId: "v", nodeId: "n-fx", start: 4, end: 8 },
      { id: "k1", cardId: "title", params: {}, start: 8, end: 10 },
    ] }],
  });
}
const find = (id) => getState().project.tracks[0].clips.find((c) => c.id === id);

test("flipX and crop in one call: mirrored, cropped, the box reshaped and echoed", () => {
  load();
  const r = clipsHandlers.updateClip({ clipId: "v1", flipX: true, crop: { x: 0.21875, y: 0, w: 0.5625, h: 1 } });
  assert.equal(r.ok, true);
  assert.equal(r.flipX, true);
  assert.deepEqual(r.crop, { x: 0.21875, y: 0, w: 0.5625, h: 1 });
  assert.deepEqual(r.frame, { x: 960, y: 540, w: 1080, h: 1080, anchor: [0.5, 0.5] });
  assert.equal(find("v1").flipX, true);
  const back = clipsHandlers.updateClip({ clipId: "v1", flipX: false, crop: { x: 0, y: 0, w: 1, h: 1 } });
  assert.equal(back.crop, null, "the whole picture removes the crop");
  assert.equal("flipX" in find("v1"), false);
  assert.equal("crop" in find("v1"), false);
});

test("refused before anything is written: a bad crop, a non-boolean flipX, a card, a media effect card", () => {
  load();
  assert.throws(() => clipsHandlers.updateClip({ clipId: "v1", opacity: 0.5, crop: { x: 0.8, y: 0, w: 0.5, h: 1 } }), /crop must stay inside the picture/);
  assert.equal(find("v1").opacity, undefined, "the opacity in the same call was not written either");
  assert.throws(() => clipsHandlers.updateClip({ clipId: "v1", flipX: "yes" }), /flipX must be true or false/);
  assert.throws(() => clipsHandlers.updateClip({ clipId: "k1", flipX: true }), /only apply to video and image clips/);
  assert.throws(() => clipsHandlers.updateClip({ clipId: "fx", crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }), /media effect card/);
  assert.equal(find("fx").crop, undefined);
});
