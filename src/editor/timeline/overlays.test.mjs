/**
 * 叠加卡清单与退化档次(`overlays.ts`)。
 *
 * 要守住的两件事:
 * 1. 带里从左到右就是处理顺序 —— 像素映射走哪一档看它定义里的 `source.stage`;
 * 2. 片段短下去时一档一档退,最后只剩那个计数徽标,而不是让名字和徽标互相盖住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BAND_H, NARROW_PX, chipWidth, countWidth, overlaysOfClip, planBand, planClipLayout,
} from "./overlays.ts";

const libs = { cardName: (id) => ({ "vignette": "暗角" })[id] };

function projectWith(extra = {}) {
  return {
    filters: [{ id: "f1", name: "压暗", ops: [{ kind: "brightness", value: 0.72 }] }],
    pixelMaps: [{ id: "p1", name: "抠绿", where: "g>0.6", source: { stage: "origin" }, to: {}, mode: "continuous" }],
    audioFx: [{ id: "a1", name: "人声清晰", ops: [{ kind: "gain", values: { db: 3 } }] }],
    cardNodes: [{ id: "n1", adapter: "filter", cardId: "vignette", kind: "filter" }],
    ...extra,
  };
}

test("没挂东西的片段给空清单", () => {
  assert.deepEqual(overlaysOfClip(projectWith(), { id: "c1", start: 0, end: 1 }, libs), []);
});

test("顺序就是处理顺序:取原始输出的像素映射排在滤镜前面", () => {
  const items = overlaysOfClip(projectWith(), { id: "c1", start: 0, end: 1, pixelMap: { id: "p1" }, filter: { id: "f1" } }, libs);
  assert.deepEqual(items.map((i) => i.kind), ["pixelMap", "filter"]);
});

test("取滤镜之后那一档的像素映射排在滤镜后面", () => {
  const project = projectWith({
    pixelMaps: [{ id: "p1", name: "抠绿", where: "g>0.6", source: { stage: "after_filters" }, to: {}, mode: "continuous" }],
  });
  const items = overlaysOfClip(project, { id: "c1", start: 0, end: 1, pixelMap: { id: "p1" }, filter: { id: "f1" } }, libs);
  assert.deepEqual(items.map((i) => i.kind), ["filter", "pixelMap"]);
});

test("四样一起挂:声音那一支排在最后,素材效果卡取卡片名", () => {
  const clip = { id: "c1", start: 0, end: 1, pixelMap: { id: "p1" }, filter: { id: "f1" }, nodeId: "n1", audioFx: { id: "a1" } };
  const items = overlaysOfClip(projectWith(), clip, libs);
  assert.deepEqual(items.map((i) => i.kind), ["pixelMap", "filter", "card", "audioFx"]);
  assert.equal(items[2].name, "暗角");
  assert.equal(items.every((i) => i.upstream === false), true);
});

test("库里那条定义不在了就不列它(悬空引用不让时间轴炸)", () => {
  const items = overlaysOfClip(projectWith({ filters: [] }), { id: "c1", start: 0, end: 1, filter: { id: "f1" } }, libs);
  assert.deepEqual(items, []);
});

test("摘要算不出来时留空,不抛错", () => {
  const project = projectWith({ filters: [{ id: "f1", name: "坏的", ops: null }] });
  const items = overlaysOfClip(project, { id: "c1", start: 0, end: 1, filter: { id: "f1" } }, libs);
  assert.equal(items.length, 1);
  assert.equal(items[0].value, "");
});

test("停用的照列,带上标着 off —— 清单是「挂着什么」,不是「现在生效什么」", () => {
  const clip = { id: "c1", start: 0, end: 1, filter: { id: "f1", off: true }, audioFx: { id: "a1" } };
  const items = overlaysOfClip(projectWith(), clip, libs);
  assert.deepEqual(items.map((i) => [i.name, i.off]), [["压暗", true], ["人声清晰", false]]);
});

test("素材效果卡切不了停用:它是节点图里的一个节点", () => {
  const items = overlaysOfClip(projectWith(), { id: "c1", start: 0, end: 1, nodeId: "n1" }, libs);
  assert.equal(items[0].canToggle, false);
  assert.equal(items[0].off, false);
});

test("滤镜、像素映射、音频效果都切得了停用", () => {
  const clip = { id: "c1", start: 0, end: 1, filter: { id: "f1" }, pixelMap: { id: "p1" }, audioFx: { id: "a1" } };
  const items = overlaysOfClip(projectWith(), clip, libs);
  assert.equal(items.every((i) => i.canToggle), true);
});

/* ------------------------------------------------------------------ 带 */

const chips = (names) => names.map((name) => ({ kind: "filter", refId: name, name, value: "", upstream: false, off: false, canToggle: true }));

test("摆得下就全摆,不出 +N", () => {
  const plan = planBand(chips(["压暗", "抠绿"]), 300);
  assert.equal(plan.shown.length, 2);
  assert.equal(plan.hidden, 0);
});

test("摆不下的收成 +N,高度不随数量涨", () => {
  const plan = planBand(chips(["压暗", "模糊", "暗角"]), 130);
  assert.equal(plan.shown.length, 2);
  assert.equal(plan.hidden, 1);
});

test("选中的那一张被挤进 +N 时换到最后一格", () => {
  const items = chips(["压暗", "模糊", "暗角"]);
  const plan = planBand(items, 130, 2);
  assert.equal(plan.hidden, 1);
  assert.equal(plan.shown[plan.shown.length - 1].name, "暗角");
});

test("窄到一张都摆不下时 shown 为空,全进 +N", () => {
  const plan = planBand(chips(["压暗", "模糊"]), 40);
  assert.equal(plan.shown.length, 0);
  assert.equal(plan.hidden, 2);
});

/* ------------------------------------------------------------------ 退化档次 */

test("中行高够宽:画带、写时长、写名字", () => {
  const p = planClipLayout(300, "medium", 2);
  assert.deepEqual(
    { band: p.band, countOnly: p.countOnly, pill: p.pill, duration: p.duration, name: p.name },
    { band: true, countOnly: false, pill: false, duration: true, name: true },
  );
});

test("窄片段:带照画但只放 +N,正文不写时长", () => {
  const p = planClipLayout(NARROW_PX - 1, "medium", 1);
  assert.equal(p.band, true);
  assert.equal(p.countOnly, true);
  assert.equal(p.duration, false);
  assert.equal(p.name, true, "57px 还放得下「户型…」");
});

test("最窄那一档连名字都不画,只剩带里的 +N", () => {
  const p = planClipLayout(31, "medium", 1);
  assert.equal(p.countOnly, true);
  assert.equal(p.name, false);
});

test("小行高不画带,+N 排在名字后面", () => {
  const p = planClipLayout(300, "small", 3);
  assert.equal(p.band, false);
  assert.equal(p.pill, true);
  assert.equal(p.name, true);
  assert.equal(BAND_H.small, 0);
});

test("小行高 + 窄片段:徽标占掉之后名字就不画了", () => {
  const p = planClipLayout(31, "small", 1);
  assert.equal(p.pill, true);
  assert.equal(p.name, false);
});

test("没挂东西的片段在中 / 大行高照样留出带那一格", () => {
  const p = planClipLayout(300, "medium", 0);
  assert.equal(p.band, true);
  assert.equal(p.pill, false);
});

test("宽度估算随名字变长", () => {
  assert.ok(chipWidth("压暗") < chipWidth("人声清晰"));
  assert.ok(countWidth(9) < countWidth(10));
});
