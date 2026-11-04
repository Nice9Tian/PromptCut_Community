import test from "node:test";
import assert from "node:assert/strict";
import {
  clipSpeed, isSpeedChanged, speedMutesSource, mediaTimeAt, timelineTimeAt, mediaOffsetAfter, mediaSpanOf, timelineSpanOf,
  normalizeSpeed, withSpeed, speedKeyPart, speedLabel, CLIP_SPEED_MIN, CLIP_SPEED_MAX, resampleVarispeed, speedInRange,
} from "./clipTime.mjs";

test("clipSpeed: a missing field or anything that is not a finite positive number counts as 1", () => {
  for (const speed of [undefined, null, 0, -1, NaN, Infinity, "2"]) assert.equal(clipSpeed({ speed }), 1, String(speed));
  assert.equal(clipSpeed(undefined), 1);
  assert.equal(clipSpeed({ speed: 0.5 }), 0.5);
  assert.equal(isSpeedChanged({}), false);
  assert.equal(isSpeedChanged({ speed: 1 }), false);
  assert.equal(isSpeedChanged({ speed: 2 }), true);
});

test("Default 1: mediaTimeAt / timelineTimeAt / mediaOffsetAfter / span are bit-for-bit identical to the original formulation (20,000 random cases)", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 20000; i++) {
    const clip = { start: rnd() * 300, end: 0, mediaOffset: i % 3 ? rnd() * 50 : undefined };
    clip.end = clip.start + rnd() * 20;
    const t = clip.start + rnd() * 30, m = rnd() * 80, dt = rnd() * 10;
    const off = clip.mediaOffset ?? 0;
    assert.ok(Object.is(mediaTimeAt(clip, t), off + (t - clip.start)));
    assert.ok(Object.is(timelineTimeAt(clip, m), clip.start + (m - off)));
    assert.ok(Object.is(mediaOffsetAfter(clip, dt), off + dt));
    assert.ok(Object.is(mediaSpanOf(clip), clip.end - clip.start));
    assert.ok(Object.is(timelineSpanOf(clip, m), m));
  }
});

test("Speed change: media time = mediaOffset + (t − start) × speed, and the inverse function matches", () => {
  const clip = { start: 10, end: 14, mediaOffset: 3, speed: 2 };
  assert.equal(mediaTimeAt(clip, 11), 5);
  assert.equal(timelineTimeAt(clip, 5), 11);
  assert.equal(mediaOffsetAfter(clip, 1.5), 6);
  assert.equal(mediaSpanOf(clip), 8);
  assert.equal(timelineSpanOf(clip, 8), 4);
  const slow = { start: 0, end: 4, speed: 0.5 };
  assert.equal(mediaTimeAt(slow, 3), 1.5);
  assert.equal(timelineTimeAt(slow, 1.5), 3);
});

test("speedMutesSource: only speed-changed media clips; card clips and cut segments do not count", () => {
  assert.equal(speedMutesSource({ mediaId: "v", speed: 2 }), true);
  assert.equal(speedMutesSource({ mediaId: "v" }), false);
  assert.equal(speedMutesSource({ cardId: "x", speed: 2 }), false);
  const project = { media: [{ id: "v", kind: "video" }, { id: "s", kind: "audio" }] };
  assert.equal(speedMutesSource({ mediaId: "v", speed: 2 }, project), true, "A video clip produces no original audio");
  assert.equal(speedMutesSource({ mediaId: "s", speed: 2 }, project), false, "Sound clips (split from audio-visual clips) play as usual, with pitch change");
});

test("normalizeSpeed / withSpeed / speedKeyPart", () => {
  assert.equal(normalizeSpeed("x"), null);
  assert.equal(normalizeSpeed(0), null);
  assert.equal(normalizeSpeed(100), CLIP_SPEED_MAX);
  assert.equal(normalizeSpeed(0.01), CLIP_SPEED_MIN);
  assert.equal(normalizeSpeed(1.234), 1.23);
  const c = { id: "a", speed: 2 };
  assert.deepEqual(withSpeed(c, 1), { id: "a" }, "Setting it back to 1 removes the field");
  assert.deepEqual(withSpeed({ id: "a" }, 0.5), { id: "a", speed: 0.5 });
  assert.equal(c.speed, 2, "Not modified in place");
  assert.equal(speedKeyPart({}), null);
  assert.equal(speedKeyPart({ speed: 1 }), null);
  assert.deepEqual(speedKeyPart({ speed: 3 }), { speed: 3 });
  assert.equal(speedLabel(0.5), "0.5×");
});

test("resampleVarispeed: linear interpolation stepping by the speed ratio; speedInRange", () => {
  const src = Float32Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual([...resampleVarispeed(src, 2, 2, 4)], [2, 4, 6, 8]);
  assert.deepEqual([...resampleVarispeed(src, 0, 0.5, 4)], [0, 0.5, 1, 1.5]);
  assert.deepEqual([...resampleVarispeed(src, 8, 2, 3)], [8, 0, 0], "Out of range is padded with 0");
  assert.equal(speedInRange(0.25), true);
  assert.equal(speedInRange(4), true);
  assert.equal(speedInRange(4.01), false);
  assert.equal(speedInRange("x"), false);
});
