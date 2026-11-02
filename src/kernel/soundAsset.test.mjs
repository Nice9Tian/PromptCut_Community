// node --test src/kernel/soundAsset.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { soundAssetFrom, findSoundAsset, opacityAt } = await import("./project.ts");

const video = {
  id: "m1", kind: "video", name: "Interview original.mp4", url: "/media/a.mp4", path: "C:/x/a.mp4",
  duration: 12.5, width: 1920, height: 1080,
  transcript: { engine: "faster-whisper", model: "small", segments: [{ start: 0, end: 1, text: "Hello" }] },
};

test("soundAssetFrom: same file, extension removed and \"· Sound\" added, aspect ratio not carried over", () => {
  const s = soundAssetFrom(video, "m2");
  assert.equal(s.kind, "audio");
  assert.equal(s.name, "Interview original · Audio");
  assert.equal(s.url, video.url);
  assert.equal(s.path, video.path);
  assert.equal(s.duration, 12.5);
  assert.equal(s.soundOf, "m1");
  // Audio has no aspect ratio: carrying width/height causes places like "use video aspect ratio as
  // project aspect ratio" to misjudge
  assert.equal(s.width, undefined);
  assert.equal(s.height, undefined);
  // Transcription belongs to the same audio track, inherit directly
  assert.equal(s.transcript.segments.length, 1);
});

test("soundAssetFrom: an asset without path / duration / transcript does not gain these keys out of thin air", () => {
  const s = soundAssetFrom({ id: "m9", kind: "video", name: "No extension", url: "blob:x" }, "m10");
  assert.equal(s.name, "No extension · Audio");
  assert.equal("path" in s, false);
  assert.equal("duration" in s, false);
  assert.equal("transcript" in s, false);
});

test("findSoundAsset: once derived it can be found, the basis for idempotence", () => {
  const p = { media: [video, soundAssetFrom(video, "m2"), { id: "m3", kind: "audio", name: "bgm", url: "" }] };
  assert.equal(findSoundAsset(p, "m1").id, "m2");
  assert.equal(findSoundAsset(p, "No such clip"), undefined);
  // Built-in audio assets are not derived from anything; do not mistake them for audio of a video
  assert.equal(findSoundAsset(p, "m3"), undefined);
});

test("opacityAt: sound clips take it as their volume: proportional inside the fade-in and fade-out intervals, full outside them", () => {
  const clip = { id: "c1", start: 10, end: 20, params: {}, cardId: "", fadeIn: 2, fadeOut: 4 };
  assert.equal(opacityAt(clip, 10), 0);
  assert.equal(opacityAt(clip, 11), 0.5);
  assert.equal(opacityAt(clip, 12), 1);
  assert.equal(opacityAt(clip, 15), 1);
  assert.equal(opacityAt(clip, 18), 0.5);
  assert.equal(opacityAt(clip, 20), 0); // Outside range
  // opacity is master volume, multiplied with fade
  assert.equal(opacityAt({ ...clip, opacity: 0.5 }, 11), 0.25);
});
