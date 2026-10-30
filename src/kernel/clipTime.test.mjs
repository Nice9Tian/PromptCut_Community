import test from "node:test";
import assert from "node:assert/strict";
import {
  clipSpeed, isSpeedChanged, speedMutesSource, mediaTimeAt, timelineTimeAt, mediaOffsetAfter, mediaSpanOf, timelineSpanOf,
  normalizeSpeed, withSpeed, speedKeyPart, speedLabel, CLIP_SPEED_MIN, CLIP_SPEED_MAX, resampleVarispeed, speedInRange,
} from "./clipTime.mjs";

test("clipSpeed:没有字段、不是有限正数一律按 1", () => {
  for (const speed of [undefined, null, 0, -1, NaN, Infinity, "2"]) assert.equal(clipSpeed({ speed }), 1, String(speed));
  assert.equal(clipSpeed(undefined), 1);
  assert.equal(clipSpeed({ speed: 0.5 }), 0.5);
  assert.equal(isSpeedChanged({}), false);
  assert.equal(isSpeedChanged({ speed: 1 }), false);
  assert.equal(isSpeedChanged({ speed: 2 }), true);
});

test("缺省 1:mediaTimeAt / timelineTimeAt / mediaOffsetAfter / 跨度与原来的写法逐位相同(随机 2 万组)", () => {
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

test("变速:素材时刻 = mediaOffset + (t − start) × speed,反函数对得上", () => {
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

test("speedMutesSource:只有变速的素材段;卡片段、剪辑段不算", () => {
  assert.equal(speedMutesSource({ mediaId: "v", speed: 2 }), true);
  assert.equal(speedMutesSource({ mediaId: "v" }), false);
  assert.equal(speedMutesSource({ cardId: "x", speed: 2 }), false);
  const project = { media: [{ id: "v", kind: "video" }, { id: "s", kind: "audio" }] };
  assert.equal(speedMutesSource({ mediaId: "v", speed: 2 }, project), true, "视频段不出原声");
  assert.equal(speedMutesSource({ mediaId: "s", speed: 2 }, project), false, "声音段(音画分离出来的)照常出声、变调");
});

test("normalizeSpeed / withSpeed / speedKeyPart", () => {
  assert.equal(normalizeSpeed("x"), null);
  assert.equal(normalizeSpeed(0), null);
  assert.equal(normalizeSpeed(100), CLIP_SPEED_MAX);
  assert.equal(normalizeSpeed(0.01), CLIP_SPEED_MIN);
  assert.equal(normalizeSpeed(1.234), 1.23);
  const c = { id: "a", speed: 2 };
  assert.deepEqual(withSpeed(c, 1), { id: "a" }, "改回 1 删字段");
  assert.deepEqual(withSpeed({ id: "a" }, 0.5), { id: "a", speed: 0.5 });
  assert.equal(c.speed, 2, "不原地改");
  assert.equal(speedKeyPart({}), null);
  assert.equal(speedKeyPart({ speed: 1 }), null);
  assert.deepEqual(speedKeyPart({ speed: 3 }), { speed: 3 });
  assert.equal(speedLabel(0.5), "0.5×");
});

test("resampleVarispeed:按倍率步进线性插值;speedInRange", () => {
  const src = Float32Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual([...resampleVarispeed(src, 2, 2, 4)], [2, 4, 6, 8]);
  assert.deepEqual([...resampleVarispeed(src, 0, 0.5, 4)], [0, 0.5, 1, 1.5]);
  assert.deepEqual([...resampleVarispeed(src, 8, 2, 3)], [8, 0, 0], "越界补 0");
  assert.equal(speedInRange(0.25), true);
  assert.equal(speedInRange(4), true);
  assert.equal(speedInRange(4.01), false);
  assert.equal(speedInRange("x"), false);
});
