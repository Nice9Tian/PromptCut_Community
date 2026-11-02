/**
 * Unit tests for parts/fit.ts. Run: node --test src/parts/fit.test.mjs
 * Font size auto-fitting is purely estimated with no DOM, so it can be pinned in node: identical
 * input always produces the identical font size, and will not overflow the box.
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
  // Single line of 4 Chinese characters, 900 wide 160 high: width allows 900*0.92/4 = 207, height allows 160*0.78/1.25 = 99.8 → 100
  assert.equal(fitFontSize({ width: 900, height: 160, text: "核心要点" }), 100);
  // Very wide boxes are determined by height; very narrow boxes are determined by width
  assert.equal(fitFontSize({ width: 300, height: 400, text: "核心要点" }), 69);
  // Three lines
  assert.equal(fitFontSize({ width: 900, height: 420, text: "a|b|c", splitter: "|" }), Math.round((420 * 0.78) / (3 * 1.25)));
  assert.equal(fitFontSize({ width: 10, height: 10, text: "x" }), 12, "lower limit");
  assert.equal(fitFontSize({ width: 9000, height: 9000, text: "x", max: 300 }), 300, "Ceiling");
  // Determinism
  assert.equal(fitFontSize({ width: 777, height: 333, text: "same input" }), fitFontSize({ width: 777, height: 333, text: "same input" }));
});

test("fitOr: a positive number is used as is, 0 / invalid values use auto-fit", () => {
  assert.equal(fitOr(48, { width: 900, height: 160, text: "x" }), 48);
  assert.equal(fitOr(0, { width: 900, height: 160, text: "核心要点" }), 100);
  assert.equal(fitOr("nope", { width: 900, height: 160, text: "核心要点" }), 100);
});
