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

test("屏幕上正显示的那个时刻排最前", () => {
  const moments = [...spread("a", 0, 5, 3), ...spread("b", 5, 10, 3), ...spread("c", 10, 15, 3)];
  const p = plan({ moments, t: 7 });
  assert.equal(p.jobs[0].clipId, "b", "t=7 落在 b 上");
  assert.equal(p.jobs[0].phase, "current");
  // b 的三个时刻是 5 / 6.67 / 8.33,离 7 最近的是 6.67
  assert.ok(Math.abs(p.jobs[0].t - 6.666) < 0.01, `该挑最贴近当前时间的那个时刻,实得 ${p.jobs[0].t}`);
});

test("一张卡在播,也只有「最贴近现在」的那个时刻算 current", () => {
  const moments = spread("a", 0, 10, 5); // 0 / 2 / 4 / 6 / 8
  const p = plan({ moments, t: 4.4 });
  const cur = p.jobs.filter((j) => j.phase === "current");
  assert.equal(cur.length, 1, "同一张卡只有一个时刻是 current");
  assert.equal(cur[0].t, 4);
  // 同一张卡后面几秒的样子也要渲,只是不和「现在这一帧」抢优先级
  assert.equal(p.jobs.length, 5);
  assert.deepEqual(p.jobs.slice(1).map((j) => j.phase), ["near", "near", "near", "near"]);
});

test("同时有几张卡在画面上,每张都各出一个 current", () => {
  // 叠在一起的两张卡(不同轨道)
  const moments = [...spread("a", 0, 10, 3), ...spread("b", 0, 10, 3)];
  const p = plan({ moments, t: 5 });
  const cur = p.jobs.filter((j) => j.phase === "current");
  assert.equal(cur.length, 2);
  assert.deepEqual(cur.map((j) => j.clipId).sort(), ["a", "b"]);
});

test("其余按离播放头的距离往两侧展开,一样远时优先往后", () => {
  const moments = [
    M("cur", 10, 9.5, 10.5),   // 正在播
    M("back", 9, 8, 9),        // 距离 1
    M("fwd", 11, 11, 12),      // 距离 1(和 back 等距)
    M("far-back", 2, 0, 2),    // 距离 8
    M("far-fwd", 19.5, 19, 21),// 距离 9.5
  ];
  const order = plan({ moments, t: 10 }).jobs.map((j) => j.clipId);
  assert.equal(order[0], "cur", "正在播的最先");
  assert.deepEqual(order.slice(1, 3), ["fwd", "back"], `等距时该先往后,实得 ${order}`);
  assert.deepEqual(order.slice(3), ["far-back", "far-fwd"], "再往外按距离,8 比 9.5 近");
});

test("超出「身边」窗口的从 0 开始按时间顺序铺", () => {
  const moments = [
    M("z", 100, 100, 101),
    M("head", 0.5, 0, 1),
    M("mid", 50, 50, 51),
    M("cur", 200.5, 200, 201),
  ];
  const p = plan({ moments, t: 200.5, nearWindowSec: 5 });
  const order = p.jobs.map((j) => j.clipId);
  assert.equal(order[0], "cur");
  assert.deepEqual(order.slice(1), ["head", "mid", "z"], "从 0 开始,不是从近到远");
  assert.deepEqual(p.jobs.slice(1).map((j) => j.phase), ["rest", "rest", "rest"]);
});

test("还没预渲染的不占空间 —— 磁盘上根本没这个文件", () => {
  const moments = [...spread("a", 0, 5, 4), ...spread("b", 10, 15, 4)];
  const p = plan({ moments, t: 1, budgetBytes: 1 });
  assert.equal(p.footprintBytes, 0, "一个都没预渲染,占用就是 0");
  assert.equal(p.dropped, 0, "预算只有 1 字节也不该丢 —— 它们本来就不占");
  assert.equal(p.jobs.length, 8, "八个时刻都该排进待预渲染队列");
});

test("占用是**实测字节**加出来的,不同大小的文件算得不一样", () => {
  // 实测同一批贴图 2.4KB~95KB 都有
  const moments = [M("small", 1, 0, 5), M("big", 12, 10, 15)];
  const p = plan({ moments, t: 1, known: new Map([["small@1", 2366], ["big@12", 95118]]) });
  assert.equal(p.footprintBytes, 2366 + 95118);
  assert.deepEqual(p.keep.map((k) => k.bytes).sort((a, b) => a - b), [2366, 95118]);
});

test("预算按字节截断,不是按张数", () => {
  const moments = [M("big", 5.5, 5, 6), M("s1", 7.5, 7, 8), M("s2", 9.5, 9, 10)];
  const known = new Map([["big@5.5", 95118], ["s1@7.5", 2366], ["s2@9.5", 2366]]);
  // 预算 6KB:装不下那个大的,但两个小的都装得下
  const p = plan({ moments, t: 0, budgetBytes: 6000, known, nearWindowSec: 100 });
  assert.deepEqual(p.keep.map((k) => k.clipId).sort(), ["s1", "s2"], "按张数算的话这里只会留一张");
  assert.deepEqual(p.evict, ["big@5.5"]);
  assert.equal(p.dropped, 1);
});

