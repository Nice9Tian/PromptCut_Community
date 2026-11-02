/**
 * subjectForRange / positionForSafeSide / subjectSampleTimes 的单测。跑：node --test src/kernel/subject.test.mjs
 *
 * 这两个函数是「主体检测」到「卡片位置」之间唯一的那道换算，list_shots 每个镜头的
 * suggestedPosition 都从这里出来。它算错不会报错，只会让 AI 把卡片放到人脸上，
 * 而画面里看起来「就是位置没选好」，没人会想到是这段折叠逻辑的问题。所以钉死：
 *   - 区间里一个采样都没有时必须退回最近的一个，并且**说出来**（approximate）；
 *   - safeSide 取众数、并列时的顺序是确定的（不然同一段素材两次调用给两种建议）；
 *   - safeSide 为 top 时不能原样传给卡片 —— 卡片没有 top 档，会掉进 center。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  subjectForRange, positionForSafeSide, subjectSampleTimes, suggestPosition, MAX_SUBJECT_TIMES,
} from "./project.ts";

/** 造一个采样：t 时刻、safeSide、四侧占用率 */
function sample(t, safeSide, occ, boxes = []) {
  return { t, safeSide, occupancy: occ, boxes };
}

const OCC = (left, right, top, bottom) => ({ left, right, top, bottom });

const threeSamples = {
  engine: "light",
  createdAt: "2026-09-07T00:00:00.000Z",
  prompt: "",
  width: 1920,
  height: 1080,
  samples: [
    sample(1, "right", OCC(0.6, 0.1, 0.2, 0.5), [{ label: "person", x: 100, y: 100, w: 400, h: 800, conf: 0.9 }]),
    sample(2, "right", OCC(0.5, 0.2, 0.1, 0.4), [{ label: "face", x: 200, y: 120, w: 120, h: 140, conf: 0.95 }]),
    sample(3, "left", OCC(0.1, 0.7, 0.3, 0.6), [{ label: "person", x: 1200, y: 90, w: 420, h: 820, conf: 0.88 }]),
  ],
};

test("All samples inside the interval take part in the merge: boxes accumulate, occupancy is averaged", () => {
  const r = subjectForRange(threeSamples, 0.5, 3.5);
  assert.deepEqual(r.times, [1, 2, 3]);
  assert.equal(r.approximate, false);
  assert.equal(r.boxes.length, 3, "The boxes of all three samples must be included");
  assert.equal(Math.round(r.occupancy.left * 1000) / 1000, 0.4); // (0.6+0.5+0.1)/3
  assert.equal(Math.round(r.occupancy.right * 1000) / 1000, 0.333);
});

test("safeSide takes the mode, not the first and not the last", () => {
  // right 出现两次、left 一次 —— 只看首尾都会得到错的那一边
  assert.equal(subjectForRange(threeSamples, 0, 10).safeSide, "right");
});

test("When modes tie, take them in a fixed order, so two calls on the same data give the same result", () => {
  const tie = {
    ...threeSamples,
    samples: [sample(1, "bottom", OCC(0.4, 0.4, 0.4, 0.1)), sample(2, "left", OCC(0.1, 0.4, 0.4, 0.4))],
  };
  const a = subjectForRange(tie, 0, 5);
  const b = subjectForRange(tie, 0, 5);
  assert.equal(a.safeSide, "left", "The order is right > left > bottom > top");
  assert.equal(a.safeSide, b.safeSide);
});

test("No sample in the interval: fall back to the nearest one and mark it approximate", () => {
  // 镜头 [5, 6] 上没有采样，最近的是 t=3
  const r = subjectForRange(threeSamples, 5, 6);
  assert.equal(r.approximate, true, "Without the mark, the caller would take the conclusion of a neighboring shot as this shot's");
  assert.deepEqual(r.times, [3]);
  assert.equal(r.safeSide, "left");
});

test("The nearest one may be to the left of the interval", () => {
  const r = subjectForRange(threeSamples, 1.2, 1.4);
  assert.deepEqual(r.times, [1]);
  assert.equal(r.approximate, true);
});

