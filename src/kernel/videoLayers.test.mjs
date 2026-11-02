/**
 * 画面层的「现在」和「下一段」。跑:node --test src/kernel/videoLayers.test.mjs
 *
 * 预览的双缓冲播放器(editor/preview/MediaLayers.tsx)每条序列固定两个 <video>:一个放当前段,
 * 一个提前装好下一段、seek 到起点。「下一段是谁」就是 nextVideoLayerAfter 回答的。钉死:
 *   - 按序列分开找,每条序列只给离 t 最近的那一段,而且严格在 t 之后(正在播的那段不算);
 *   - 口径和 videoLayersAt 一致:跳过隐藏序列、音频段、卡片段、找不到素材的段,顺序也一样;
 *   - 空档里(这一刻这条序列没有画面)照样能找到空档后面那段 —— 空档正是提前装好的好时机;
 *   - videoLayersAt 带上 trackId,预览才能按序列把「当前段」和「下一段」配成一对。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { nextVideoLayerAfter, videoLayersAt } from "./project.ts";

const media = [
  { id: "a", kind: "video", name: "a.mp4", url: "/@media/a.mp4" },
  { id: "b", kind: "video", name: "b.mp4", url: "/@media/b.mp4" },
  { id: "img", kind: "image", name: "p.jpg", url: "/@media/p.jpg" },
  { id: "snd", kind: "audio", name: "m.mp3", url: "/@media/m.mp3" },
];
const clip = (id, mediaId, start, end, extra = {}) => ({ id, mediaId, start, end, mediaOffset: 0, ...extra });
const proj = (tracks) => ({ version: 1, name: "t", width: 1920, height: 1080, fps: 30, duration: 60, themeId: "midnight", media, tracks });

const oneTrack = proj([
  { id: "v", name: "Video", clips: [clip("c1", "a", 0, 3), clip("c2", "a", 3, 5, { mediaOffset: 40 }), clip("c3", "b", 8, 10)] },
]);

test("In the middle of a clip: the next clip is the one right after it, carrying the asset and track id", () => {
  const n = nextVideoLayerAfter(oneTrack, 1.2);
  assert.equal(n.length, 1);
  assert.equal(n[0].clip.id, "c2");
  assert.equal(n[0].media.id, "a");
  assert.equal(n[0].trackId, "v");
});

test("Exactly at the start of a clip: this clip is \"now\", not \"the next one\"", () => {
  assert.equal(nextVideoLayerAfter(oneTrack, 3).map((l) => l.clip.id).join(), "c3");
});

test("In a gap, the clip after the gap can still be found", () => {
  assert.equal(nextVideoLayerAfter(oneTrack, 6.5)[0].clip.id, "c3");
});

test("After the last clip: this track has no next clip, so no entry is produced", () => {
  assert.deepEqual(nextVideoLayerAfter(oneTrack, 9), []);
});

test("Skip audio clips, card clips, hidden tracks, and clips whose asset cannot be found; image clips count as picture", () => {
  const p = proj([
    { id: "top", name: "Upper", hidden: true, clips: [clip("h", "a", 2, 3)] },
    {
      id: "mix", name: "Mix", clips: [
        clip("s", "snd", 1, 2),
        { id: "card", cardId: "x", start: 2, end: 3, params: {} },
        clip("gone", "nope", 3, 4),
        clip("pic", "img", 4, 5),
      ],
    },
  ]);
  const n = nextVideoLayerAfter(p, 0);
  assert.equal(n.length, 1);
  assert.equal(n[0].clip.id, "pic");
});

test("Multiple tracks: each gives one clip, in the same order as videoLayersAt (the last one = the top layer)", () => {
  const p = proj([
    { id: "upper", name: "Upper", clips: [clip("u1", "b", 0, 2), clip("u2", "b", 4, 6)] },
    { id: "lower", name: "Lower", clips: [clip("l1", "a", 0, 5), clip("l2", "a", 5, 9)] },
  ]);
  assert.deepEqual(nextVideoLayerAfter(p, 1).map((l) => l.trackId), ["lower", "upper"]);
  assert.deepEqual(videoLayersAt(p, 1).map((l) => l.trackId), ["lower", "upper"]);
  assert.deepEqual(nextVideoLayerAfter(p, 1).map((l) => l.clip.id), ["l2", "u2"]);
});

test("A next clip that fades in at its start (starting opacity 0) still counts: it is exactly the one that must be loaded in advance", () => {
  const p = proj([{ id: "v", name: "v", clips: [clip("c1", "a", 0, 2), clip("c2", "b", 2, 4, { fadeIn: 1 })] }]);
  assert.equal(nextVideoLayerAfter(p, 1)[0].clip.id, "c2");
});

test("The clip array is searched correctly even when not sorted by start (defensive: old files that are read in may not be sorted)", () => {
  const p = proj([{ id: "v", name: "v", clips: [clip("late", "a", 9, 10), clip("soon", "b", 4, 5)] }]);
  assert.equal(nextVideoLayerAfter(p, 1)[0].clip.id, "soon");
});
