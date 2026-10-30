// node --test src/ai/sequences.test.mjs —— see_frames 素材模式(source: "media")的规划逻辑
import test from "node:test";
import assert from "node:assert/strict";

import { scenesOf, planSequences, frameTimes, transcriptFor, MAX_PER_PAGE } from "./sequences.ts";

const shots = {
  engine: "transnetv2", createdAt: "", transitions: [],
  shots: Array.from({ length: 27 }, (_, i) => ({ start: i * 5, end: (i + 1) * 5, inTransition: i ? "cut" : null, outTransition: i < 26 ? "cut" : null })),
};

test("scenesOf:有镜头结果按镜头来,序号从 1 起;没有就按 10 秒切并标 fallback", () => {
  const a = scenesOf(shots, 135);
  assert.equal(a.scenes.length, 27);
  assert.equal(a.scenes[0].index, 1);
  assert.equal(a.fallback, undefined);
  const b = scenesOf(null, 33);
  assert.equal(b.fallback, "fixed-interval");
  assert.deepEqual(b.scenes.map((s) => [s.start, s.end]), [[0, 10], [10, 20], [20, 30], [30, 33]]);
  assert.equal(scenesOf(null, 0).scenes.length, 0);
});

test("planSequences:默认 6 张一页;翻页;上限 12", () => {
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
  assert.equal(planSequences(all, { page: 99 }).page, 5, "超出的页夹回最后一页");
  assert.equal(planSequences(all, { perPage: 100 }).perPage, MAX_PER_PAGE);
  assert.equal(planSequences(all, { grid: 9 }).grid, 9);
  assert.equal(planSequences(all, { grid: 5 }).grid, 4, "只认 4 / 9");
});

test("planSequences:from / to 先筛再分页,跨边界的镜头也算;scene 单看一个默认 9 格", () => {
  const all = scenesOf(shots, 135).scenes;
  const p = planSequences(all, { from: 12, to: 33 });
  assert.deepEqual(p.scenes.map((s) => s.index), [3, 4, 5, 6, 7]);
  assert.equal(p.matched, 5);
  assert.equal(p.pages, 1);
  const one = planSequences(all, { scene: 9, page: 3 });
  assert.deepEqual(one.scenes.map((s) => s.index), [9]);
  assert.equal(one.grid, 9);
  assert.equal(one.pages, 1);
  assert.throws(() => planSequences(all, { scene: 28 }), /1~27/);
  assert.throws(() => planSequences(all, { from: 50, to: 10 }), /from 不能大于 to/);
});

test("frameTimes:等间隔,起点略后挪;4 格和 9 格", () => {
  assert.deepEqual(frameTimes(10, 14, 4), [10.05, 11.04, 12.03, 13.01]);
  assert.equal(frameTimes(0, 9, 9).length, 9);
  assert.equal(frameTimes(3, 3.01, 4).length, 4, "极短镜头也给 grid 个时间点");
});

test("transcriptFor:取和区间有交集的字幕段", () => {
  const tr = { engine: "x", model: "y", createdAt: "", segments: [{ start: 0, end: 4, text: "甲" }, { start: 4, end: 9, text: " 乙 " }, { start: 9, end: 12, text: "丙" }] };
  assert.equal(transcriptFor(tr, 5, 10), "乙 丙");
  assert.equal(transcriptFor(tr, 20, 30), "");
  assert.equal(transcriptFor(undefined, 0, 1), "");
});