test("Closed interval at the boundaries: t exactly equal to start or end counts as inside the interval", () => {
  assert.deepEqual(subjectForRange(threeSamples, 1, 2).times, [1, 2]);
});

test("Never detected means null; do not make up an empty shell", () => {
  assert.equal(subjectForRange(null, 0, 1), null);
  assert.equal(subjectForRange(undefined, 0, 1), null);
  assert.equal(subjectForRange({ ...threeSamples, samples: [] }, 0, 1), null);
});

test("Passing start / end in reverse does not crash either", () => {
  assert.deepEqual(subjectForRange(threeSamples, 3, 1).times, [1, 2, 3]);
});

// ── safeSide → 卡片 position ────────────────────────────────────────
test("The three tiers left, right and bottom map unchanged", () => {
  assert.equal(positionForSafeSide("left"), "left");
  assert.equal(positionForSafeSide("right"), "right");
  assert.equal(positionForSafeSide("bottom"), "bottom");
});

test("top cannot be passed through unchanged: cards have no top tier, so it would fall into center and cover the face", () => {
  const p = positionForSafeSide("top", OCC(0.7, 0.15, 0.05, 0.6));
  assert.notEqual(p, "center");
  assert.equal(p, "right", "Pick the one with the lowest occupancy among the three remaining valid tiers");
});

test("A valid value must also be given when it is top and there is no occupancy", () => {
  assert.ok(["left", "right", "bottom"].includes(positionForSafeSide("top")));
});

// ── 采样时刻 ────────────────────────────────────────────────────────
// 采样点选错不会报错，只会让检测在人物没出现的那几帧上做出结论。

const makeShot = (start, end) => ({ start, end, inTransition: null, outTransition: null });

test("With shot division: three points per shot at 20% / 50% / 80%", () => {
  const times = subjectSampleTimes({
    duration: 20,
    shots: { engine: "transnetv2", createdAt: "", transitions: [], shots: [makeShot(0, 10)] },
  });
  assert.deepEqual(times, [2, 5, 8]);
});

test("A shot shorter than 1 second takes only the midpoint: three frame extractions would hit the same frame, wasting two forward passes", () => {
  const times = subjectSampleTimes({
    duration: 20,
    shots: { engine: "transnetv2", createdAt: "", transitions: [], shots: [makeShot(4, 4.6)] },
  });
  assert.deepEqual(times, [4.3]);
});

test("No shot detection done: one point every 2 seconds", () => {
  assert.deepEqual(subjectSampleTimes({ duration: 7 }), [1, 3, 5]);
});

test("Sample points never exceed the asset duration: an ffmpeg seek past the end extracts no frame and that sample is wasted", () => {
  const times = subjectSampleTimes({
    duration: 5,
    shots: { engine: "scdet", createdAt: "", transitions: [], shots: [makeShot(0, 5)] },
  });
  assert.ok(times.every((t) => t <= 5), `Out of range: ${times}`);
});

test("Even a very short asset must yield at least one sample point; it cannot return an empty array", () => {
  assert.equal(subjectSampleTimes({ duration: 0.6 }).length, 1);
});

test("When adjacent shots yield the same time, deduplicate, so the same frame is not extracted twice", () => {
  const times = subjectSampleTimes({
    duration: 10,
    shots: {
      engine: "transnetv2", createdAt: "", transitions: [],
      shots: [makeShot(0, 5), makeShot(0, 5)],
    },
  });
  assert.deepEqual(times, [1, 2.5, 4]);
});

// ── 采样上限 ────────────────────────────────────────────────────────
// 服务端 /api/subject/detect 硬拒超过 MAX_SUBJECT_TIMES 的请求，而「不传 times 就
// 自动算」是工具描述里承诺的默认路径。这两件事以前是矛盾的：校验员把 subjectSampleTimes
// 原样搬到 node 里复算，三个真实场景全部超限（7 分钟无镜头 210 点、5 分钟 80 镜头
// 240 点、3 分钟 90 个 2 秒镜头 270 点），标准流程 detect_shots → detect_subjects
// 会直接被 400 拒掉；服务端给的补救话术「请分批」在客户端还做不成——setMediaSubjects
// 是整体替换，第二批会把第一批冲掉。所以上限必须在这一层就夹住。

