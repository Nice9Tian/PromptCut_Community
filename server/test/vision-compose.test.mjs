// node --test server/test/vision-compose.test.mjs
// see_frames 的合成:卡片层只进页面、素材层由 ffmpeg 抽帧,这里验纯函数那部分。
import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { alphaOver, cardsOnly, composeFrame, extractArgs, mediaLayersAt, opacityAt } from "../vision-compose.mjs";

const project = {
  width: 1920, height: 1080, fps: 30, duration: 42.68,
  media: [
    { id: "m1", kind: "video", name: "a.mp4", url: "/@media/a.mp4" },
    { id: "m2", kind: "image", name: "b.jpg", url: "/@media/b.jpg" },
    { id: "m3", kind: "audio", name: "c.mp3", url: "/@media/c.mp3" },
  ],
  tracks: [
    { id: "t1", name: "Track 1", clips: [{ id: "c1", cardId: "punch-pill", start: 0, end: 5, params: {} }, { id: "v1", mediaId: "m1", start: 2.68, end: 42.68, mediaOffset: 1.5, params: {} }] },
    { id: "t2", name: "Track 2", clips: [{ id: "i1", mediaId: "m2", start: 10, end: 20, fadeIn: 2, params: {} }, { id: "a1", mediaId: "m3", start: 0, end: 40, params: {} }] },
    { id: "t3", name: "The hidden one", hidden: true, clips: [{ id: "v2", mediaId: "m1", start: 0, end: 40, params: {} }] },
  ],
};

test("cardsOnly: all media clips and the media list are removed, card clips are left as they are", () => {
  const p = cardsOnly(project);
  assert.deepEqual(p.media, []);
  assert.deepEqual(p.tracks.map((t) => t.clips.map((c) => c.id)), [["c1"], [], []]);
  // 原对象不动
  assert.equal(project.tracks[0].clips.length, 2);
});

test("mediaLayersAt: at second 12 there are two layers, video and image, ordered bottom to top; audio and hidden tracks do not count", () => {
  const layers = mediaLayersAt(project, 12);
  // 数组从下到上:最后一个盖在最上面。时间轴上靠上的序列在上层,所以序列 2 的图片在下、序列 1 的视频在上
  assert.deepEqual(layers.map((l) => l.media.id), ["m2", "m1"]);
  // 图片段 10 秒进、淡入 2 秒:第 12 秒刚好淡完
  assert.equal(layers[0].opacity, 1);
  // 视频段从素材第 1.5 秒起播,第 12 秒对应素材的 1.5 + (12 - 2.68)
  assert.ok(Math.abs(layers[1].mediaTime - (1.5 + 12 - 2.68)) < 1e-9);
  assert.equal(layers[1].opacity, 1);
  assert.equal(opacityAt(project.tracks[1].clips[0], 11), 0.5);
  assert.deepEqual(mediaLayersAt(project, 1).map((l) => l.media.id), [], "At second 1 there are only cards and no media layers");
});

test("extractArgs: video seeks with -ss, fills with cover, and adds blending only when semi-transparent; images carry no -ss", () => {
  const v = extractArgs({ file: "a.mp4", kind: "video", seconds: 10.82, width: 1920, height: 1080, opacity: 1, out: "o.png" });
  assert.ok(v.includes("-ss") && v[v.indexOf("-ss") + 1] === "10.820");
  assert.ok(v.indexOf("-ss") < v.indexOf("-i"), "-ss must come before -i for fast seeking");
  const vf = v[v.indexOf("-vf") + 1];
  assert.match(vf, /scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=rgba$/);
  const half = extractArgs({ file: "a.mp4", kind: "video", seconds: 1, width: 10, height: 10, opacity: 0.5, out: "o.png" });
  assert.match(half[half.indexOf("-vf") + 1], /colorchannelmixer=aa=0\.5000$/);
  const img = extractArgs({ file: "b.jpg", kind: "image", seconds: 3, width: 10, height: 10, opacity: 1, out: "o.png" });
  assert.ok(!img.includes("-ss"));
});

function solid(w, h, [r, g, b, a]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set([r, g, b, a], i << 2);
  return png;
}

test("alphaOver / composeFrame: cards sit on top of the media, transparent areas show the media through, and where there is no media it stays transparent", () => {
  const video = solid(4, 4, [0, 0, 255, 255]);
  const cards = solid(4, 4, [0, 0, 0, 0]);
  cards.data.set([255, 0, 0, 255], 0); // 左上角一个不透明红点
  cards.data.set([255, 0, 0, 128], 4); // 旁边一个半透明红点
  const out = composeFrame(4, 4, [video], cards);
  assert.deepEqual([...out.data.subarray(0, 4)], [255, 0, 0, 255], "The red dot covers the video");
  const mixed = [...out.data.subarray(4, 8)];
  assert.ok(mixed[0] > 120 && mixed[0] < 136 && mixed[2] > 120 && mixed[2] < 136 && mixed[3] === 255, `A semi-transparent red dot should blend with the blue background into purple: ${mixed}`);
  assert.deepEqual([...out.data.subarray(8, 12)], [0, 0, 255, 255], "Everywhere else is the video");

  const none = composeFrame(4, 4, [], cards);
  assert.equal(none.data[11], 0, "Where there is no media layer it stays transparent, leaving shrink to lay down the background color");
  // 两层素材:上面那层半透明,能看见下面那层
  const top = solid(4, 4, [255, 255, 255, 128]);
  const two = composeFrame(4, 4, [video, top], null);
  const px = [...two.data.subarray(8, 12)];
  assert.ok(px[0] > 120 && px[2] > 240 && px[3] === 255, `Semi-transparent white over blue: ${px}`);
  assert.equal(alphaOver(solid(2, 2, [1, 2, 3, 0]), solid(2, 2, [9, 9, 9, 0])).data[3], 0);
});
