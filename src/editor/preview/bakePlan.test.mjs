/**
 * 预渲染排队算法的单测。跑:node --test src/editor/preview/bakePlan.test.mjs
 *
 * 这套东西错了不会报错,只会「有时候要等五秒」或者「out/media 里悄悄堆几千个文件」——
 * 最难查的那一类。所以把意图钉死:
 *   - 屏幕上正显示的那几个时刻永远排最前,而且**不受预算限制**;
 *   - 其余按离播放头的距离两侧交替,一样远时优先往后;
 *   - 更远的从 0 开始按时间铺;
 *   - 占用只算**已经渲出来的文件的真实字节**,没渲的不占,不估;
 *   - 对不上号的文件排最后:空间够就留着,不够才最先被挤出去。
 *
 * 这些用例做过变异测试:把上面每一条分别改坏,都至少有一个用例挂。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { planBakes, distanceFrom, isLive, defaultBudgetBytes } from "./bakePlan.ts";

/** 造一个时刻。键默认按「卡 + 时刻」拼,和 bakeTime.ts 的 texKeyOf 一个意思 */
const M = (clipId, t, start, end, key) => ({ clipId, t, start, end, key: key ?? `${clipId}@${t}` });
/** 把一张卡摊成若干个时刻(模拟 sampleTimesFor) */
const spread = (clipId, start, end, n) =>
  Array.from({ length: n }, (_, i) => M(clipId, start + ((end - start) * i) / n, start, end));

const plan = (over = {}) =>
  planBakes({
    moments: over.moments ?? [],
    t: over.t ?? 0,
    budgetBytes: over.budgetBytes ?? 120 * 1024 * 1024,
    known: over.known ?? new Map(),
    ...(over.nearWindowSec !== undefined ? { nearWindowSec: over.nearWindowSec } : {}),
  });

test("The moment currently shown on screen is queued first", () => {
  const moments = [...spread("a", 0, 5, 3), ...spread("b", 5, 10, 3), ...spread("c", 10, 15, 3)];
  const p = plan({ moments, t: 7 });
  assert.equal(p.jobs[0].clipId, "b", "t=7 falls on b");
  assert.equal(p.jobs[0].phase, "current");
  // b 的三个时刻是 5 / 6.67 / 8.33,离 7 最近的是 6.67
  assert.ok(Math.abs(p.jobs[0].t - 6.666) < 0.01, `Should pick the moment closest to the current time, got ${p.jobs[0].t}`);
});

test("Even while a card is playing, only the \"closest to now\" moment counts as current", () => {
  const moments = spread("a", 0, 10, 5); // 0 / 2 / 4 / 6 / 8
  const p = plan({ moments, t: 4.4 });
  const cur = p.jobs.filter((j) => j.phase === "current");
  assert.equal(cur.length, 1, "Only one moment of the same card is current");
  assert.equal(cur[0].t, 4);
  // 同一张卡后面几秒的样子也要渲,只是不和「现在这一帧」抢优先级
  assert.equal(p.jobs.length, 5);
  assert.deepEqual(p.jobs.slice(1).map((j) => j.phase), ["near", "near", "near", "near"]);
});

test("When several cards are on screen at once, each yields its own current", () => {
  // 叠在一起的两张卡(不同轨道)
  const moments = [...spread("a", 0, 10, 3), ...spread("b", 0, 10, 3)];
  const p = plan({ moments, t: 5 });
  const cur = p.jobs.filter((j) => j.phase === "current");
  assert.equal(cur.length, 2);
  assert.deepEqual(cur.map((j) => j.clipId).sort(), ["a", "b"]);
});

