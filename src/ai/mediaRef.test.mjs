/**
 * node --test src/ai/mediaRef.test.mjs
 *
 * 模型在卡片里引用素材库文件靠 cardUrl(/@media/<文件名>)。换算错了,卡片上那张图就是空的。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { mediaCardUrl, isImageMedia } = await import("./mediaRef.ts");

test("blob: 素材按磁盘路径的文件名换成 /@media", () => {
  assert.equal(mediaCardUrl({ url: "blob:http://127.0.0.1:5210/abc", path: "C:\\Users\\x\\Videos\\PromptCut\\media\\浅草 雷门.jpg" }),
    "/@media/" + encodeURIComponent("浅草 雷门.jpg"));
  assert.equal(mediaCardUrl({ url: "", path: "/home/x/out/media/a.mp4" }), "/@media/a.mp4");
});

test("本来就是 /@media 或网址的原样给", () => {
  assert.equal(mediaCardUrl({ url: "/@media/b.png", path: "C:\\z\\other.png" }), "/@media/b.png");
  assert.equal(mediaCardUrl({ url: "https://images.example.com/p.jpg" }), "https://images.example.com/p.jpg");
});

test("既是 blob: 又没有 path:给空,不给一个用不了的地址", () => {
  assert.equal(mediaCardUrl({ url: "blob:x" }), "");
});

test("图片认得出来,包括被错登记成 video 的老 jpg", () => {
  assert.equal(isImageMedia({ kind: "image", name: "a" }), true);
  assert.equal(isImageMedia({ kind: "video", name: "food-wagyu.jpg" }), true);
  assert.equal(isImageMedia({ kind: "video", name: "a.mp4", path: "C:\\m\\a.mp4" }), false);
  assert.equal(isImageMedia({ kind: "audio", name: "a.mp3" }), false);
});
