/**
 * kernel/audioPlan.mjs:导出混音、测响度共用的「谁在什么时候出声」清单。
 * 跑:node --test src/kernel/audioPlan.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { audioPlanOf, soundingAt } from "./audioPlan.mjs";

const project = {
  media: [
    { id: "v", kind: "video", url: "/@media/v.mp4" },
    { id: "a", kind: "audio", url: "/@media/a.m4a" },
    { id: "i", kind: "image", url: "/@media/i.jpg" },
    { id: "gone", kind: "audio", url: "" },
  ],
  audioFx: [{ id: "afx1", name: "g", ops: [{ kind: "gain", db: -12 }] }],
  tracks: [
    { id: "t1", clips: [
      { id: "c1", mediaId: "v", start: 0, end: 5, mediaOffset: 2, opacity: 0.5, audioVolume: 0.5, fadeIn: 1, audioFx: { id: "afx1", params: {} } },
      { id: "c2", mediaId: "v", start: 5, end: 8, audioMuted: true },
      { id: "c3", mediaId: "i", start: 8, end: 9 },
      { id: "c4", mediaId: "gone", start: 9, end: 10 },
      { id: "c5", mediaId: "a", start: 4, end: 6, audioFx: { id: "nope" } },
    ] },
    { id: "t2", muted: true, clips: [{ id: "m1", mediaId: "a", start: 0, end: 3 }] },
    { id: "t3", hidden: true, clips: [{ id: "h1", mediaId: "a", start: 0, end: 3 }] },
    { id: "t4", clips: [{ id: "k1", cardId: "x", start: 0, end: 3 }, { id: "z1", mediaId: "a", start: 3, end: 3 }] },
  ],
};

test("静音 / 隐藏的序列、audioMuted、图片、没地址的素材、卡片、零时长都不出声;音量 = opacity × audioVolume;效果带定义", () => {
  const plan = audioPlanOf(project);
  assert.deepEqual(plan.map((p) => p.clipId), ["c1", "c5"]);
  const c1 = plan[0];
  assert.equal(c1.volume, 0.25);
  assert.equal(c1.offset, 2);
  assert.equal(c1.fadeIn, 1);
  assert.equal(c1.fx.def.id, "afx1");
  assert.equal(plan[1].fx, null, "找不到定义的效果按没挂算");
});

test("soundingAt:某一秒谁在出声", () => {
  const plan = audioPlanOf(project);
  assert.deepEqual(soundingAt(plan, 4.5), ["c1", "c5"]);
  assert.deepEqual(soundingAt(plan, 5), ["c5"]);
  assert.deepEqual(soundingAt(plan, 7), []);
});

test("合成 WAV 的起点、时长和裁切偏移保留采样精度，切分不重启第一事件", () => {
  const sample = 1 / 48000;
  const start = 17 * sample, split = start + 2537 * sample;
  const p = {
    media: [{ id: "s", kind: "audio", url: "/@media/s.wav", soundEffect: { reuseKey: "r" } }],
    tracks: [{ id: "t", clips: [
      { id: "left", mediaId: "s", start, end: split, mediaOffset: 31 * sample },
      { id: "right", mediaId: "s", start: split, end: split + sample, mediaOffset: (31 + 2537) * sample },
    ] }],
  };
  const [a, b] = audioPlanOf(p);
  assert.equal(a.start, start);
  assert.equal(a.dur, split - start);
  assert.equal(b.offset, 2568 * sample);
  assert.ok(Math.abs((b.offset - a.offset - a.dur) * 48000) < 1e-9);
  assert.ok(Math.abs(b.dur * 48000 - 1) < 1e-9, "单个采样长度的片段不能被毫秒舍入丢掉");
});

test("被引用的合成素材缺失时明确失败，静音和隐藏序列仍不请求声音", () => {
  const p = { media: [], tracks: [{ id: "t", clips: [{ id: "lost", mediaId: "gone", soundEffect: { reuseKey: "r" }, start: 0, end: 1 }] }] };
  assert.throws(() => audioPlanOf(p), /lost.*合成音效素材缺失/);
  assert.deepEqual(audioPlanOf({ ...p, tracks: [{ ...p.tracks[0], muted: true }] }), []);
  assert.deepEqual(audioPlanOf({ ...p, tracks: [{ ...p.tracks[0], hidden: true }] }), []);
  assert.deepEqual(audioPlanOf({ ...p, tracks: [{ ...p.tracks[0], clips: [{ ...p.tracks[0].clips[0], audioMuted: true }] }] }), []);
  assert.throws(() => audioPlanOf({ ...p, media: [{ id: "gone", kind: "audio", url: "", soundEffect: {} }] }), /素材缺失/);
});

// 导出的淡入淡出包络:和 ffmpeg 两条 afade(线性)相乘一样。重叠、比片段还长这两种以前会出错
import { fadeEnvelope } from "./audioPlan.mjs";
test("fadeEnvelope:两条线性淡化相乘;重叠时是三角形,淡入比片段长时终点只到 dur/fadeIn", () => {
  const at = (env, dur, t) => env[Math.round((t / dur) * (env.length - 1))];
  const plain = fadeEnvelope(0.5, 1, 1, 4, 401);
  assert.equal(at(plain, 4, 0), 0);
  assert.ok(Math.abs(at(plain, 4, 0.5) - 0.25) < 1e-6);
  assert.ok(Math.abs(at(plain, 4, 2) - 0.5) < 1e-6);
  assert.equal(at(plain, 4, 4), 0);
  // fadeIn + fadeOut > dur:峰值在中点 = (1/1.5)*(1/1.5)... 这里 dur 2、各 1.5:t=1 时 (1/1.5)×(1/1.5)=0.444
  const overlap = fadeEnvelope(1, 1.5, 1.5, 2, 201);
  assert.ok(Math.abs(at(overlap, 2, 1) - 4 / 9) < 1e-6);
  assert.ok(at(overlap, 2, 0.5) > 0 && at(overlap, 2, 0.5) < at(overlap, 2, 1), "不能有从 0 硬跳到满音量的台阶");
  // fadeIn 比片段还长:末尾只升到 dur/fadeIn
  const longIn = fadeEnvelope(1, 4, 0, 2, 201);
  assert.ok(Math.abs(at(longIn, 2, 2) - 0.5) < 1e-6);
  assert.equal(fadeEnvelope(1, 0, 0, 3, 5).every((v) => v === 1), true);
});
