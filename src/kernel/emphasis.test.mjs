// node --test src/kernel/emphasis.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { emphasisFilter, normalizeEmphasis, describeEmphasis, EMPHASIS_DEFAULTS } = await import("./emphasis.ts");

test("normalizeEmphasis: fills in defaults, clamps ranges, returns null for an unknown kind", () => {
  assert.equal(normalizeEmphasis(null), null);
  assert.equal(normalizeEmphasis({ kind: "glow" }), null);
  assert.deepEqual(normalizeEmphasis({ kind: "shadow" }), { kind: "shadow", ...EMPHASIS_DEFAULTS.shadow });
  const big = normalizeEmphasis({ kind: "outline", size: 999, opacity: 5, dx: -9999 });
  assert.equal(big.size, 80);
  assert.equal(big.opacity, 1);
  assert.equal(big.dx, -200);
  // Use default value if not a number, never calculates NaN
  assert.equal(normalizeEmphasis({ kind: "shadow", size: "Thick" }).size, EMPHASIS_DEFAULTS.shadow.size);
  assert.equal(normalizeEmphasis({ kind: "shadow", color: "   " }).color, "#000000");
});

test("Shadow: one drop-shadow, with both offset and blur written in", () => {
  const f = emphasisFilter({ kind: "shadow", color: "#000", size: 10, opacity: 1, dx: 0, dy: 4 });
  assert.equal(f, "drop-shadow(0px 4px 10px #000)");
});

test("Opacity is applied with color-mix, without parsing the color string itself", () => {
  const f = emphasisFilter({ kind: "shadow", color: "rgb(10 20 30)", size: 8, opacity: 0.5, dx: 0, dy: 0 });
  assert.match(f, /color-mix\(in srgb, rgb\(10 20 30\) 50%, transparent\)/);
});

test("Outline: eight directions around a circle, the line width is the radius; thick ones get a touch of blur to fill the gaps", () => {
  const thin = emphasisFilter({ kind: "outline", color: "#fff", size: 3, opacity: 1 });
  assert.equal(thin.match(/drop-shadow/g).length, 8);
  assert.match(thin, /drop-shadow\(3px 0px 0px #fff\)/); // Due right direction
  assert.equal(/0px 0px 0px/.test(thin.split(" drop-shadow")[0]), false);

  const thick = emphasisFilter({ kind: "outline", color: "#fff", size: 10, opacity: 1 });
  assert.equal(thick.match(/drop-shadow/g).length, 8);
  assert.match(thick, /drop-shadow\(10px 0px 2px #fff\)/); // Blur = 10 × 0.2
});

test("scale: the media layer scales the line width by its own ratio; it is not needed when the whole stage is scaled", () => {
  const a = emphasisFilter({ kind: "shadow", color: "#000", size: 10, opacity: 1, dx: 0, dy: 5 }, 2);
  assert.equal(a, "drop-shadow(0px 10px 20px #000)");
});

test("None / size 0 / fully transparent → empty string (an empty string means no filter is written, so the DOM of old projects is unchanged)", () => {
  assert.equal(emphasisFilter(null), "");
  assert.equal(emphasisFilter(undefined), "");
  assert.equal(emphasisFilter({ kind: "shadow", size: 0 }), "");
  assert.equal(emphasisFilter({ kind: "outline", opacity: 0 }), "");
});

test("describeEmphasis: the UI and the Agent echo the same sentence", () => {
  assert.equal(describeEmphasis(null), "无"); // i18n-allow: emphasis.ts is left untranslated (audio card closure)
  assert.match(describeEmphasis({ kind: "outline", size: 6, color: "#fff", opacity: 1 }), /描边 6px/); // i18n-allow: emphasis.ts is left untranslated
  assert.match(describeEmphasis({ kind: "shadow" }), /阴影 18px · 偏移 0,8/); // i18n-allow: emphasis.ts is left untranslated
});
