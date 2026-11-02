import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { findMissingMaterialFontFile } from "./export.mjs";

test("confirmed-missing Chinese proxy resolves only from trusted Windows Fonts candidates", () => {
  const expected = path.join("C:/Windows", "Fonts", "msyh.ttc");
  const result = findMissingMaterialFontFile({
    platform: "win32",
    windir: "C:/Windows",
    exists: (candidate) => candidate === expected,
  });
  assert.equal(result, expected);
});

test("confirmed-missing Chinese proxy prefers the deployed Noto Sans CJK", () => {
  const expected = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
  assert.equal(findMissingMaterialFontFile({
    platform: "linux",
    exists: (candidate) => candidate === expected,
  }), expected);
});

test("reports a resource error when no usable platform Chinese font exists", () => {
  assert.throws(() => findMissingMaterialFontFile({ platform: "linux", exists: () => false }), /requires a Chinese proxy font/);
});