test("The rest spread out to both sides by distance from the playhead, preferring later ones when equally far", () => {
  const moments = [
    M("cur", 10, 9.5, 10.5),   // 正在播
    M("back", 9, 8, 9),        // 距离 1
    M("fwd", 11, 11, 12),      // 距离 1(和 back 等距)
    M("far-back", 2, 0, 2),    // 距离 8
    M("far-fwd", 19.5, 19, 21),// 距离 9.5
  ];
  const order = plan({ moments, t: 10 }).jobs.map((j) => j.clipId);
  assert.equal(order[0], "cur", "The one currently playing comes first");
  assert.deepEqual(order.slice(1, 3), ["fwd", "back"], `When equidistant, the later one should come first, got ${order}`);
  assert.deepEqual(order.slice(3), ["far-back", "far-fwd"], "Further out by distance, 8 is closer than 9.5");
});

test("Moments outside the \"nearby\" window are laid out from 0 in time order", () => {
  const moments = [
    M("z", 100, 100, 101),
    M("head", 0.5, 0, 1),
    M("mid", 50, 50, 51),
    M("cur", 200.5, 200, 201),
  ];
  const p = plan({ moments, t: 200.5, nearWindowSec: 5 });
  const order = p.jobs.map((j) => j.clipId);
  assert.equal(order[0], "cur");
  assert.deepEqual(order.slice(1), ["head", "mid", "z"], "Starting from 0, not from near to far");
  assert.deepEqual(p.jobs.slice(1).map((j) => j.phase), ["rest", "rest", "rest"]);
});

test("Those not yet prerendered take no space: there is no such file on disk at all", () => {
  const moments = [...spread("a", 0, 5, 4), ...spread("b", 10, 15, 4)];
  const p = plan({ moments, t: 1, budgetBytes: 1 });
  assert.equal(p.footprintBytes, 0, "With nothing prerendered, usage is 0");
  assert.equal(p.dropped, 0, "Even with a budget of only 1 byte nothing should be dropped: they take no space anyway");
  assert.equal(p.jobs.length, 8, "All eight moments should be queued for prerendering");
});

test("Usage is the sum of **measured bytes**, so files of different sizes count differently", () => {
  // 实测同一批贴图 2.4KB~95KB 都有
  const moments = [M("small", 1, 0, 5), M("big", 12, 10, 15)];
  const p = plan({ moments, t: 1, known: new Map([["small@1", 2366], ["big@12", 95118]]) });
  assert.equal(p.footprintBytes, 2366 + 95118);
  assert.deepEqual(p.keep.map((k) => k.bytes).sort((a, b) => a - b), [2366, 95118]);
});

test("The budget cuts off by bytes, not by number of images", () => {
  const moments = [M("big", 5.5, 5, 6), M("s1", 7.5, 7, 8), M("s2", 9.5, 9, 10)];
  const known = new Map([["big@5.5", 95118], ["s1@7.5", 2366], ["s2@9.5", 2366]]);
  // 预算 6KB:装不下那个大的,但两个小的都装得下
  const p = plan({ moments, t: 0, budgetBytes: 6000, known, nearWindowSec: 100 });
  assert.deepEqual(p.keep.map((k) => k.clipId).sort(), ["s1", "s2"], "Counting by number of images would keep only one here");
  assert.deepEqual(p.evict, ["big@5.5"]);
  assert.equal(p.dropped, 1);
});

test("Those already prerendered do not go into jobs again", () => {
  const moments = [M("a", 1, 0, 5), M("b", 12, 10, 15)];
  const p = plan({ moments, t: 1, known: new Map([["a@1", 40000]]) });
  assert.deepEqual(p.jobs.map((j) => j.clipId), ["b"], "a already exists, so there is no need to render it again");
  assert.deepEqual(p.keep.map((k) => k.clipId), ["a"]);
  assert.equal(p.footprintBytes, 40000);
});

