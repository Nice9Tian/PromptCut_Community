import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildAudioPlan, buildFfmpegArgs, isCardAudioNode, MISSING_MATERIAL_WAV, playableAudioPlan } from "./mux-audio.mjs";

test("generated-only and video-backed card audio replace source entries without timing quantization", () => {
  const project = {
    media: [{ id: "audio", kind: "audio", url: "/@media/a.wav" }, { id: "video", kind: "video", url: "/@media/v.mp4" }],
    cardNodes: [{ id: "n1", adapter: "card", cardId: "beep", kind: "audio" }, { id: "n2", adapter: "card", cardId: "beep", kind: "audio" }, { id: "n3", adapter: "card", cardId: "blur", kind: "filter" }],
    tracks: [{ id: "t", clips: [
      { id: "generated-only", cardId: "", nodeId: "n1", start: 0.0001234, end: 1.2345678 },
      { id: "video-backed", cardId: "", nodeId: "n2", mediaId: "video", start: 2.0001234, end: 3.2345678 },
      { id: "ordinary", cardId: "", mediaId: "audio", start: 4, end: 5 },
    ] }],
  };
  const plan = buildAudioPlan(project, ".", () => true, (media) => media && `/disk/${media.id}`);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.filter(x => x.cardAudio).map(x => x.clipId), ["generated-only", "video-backed"]);
  assert.equal(plan.find(x => x.clipId === "generated-only").start, 0.0001234);
  assert.ok(Math.abs(plan.find(x => x.clipId === "generated-only").dur - 1.2344444) < 1e-12);
  assert.equal(plan.find(x => x.clipId === "video-backed").file, undefined, "video source must not double-play beside its generated node");
  assert.equal(plan.find(x => x.clipId === "ordinary").file, "/disk/audio");
  assert.throws(() => buildFfmpegArgs("video.mp4", plan, "out.mp4", 5), /cannot render card audio/);
  // 只看节点:Node 侧读不到 TSX 定义,kind 是 H2 从定义抄进节点的那一份
  assert.equal(isCardAudioNode(project, "n1"), true);
  assert.equal(isCardAudioNode(project, "n3"), false, "kind 不是 audio 的素材效果卡节点不出声");
  assert.equal(isCardAudioNode(project, undefined), false);
});

test("持久化合成 WAV 保留采样定位，缺文件或无音轨必须报错", () => {
  const clip = { id: "sound", mediaId: "s", start: 17 / 48000, end: 48017 / 48000, mediaOffset: 7 / 48000 };
  const project = {
    media: [{ id: "s", kind: "audio", url: "/@media/s.wav", soundEffect: { reuseKey: "r" } }],
    tracks: [{ id: "t", clips: [clip] }],
  };
  const source = () => "/disk/s.wav";
  assert.throws(() => buildAudioPlan(project, ".", () => false, source), /合成音效文件缺失/);
  assert.throws(() => buildAudioPlan(project, ".", () => true, () => null), /合成音效文件缺失/);
  const plan = buildAudioPlan(project, ".", () => true, source);
  assert.equal(plan.length, 1, "只播普通素材一次，不加入素材效果卡音频");
  assert.equal(plan[0].soundEffect, true);
  assert.equal(plan[0].start, clip.start);
  assert.equal(plan[0].offset, clip.mediaOffset);
  assert.throws(() => playableAudioPlan(plan, "ffprobe", () => false), /合成音效无法读取音轨/);
  assert.deepEqual(playableAudioPlan(plan, "ffprobe", () => true), plan);
  assert.deepEqual(playableAudioPlan([{ file: "/silent-video.mp4" }], "ffprobe", () => false), []);
  const args = buildFfmpegArgs("v.mp4", plan, "out.mp4", 2);
  assert.match(args[args.indexOf("-filter_complex") + 1], /aresample=48000,adelay=17S:all=1/);
});

test("只有匹配的 confirmed-missing 音频使用软件内固定 WAV 且从片段起点播放", () => {
  const project = {
    media: [{ id: "gone", kind: "audio", name: "旁白.wav", url: "/@media/original", missingMaterial: {
      v: 1, mediaId: "gone", original: { kind: "audio", name: "旁白.wav", url: "/@media/original" }, reason: "confirmed-missing", visual: false, audio: true,
    } }],
    tracks: [{ id: "audio", clips: [{ id: "lost-clip", mediaId: "gone", start: 4, end: 8, mediaOffset: 53, audioVolume: .4, fadeIn: .2, fadeOut: .3 }] }],
  };
  const plan = buildAudioPlan(project, ".", (file) => file.endsWith("missing-material.wav"), () => { throw new Error("must not resolve original media"); });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].missingMaterial, true);
  assert.equal(plan[0].offset, 0);
  assert.equal(plan[0].start, 4);
  assert.equal(plan[0].dur, 4);
  assert.equal(plan[0].volume, .4);
  assert.equal(plan[0].fadeIn, .2);
  assert.equal(plan[0].fadeOut, .3);
  assert.match(plan[0].file, /src[\\/]audio[\\/]assets[\\/]missing-material\.wav$/);
  assert.ok(requireFileExists(plan[0].file));
});

test("分离的声音引用已确认缺失视频的音轨时仍只计划固定占位人声", () => {
  const project = {
    media: [
      { id: "video", kind: "video", name: "scene.mp4", url: "/@media/scene", missingMaterial: {
        v: 1, mediaId: "video", original: { kind: "video", name: "scene.mp4", url: "/@media/scene" }, reason: "confirmed-missing", visual: true, audio: true,
      } },
      { id: "sound", kind: "audio", name: "scene · 声音", url: "/@media/scene", soundOf: "video" },
    ],
    tracks: [{ id: "audio", clips: [{ id: "separated", mediaId: "sound", start: 2, end: 4, mediaOffset: 19 }] }],
  };
  const plan = buildAudioPlan(project, ".", (file) => file.endsWith("missing-material.wav"), () => { throw new Error("must not resolve the source video"); });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].missingMaterial, true);
  assert.equal(plan[0].offset, 0);
  assert.equal(plan[0].file, MISSING_MATERIAL_WAV);
});

function requireFileExists(file) { return fs.existsSync(file); }