const makeShotSeries = (n, len) =>
  Array.from({ length: n }, (_, i) => makeShot(i * len, (i + 1) * len));

test("7-minute asset without shots: originally 210 points, clamped to within 200", () => {
  const times = subjectSampleTimes({ duration: 420 });
  assert.equal(subjectSampleTimes({ duration: 420 }, Number.MAX_SAFE_INTEGER).length, 210, "Pin down the original point count first, so this case does not silently become ineffective if the step size changes later");
  assert.ok(times.length <= MAX_SUBJECT_TIMES, `Over the limit: ${times.length}`);
  assert.equal(times.length, MAX_SUBJECT_TIMES, "Thinning should reach exactly the limit; do not throw points away for nothing");
  assert.ok(times.every((t) => t >= 0 && t <= 420), "After thinning, points must still fall inside the asset");
  assert.deepEqual([...times].sort((a, b) => a - b), times, "Thinning must not shuffle the order");
  assert.equal(new Set(times).size, times.length, "Thinning must not produce duplicate times");
});

test("5 minutes, 80 shots: originally 240 points, thinned by shot group to exactly 200, with each shot guaranteed to keep its midpoint", () => {
  const shots = { engine: "transnetv2", createdAt: "", transitions: [], shots: makeShotSeries(80, 3.75) };
  const media = { duration: 300, shots };
  assert.equal(subjectSampleTimes(media, Number.MAX_SAFE_INTEGER).length, 240);
  const times = subjectSampleTimes(media);
  assert.ok(times.length <= MAX_SUBJECT_TIMES, `Over the limit: ${times.length}`);
  // 只超一点点就整体塌成每镜头一个中点（80 点）是降过了头：明明能留 200 个。
  // 正确做法是每个镜头保底留中点，剩下 120 个名额在 20%/80% 点里等距分。
  assert.equal(times.length, MAX_SUBJECT_TIMES, "Thinning should reach exactly the limit; do not throw points away for nothing");
  for (const s of shots.shots) {
    const mid = Math.round((s.start + (s.end - s.start) / 2) * 100) / 100;
    assert.ok(times.includes(mid), `Midpoint of shot ${s.start}-${s.end} was lost`);
  }
});

test("3 minutes, 90 shots of 2 seconds (the \"shots are extremely fragmented\" scenario named in the prompt): originally 270 points, clamped to within 200", () => {
  const shots = { engine: "transnetv2", createdAt: "", transitions: [], shots: makeShotSeries(90, 2) };
  const media = { duration: 180, shots };
  assert.equal(subjectSampleTimes(media, Number.MAX_SAFE_INTEGER).length, 270);
  const times = subjectSampleTimes(media);
  assert.ok(times.length <= MAX_SUBJECT_TIMES, `Over the limit: ${times.length}`);
  // 90 个中点保底 + 110 个名额分给 20%/80% 点 = 正好 200；镜头一个不少
  assert.equal(times.length, MAX_SUBJECT_TIMES, "Thinning should reach exactly the limit");
  for (const s of shots.shots) {
    const mid = Math.round((s.start + (s.end - s.start) / 2) * 100) / 100;
    assert.ok(times.includes(mid), `Midpoint of shot ${s.start}-${s.end} was lost`);
  }
});

test("When there are so many shots that even the midpoints do not fit: thin evenly to the limit instead of keeping the first 200", () => {
  // 300 个 1.5 秒镜头 → 三点 900、中点 300，两步都超，只能抽稀
  const shots = { engine: "transnetv2", createdAt: "", transitions: [], shots: makeShotSeries(300, 1.5) };
  const times = subjectSampleTimes({ duration: 450, shots });
  assert.equal(times.length, MAX_SUBJECT_TIMES);
  // 等距的关键证据：最后一个采样要落在素材尾部附近，不能只覆盖前 2/3
  assert.ok(times[times.length - 1] > 440, `Tail lost: ${times[times.length - 1]}`);
  assert.ok(times[0] < 5, `Head lost: ${times[0]}`);
});

