/**
 * kernel/audioPlan.mjs: the "who makes sound when" manifest shared by export mixing and
 * loudness measurement.
 * Run: node --test src/kernel/audioPlan.test.mjs
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

test("Muted / hidden tracks, audioMuted, images, media with no URL, cards and zero-duration clips are all silent; volume = opacity × audioVolume; effects carry their definitions", () => {
  const plan = audioPlanOf(project);
  assert.deepEqual(plan.map((p) => p.clipId), ["c1", "c5"]);
  const c1 = plan[0];
  assert.equal(c1.volume, 0.25);
  assert.equal(c1.offset, 2);
  assert.equal(c1.fadeIn, 1);
  assert.equal(c1.fx.def.id, "afx1");
  assert.equal(plan[1].fx, null, "An effect whose definition cannot be found is treated as not attached");
});

test("soundingAt: who is sounding at a given second", () => {
  const plan = audioPlanOf(project);
  assert.deepEqual(soundingAt(plan, 4.5), ["c1", "c5"]);
  assert.deepEqual(soundingAt(plan, 5), ["c5"]);
  assert.deepEqual(soundingAt(plan, 7), []);
});

test("Synthesized WAV start, duration and trim offset keep sample accuracy; splitting does not restart the first event", () => {
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
  assert.ok(Math.abs(b.dur * 48000 - 1) < 1e-9, "A clip one sample long must not be dropped by millisecond rounding");
});

test("Fails explicitly when a referenced synthesized media item is missing; muted and hidden tracks still do not request sound", () => {
  const p = { media: [], tracks: [{ id: "t", clips: [{ id: "lost", mediaId: "gone", soundEffect: { reuseKey: "r" }, start: 0, end: 1 }] }] };
  assert.throws(() => audioPlanOf(p), /The synthesized sound effect media for lost is missing/);
  assert.deepEqual(audioPlanOf({ ...p, tracks: [{ ...p.tracks[0], muted: true }] }), []);
  assert.deepEqual(audioPlanOf({ ...p, tracks: [{ ...p.tracks[0], hidden: true }] }), []);
  assert.deepEqual(audioPlanOf({ ...p, tracks: [{ ...p.tracks[0], clips: [{ ...p.tracks[0].clips[0], audioMuted: true }] }] }), []);
  assert.throws(() => audioPlanOf({ ...p, media: [{ id: "gone", kind: "audio", url: "", soundEffect: {} }] }), /media for lost is missing/);
});

// Export fade-in/fade-out envelope: identical to multiplying two ffmpeg afade (linear).
// Overlapping and longer than the clip previously caused errors
import { fadeEnvelope } from "./audioPlan.mjs";
test("fadeEnvelope: two linear fades multiplied; when they overlap it is a triangle, and when the fade-in is longer than the clip the endpoint only reaches dur/fadeIn", () => {
  const at = (env, dur, t) => env[Math.round((t / dur) * (env.length - 1))];
  const plain = fadeEnvelope(0.5, 1, 1, 4, 401);
  assert.equal(at(plain, 4, 0), 0);
  assert.ok(Math.abs(at(plain, 4, 0.5) - 0.25) < 1e-6);
  assert.ok(Math.abs(at(plain, 4, 2) - 0.5) < 1e-6);
  assert.equal(at(plain, 4, 4), 0);
  // fadeIn + fadeOut > dur: peak is at midpoint = (1/1.5)*(1/1.5)... here dur 2, each 1.5:
  // at t=1, (1/1.5)×(1/1.5)=0.444
  const overlap = fadeEnvelope(1, 1.5, 1.5, 2, 201);
  assert.ok(Math.abs(at(overlap, 2, 1) - 4 / 9) < 1e-6);
  assert.ok(at(overlap, 2, 0.5) > 0 && at(overlap, 2, 0.5) < at(overlap, 2, 1), "There must be no step that jumps hard from 0 to full volume");
  // fadeIn is longer than the clip: only rises to dur/fadeIn at the end
  const longIn = fadeEnvelope(1, 4, 0, 2, 201);
  assert.ok(Math.abs(at(longIn, 2, 2) - 0.5) < 1e-6);
  assert.equal(fadeEnvelope(1, 0, 0, 3, 5).every((v) => v === 1), true);
});
