/**
 * Crop and mirror numbers shared by the page, the 3D canvas path and the ffmpeg export
 * (kernel/mediaPicture.mjs). Run: node --test src/kernel/mediaPicture.test.mjs
 *
 * Pinned: what a crop may be and how it is stored; that the cropped part covers the box exactly
 * like object-fit: cover (and that no crop is plain cover); the box a crop gives a clip; the ffmpeg
 * crop filter; which clips crop and mirror apply to.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CROP_MIN, boxForCrop, cropAspect, ffmpegCropFilter, mediaAspect, normalizeCrop, pictureEditBlock, pictureRect } from "./mediaPicture.mjs";

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} expected ${b}, got ${a}`);
const closeRect = (r, e) => { for (const k of Object.keys(e)) close(r[k], e[k], k); };

test("normalizeCrop: the whole picture is no crop; values are kept inside the picture and rounded to six decimals", () => {
  assert.deepEqual(normalizeCrop(undefined), { ok: true, crop: null });
  assert.deepEqual(normalizeCrop(null), { ok: true, crop: null });
  assert.deepEqual(normalizeCrop({ x: 0, y: 0, w: 1, h: 1 }), { ok: true, crop: null }, "{0,0,1,1} is stored as no crop, not as a no-op field");
  assert.deepEqual(normalizeCrop({ x: 1e-9, y: 0, w: 1, h: 0.9999999 }), { ok: true, crop: null }, "dialog round-trip noise around the whole picture is the whole picture");
  assert.deepEqual(normalizeCrop({ x: 0.25, y: 0.1, w: 0.5, h: 0.8 }), { ok: true, crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.8 } });
  assert.deepEqual(normalizeCrop({ x: 1 / 3, y: 0, w: 1 / 3, h: 1 }), { ok: true, crop: { x: 0.333333, y: 0, w: 0.333333, h: 1 } });
  const edge = normalizeCrop({ x: 0.6, y: 0.5, w: 0.4000001, h: 0.5 });
  assert.equal(edge.ok, true);
  assert.ok(edge.crop.x + edge.crop.w <= 1 + 1e-12, "a tiny overshoot is cut back to the picture's edge");
});

test("normalizeCrop: anything outside the picture, too small or not a number is refused with a reason", () => {
  for (const bad of [
    { x: -0.1, y: 0, w: 0.5, h: 0.5 },
    { x: 0.6, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0, w: CROP_MIN / 2, h: 0.5 },
    { x: 0, y: 0, w: 0.5 },
    { x: "0", y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0, w: NaN, h: 0.5 },
    [0, 0, 1, 1],
    "0,0,1,1",
  ]) {
    const r = normalizeCrop(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /crop/);
  }
});

test("pictureRect: no crop is object-fit: cover; a crop covers the box with its own center on the box's center", () => {
  // 16:9 picture in a 16:9 box: exactly the box
  closeRect(pictureRect(null, 16 / 9, 16 / 9), { left: 0, top: 0, width: 1, height: 1 });
  // 4:3 picture in a 16:9 box: full width, top and bottom overflow equally (cover)
  closeRect(pictureRect(null, 4 / 3, 16 / 9), { left: 0, width: 1, height: (16 / 9) / (4 / 3), top: (1 - (16 / 9) / (4 / 3)) / 2 });
  // Center quarter of a 16:9 picture in a 16:9 box: the picture is drawn at twice the box, centered
  closeRect(pictureRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 16 / 9, 16 / 9), { left: -0.5, top: -0.5, width: 2, height: 2 });
  // Left half of a 16:9 picture (8:9) in a square box: the cropped part is narrower, so its width fills the box
  const r = pictureRect({ x: 0, y: 0, w: 0.5, h: 1 }, 16 / 9, 1);
  close(r.width, 2, "picture is twice the box wide");
  close(r.left, 0, "the cropped part starts at the box's left edge");
  close(r.height, (1 / (16 / 9)) * 2, "height keeps the picture's aspect ratio");
  close(r.top + r.height / 2, 0.5, "vertically centered");
});

test("pictureRect: an unknown picture size stretches the cropped part onto the box", () => {
  closeRect(pictureRect({ x: 0.2, y: 0.1, w: 0.5, h: 0.4 }, null, 16 / 9), { left: -0.4, top: -0.25, width: 2, height: 2.5 });
  closeRect(pictureRect(null, null, 16 / 9), { left: 0, top: 0, width: 1, height: 1 });
});

test("boxForCrop: a full-stage clip stays full-stage; cropping back to the whole picture restores the box", () => {
  const stage = { width: 1920, height: 1080 };
  const a = 16 / 9;
  const square = { x: (1 - 9 / 16) / 2, y: 0, w: 9 / 16, h: 1 };
  close(cropAspect(square, a), 1, "this crop is square in pixels");
  assert.deepEqual(boxForCrop({ box: { w: 1920, h: 1080 }, prevCrop: null, nextCrop: square, sourceAspect: a, stage }), { w: 1080, h: 1080 });
  assert.deepEqual(boxForCrop({ box: { w: 1080, h: 1080 }, prevCrop: square, nextCrop: null, sourceAspect: a, stage }), { w: 1920, h: 1080 });
  // A 16:9 crop keeps the 16:9 box (the crop zooms in)
  assert.deepEqual(boxForCrop({ box: { w: 1920, h: 1080 }, prevCrop: null, nextCrop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, sourceAspect: a, stage }), { w: 1920, h: 1080 });
  // A picture-in-picture keeps its size relative to the stage
  assert.deepEqual(boxForCrop({ box: { w: 640, h: 360 }, prevCrop: null, nextCrop: square, sourceAspect: a, stage }), { w: 360, h: 360 });
  // A 9:16 phone video covering a 16:9 stage counts as filling the stage: its whole picture fits by height
  const tall = boxForCrop({ box: { w: 1920, h: 1080 }, prevCrop: null, nextCrop: { x: 0, y: 0.25, w: 1, h: 0.5 }, sourceAspect: 9 / 16, stage });
  assert.deepEqual(tall, { w: 1215, h: 1080 }, "a 9:8 crop of a 9:16 picture, fitted to the stage height");
});

test("ffmpegCropFilter: fractions of the input size, rounded like the page, exact offsets", () => {
  assert.equal(ffmpegCropFilter(null), "");
  assert.equal(ffmpegCropFilter({ x: 0.25, y: 0.1, w: 0.5, h: 0.8 }), "crop=w=round(iw*0.5):h=round(ih*0.8):x=round(iw*0.25):y=round(ih*0.1):exact=1");
  assert.ok(!ffmpegCropFilter({ x: 1 / 3, y: 0, w: 1 / 3, h: 1 }).includes(","), "no comma: it sits inside a filter chain");
});

test("pictureEditBlock: only video and image clips, and not when a media effect card draws the picture", () => {
  const project = {
    media: [{ id: "v", kind: "video" }, { id: "i", kind: "image" }, { id: "a", kind: "audio" }],
    cardNodes: [{ id: "n-fx", adapter: "card", kind: "filter" }, { id: "n-sound", adapter: "card", kind: "audio" }],
  };
  assert.equal(pictureEditBlock(project, { mediaId: "v" }), null);
  assert.equal(pictureEditBlock(project, { mediaId: "i" }), null);
  assert.equal(pictureEditBlock(project, { mediaId: "a" }), "not-media");
  assert.equal(pictureEditBlock(project, { cardId: "title" }), "not-media");
  assert.equal(pictureEditBlock(project, { cutId: "cut-2" }), "not-media");
  assert.equal(pictureEditBlock(project, { mediaId: "gone" }), "not-media");
  assert.equal(pictureEditBlock(project, { mediaId: "v", nodeId: "n-fx" }), "effect-card");
  assert.equal(pictureEditBlock(project, { mediaId: "v", nodeId: "n-sound" }), null, "an audio effect card leaves the picture alone");
  assert.equal(pictureEditBlock({ ...project, cardNodes: { "n-fx": project.cardNodes[0] } }, { mediaId: "v", nodeId: "n-fx" }), "effect-card", "cardNodes kept as an object map");
});

test("mediaAspect: only a recorded positive size counts", () => {
  assert.equal(mediaAspect({ width: 1920, height: 1080 }), 1920 / 1080);
  assert.equal(mediaAspect({ width: 1920 }), null);
  assert.equal(mediaAspect({ width: 0, height: 1080 }), null);
  assert.equal(mediaAspect(undefined), null);
});
