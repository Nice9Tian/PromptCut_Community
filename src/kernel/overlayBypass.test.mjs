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
  filters: [{ id: "f1", name: "压暗", ops: [{ kind: "brightness", value: 0.72 }] }],
  pixelMaps: [{ id: "p1", name: "抠绿", where: "g>0.6", source: { stage: "origin" }, to: { kind: "transparent" }, mode: "continuous" }],
  audioFx: [{ id: "a1", name: "人声清晰", ops: [{ kind: "gain", values: { db: 3 } }] }],
};
const clip = (extra) => ({ id: "c1", start: 0, end: 2, ...extra });

test("滤镜:挂着就解析得到", () => {
  assert.equal(filterOfClip(project, clip({ filter: { id: "f1" } }))?.name, "压暗");
});

test("滤镜:停用之后按没挂算,逐帧数值也没有了", () => {
  const c = clip({ filter: { id: "f1", off: true } });
  assert.equal(filterOfClip(project, c), null);
  assert.equal(clipFilterOpsAt(project, c, 1), null);
});

test("像素映射:停用之后按没挂算", () => {
  assert.equal(pixelMapOfClip(project, clip({ pixelMap: { id: "p1" } }))?.name, "抠绿");
  assert.equal(pixelMapOfClip(project, clip({ pixelMap: { id: "p1", off: true } })), null);
});

test("音频效果:停用之后按没挂算,逐帧数值也没有了", () => {
  const on = clip({ audioFx: { id: "a1" } });
  const off = clip({ audioFx: { id: "a1", off: true } });
  assert.equal(audioFxOfClip(project, on)?.name, "人声清晰");
  assert.equal(audioFxOfClip(project, off), null);
  assert.notEqual(clipAudioFxAt(project, on, 1), null);
  assert.equal(clipAudioFxAt(project, off, 1), null);
});

test("停用不动挂载本身:库里的定义、逐段参数都还在", () => {
  const c = clip({ filter: { id: "f1", params: { amount: 0.4 }, off: true } });
  assert.equal(filterOfClip(project, c), null);
  // 这一段上不生效,但「挂的是哪一条、参数是多少」一个字都没少 —— 启用回来不用重填
  assert.deepEqual(c.filter, { id: "f1", params: { amount: 0.4 }, off: true });
  assert.equal(project.filters.length, 1);
});

test("off 为 false 当成没停用(撤销 / 协作合并回来的旧值)", () => {
  assert.equal(filterOfClip(project, clip({ filter: { id: "f1", off: false } }))?.id, "f1");
  assert.equal(pixelMapOfClip(project, clip({ pixelMap: { id: "p1", off: false } }))?.id, "p1");
  assert.equal(audioFxOfClip(project, clip({ audioFx: { id: "a1", off: false } }))?.id, "a1");
});

test("定义被删了仍然给 null,和停不停用无关", () => {
  const empty = { filters: [], pixelMaps: [], audioFx: [] };
  assert.equal(filterOfClip(empty, clip({ filter: { id: "f1" } })), null);
  assert.equal(pixelMapOfClip(empty, clip({ pixelMap: { id: "p1", off: true } })), null);
  assert.equal(audioFxOfClip(empty, clip({ audioFx: { id: "a1" } })), null);
});
