// node --test src/kernel/soundAsset.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { soundAssetFrom, findSoundAsset, opacityAt } = await import("./project.ts");

const video = {
  id: "m1", kind: "video", name: "访谈原片.mp4", url: "/media/a.mp4", path: "C:/x/a.mp4",
  duration: 12.5, width: 1920, height: 1080,
  transcript: { engine: "faster-whisper", model: "small", segments: [{ start: 0, end: 1, text: "喂" }] },
};

test("soundAssetFrom:同一个文件、去掉扩展名加「· 声音」,画幅不带过去", () => {
  const s = soundAssetFrom(video, "m2");
  assert.equal(s.kind, "audio");
  assert.equal(s.name, "访谈原片 · 声音");
  assert.equal(s.url, video.url);
  assert.equal(s.path, video.path);
  assert.equal(s.duration, 12.5);
  assert.equal(s.soundOf, "m1");
  // 声音没有画幅:带着 width/height 会让「以视频比例作为项目比例」之类的地方误判
  assert.equal(s.width, undefined);
  assert.equal(s.height, undefined);
  // 转写是同一条音轨的,直接继承
  assert.equal(s.transcript.segments.length, 1);
});

test("soundAssetFrom:没有 path / duration / 转写的素材不会凭空多出这些键", () => {
  const s = soundAssetFrom({ id: "m9", kind: "video", name: "无扩展名", url: "blob:x" }, "m10");
  assert.equal(s.name, "无扩展名 · 声音");
  assert.equal("path" in s, false);
  assert.equal("duration" in s, false);
  assert.equal("transcript" in s, false);
});

test("findSoundAsset:派生过就找得到,幂等的依据", () => {
  const p = { media: [video, soundAssetFrom(video, "m2"), { id: "m3", kind: "audio", name: "bgm", url: "" }] };
  assert.equal(findSoundAsset(p, "m1").id, "m2");
  assert.equal(findSoundAsset(p, "没这段"), undefined);
  // 自带的音频素材不是谁派生的,别把它认成某段视频的声音
  assert.equal(findSoundAsset(p, "m3"), undefined);
});

test("opacityAt:声音段拿它当音量 —— 淡入淡出区间内按比例,区间外是满的", () => {
  const clip = { id: "c1", start: 10, end: 20, params: {}, cardId: "", fadeIn: 2, fadeOut: 4 };
  assert.equal(opacityAt(clip, 10), 0);
  assert.equal(opacityAt(clip, 11), 0.5);
  assert.equal(opacityAt(clip, 12), 1);
  assert.equal(opacityAt(clip, 15), 1);
  assert.equal(opacityAt(clip, 18), 0.5);
  assert.equal(opacityAt(clip, 20), 0); // 区间外
  // opacity 是总音量,和淡化相乘
  assert.equal(opacityAt({ ...clip, opacity: 0.5 }, 11), 0.25);
});