test("The one being viewed is not limited by the budget: it must never be deleted, however small the budget", () => {
  const moments = [M("cur", 2, 0, 5), M("other", 12, 10, 15)];
  const known = new Map([["cur@2", 95118], ["other@12", 2366]]);
  const p = plan({ moments, t: 2, budgetBytes: 1, known });
  assert.deepEqual(p.keep.map((k) => k.clipId), ["cur"]);
  assert.equal(p.keep[0].phase, "current");
  assert.ok(p.footprintBytes > 1, "It did exceed the budget, but was kept anyway");
  assert.deepEqual(p.evict, ["other@12"], "Others are still deleted as usual");
});

test("Old files that match nothing: keep them if there is room, and do not delete them just because they are \"not from this project\"", () => {
  const moments = [M("a", 1, 0, 5)];
  const old1 = "a@1|old params";
  const other = "card of another project@3";
  const known = new Map([["a@1", 40000], [old1, 38000], [other, 50000]]);
  const p = plan({ moments, t: 1, known });
  assert.deepEqual(p.evict, [], "Plenty of space, nothing should be deleted: the cache should be kept anyway");
  assert.equal(p.footprintBytes, 40000 + 38000 + 50000, "But they do take up space and must be counted");
  assert.deepEqual(p.keep.filter((k) => k.phase === "spare").map((k) => k.key).sort(), [old1, other].sort());
});

test("When space runs short, the ones that match nothing are evicted first", () => {
  const moments = [M("a", 1, 0, 5), M("b", 12, 10, 15)];
  const other = "card of another project@3";
  const known = new Map([["a@1", 40000], ["b@12", 40000], [other, 40000]]);
  const p = plan({ moments, t: 1, budgetBytes: 90000, known });
  assert.deepEqual(p.evict, [other], "Evict the unclaimed ones first, not those of the current project");
  assert.deepEqual(p.keep.map((k) => k.clipId), ["a", "b"]);
  assert.equal(p.dropped, 1);
});

test("What to keep and what to delete never overlap, and every file on disk is accounted for", () => {
  const moments = [M("a", 1, 0, 5), M("b", 12, 10, 15), M("c", 102, 100, 105)];
  const stale = "long-stale key@9";
  const known = new Map([["a@1", 40000], ["b@12", 40000], ["c@102", 40000], [stale, 40000]]);
  const p = plan({ moments, t: 1, budgetBytes: 85000, known });
  const keptKeys = new Set(p.keep.map((k) => k.key));
  for (const e of p.evict) assert.ok(!keptKeys.has(e), `${e} is both to be kept and to be deleted`);
  assert.equal(p.keep.length + p.evict.length, known.size);
  assert.ok(p.footprintBytes <= 85000);
});

test("The same key appearing twice counts only once", () => {
  const dup = M("dup", 1, 0, 5);
  const p = plan({ moments: [dup, { ...dup }], t: 1 });
  assert.equal(p.jobs.length, 1, "The same key is rendered only once");
  const p2 = plan({ moments: [dup, { ...dup }], t: 1, known: new Map([["dup@1", 40000]]) });
  assert.equal(p2.keep.length, 1);
  assert.equal(p2.footprintBytes, 40000, "Must not be counted twice");
});

test("Distance is computed from the time of the moment itself; whether it is playing is computed from the interval of the card", () => {
  const m = M("x", 12, 10, 20);
  assert.equal(distanceFrom(m, 12), 0);
  assert.equal(distanceFrom(m, 15), 3);
  assert.equal(distanceFrom(m, 8), 4);
  assert.equal(isLive(m, 15), true, "The playhead is inside the interval");
  assert.equal(isLive(m, 20), false, "The right endpoint is open (exclusive), handed over to the next card");
  assert.equal(isLive(m, 10), true, "The left endpoint is included");
});

test("The budget is tiered by machine memory, with lower and upper limits", () => {
  assert.equal(defaultBudgetBytes(8), Math.round(8 * 1024 ** 3 * 0.015));
  assert.equal(defaultBudgetBytes(undefined), defaultBudgetBytes(4), "If memory cannot be obtained, assume 4GB");
  assert.equal(defaultBudgetBytes(0.25), 64 * 1024 * 1024, "Machines that are too small are floored at 64MB");
  assert.equal(defaultBudgetBytes(1024), 512 * 1024 * 1024, "However large, capped at 512MB");
  // 按实测平均 55KB 一个、一张卡十来个时刻算,8GB 的机器够放一两百张卡
  assert.ok(defaultBudgetBytes(8) / 55000 / 12 > 100);
});

