import { test } from "node:test";
import assert from "node:assert/strict";

const { classifyFileDetailed } = await import("./mediaKinds.ts");

test("MIME 和扩展名一致时接受", () => {
  assert.equal(classifyFileDetailed({ name: "a.jpg", type: "image/jpeg" }).kind, "image");
  assert.equal(classifyFileDetailed({ name: "a.mp3", type: "audio/mpeg" }).kind, "audio");
});

test("MIME 缺失时按扩展名接受", () => {
  assert.equal(classifyFileDetailed({ name: "a.mkv", type: "application/octet-stream" }).kind, "video");
  assert.equal(classifyFileDetailed({ name: "a.jpg", type: "" }).kind, "image");
});

test("明显冲突时拒绝并给出分页建议", () => {
  const result = classifyFileDetailed({ name: "a.jpg", type: "video/mp4" });
  assert.equal(result.kind, null);
  assert.equal(result.conflict, true);
  assert.match(result.reason, /图片/);
});

test("未知类型拒绝而不是默认成视频", () => {
  const result = classifyFileDetailed({ name: "a.bin", type: "application/octet-stream" });
  assert.equal(result.kind, null);
  assert.match(result.reason, /无法识别/);
});
