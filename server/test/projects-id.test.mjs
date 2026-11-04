// Draft id is used directly as file name; this validation is the only thing preventing path traversal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidDraftId } from "../vite-plugin-projects.ts";

test("valid ids pass", () => {
  for (const id of ["20260907-a1b2c3", "abc", "A_b-C9", "x".repeat(64)]) {
    assert.equal(isValidDraftId(id), true, id);
  }
});

test("path traversal is always blocked", () => {
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
    assert.equal(isValidDraftId(id), false, `should be blocked: ${id}`);
  }
});

test("empty ids, overly long ids and ids with odd characters are all blocked", () => {
  for (const id of ["", "x".repeat(65), "a b", "a.proc", "名字", "a\0b", "a%2e%2e", "a:b", "a*b"]) {
    assert.equal(isValidDraftId(id), false, `should be blocked: ${JSON.stringify(id)}`);
  }
});