/* ── 两档:低帧率全部铺完,才开始原始帧率 ─────────────────────── */

const MT = (clipId, t, start, end, tier) => ({ clipId, t, start, end, tier, key: `${clipId}@${t}#${tier}` });

test("The low frame rate tier is queued completely before the original frame rate gets its turn", () => {
  const moments = [
    // 原始帧率的放在数组前面,故意让"照数组顺序"这种写法露馅
    MT("a", 0.1, 0, 2, "full"), MT("a", 0.2, 0, 2, "full"),
    MT("a", 0, 0, 2, "coarse"), MT("b", 10, 10, 12, "coarse"),
  ];
  const p = planBakes({ moments, t: 0, budgetBytes: 1e9, known: new Map() });
  const tiers = p.jobs.map((j) => j.tier);
  assert.deepEqual(tiers, ["coarse", "coarse", "full", "full"], `Got ${tiers}`);
});

test("Even if the original-frame-rate one is right at the playhead, wait until all the low-frame-rate ones are laid out", () => {
  const moments = [
    MT("cur", 5, 5, 7, "full"),      // 正在播,而且是精确那一档
    MT("far", 100, 100, 102, "coarse"), // 离得很远,但属于低帧率档
  ];
  const p = planBakes({ moments, t: 5, budgetBytes: 1e9, known: new Map() });
  assert.deepEqual(p.jobs.map((j) => j.clipId), ["far", "cur"],
    "Covering the whole video at the low frame rate first is more useful than making the frame right in front exact");
});

test("Within each tier the order is still \"in front → both sides → from 0\"", () => {
  const moments = [
    MT("c-far", 50, 50, 52, "coarse"),
    MT("c-cur", 5, 5, 7, "coarse"),
    MT("c-near", 8, 8, 9, "coarse"),
    MT("f-far", 50, 50, 52, "full"),
    MT("f-cur", 5, 5, 7, "full"),
  ];
  const p = planBakes({ moments, t: 5, budgetBytes: 1e9, known: new Map(), nearWindowSec: 10 });
  assert.deepEqual(p.jobs.map((j) => j.clipId), ["c-cur", "c-near", "c-far", "f-cur", "f-far"]);
  assert.deepEqual(p.jobs.map((j) => j.phase), ["current", "near", "rest", "current", "rest"]);
});

test("Entries without a tier are treated as low frame rate (old callers do not drop to the end because of this)", () => {
  const moments = [
    { clipId: "old", t: 1, start: 0, end: 2, key: "old@1" },
    MT("newfull", 1.1, 0, 2, "full"),
  ];
  const p = planBakes({ moments, t: 1, budgetBytes: 1e9, known: new Map() });
  assert.deepEqual(p.jobs.map((j) => j.tier), ["coarse", "full"]);
  assert.equal(p.jobs[0].clipId, "old");
});

/* ── 归到帧号:两档格子对得上账的前提 ─────────────────────────── */