test("max can be passed explicitly, and 1 is also a valid value (takes the middle one, not the first)", () => {
  const one = subjectSampleTimes({ duration: 420 }, 1);
  assert.equal(one.length, 1);
  assert.ok(one[0] > 100 && one[0] < 320, `Did not take the middle one: ${one[0]}`);
});

// ── 抽帧失败的采样 ───────────────────────────────────────────────────
// 失败的采样在 JSON 里和「这一帧真的没有人」逐字段相同（boxes 空、occupancy 四个 0、
// safeSide 是个占位值）。不过滤的话，一次部分失败的检测会给出「这段没人、卡片随便放、
// right 侧安全」的伪结论——恰好是这个功能最该避免的那种错。

const failedSample = (t) => ({
  t, failed: true, reason: "Frame extraction failed: no data decoded (time beyond the duration?)",
  boxes: [], safeSide: "right", occupancy: OCC(0, 0, 0, 0),
});

test("Samples whose frame extraction failed do not take part in the merge: occupancy must not be diluted by those zeros", () => {
  const mixedFailures = {
    ...threeSamples,
    samples: [threeSamples.samples[0], failedSample(1.5), threeSamples.samples[1]],
  };
  const r = subjectForRange(mixedFailures, 0, 5);
  assert.deepEqual(r.times, [1, 2], "The failed one must not appear in times");
  assert.equal(Math.round(r.occupancy.left * 1000) / 1000, 0.55, "(0.6+0.5)/2, mixing in a 0 would give 0.367");
});

test("When all fail, return null; do not make up a fake right", () => {
  const allFailed = { ...threeSamples, samples: [failedSample(1), failedSample(2)] };
  assert.equal(subjectForRange(allFailed, 0, 5), null);
});

test("When the interval contains only failed samples, fall back to the nearest successful sample and mark it approximate", () => {
  const mixedFailures = { ...threeSamples, samples: [threeSamples.samples[0], failedSample(9)] };
  const r = subjectForRange(mixedFailures, 8, 10);
  assert.equal(r.approximate, true);
  assert.deepEqual(r.times, [1]);
});

// ── 被占住时不给建议 ─────────────────────────────────────────────────
// positionForSafeSide 是在剩下三个合法档里挑「最不坏」的，不等于「保证不遮」。
// 实测 out/media/talker.mp4（720x1280 正面说话人）t=2.75：
// occupancy {left:0.895, right:0.895, top:0.692, bottom:0.993}、safeSide="top"，
// 挑出来的 right 有 89.5% 是人——卡片照着填就正压在脸上。

test("When a side is truly empty, give the suggestion as usual and report the occupancy of that side", () => {
  const s = suggestPosition("top", OCC(0.7, 0.15, 0.05, 0.6));
  assert.equal(s.suggestedPosition, "right");
  assert.equal(s.suggestedOccupancy, 0.15);
  assert.equal(s.warning, undefined);
});

test("All four tiers are occupied: suggestedPosition is set to null and a warning is given (measured numbers from talker.mp4)", () => {
  const s = suggestPosition("top", OCC(0.895, 0.895, 0.692, 0.993));
  assert.equal(s.suggestedPosition, null, "89.5% is the side where the person is; it must not be given out as a suggestion");
  assert.equal(s.suggestedOccupancy, 0.9);
  assert.match(s.warning, /no position that avoids covering the person/);
});

test("Sitting exactly on the threshold does not count as occupied (0.5 means \"counts only when exceeded\")", () => {
  assert.equal(suggestPosition("right", OCC(0.9, 0.5, 0.9, 0.9)).suggestedPosition, "right");
  assert.equal(suggestPosition("right", OCC(0.9, 0.51, 0.9, 0.9)).suggestedPosition, null);
});

test("The value domain of suggestedPosition has no center: the center is exactly where the face is", () => {
  for (const side of ["left", "right", "top", "bottom"]) {
    const s = suggestPosition(side, OCC(0.1, 0.1, 0.1, 0.1));
    assert.notEqual(s.suggestedPosition, "center");
    assert.ok(["left", "right", "bottom"].includes(s.suggestedPosition));
  }
});
