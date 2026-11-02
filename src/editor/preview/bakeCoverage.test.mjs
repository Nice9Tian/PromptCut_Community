/**
 * 绿条覆盖范围的单测。跑:node --test src/editor/preview/bakeCoverage.test.mjs
 *
 * 这条绿条要么是可信的,要么就该拆掉:它承诺的是「绿的地方拖过去立刻有画面」。
 * 画多了就是骗人(拖过去还要等五秒,条却是绿的),画少了就白等。所以把意图钉死:
 *   - 一个预渲染好的时刻覆盖到**同一张卡的下一个时刻**为止,最后一个管到卡结束;
 *   - 没渲的时刻不产生任何绿色;
 *   - 相邻的段要合并,不能画成一排带缝的小块;
 *   - 覆盖范围不能超出这张卡自己的区间。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { coverageSegments } from "./bakeCoverage.ts";

/** 造一张卡的若干时刻 */
const spread = (clipId, start, end, ts) => ts.map((t) => ({ clipId, t, start, end }));
const all = () => true;
const none = () => false;

test("A prerendered moment covers up to the next moment of the same card", () => {
  const m = spread("a", 0, 4, [0, 1, 2]);
  // 只有 t=1 渲好了 → 覆盖 [1,2),不该蔓延到 0 或 2 之后
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
  // 渲了 0 和 3,中间 1、2 没渲
  const segs = coverageSegments(m, (x) => x.t === 0 || x.t === 3);
  assert.deepEqual(segs, [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
});

test("A moment covers up to the next moment, and **never searches across cards**", () => {
  // 两张卡首尾相接:a 的最后一个时刻只能管到 a 结束,不能借用 b 的时刻
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
  // 构造一个越界的时刻表(理论上不该出现,但越界的绿条是会骗人的,得兜住)
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
  // 模拟 sampleTimesFor 的累加:0, 0.25, 0.5, ... 末位有误差
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

/* ── 改一张卡:只有这一张的覆盖作废,而且是当帧作废 ─────────────── */

const { visibleCoverage, clipFingerprint, momentId } = await import("./bakeCoverage.ts");

/**
 * 造一张卡的覆盖:[a,b) 里按 step 铺时刻。覆盖表存的是**事实**(有哪些时刻),
 * 段落由 visibleCoverage 现算 —— 这样前台渲完只要往 baked 里加一个 id 就行。
 */
const CC = (clipId, fp, a, b, step = 1) => {
  const moments = [];
  for (let t = a; t < b - 1e-9; t += step) {
    moments.push({ clipId, id: momentId(clipId, t), t, start: a, end: b, tier: "coarse", fine: true });
  }
  return { clipId, fp, start: a, moments };
};
/** 把这几张卡的所有时刻都标成已渲 */
const allBaked = (clips) => new Set(clips.flatMap((c) => c.moments.map((m) => m.id)));
const COV = (clips, baked) => ({ clips, baked: baked ?? allBaked(clips), bakingAt: null, bytes: 0 });

test("A changed: only the segment of A disappears, B is not affected at all", () => {
  const cov = COV([CC("a", "fpA", 0, 2), CC("b", "fpB", 10, 12)]);
  // 用户改了 A 的参数 → A 的指纹变了,B 没变
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
  const a = CC("a", "fpA", 0, 3);           // 三个时刻:0 / 1 / 2
  const cov = COV([a], new Set());           // 一个都没渲
  const live = new Map([["fpA", 0]]);
  assert.deepEqual(visibleCoverage(cov, live).coarse, [], "With nothing prerendered there is no color");

  // 只渲中间那一刻 → 只覆盖 [1,2)
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

/* ── 前台现场渲染完也要记账,否则条子慢半拍 ─────────────────────── */

test("markBaked makes \"the moment that was just prerendered\" count toward the coverage immediately", async () => {
  const m = await import("./bakeCoverage.ts");
  const a = CC("a", "fpA", 0, 3);
  m.publishCoverage({ clips: [a], baked: new Set(), bakingAt: null, bytes: 0 });
  const live = new Map([["fpA", 0]]);
  assert.deepEqual(m.visibleCoverage(m.getCoverage(), live).coarse, [], "Not prerendered yet, no color");

  // 前台现场渲染完了那一刻 —— 只给一个 id,不用重新盘点、不用重算段
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
  // 同一个 id 再标一次不该白通知一遍(条子没变化,重画是浪费)
  m.markBaked([momentId("a", 0)]);
  assert.equal(hits, 1, "Marking again should not notify again");
  off();
});

/* ── 挪一下位置 / 剪短一点:条子必须当帧说实话 ─────────────────────
 *
 * 这两条是从一次实测来的:项目里六张卡全部渲好、条子全绿,把 [20,24] 那张挪到 27 秒,
 * 条子**仍然在 [20,24] 上画着绿**,而那块时间轴已经空了,`stale` 还报 0。
 * 指纹里故意不带时间轴位置(挪一下像素不变),所以光看指纹看不出卡挪没挪;
 * 而每个时刻记的都是绝对秒,卡走了它们还留在原地。
 */

test("Card moved elsewhere: the green segment moves with it, instead of staying in place and misleading", () => {
  const cov = COV([CC("a", "fpA", 20, 24)]);
  // 指纹没变(挪位置不改像素),但起点从 20 变成 27
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

test("The fingerprint is a denylist: changing any field on a clip other than the position must invalidate", () => {
  const base = { id: "c1", cardId: "odometer", params: { to: 1 }, start: 0, end: 4 };
  // 这几样都进了服务端的缓存键(bakeTarget 只摘掉 frame),漏一个就是「改完还是绿的」
  for (const [fieldName, editedClip] of [
    ["emphasis", { ...base, emphasis: { kind: "shadow" } }],
    ["motion", { ...base, motion: { pathId: "p1" } }],
    ["fadeIn", { ...base, fadeIn: 0.5 }],
    ["opacity", { ...base, opacity: 0.5 }],
    ["parts", { ...base, parts: [{ id: "p" }] }],
  ]) {
    assert.notEqual(clipFingerprint(editedClip), clipFingerprint(base), `Changing ${fieldName} must invalidate`);
  }
});

/* ── 本来就没东西要渲的那几段,也该是有色的 ──────────────────────
 *
 * 用户报的现象:「有时候某一段时间没有素材,时间条那里永远不会变绿」。
 * 那几秒拖过去立刻就是它该有的样子(空的),按条子的契约就该有色;
 * 一直留白的话,用户分不清「还没渲」和「本来就没东西」,看上去像预渲染卡死了。
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
