import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { findMissingMaterialFontFile } from "./export.mjs";

test("confirmed-missing 中文代理只从 Windows Fonts 可信候选解析", () => {
  const expected = path.join("C:/Windows", "Fonts", "msyh.ttc");
  const result = findMissingMaterialFontFile({
    platform: "win32",
    windir: "C:/Windows",
    exists: (candidate) => candidate === expected,
  });
  assert.equal(result, expected);
});

test("confirmed-missing 中文代理优先用已部署的 Noto Sans CJK", () => {
  const expected = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
  assert.equal(findMissingMaterialFontFile({
    platform: "linux",
    exists: (candidate) => candidate === expected,
  }), expected);
});

test("没有可用平台中文字体时报资源错误", () => {
  assert.throws(() => findMissingMaterialFontFile({ platform: "linux", exists: () => false }), /需要中文代理字体/);
});

