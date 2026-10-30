// 草稿 id 直接当文件名用,这道校验是唯一挡住路径穿越的东西。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidDraftId } from "../vite-plugin-projects.ts";

test("正常的 id 放行", () => {
  for (const id of ["20260907-a1b2c3", "abc", "A_b-C9", "x".repeat(64)]) {
    assert.equal(isValidDraftId(id), true, id);
  }
});

test("路径穿越一律拦下", () => {
  for (const id of [
    "..",
    "../x",
    "../../etc/passwd",
    "a/b",
    "a\\b",
    "C:/x",
    "/abs",
    ".",
    "a/../../b",
  ]) {
    assert.equal(isValidDraftId(id), false, `应该拦下:${id}`);
  }
});

test("空的、超长的、带奇怪字符的都拦下", () => {
  for (const id of ["", "x".repeat(65), "a b", "a.proc", "名字", "a\0b", "a%2e%2e", "a:b", "a*b"]) {
    assert.equal(isValidDraftId(id), false, `应该拦下:${JSON.stringify(id)}`);
  }
});
