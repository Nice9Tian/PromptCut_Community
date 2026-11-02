/**
 * 叠加卡的停用(`workflow/editing.md`「叠加卡」、`product/project-model.md`「片段」)。
 *
 * 停用 = 挂载和逐段参数都留着,这一段上不生效。闸门只在三个解析口上:
 * `filterOfClip`、`pixelMapOfClip`、`audioFxOfClip` —— 预览、导出、ffmpeg 链、缓存签名
 * 全都从这三处取,各处自己判一遍必然漏一处。
 *
 * 这里守的就是「闸门在解析口上」这件事:停用之后解析口给 null,而挂载本身一个字段都没少。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clipFilterOpsAt, filterOfClip } from "./filters.mjs";
import { pixelMapOfClip } from "./pixelMap.mjs";
import { audioFxOfClip, clipAudioFxAt } from "./audioFx.mjs";

const project = {
  filters: [{ id: "f1", name: "Darken", ops: [{ kind: "brightness", value: 0.72 }] }],
  pixelMaps: [{ id: "p1", name: "Key out green", where: "g>0.6", source: { stage: "origin" }, to: { kind: "transparent" }, mode: "continuous" }],
  audioFx: [{ id: "a1", name: "Vocal clarity", ops: [{ kind: "gain", values: { db: 3 } }] }],
};
const clip = (extra) => ({ id: "c1", start: 0, end: 2, ...extra });

test("Filter: resolves as long as it is attached", () => {
  assert.equal(filterOfClip(project, clip({ filter: { id: "f1" } }))?.name, "Darken");
});

test("Filter: once disabled it is treated as not attached, and the per-frame values are gone too", () => {
  const c = clip({ filter: { id: "f1", off: true } });
  assert.equal(filterOfClip(project, c), null);
  assert.equal(clipFilterOpsAt(project, c, 1), null);
});

test("Pixel map: once disabled it is treated as not attached", () => {
  assert.equal(pixelMapOfClip(project, clip({ pixelMap: { id: "p1" } }))?.name, "Key out green");
  assert.equal(pixelMapOfClip(project, clip({ pixelMap: { id: "p1", off: true } })), null);
});

test("Audio effect: once disabled it is treated as not attached, and the per-frame values are gone too", () => {
  const on = clip({ audioFx: { id: "a1" } });
  const off = clip({ audioFx: { id: "a1", off: true } });
  assert.equal(audioFxOfClip(project, on)?.name, "Vocal clarity");
  assert.equal(audioFxOfClip(project, off), null);
  assert.notEqual(clipAudioFxAt(project, on, 1), null);
  assert.equal(clipAudioFxAt(project, off, 1), null);
});

test("Disabling does not touch the attachment itself: the definitions in the library and the per-segment params are still there", () => {
  const c = clip({ filter: { id: "f1", params: { amount: 0.4 }, off: true } });
  assert.equal(filterOfClip(project, c), null);
  // 这一段上不生效,但「挂的是哪一条、参数是多少」一个字都没少 —— 启用回来不用重填
  assert.deepEqual(c.filter, { id: "f1", params: { amount: 0.4 }, off: true });
  assert.equal(project.filters.length, 1);
});

test("off set to false counts as not disabled (an old value restored by undo / collaboration merge)", () => {
  assert.equal(filterOfClip(project, clip({ filter: { id: "f1", off: false } }))?.id, "f1");
  assert.equal(pixelMapOfClip(project, clip({ pixelMap: { id: "p1", off: false } }))?.id, "p1");
  assert.equal(audioFxOfClip(project, clip({ audioFx: { id: "a1", off: false } }))?.id, "a1");
});

test("A deleted definition still yields null, regardless of whether it is disabled", () => {
  const empty = { filters: [], pixelMaps: [], audioFx: [] };
  assert.equal(filterOfClip(empty, clip({ filter: { id: "f1" } })), null);
  assert.equal(pixelMapOfClip(empty, clip({ pixelMap: { id: "p1", off: true } })), null);
  assert.equal(audioFxOfClip(empty, clip({ audioFx: { id: "a1" } })), null);
});
