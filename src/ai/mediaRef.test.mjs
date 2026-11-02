/**
 * node --test src/ai/mediaRef.test.mjs
 *
 * 模型在卡片里引用素材库文件靠 cardUrl(/@media/<文件名>)。换算错了,卡片上那张图就是空的。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { mediaCardUrl, isImageMedia } = await import("./mediaRef.ts");

test("A blob: asset is replaced with /@media using the file name from its disk path", () => {
  assert.equal(mediaCardUrl({ url: "blob:http://127.0.0.1:5210/abc", path: "C:\\Users\\x\\Videos\\PromptCut\\media\\浅草 雷门.jpg" }),
    "/@media/" + encodeURIComponent("浅草 雷门.jpg"));
  assert.equal(mediaCardUrl({ url: "", path: "/home/x/out/media/a.mp4" }), "/@media/a.mp4");
});

test("A value that is already /@media or a URL is returned as is", () => {
  assert.equal(mediaCardUrl({ url: "/@media/b.png", path: "C:\\z\\other.png" }), "/@media/b.png");
  assert.equal(mediaCardUrl({ url: "https://images.example.com/p.jpg" }), "https://images.example.com/p.jpg");
});

test("A blob: URL with no path: returns empty rather than an unusable address", () => {
  assert.equal(mediaCardUrl({ url: "blob:x" }), "");
});

test("Images are recognized, including old jpgs wrongly registered as video", () => {
  assert.equal(isImageMedia({ kind: "image", name: "a" }), true);
  assert.equal(isImageMedia({ kind: "video", name: "food-wagyu.jpg" }), true);
  assert.equal(isImageMedia({ kind: "video", name: "a.mp4", path: "C:\\m\\a.mp4" }), false);
  assert.equal(isImageMedia({ kind: "audio", name: "a.mp3" }), false);
});
