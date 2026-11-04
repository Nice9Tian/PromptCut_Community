/**
 * Unit test for font fingerprint (I0, landed in step 2 of A3a). Run:
 *   node --test src/render/fontFingerprint.test.mjs
 *
 * This value enters the shared snapshot key. An error here throws no exception, but causes two
 * machines with different fonts to reuse each other's snapshots (replacing all characters and
 * breaking layout completely), or conversely makes the same machine generate a new key each time
 * a project opens so the shared tier never hits. Therefore, three properties are pinned: only
 * recognize loaded fonts, compute each family only once, and stay independent of iteration order.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { fontFamilyNames, fontFingerprintOf } from "./fontFingerprint.ts";

/** FontFaceSet is an iterable collection of FontFace; only family and status fields are used here. */
const set = (...faces) => faces.map(([family, status = "loaded"]) => ({ family, status }));

test("only take loaded families: an @font-face that is declared but not downloaded does not affect this frame's layout", () => {
  assert.deepEqual(fontFamilyNames(set(["Inter"], ["Noto Sans CJK SC", "unloaded"], ["Fira Code", "loading"])), ["Inter"]);
  // None loaded: an empty list, not "uncomputed".
  assert.deepEqual(fontFamilyNames(set(["Inter", "unloaded"])), []);
  assert.deepEqual(fontFamilyNames([]), []);
  assert.deepEqual(fontFamilyNames(null), []);
  assert.deepEqual(fontFamilyNames(undefined), []);
});

test("multiple weights / glyph styles of one family count once, empty names do not count", () => {
  // 400 / 700 / italic for one family are three FontFaces, but typography resolves to the same family.
  assert.deepEqual(fontFamilyNames(set(["Inter"], ["Inter"], ["Inter"])), ["Inter"]);
  assert.deepEqual(fontFamilyNames(set(["Inter"], ["  Inter  "])), ["Inter"], "leading and trailing whitespace is not a different family");
  assert.deepEqual(fontFamilyNames(set(["", "loaded"], ["   "], ["Inter"])), ["Inter"]);
});

test("independent of FontFaceSet iteration order: order depends on load timing, and without sorting two machines would get different keys", () => {
  const a = fontFingerprintOf(set(["Inter"], ["Noto Sans CJK SC"], ["Fira Code"]));
  const b = fontFingerprintOf(set(["Fira Code"], ["Inter"], ["Noto Sans CJK SC"]));
  assert.equal(a, b);
  assert.deepEqual(fontFamilyNames(set(["Fira Code"], ["Inter"])), ["Fira Code", "Inter"], "the output itself is sorted");
});

test("the fingerprint changes when the font set changes; a machine missing fonts and a fully installed machine do not share snapshots", () => {
  const full = fontFingerprintOf(set(["Inter"], ["Noto Sans CJK SC"]));
  const missingCjk = fontFingerprintOf(set(["Inter"]));
  assert.notEqual(full, missingCjk);
  // An extra family also counts as a change.
  assert.notEqual(full, fontFingerprintOf(set(["Inter"], ["Noto Sans CJK SC"], ["Fira Code"])));
  // "No fonts at all" is a deterministic value, not an empty string: "no fonts" and "uncomputed"
  // must be distinguishable.
  const empty = fontFingerprintOf([]);
  assert.match(empty, /^[0-9a-f]{16}$/);
  assert.equal(empty, fontFingerprintOf(null));
  assert.notEqual(empty, "");
  assert.notEqual(empty, full);
});

test("the same input always gives the same value (pure function, reproducible across processes and machines)", () => {
  const fonts = set(["Inter"], ["Noto Sans CJK SC"]);
  assert.equal(fontFingerprintOf(fonts), fontFingerprintOf(fonts));
  assert.match(fontFingerprintOf(fonts), /^[0-9a-f]{16}$/);
  // Does not simply concatenate names: delimiters in family names will not cause key collisions.
  assert.notEqual(fontFingerprintOf(set(["A\nB"])), fontFingerprintOf(set(["A"], ["B"])));
});
