/**
 * "Current" and "next clip" for video layers. Run: node --test src/kernel/videoLayers.test.mjs
 *
 * The preview double-buffered player (editor/preview/MediaLayers.tsx) fixes two <video> elements
 * per track: one holds the current clip, and one preloads the next clip and seeks to the start.
 * "Which clip is next" is what nextVideoLayerAfter answers. Pin down:
 *   - Search per track, returning only the clip closest to t for each track, strictly after t
 *     (the currently playing clip does not count);
 *   - Matches videoLayersAt criteria: skips hidden tracks, audio clips, card clips, and clips
 *     with missing media, in the same order;
 *   - In gaps (when this track has no video at this moment), the clip after the gap is still
 *     found: a gap is the ideal time to preload;
 *   - videoLayersAt includes trackId so preview can pair up "current clip" and "next clip"
 *     by track.
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
