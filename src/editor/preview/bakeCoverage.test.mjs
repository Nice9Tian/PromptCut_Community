/**
 * Unit tests for green bar coverage. Run: node --test src/editor/preview/bakeCoverage.test.mjs
 *
 * This green bar must either be trustworthy or removed: it promises that "scrubbing to green areas
 * immediately shows video". Drawing too much is misleading (scrubbing there still waits five seconds
 * while the bar is green); drawing too little causes pointless waiting. So lock down the intent:
 *   - A prerendered time covers until **the next time of the same card**, and the last covers until
 *     card end;
 *   - Unrendered times produce no green;
 *   - Adjacent segments must be merged, not drawn as a row of small chunks with seams;
 *   - Coverage range must not exceed the interval of the card itself.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { coverageSegments } from "./bakeCoverage.ts";

/** Create several sample times for a card */
const spread = (clipId, start, end, ts) => ts.map((t) => ({ clipId, t, start, end }));
const all = () => true;
const none = () => false;

test("A prerendered moment covers up to the next moment of the same card", () => {
  const m = spread("a", 0, 4, [0, 1, 2]);
  // Only t=1 is rendered → covers [1,2), should not bleed into 0 or past 2
  const segs = coverageSegments(m, (x) => x.t === 1);
  assert.deepEqual(segs, [{ start: 1, end: 2 }]);
});

test("The last moment covers all the way to the end of the card", () => {
  const m = spread("a", 0, 4, [0, 1, 2]);
  const segs = coverageSegments(m, (x) => x.t === 2);
  assert.deepEqual(segs, [{ start: 2, end: 4 }], "2 is the last one, and the whole rest relies on it");
});

test("All prerendered = the whole card forms one segment, not a row of small blocks with gaps", () => {
  const m = spread("a", 0, 4, [0, 1, 2]);
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 4 }]);
});

test("With nothing prerendered there is no green", () => {
  assert.deepEqual(coverageSegments(spread("a", 0, 4, [0, 1, 2]), none), []);
});

test("Prerendered halfway: the first half is green, the second half is not; painting the whole thing green would mislead", () => {
  const m = spread("a", 0, 4, [0, 1, 2, 3]);
  const segs = coverageSegments(m, (x) => x.t <= 1);
  assert.deepEqual(segs, [{ start: 0, end: 2 }], "0 and 1 together make [0,2), and nothing after 2 is prerendered yet");
});

test("Two segments with a gap between them cannot be merged", () => {
  const m = spread("a", 0, 5, [0, 1, 2, 3, 4]);
  // Rendered 0 and 3; 1 and 2 in between are unrendered
  const segs = coverageSegments(m, (x) => x.t === 0 || x.t === 3);
  assert.deepEqual(segs, [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
});

test("A moment covers up to the next moment, and **never searches across cards**", () => {
  // Two cards end-to-end: the last time of a can only cover until a ends, cannot borrow times from b
  const m = [...spread("a", 0, 2, [0, 1]), ...spread("b", 2, 4, [2, 3])];
  const segs = coverageSegments(m, (x) => x.clipId === "a");
  assert.deepEqual(segs, [{ start: 0, end: 2 }], "Covers only the two seconds of a itself");
});

test("Two cards joined end to end are both prerendered, drawn as one continuous bar", () => {
  const m = [...spread("a", 0, 2, [0, 1]), ...spread("b", 2, 4, [2, 3])];
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 4 }], "Adjacent ones should merge into one segment");
});

test("Two cards with a gap between them: the green bar must break there too", () => {
  const m = [...spread("a", 0, 2, [0, 1]), ...spread("b", 5, 7, [5, 6])];
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 2 }, { start: 5, end: 7 }]);
});

test("The coverage never goes beyond the interval of the card itself", () => {
  // Construct an out-of-bounds timetable (should not occur in theory, but out-of-bounds green bars are
  // misleading and must be handled)
  const m = [{ clipId: "a", t: 3, start: 0, end: 2 }];
  assert.deepEqual(coverageSegments(m, all), [], "A moment that is already after the card ends produces no green");
});

test("Moments passed in out of order are still computed correctly", () => {
  const m = spread("a", 0, 4, [2, 0, 1]);
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 4 }]);
});