test("已经预渲染好的不再进 jobs", () => {
  const moments = [M("a", 1, 0, 5), M("b", 12, 10, 15)];
  const p = plan({ moments, t: 1, known: new Map([["a@1", 40000]]) });
  assert.deepEqual(p.jobs.map((j) => j.clipId), ["b"], "a 已经有了,不用再渲染");
  assert.deepEqual(p.keep.map((k) => k.clipId), ["a"]);
  assert.equal(p.footprintBytes, 40000);
});

test("正在看的那一张不受预算限制 —— 预算再小也不能把它删掉", () => {
  const moments = [M("cur", 2, 0, 5), M("other", 12, 10, 15)];
  const known = new Map([["cur@2", 95118], ["other@12", 2366]]);
  const p = plan({ moments, t: 2, budgetBytes: 1, known });
  assert.deepEqual(p.keep.map((k) => k.clipId), ["cur"]);
  assert.equal(p.keep[0].phase, "current");
  assert.ok(p.footprintBytes > 1, "它确实超了预算,但还是留下了");
  assert.deepEqual(p.evict, ["other@12"], "别的照删不误");
});

test("对不上号的旧文件:空间够就留着,不能因为「不是这个项目的」就删", () => {
  const moments = [M("a", 1, 0, 5)];
  const old1 = "a@1|旧参数";
  const other = "别的项目的卡@3";
  const known = new Map([["a@1", 40000], [old1, 38000], [other, 50000]]);
  const p = plan({ moments, t: 1, known });
  assert.deepEqual(p.evict, [], "空间富裕,一个都不该删 —— 缓存本来就该留着");
  assert.equal(p.footprintBytes, 40000 + 38000 + 50000, "但它们确实占着空间,要算进去");
  assert.deepEqual(p.keep.filter((k) => k.phase === "spare").map((k) => k.key).sort(), [old1, other].sort());
});

test("空间不够时,对不上号的那些最先被挤出去", () => {
  const moments = [M("a", 1, 0, 5), M("b", 12, 10, 15)];
  const other = "别的项目的卡@3";
  const known = new Map([["a@1", 40000], ["b@12", 40000], [other, 40000]]);
  const p = plan({ moments, t: 1, budgetBytes: 90000, known });
  assert.deepEqual(p.evict, [other], "先挤没人认领的,不是先挤当前项目的");
  assert.deepEqual(p.keep.map((k) => k.clipId), ["a", "b"]);
  assert.equal(p.dropped, 1);
});

test("要留的和要删的绝不重叠,而且磁盘上每个文件都有个说法", () => {
  const moments = [M("a", 1, 0, 5), M("b", 12, 10, 15), M("c", 102, 100, 105)];
  const stale = "陈年旧键@9";
  const known = new Map([["a@1", 40000], ["b@12", 40000], ["c@102", 40000], [stale, 40000]]);
  const p = plan({ moments, t: 1, budgetBytes: 85000, known });
  const keptKeys = new Set(p.keep.map((k) => k.key));
  for (const e of p.evict) assert.ok(!keptKeys.has(e), `${e} 既要留又要删`);
  assert.equal(p.keep.length + p.evict.length, known.size);
  assert.ok(p.footprintBytes <= 85000);
});

test("同一个键出现两次只算一份", () => {
  const dup = M("dup", 1, 0, 5);
  const p = plan({ moments: [dup, { ...dup }], t: 1 });
  assert.equal(p.jobs.length, 1, "同一个键只渲染一次");
  const p2 = plan({ moments: [dup, { ...dup }], t: 1, known: new Map([["dup@1", 40000]]) });
  assert.equal(p2.keep.length, 1);
  assert.equal(p2.footprintBytes, 40000, "不能算两遍");
});

test("距离按时刻自己的时间算;是否在播按卡的区间算", () => {
  const m = M("x", 12, 10, 20);
  assert.equal(distanceFrom(m, 12), 0);
  assert.equal(distanceFrom(m, 15), 3);
  assert.equal(distanceFrom(m, 8), 4);
  assert.equal(isLive(m, 15), true, "播放头在区间内");
  assert.equal(isLive(m, 20), false, "右端点是开区间,交给下一张卡");
  assert.equal(isLive(m, 10), true, "左端点算在内");
});

