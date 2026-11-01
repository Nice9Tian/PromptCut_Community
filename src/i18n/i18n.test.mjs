import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LOCALES, getLocale, matchLocale, tr, translate } from "./index.ts";

const table = JSON.parse(fs.readFileSync(new URL("./table.json", import.meta.url), "utf8"));
const holes = (s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(",");

test("matchLocale: Chinese variants, Japanese and English, nothing else", () => {
  assert.equal(matchLocale("zh-TW"), "zh-CN");
  assert.equal(matchLocale("ZH"), "zh-CN");
  assert.equal(matchLocale("ja-JP"), "ja");
  assert.equal(matchLocale("en-GB"), "en");
  assert.equal(matchLocale("fr"), null);
});

test("outside a page the language is English and text passes through", () => {
  assert.equal(getLocale(), "en");
  assert.equal(tr("Not in the table"), "Not in the table");
  assert.equal(tr("Failed: {0}, {1}", "x", 2), "Failed: x, 2");
});

test("translate: a missing row and an empty cell both fall back to English", () => {
  assert.equal(translate("ja", "Not in the table"), "Not in the table");
  assert.equal(translate("zh-CN", "constructor"), "constructor");
});

test("translate: a hole with no argument stays visible", () => {
  assert.equal(translate("en", "{0} and {1}", ["a"]), "a and {1}");
});

test("every language in the menu names itself", () => {
  assert.deepEqual(LOCALES.map((l) => l.id), ["en", "zh-CN", "ja"]);
});

test("table: every row has Chinese and Japanese with the same placeholders as the English", () => {
  for (const [en, row] of Object.entries(table)) {
    assert.ok(row.zh, `no Chinese for: ${en}`);
    assert.ok(row.ja, `no Japanese for: ${en}`);
    assert.equal(holes(row.zh), holes(en), `Chinese placeholders differ: ${en}`);
    assert.equal(holes(row.ja), holes(en), `Japanese placeholders differ: ${en}`);
  }
});
