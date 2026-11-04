/**
 * Unit tests for subjectForRange / positionForSafeSide / subjectSampleTimes. Run: node --test src/kernel/subject.test.mjs
 *
 * These two functions are the only conversion between "subject detection" and "card position",
 * from which suggestedPosition for each shot in list_shots originates. If they compute incorrectly,
 * no error is thrown; it merely causes AI to place cards over people's faces, and in the visuals
 * it looks like "just poorly positioned", with no one suspecting this folding logic. So pin it down:
 *   - When there are no samples in the interval, must fall back to the nearest one and **report it** (approximate);
 *   - safeSide uses mode, with deterministic ordering on ties (otherwise two calls on the same asset give two suggestions);
 *   - When safeSide is top, cannot pass to card as is: cards have no top tier, falling back into center.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  subjectForRange, positionForSafeSide, subjectSampleTimes, suggestPosition, MAX_SUBJECT_TIMES,
} from "./project.ts";

/** Create a sample: timestamp t, safeSide, four-side occupancy */
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
  // right appears twice, left once: inspecting only ends yields the wrong side
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
  // Shot [5, 6] has no samples, the closest is t=3
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

// ── safeSide → card position ────────────────────────────────────────
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

// ── Sample timestamps ───────────────────────────────────────────────
// Picking wrong sample points does not error; it just makes detection draw conclusions from frames
// where no subject appears.

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

// ── Sample limit ─────────────────────────────────────────────────────
// The server /api/subject/detect hard-rejects requests exceeding MAX_SUBJECT_TIMES, while
// "automatically compute when times is omitted" is the default path promised in tool descriptions.
// These two previously conflicted: validators copied subjectSampleTimes directly into node to
// recalculate, and three real-world scenarios all exceeded the limit (7 min without shots: 210
// points; 5 min with 80 shots: 240 points; 3 min with 90 2-second shots: 270 points); standard
// workflow detect_shots → detect_subjects was directly rejected with 400; the server's suggested
// workaround "please batch" cannot even be done on the client: setMediaSubjects is a full
// replacement, so the second batch clobbers the first. Therefore, the limit must be clamped at
// this layer.

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
  // Collapsing entirely to one midpoint per shot (80 points) for a slight overflow is excessive
  // downgrade: clearly 200 can be kept. The correct approach is guaranteeing a midpoint per shot,
  // and distributing the remaining 120 slots evenly among the 20%/80% points.
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
  // 90 guaranteed midpoints + 110 slots distributed to 20%/80% points = exactly 200;
  // not a single shot missing
  assert.equal(times.length, MAX_SUBJECT_TIMES, "Thinning should reach exactly the limit");
  for (const s of shots.shots) {
    const mid = Math.round((s.start + (s.end - s.start) / 2) * 100) / 100;
    assert.ok(times.includes(mid), `Midpoint of shot ${s.start}-${s.end} was lost`);
  }
});

test("When there are so many shots that even the midpoints do not fit: thin evenly to the limit instead of keeping the first 200", () => {
  // 300 1.5-second shots → 900 3-point samples, 300 midpoints; both steps exceed limit, must decimate
  const shots = { engine: "transnetv2", createdAt: "", transitions: [], shots: makeShotSeries(300, 1.5) };
  const times = subjectSampleTimes({ duration: 450, shots });
  assert.equal(times.length, MAX_SUBJECT_TIMES);
  // Key evidence of equidistant spacing: the last sample must fall near the tail of the asset,
  // not just cover the first 2/3
  assert.ok(times[times.length - 1] > 440, `Tail lost: ${times[times.length - 1]}`);
  assert.ok(times[0] < 5, `Head lost: ${times[0]}`);
});

test("max can be passed explicitly, and 1 is also a valid value (takes the middle one, not the first)", () => {
  const one = subjectSampleTimes({ duration: 420 }, 1);
  assert.equal(one.length, 1);
  assert.ok(one[0] > 100 && one[0] < 320, `Did not take the middle one: ${one[0]}`);
});

// ── Samples from failed frame extraction ─────────────────────────────
// Failed samples are field-by-field identical in JSON to "there really is no person in this frame"
// (empty boxes, four 0s in occupancy, safeSide is a placeholder value). Without filtering, a
// partially failed detection yields the false conclusion "no one in this section, place cards
// anywhere, right side is safe": precisely the kind of error this feature must avoid.

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

// ── Do not suggest when occupied ─────────────────────────────────────
// positionForSafeSide picks the "least bad" option among the remaining three valid tiers, which
// does not equate to "guaranteed not to occlude". Actual test on out/media/talker.mp4 (720x1280
// frontal speaker) at t=2.75: occupancy {left:0.895, right:0.895, top:0.692, bottom:0.993},
// safeSide="top"; the selected right side is 89.5% human: placing the card accordingly puts it
// right over the face.

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
