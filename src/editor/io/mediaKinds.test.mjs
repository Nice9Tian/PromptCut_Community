import { test } from "node:test";
import assert from "node:assert/strict";

const { classifyFileDetailed } = await import("./mediaKinds.ts");

test("Accept when MIME type and extension agree", () => {
  assert.equal(classifyFileDetailed({ name: "a.jpg", type: "image/jpeg" }).kind, "image");
  assert.equal(classifyFileDetailed({ name: "a.mp3", type: "audio/mpeg" }).kind, "audio");
});

test("Accept by extension when MIME type is missing", () => {
  assert.equal(classifyFileDetailed({ name: "a.mkv", type: "application/octet-stream" }).kind, "video");
  assert.equal(classifyFileDetailed({ name: "a.jpg", type: "" }).kind, "image");
});

test("Reject with a tab suggestion on obvious conflict", () => {
  const result = classifyFileDetailed({ name: "a.jpg", type: "video/mp4" });
  assert.equal(result.kind, null);
  assert.equal(result.conflict, true);
  assert.match(result.reason, /Images/);
});

test("An unknown type is rejected instead of defaulting to video", () => {
  const result = classifyFileDetailed({ name: "a.bin", type: "application/octet-stream" });
  assert.equal(result.kind, null);
  assert.match(result.reason, /Cannot recognize the type of file/);
});