test("Overlapping cards (stacked on different tracks) merge into one bar and are not drawn twice", () => {
  const m = [...spread("a", 0, 3, [0, 1, 2]), ...spread("b", 1, 4, [1, 2, 3])];
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 4 }]);
});

test("The floating-point error accumulated by stepping 0.25 s at a time does not draw a pile of tiny gaps", () => {
  // Simulate accumulation in sampleTimesFor: 0, 0.25, 0.5, ... with precision error in the last digit
  const ts = [];
  for (let i = 0, v = 0; i < 8; i++, v += 0.25) ts.push(v);
  const m = spread("a", 0, 2, ts);
  const segs = coverageSegments(m, all);
  assert.equal(segs.length, 1, `Should merge into one segment, got ${segs.length} segments: ${JSON.stringify(segs)}`);
  assert.ok(Math.abs(segs[0].start - 0) < 1e-6);
  assert.ok(Math.abs(segs[0].end - 2) < 1e-6);
});

test("Empty input does not crash", () => {
  assert.deepEqual(coverageSegments([], all), []);
});

/* ── Modify a card: only its coverage is invalidated, and invalidated on the current frame ──── */

const { visibleCoverage, clipFingerprint, momentId } = await import("./bakeCoverage.ts");

/**
 * Create coverage for a card: lay out times in [a,b) by step. Coverage table stores **facts** (which
 * times exist); segments are computed on the fly by visibleCoverage: so when foreground finishes
 * rendering, it only needs to add an id to baked.
 */
const CC = (clipId, fp, a, b, step = 1) => {
  const moments = [];
  for (let t = a; t < b - 1e-9; t += step) {
    moments.push({ clipId, id: momentId(clipId, t), t, start: a, end: b, tier: "coarse", fine: true });
  }
  return { clipId, fp, start: a, moments };
};
/** Mark all sample times for these cards as rendered */
const allBaked = (clips) => new Set(clips.flatMap((c) => c.moments.map((m) => m.id)));
const COV = (clips, baked) => ({ clips, baked: baked ?? allBaked(clips), bakingAt: null, bytes: 0 });

test("A changed: only the segment of A disappears, B is not affected at all", () => {
  const cov = COV([CC("a", "fpA", 0, 2), CC("b", "fpB", 10, 12)]);
  // User modified parameters of A → fingerprint of A changed, B unchanged
  const v = visibleCoverage(cov, new Map([["fpA-changed", 0], ["fpB", 10]]));
  assert.deepEqual(v.coarse, [{ start: 10, end: 12 }], "Only the segment of B should remain");
  assert.equal(v.stale, 1, "The coverage of 1 card has been invalidated");
  assert.equal(v.coarseTotal, 2, "The count also leaves only B, and A must not be counted in");
});

test("Nothing changed: both stay, and the ones joined end to end merge into one bar", () => {
  const cov = COV([CC("a", "fpA", 0, 2), CC("b", "fpB", 2, 4)]);
  const v = visibleCoverage(cov, new Map([["fpA", 0], ["fpB", 2]]));
  assert.deepEqual(v.coarse, [{ start: 0, end: 4 }], "Adjacent ones should join into one bar");
  assert.equal(v.stale, 0);
  assert.equal(v.coarseTotal, 4);
});

test("Card deleted: its coverage is not drawn either (the fingerprint does not exist in the current project at all)", () => {
  const cov = COV([CC("a", "fpA", 0, 2), CC("b", "fpB", 10, 12)]);
  const v = visibleCoverage(cov, new Map([["fpB", 10]]));
  assert.deepEqual(v.coarse, [{ start: 10, end: 12 }]);
  assert.equal(v.stale, 1);
});

test("Everything changed: the whole bar is empty, not stale ones left behind to mislead", () => {
  const cov = COV([CC("a", "fpA", 0, 2), CC("b", "fpB", 10, 12)]);
  const v = visibleCoverage(cov, new Map([["newA", 0], ["newB", 10]]));
  assert.deepEqual(v.coarse, []);
  assert.deepEqual(v.full, []);
  assert.equal(v.coarseTotal, 0);
  assert.equal(v.stale, 2);
});

