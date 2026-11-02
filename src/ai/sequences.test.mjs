// node --test src/ai/sequences.test.mjs: planning logic for see_frames media mode (source: "media")
import test from "node:test";
import assert from "node:assert/strict";

import { scenesOf, planSequences, frameTimes, transcriptFor, MAX_PER_PAGE } from "./sequences.ts";

const shots = {
  engine: "transnetv2", createdAt: "", transitions: [],
  shots: Array.from({ length: 27 }, (_, i) => ({ start: i * 5, end: (i + 1) * 5, inTransition: i ? "cut" : null, outTransition: i < 26 ? "cut" : null })),
};

test("scenesOf: with shot results, go by shot, numbering from 1; without them, cut every 10 seconds and mark fallback", () => {
  const a = scenesOf(shots, 135);
  assert.equal(a.scenes.length, 27);
  assert.equal(a.scenes[0].index, 1);
  assert.equal(a.fallback, undefined);
  const b = scenesOf(null, 33);
  assert.equal(b.fallback, "fixed-interval");
  assert.deepEqual(b.scenes.map((s) => [s.start, s.end]), [[0, 10], [10, 20], [20, 30], [30, 33]]);
  assert.equal(scenesOf(null, 0).scenes.length, 0);
});

test("planSequences: default 6 per page; paging; maximum 12", () => {
  const all = scenesOf(shots, 135).scenes;
  const p1 = planSequences(all, {});
  assert.equal(p1.perPage, 6);
  assert.equal(p1.pages, 5);
  assert.equal(p1.page, 1);
  assert.equal(p1.nextPage, 2);
  assert.equal(p1.prevPage, null);
  assert.deepEqual(p1.scenes.map((s) => s.index), [1, 2, 3, 4, 5, 6]);
  const p5 = planSequences(all, { page: 5 });
  assert.deepEqual(p5.scenes.map((s) => s.index), [25, 26, 27]);
  assert.equal(p5.nextPage, null);
  assert.equal(planSequences(all, { page: 99 }).page, 5, "A page out of range is clamped back to the last page");
  assert.equal(planSequences(all, { perPage: 100 }).perPage, MAX_PER_PAGE);
  assert.equal(planSequences(all, { grid: 9 }).grid, 9);
  assert.equal(planSequences(all, { grid: 5 }).grid, 4, "Only 4 / 9 are accepted");
});

test("planSequences: from / to filter first and then paginate, shots crossing the boundary count too; viewing a single scene defaults to 9 cells", () => {
  const all = scenesOf(shots, 135).scenes;
  const p = planSequences(all, { from: 12, to: 33 });
  assert.deepEqual(p.scenes.map((s) => s.index), [3, 4, 5, 6, 7]);
  assert.equal(p.matched, 5);
  assert.equal(p.pages, 1);
  const one = planSequences(all, { scene: 9, page: 3 });
  assert.deepEqual(one.scenes.map((s) => s.index), [9]);
  assert.equal(one.grid, 9);
  assert.equal(one.pages, 1);
  assert.throws(() => planSequences(all, { scene: 28 }), /between 1 and 27/);
  assert.throws(() => planSequences(all, { from: 50, to: 10 }), /from must not be greater than to/);
});

test("frameTimes: evenly spaced, with the start shifted slightly later; 4 cells and 9 cells", () => {
  assert.deepEqual(frameTimes(10, 14, 4), [10.05, 11.04, 12.03, 13.01]);
  assert.equal(frameTimes(0, 9, 9).length, 9);
  assert.equal(frameTimes(3, 3.01, 4).length, 4, "Even a very short shot gets grid time points");
});

test("transcriptFor: take the caption segments that overlap the range", () => {
  const tr = { engine: "x", model: "y", createdAt: "", segments: [{ start: 0, end: 4, text: "A" }, { start: 4, end: 9, text: " B " }, { start: 9, end: 12, text: "C" }] };
  assert.equal(transcriptFor(tr, 5, 10), "B C");
  assert.equal(transcriptFor(tr, 20, 30), "");
  assert.equal(transcriptFor(undefined, 0, 1), "");
});