test("Canonicalization is the second line of defense: an accumulated value is also mapped back to the same frame", async () => {
  const { canonFrameT } = await import("./bakePlan.ts");
  /*
   * bakeTime.ts 现在按序号乘(gridAt),所以它自己产出的值已经对得齐了 ——
   * 这条不再依赖它产出不齐的值,而是**自己造**一组累加出来的(那正是历史上出问题的形状),
   * 证明 canonFrameT 能把它们归回和「按序号乘」一样的那个浮点数。
   *
   * 留着这道防线是因为时刻不一定都来自 sampleTimesFor:换个步长、从别处传进来,
   * 都可能带着表示误差,而缓存键是对这个浮点数做哈希的,差一位就是两个文件。
   */
  for (const fps of [30, 24, 25, 60]) {
    const step = 1 / fps;
    let drifted = 0;
    let sawDrift = false;
    for (let i = 0; i < 60; i++) {
      const byMul = i * step;               // 按序号乘(bakeTime 现在的做法)
      if (drifted !== byMul) sawDrift = true;
      assert.equal(
        canonFrameT(drifted, 0, fps),
        canonFrameT(byMul, 0, fps),
        `${fps}fps frame ${i}: accumulated value ${drifted} and multiplied value ${byMul} still differ after canonicalization`,
      );
      drifted += step;                      // 累加(历史上出问题的做法)
    }
    assert.ok(sawDrift, `${fps}fps: accumulating and multiplying are somehow bit-for-bit identical, so this case has lost its meaning`);
  }
});

test("Quantizing to a fixed number of decimal places is wrong (it steps back a whole frame): noted, do not try it again", async () => {
  const { sampleTimesFor, pickBakeT } = await import("./bakeTime.ts");
  const clip = { id: "c", cardId: "x", start: 0, end: 2, params: {} };
  const motion = { settleMs: 0, after: "evolve" };
  const step = 1 / 30;
  const q = (t) => Math.round(t * 1e6) / 1e6;   // 微秒量化:看着合理,其实不成立
  const bad = sampleTimesFor(clip, motion, { stepSec: step, maxPerClip: 10000 })
    .map(q)
    .filter((t) => q(pickBakeT(clip, motion, t, { stepSec: step })) !== t).length;
  assert.ok(bad > 0, "Microsecond quantization somehow works? Then reevaluate whether canonFrameT is still needed");
});

test("Canonicalization is idempotent and keeps adjacent frames distinct", async () => {
  const { canonFrameT } = await import("./bakePlan.ts");
  for (const v of [0, 0.19999999999999998, 0.2, 1 / 3, 2.5, 0.5]) {
    assert.equal(canonFrameT(canonFrameT(v, 0, 30), 0, 30), canonFrameT(v, 0, 30), `${v} differs when canonicalized twice`);
  }
  assert.notEqual(canonFrameT(10 / 60, 0, 60), canonFrameT(11 / 60, 0, 60), "If adjacent frames are merged into one cell, the frames can no longer be told apart");
});

test("Canonicalization makes the low frame rate a subset of the per-frame grid: this is the **main** reason canonFrameT exists now", async () => {
  const { canonFrameT } = await import("./bakePlan.ts");
  const { sampleTimesFor } = await import("./bakeTime.ts");
  const clip = { id: "c", cardId: "x", start: 0, end: 2, params: {} };
  const motion = { settleMs: 0, after: "evolve" };
  const fps = 30;
  const fineRaw = sampleTimesFor(clip, motion, { stepSec: 1 / fps, maxPerClip: 10000 });
  const coarseRaw = sampleTimesFor(clip, motion, { stepSec: 0.25 });

  /*
   * 先证明**不归一就是对不上的**:30fps 下 0.25 秒 = 7.5 帧,所以 0.25 / 0.75 / 1.25 / 1.75
   * 根本不落在帧格子上。对不上的后果是同一瞬间渲两遍,而且低帧率那张不算进绿条的覆盖。
   */
  const fineSetRaw = new Set(fineRaw);
  const missRaw = coarseRaw.filter((t) => !fineSetRaw.has(t));
  assert.ok(missRaw.length > 0, "It matches even without canonicalization? Then this function can be deleted");

  const fine = new Set(fineRaw.map((t) => canonFrameT(t, 0, fps)));
  for (const t of coarseRaw) {
    assert.ok(fine.has(canonFrameT(t, 0, fps)), `Low-frame-rate ${t} is still not on the per-frame grid after canonicalization`);
  }
});