test("A moment that is not prerendered produces no color, and prerendering one adds a segment: segments are computed on demand, not stored statically", () => {
  const a = CC("a", "fpA", 0, 3);           // Three sample times: 0 / 1 / 2
  const cov = COV([a], new Set());           // None rendered
  const live = new Map([["fpA", 0]]);
  assert.deepEqual(visibleCoverage(cov, live).coarse, [], "With nothing prerendered there is no color");

  // Only render the middle time → covers only [1,2)
  const one = { ...cov, baked: new Set([momentId("a", 1)]) };
  assert.deepEqual(visibleCoverage(one, live).coarse, [{ start: 1, end: 2 }]);
  assert.equal(visibleCoverage(one, live).coarseBaked, 1);
});

test("The fingerprint only considers things that \"determine pixels\": changing parameters changes it, moving the position does not", () => {
  const base = { id: "c1", cardId: "pin-board", params: { a: 1 }, frame: { x: 0, y: 0, w: 960, h: 540 } };
  const moved = { ...base, frame: { x: 500, y: 200, w: 960, h: 540 } };
  const resized = { ...base, frame: { x: 0, y: 0, w: 1920, h: 1080 } };
  const edited = { ...base, params: { a: 2 } };
  assert.equal(clipFingerprint(moved), clipFingerprint(base), "Only the position moved and the pixels did not change, so the coverage must not be invalidated");
  assert.notEqual(clipFingerprint(resized), clipFingerprint(base), "The aspect ratio changed, so the render comes out different");
  assert.notEqual(clipFingerprint(edited), clipFingerprint(base), "Changing parameters must invalidate");
});

/* ── Foreground live render must also be recorded, otherwise the bar lags behind ─────────────── */

test("markBaked makes \"the moment that was just prerendered\" count toward the coverage immediately", async () => {
  const m = await import("./bakeCoverage.ts");
  const a = CC("a", "fpA", 0, 3);
  m.publishCoverage({ clips: [a], baked: new Set(), bakingAt: null, bytes: 0 });
  const live = new Map([["fpA", 0]]);
  assert.deepEqual(m.visibleCoverage(m.getCoverage(), live).coarse, [], "Not prerendered yet, no color");

  // Foreground live-rendered that time: only give an id, no need to re-inventory or recompute segments
  m.markBaked([momentId("a", 1)]);
  assert.deepEqual(m.visibleCoverage(m.getCoverage(), live).coarse, [{ start: 1, end: 2 }],
    "The picture has appeared, so the bar must update at the same instant");
});

test("markBaked notifies subscribers (the bar repaints based on this)", async () => {
  const m = await import("./bakeCoverage.ts");
  m.publishCoverage({ clips: [CC("a", "fpA", 0, 3)], baked: new Set(), bakingAt: null, bytes: 0 });
  let hits = 0;
  const off = m.subscribeCoverage(() => { hits++; });
  m.markBaked([momentId("a", 0)]);
  assert.equal(hits, 1, "Must notify after marking, otherwise the UI does not repaint");
  // Marking the same id again should not trigger a redundant notification (bar unchanged, redraw is
  // wasteful)
  m.markBaked([momentId("a", 0)]);
  assert.equal(hits, 1, "Marking again should not notify again");
  off();
});

/* ── Move position / trim shorter: bar must reflect reality on the same frame ─────────────────────
 *
 * These two come from an actual test: all six cards in the project were rendered and the bar was
 * completely green; moving the card at [20,24] to 27s, the bar **still painted green over [20,24]**,
 * even though that part of the timeline was already empty, and `stale` still reported 0.
 * Timeline position is deliberately omitted from fingerprints (moving does not change pixels), so
 * fingerprint alone cannot tell whether a card moved; whereas each time records absolute seconds, so
 * when the card moves away, they remain in place.
 */

test("Card moved elsewhere: the green segment moves with it, instead of staying in place and misleading", () => {
  const cov = COV([CC("a", "fpA", 20, 24)]);
  // Fingerprint unchanged (moving position does not change pixels), but start changed from 20 to 27
  const v = visibleCoverage(cov, new Map([["fpA", 27]]));
  assert.deepEqual(v.coarse, [{ start: 27, end: 31 }], "The green should be where the card is now");
  assert.equal(v.stale, 0, "Moving does not invalidate: the prerendered image is still usable");
  assert.equal(v.coarseBaked, 4, "A move should not change the \"has it been prerendered\" bookkeeping");
});

