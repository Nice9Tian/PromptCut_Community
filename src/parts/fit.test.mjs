/**
 * parts/fit.ts 的单测。跑:node --test src/parts/fit.test.mjs
 * 字号自适应是纯估算、无 DOM,所以能在 node 里钉住:同一份输入永远同一个字号,且不会超出框。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fitFontSize, fitOr, textUnits } from "./fit.ts";

test("character width: full-width counts 1, Latin 0.6, space 0.3", () => {
  assert.equal(textUnits("核心要点"), 4);
  assert.equal(textUnits("ABCD"), 2.4);
  assert.equal(Math.round(textUnits("A B") * 10) / 10, 1.5);
});

test("font size from the box: whichever of width and height hits the limit first wins; multiple lines divide by line count; clamped to the min and max", () => {
  // 单行 4 个汉字,900 宽 160 高:宽允许 900*0.92/4 = 207,高允许 160*0.78/1.25 = 99.8 → 100
  assert.equal(fitFontSize({ width: 900, height: 160, text: "核心要点" }), 100);
  // 很宽的框由高决定;很窄的框由宽决定
  assert.equal(fitFontSize({ width: 300, height: 400, text: "核心要点" }), 69);
  // 三行
  assert.equal(fitFontSize({ width: 900, height: 420, text: "a|b|c", splitter: "|" }), Math.round((420 * 0.78) / (3 * 1.25)));
  assert.equal(fitFontSize({ width: 10, height: 10, text: "x" }), 12, "lower limit");
  assert.equal(fitFontSize({ width: 9000, height: 9000, text: "x", max: 300 }), 300, "Ceiling");
  // 确定性
  assert.equal(fitFontSize({ width: 777, height: 333, text: "same input" }), fitFontSize({ width: 777, height: 333, text: "same input" }));
});

test("fitOr: a positive number is used as is, 0 / invalid values use auto-fit", () => {
  assert.equal(fitOr(48, { width: 900, height: 160, text: "x" }), 48);
  assert.equal(fitOr(0, { width: 900, height: 160, text: "核心要点" }), 100);
  assert.equal(fitOr("nope", { width: 900, height: 160, text: "核心要点" }), 100);
});
