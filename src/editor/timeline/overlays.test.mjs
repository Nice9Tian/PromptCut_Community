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

const libs = { cardName: (id) => ({ "vignette": "Vignette" })[id] };

function projectWith(extra = {}) {
  return {
    filters: [{ id: "f1", name: "Darken", ops: [{ kind: "brightness", value: 0.72 }] }],
    pixelMaps: [{ id: "p1", name: "Key out green", where: "g>0.6", source: { stage: "origin" }, to: {}, mode: "continuous" }],
    audioFx: [{ id: "a1", name: "Vocal clarity", ops: [{ kind: "gain", values: { db: 3 } }] }],
    cardNodes: [{ id: "n1", adapter: "filter", cardId: "vignette", kind: "filter" }],
    ...extra,
  };
}

test("A clip with nothing attached gives an empty manifest", () => {
  assert.deepEqual(overlaysOfClip(projectWith(), { id: "c1", start: 0, end: 1 }, libs), []);
});

test("Order is processing order: a pixel map that takes the original output comes before the filter", () => {
  const items = overlaysOfClip(projectWith(), { id: "c1", start: 0, end: 1, pixelMap: { id: "p1" }, filter: { id: "f1" } }, libs);
  assert.deepEqual(items.map((i) => i.kind), ["pixelMap", "filter"]);
});

test("A pixel map that takes the after-filter tier comes after the filter", () => {
  const project = projectWith({
    pixelMaps: [{ id: "p1", name: "Key out green", where: "g>0.6", source: { stage: "after_filters" }, to: {}, mode: "continuous" }],
  });
  const items = overlaysOfClip(project, { id: "c1", start: 0, end: 1, pixelMap: { id: "p1" }, filter: { id: "f1" } }, libs);
  assert.deepEqual(items.map((i) => i.kind), ["filter", "pixelMap"]);
});

test("All four attached together: the audio branch comes last, and the media effect card uses the card name", () => {
  const clip = { id: "c1", start: 0, end: 1, pixelMap: { id: "p1" }, filter: { id: "f1" }, nodeId: "n1", audioFx: { id: "a1" } };
  const items = overlaysOfClip(projectWith(), clip, libs);
  assert.deepEqual(items.map((i) => i.kind), ["pixelMap", "filter", "card", "audioFx"]);
  assert.equal(items[2].name, "Vignette");
  assert.equal(items.every((i) => i.upstream === false), true);
});

test("If the definition in the library is gone, do not list it (a dangling reference must not blow up the timeline)", () => {
  const items = overlaysOfClip(projectWith({ filters: [] }), { id: "c1", start: 0, end: 1, filter: { id: "f1" } }, libs);
  assert.deepEqual(items, []);
});

test("Leave the summary empty when it cannot be computed; do not throw", () => {
  const project = projectWith({ filters: [{ id: "f1", name: "bad", ops: null }] });
  const items = overlaysOfClip(project, { id: "c1", start: 0, end: 1, filter: { id: "f1" } }, libs);
  assert.equal(items.length, 1);
  assert.equal(items[0].value, "");
});

test("Disabled ones are still listed, marked off: the manifest shows \"what is attached\", not \"what is in effect now\"", () => {
  const clip = { id: "c1", start: 0, end: 1, filter: { id: "f1", off: true }, audioFx: { id: "a1" } };
  const items = overlaysOfClip(projectWith(), clip, libs);
  assert.deepEqual(items.map((i) => [i.name, i.off]), [["Darken", true], ["Vocal clarity", false]]);
});

test("A media effect card cannot be toggled to disabled: it is a node in the node graph", () => {
  const items = overlaysOfClip(projectWith(), { id: "c1", start: 0, end: 1, nodeId: "n1" }, libs);
  assert.equal(items[0].canToggle, false);
  assert.equal(items[0].off, false);
});

test("Filters, pixel maps and audio effects can all be toggled to disabled", () => {
  const clip = { id: "c1", start: 0, end: 1, filter: { id: "f1" }, pixelMap: { id: "p1" }, audioFx: { id: "a1" } };
  const items = overlaysOfClip(projectWith(), clip, libs);
  assert.equal(items.every((i) => i.canToggle), true);
});

/* ------------------------------------------------------------------ 带 */

const chips = (names) => names.map((name) => ({ kind: "filter", refId: name, name, value: "", upstream: false, off: false, canToggle: true }));

test("If everything fits, show it all, with no +N", () => {
  const plan = planBand(chips(["Darken", "Key out green"]), 300);
  assert.equal(plan.shown.length, 2);
  assert.equal(plan.hidden, 0);
});

test("What does not fit collapses into +N, and the height does not grow with the count", () => {
  const plan = planBand(chips(["Darken", "blur", "Vignette"]), 200);
  assert.equal(plan.shown.length, 2);
  assert.equal(plan.hidden, 1);
});

test("When the selected one gets squeezed into +N, it is swapped into the last slot", () => {
  const items = chips(["Darken", "blur", "Vignette"]);
  const plan = planBand(items, 200, 2);
  assert.equal(plan.hidden, 1);
  assert.equal(plan.shown[plan.shown.length - 1].name, "Vignette");
});

test("When it is too narrow to fit even one, shown is empty and everything goes into +N", () => {
  const plan = planBand(chips(["Darken", "blur"]), 40);
  assert.equal(plan.shown.length, 0);
  assert.equal(plan.hidden, 2);
});

/* ------------------------------------------------------------------ 退化档次 */

test("Medium row height, wide enough: draw the band, write the duration, write the name", () => {
  const p = planClipLayout(300, "medium", 2);
  assert.deepEqual(
    { band: p.band, countOnly: p.countOnly, pill: p.pill, duration: p.duration, name: p.name },
    { band: true, countOnly: false, pill: false, duration: true, name: true },
  );
});

test("Narrow clip: the band is still drawn but holds only +N, and the body text does not show the duration", () => {
  const p = planClipLayout(NARROW_PX - 1, "medium", 1);
  assert.equal(p.band, true);
  assert.equal(p.countOnly, true);
  assert.equal(p.duration, false);
  assert.equal(p.name, true, "57px still fits \"Floor plan…\"");
});

test("At the narrowest tier even the name is not drawn, leaving only the +N in the band", () => {
  const p = planClipLayout(31, "medium", 1);
  assert.equal(p.countOnly, true);
  assert.equal(p.name, false);
});

test("Small row height draws no band, and +N goes after the name", () => {
  const p = planClipLayout(300, "small", 3);
  assert.equal(p.band, false);
  assert.equal(p.pill, true);
  assert.equal(p.name, true);
  assert.equal(BAND_H.small, 0);
});

test("Small row height + narrow clip: once the badge takes its space, the name is not drawn", () => {
  const p = planClipLayout(31, "small", 1);
  assert.equal(p.pill, true);
  assert.equal(p.name, false);
});

test("A clip with nothing attached still reserves the band slot at medium / large row heights", () => {
  const p = planClipLayout(300, "medium", 0);
  assert.equal(p.band, true);
  assert.equal(p.pill, false);
});

test("The width estimate grows as the name gets longer", () => {
  assert.ok(chipWidth("Darken") < chipWidth("Vocal clarity"));
  assert.ok(countWidth(9) < countWidth(10));
});