test("After a card is moved away, no color may remain at the old place", () => {
  const cov = COV([CC("a", "fpA", 20, 24)]);
  const v = visibleCoverage(cov, new Map([["fpA", 27]]));
  const oldSpotStillHasColor = v.coarse.some((s) => s.start < 24 - 1e-9 && s.end > 20 + 1e-9);
  assert.equal(oldSpotStillHasColor, false, "[20,24] is empty now, so drawing it green would mislead");
});

test("Trimming a bit should change the fingerprint: the length is part of the cache key, so the old image no longer counts", () => {
  const base = { id: "c1", cardId: "odometer", params: {}, start: 3, end: 7 };
  const trimmed = { ...base, end: 5 };
  const moved = { ...base, start: 17, end: 21 };
  assert.notEqual(clipFingerprint(trimmed), clipFingerprint(base), "Trimmed, so the render is a different image");
  assert.equal(clipFingerprint(moved), clipFingerprint(base), "The whole clip moved, the length is unchanged, still the same image");
});

test("The fingerprint is a denylist: changing pixel-producing fields invalidates, while 3D board material envelopes do not", () => {
  const base = { id: "c1", cardId: "odometer", params: { to: 1 }, start: 0, end: 4 };
  // These enter the server cache key; missing any causes "still green after modification"
  for (const [fieldName, editedClip] of [
    ["emphasis", { ...base, emphasis: { kind: "shadow" } }],
    ["motion", { ...base, motion: { pathId: "p1" } }],
    ["parts", { ...base, parts: [{ id: "p" }] }],
  ]) {
    assert.notEqual(clipFingerprint(editedClip), clipFingerprint(base), `Changing ${fieldName} must invalidate`);
  }
  // Opacity and fades are stripped by bakeTarget and applied on the 3D board material via cardOpacityAt,
  // avoiding double-attenuation and frozen fades on hold cards while keeping prerendered textures reusable.
  for (const [fieldName, editedClip] of [
    ["opacity", { ...base, opacity: 0.5 }],
    ["fadeIn", { ...base, fadeIn: 0.5 }],
    ["fadeOut", { ...base, fadeOut: 0.75 }],
  ]) {
    assert.equal(clipFingerprint(editedClip), clipFingerprint(base), `Changing ${fieldName} must reuse the unattenuated board texture`);
  }
});

/* ── Segments that originally have nothing to render should also be colored ──────────────────────
 *
 * User-reported issue: "Sometimes there is no media for a period of time, and the time bar never turns
 * green there". Scrubbing to those seconds immediately shows what it should be (empty), so by the
 * bar's contract it should be colored; if left blank, users cannot distinguish between "not yet rendered"
 * and "inherently empty", making prerender look stuck.
 */
const { idleSpans } = await import("./bakeCoverage.ts");

test("The gap between two cards counts as ready", () => {
  assert.deepEqual(idleSpans([{ start: 0, end: 2 }, { start: 5, end: 8 }], 10),
    [{ start: 2, end: 5 }, { start: 8, end: 10 }]);
});

test("The whole video has no cards at all: all of it counts as ready", () => {
  assert.deepEqual(idleSpans([], 6), [{ start: 0, end: 6 }]);
});

test("When cards cover everything there is no gap", () => {
  assert.deepEqual(idleSpans([{ start: 0, end: 3 }, { start: 3, end: 6 }], 6), []);
});

test("Overlapping cards never produce a gap of negative length", () => {
  assert.deepEqual(idleSpans([{ start: 0, end: 4 }, { start: 1, end: 2 }], 4), []);
});

test("A card extends beyond the video length: nothing is drawn beyond the video length", () => {
  assert.deepEqual(idleSpans([{ start: 0, end: 9 }], 5), []);
});

test("A video length of 0 / negative does not crash", () => {
  assert.deepEqual(idleSpans([{ start: 0, end: 1 }], 0), []);
  assert.deepEqual(idleSpans([], -1), []);
});
