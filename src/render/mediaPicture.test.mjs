/**
 * Crop and mirror on the page and on 3D board textures (render/mediaPicture.ts).
 * Run: node --test src/render/mediaPicture.test.mjs
 *
 * Pinned: a clip without crop or mirror gets exactly the old style and the old cover drawing (export
 * baselines); a crop places the media element so the cropped part covers the box; a mirror flips about
 * the box's center; an emphasis shadow keeps its direction on a mirrored element.
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { mediaFitCss, mediaFilterCss, drawMediaPicture } = await import(srcUrl("render/mediaPicture.ts"));
const { filterOf } = await import(srcUrl("render/mediaDrive.ts"));

const STAGE = { width: 1920, height: 1080 };
const MEDIA = { width: 1920, height: 1080 };
const clip = (extra = {}) => ({ id: "c", cardId: "", params: {}, start: 0, end: 5, mediaId: "m", ...extra });

test("no crop, no mirror: the old style, key for key; no clip (idle slot) too", () => {
  const old = { display: "block", width: "100%", height: "100%", objectFit: "cover" };
  assert.deepEqual(mediaFitCss(clip(), MEDIA, undefined, STAGE), old);
  assert.deepEqual(Object.keys(mediaFitCss(clip(), MEDIA, undefined, STAGE)), Object.keys(old));
  assert.deepEqual(mediaFitCss(null, undefined, undefined, STAGE), old);
});

test("mirror only: still covering the box, flipped about its center", () => {
  assert.deepEqual(mediaFitCss(clip({ flipX: true }), MEDIA, undefined, STAGE),
    { display: "block", width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" });
});

test("crop: the element is sized and placed so the cropped part covers the box", () => {
  const s = mediaFitCss(clip({ crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } }), MEDIA, undefined, STAGE);
  assert.equal(s.position, "absolute");
  assert.equal(s.objectFit, "fill");
  assert.equal(s.maxWidth, "none", "the page's base styles would otherwise cap media at 100%");
  assert.deepEqual([s.left, s.top, s.width, s.height], ["-100%", "0%", "200%", "200%"], "top-right quarter of a 16:9 picture in a 16:9 box");
  const m = mediaFitCss(clip({ crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 }, flipX: true }), MEDIA, undefined, STAGE);
  assert.deepEqual([m.left, m.top, m.transform], ["0%", "0%", "scaleX(-1)"], "mirrored: the rectangle mirrored about the box's center, the element flipped");
  // A square box (frame 1080×1080) on the left half of a 16:9 picture: the half's width fills the box
  const sq = mediaFitCss(clip({ crop: { x: 0, y: 0, w: 0.5, h: 1 } }), MEDIA, { x: 0, y: 0, w: 1080, h: 1080 }, STAGE);
  assert.deepEqual([sq.left, sq.width], ["0%", "200%"]);
});

test("filter: on a mirrored element the shadow's horizontal offset is turned around first; nothing else changes", () => {
  const shadow = { kind: "shadow", dx: 12, dy: 8, size: 10 };
  assert.equal(mediaFilterCss(clip({ emphasis: shadow }), undefined, 1), filterOf(clip({ emphasis: shadow }), undefined, 1), "not mirrored: same as filterOf");
  assert.equal(mediaFilterCss(clip({ emphasis: shadow, flipX: true }), undefined, 1), filterOf(clip({ emphasis: { ...shadow, dx: -12 } }), undefined, 1));
  const outline = { kind: "outline", size: 6 };
  assert.equal(mediaFilterCss(clip({ emphasis: outline, flipX: true }), undefined, 1), filterOf(clip({ emphasis: outline }), undefined, 1), "an outline is symmetric");
  assert.equal(mediaFilterCss(clip({ flipX: true }), undefined, 1), undefined);
});

/** A 2D context that records what was drawn */
function fakeContext() {
  const calls = [];
  return {
    calls,
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    translate: (...a) => calls.push(["translate", ...a]),
    scale: (...a) => calls.push(["scale", ...a]),
    drawImage: (_src, ...a) => calls.push(["drawImage", ...a]),
  };
}

test("drawMediaPicture: plain cover as before; crop and mirror through the context", () => {
  const plain = fakeContext();
  drawMediaPicture(plain, {}, { width: 1440, height: 1080 }, { width: 1920, height: 1080 }, {});
  assert.deepEqual(plain.calls, [["drawImage", 0, -180, 1920, 1440]], "a 4:3 picture covering a 16:9 board, the old arithmetic");
  const both = fakeContext();
  drawMediaPicture(both, {}, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }, { crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, flipX: true, media: MEDIA });
  assert.deepEqual(both.calls, [["save"], ["translate", 1920, 0], ["scale", -1, 1], ["drawImage", -960, -540, 3840, 2160], ["restore"]]);
  // A mirror alone covers by the element's own size, like the page: on a pixel-map canvas (stretched to
  // the box) it must not start honoring the asset's recorded 4:3 shape
  const flipOnly = fakeContext();
  drawMediaPicture(flipOnly, {}, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }, { flipX: true, media: { width: 1440, height: 1080 } });
  assert.deepEqual(flipOnly.calls, [["save"], ["translate", 1920, 0], ["scale", -1, 1], ["drawImage", 0, 0, 1920, 1080], ["restore"]]);
});