test("预算按机器内存分档,而且有上下限", () => {
  assert.equal(defaultBudgetBytes(8), Math.round(8 * 1024 ** 3 * 0.015));
  assert.equal(defaultBudgetBytes(undefined), defaultBudgetBytes(4), "拿不到内存就按 4GB 算");
  assert.equal(defaultBudgetBytes(0.25), 64 * 1024 * 1024, "太小的机器兜到 64MB");
  assert.equal(defaultBudgetBytes(1024), 512 * 1024 * 1024, "再大也封顶 512MB");
  // 按实测平均 55KB 一个、一张卡十来个时刻算,8GB 的机器够放一两百张卡
  assert.ok(defaultBudgetBytes(8) / 55000 / 12 > 100);
});

/* ── 两档:低帧率全部铺完,才开始原始帧率 ─────────────────────── */

const MT = (clipId, t, start, end, tier) => ({ clipId, t, start, end, tier, key: `${clipId}@${t}#${tier}` });

test("低帧率那一档全部排完,才轮到原始帧率", () => {
  const moments = [
    // 原始帧率的放在数组前面,故意让"照数组顺序"这种写法露馅
    MT("a", 0.1, 0, 2, "full"), MT("a", 0.2, 0, 2, "full"),
    MT("a", 0, 0, 2, "coarse"), MT("b", 10, 10, 12, "coarse"),
  ];
  const p = planBakes({ moments, t: 0, budgetBytes: 1e9, known: new Map() });
  const tiers = p.jobs.map((j) => j.tier);
  assert.deepEqual(tiers, ["coarse", "coarse", "full", "full"], `实得 ${tiers}`);
});

test("哪怕原始帧率那张就在播放头上,也要等低帧率全部铺完", () => {
  const moments = [
    MT("cur", 5, 5, 7, "full"),      // 正在播,而且是精确那一档
    MT("far", 100, 100, 102, "coarse"), // 离得很远,但属于低帧率档
  ];
  const p = planBakes({ moments, t: 5, budgetBytes: 1e9, known: new Map() });
  assert.deepEqual(p.jobs.map((j) => j.clipId), ["far", "cur"],
    "先把整条片子铺满低帧率,比让眼前这一格精确更有用");
});

test("每一档内部仍然是「眼前 → 两侧 → 从 0 铺」", () => {
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

test("不写 tier 的按低帧率算(老调用方不会因此掉到最后)", () => {
  const moments = [
    { clipId: "old", t: 1, start: 0, end: 2, key: "old@1" },
    MT("newfull", 1.1, 0, 2, "full"),
  ];
  const p = planBakes({ moments, t: 1, budgetBytes: 1e9, known: new Map() });
  assert.deepEqual(p.jobs.map((j) => j.tier), ["coarse", "full"]);
  assert.equal(p.jobs[0].clipId, "old");
});

/* ── 归到帧号:两档格子对得上账的前提 ─────────────────────────── */

test("归一是第二道防线:累加出来的值也能被归回同一个帧", async () => {
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
        `${fps}fps 第 ${i} 帧:累加值 ${drifted} 和相乘值 ${byMul} 归一之后仍然不同`,
      );
      drifted += step;                      // 累加(历史上出问题的做法)
    }
    assert.ok(sawDrift, `${fps}fps:累加和相乘居然逐位相同,这条用例失去意义了`);
  }
});

test("按固定小数位量化是错的(会整整退回一帧)—— 记下来别再试", async () => {
  const { sampleTimesFor, pickBakeT } = await import("./bakeTime.ts");
  const clip = { id: "c", cardId: "x", start: 0, end: 2, params: {} };
  const motion = { settleMs: 0, after: "evolve" };
  const step = 1 / 30;
  const q = (t) => Math.round(t * 1e6) / 1e6;   // 微秒量化:看着合理,其实不成立
  const bad = sampleTimesFor(clip, motion, { stepSec: step, maxPerClip: 10000 })
    .map(q)
    .filter((t) => q(pickBakeT(clip, motion, t, { stepSec: step })) !== t).length;
  assert.ok(bad > 0, "微秒量化居然成立了?那就该重新评估 canonFrameT 是不是还有必要");
});

test("归一是幂等的,而且分得开相邻两帧", async () => {
  const { canonFrameT } = await import("./bakePlan.ts");
  for (const v of [0, 0.19999999999999998, 0.2, 1 / 3, 2.5, 0.5]) {
    assert.equal(canonFrameT(canonFrameT(v, 0, 30), 0, 30), canonFrameT(v, 0, 30), `${v} 归一两次不一致`);
  }
  assert.notEqual(canonFrameT(10 / 60, 0, 60), canonFrameT(11 / 60, 0, 60), "相邻帧被并成一格就分不出帧了");
});

test("归一让低帧率成为逐帧的子集 —— 这是 canonFrameT 现在存在的**主要**理由", async () => {
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
  assert.ok(missRaw.length > 0, "不归一居然就对得上了?那这个函数可以删了");

  const fine = new Set(fineRaw.map((t) => canonFrameT(t, 0, fps)));
  for (const t of coarseRaw) {
    assert.ok(fine.has(canonFrameT(t, 0, fps)), `低帧率的 ${t} 归一之后仍然不在逐帧的格子上`);
  }
});
