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

test("一个预渲染好的时刻,管到同一张卡的下一个时刻为止", () => {
  const m = spread("a", 0, 4, [0, 1, 2]);
  // 只有 t=1 渲好了 → 覆盖 [1,2),不该蔓延到 0 或 2 之后
  const segs = coverageSegments(m, (x) => x.t === 1);
  assert.deepEqual(segs, [{ start: 1, end: 2 }]);
});

test("最后一个时刻一直管到这张卡结束", () => {
  const m = spread("a", 0, 4, [0, 1, 2]);
  const segs = coverageSegments(m, (x) => x.t === 2);
  assert.deepEqual(segs, [{ start: 2, end: 4 }], "2 是最后一个,后面整段都靠它");
});

test("全部预渲染好 = 整张卡连成一段,不是一排带缝的小块", () => {
  const m = spread("a", 0, 4, [0, 1, 2]);
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 4 }]);
});

test("一个都没预渲染就没有绿色", () => {
  assert.deepEqual(coverageSegments(spread("a", 0, 4, [0, 1, 2]), none), []);
});

test("预渲染到一半:前半段绿、后半段不绿 —— 整段涂绿会骗人", () => {
  const m = spread("a", 0, 4, [0, 1, 2, 3]);
  const segs = coverageSegments(m, (x) => x.t <= 1);
  assert.deepEqual(segs, [{ start: 0, end: 2 }], "0 和 1 连起来是 [0,2),2 之后还没预渲染");
});

test("中间断开的两段不能合并", () => {
  const m = spread("a", 0, 5, [0, 1, 2, 3, 4]);
  // 渲了 0 和 3,中间 1、2 没渲
  const segs = coverageSegments(m, (x) => x.t === 0 || x.t === 3);
  assert.deepEqual(segs, [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
});

test("一个时刻管到下一个时刻为止,**不跨卡**去找", () => {
  // 两张卡首尾相接:a 的最后一个时刻只能管到 a 结束,不能借用 b 的时刻
  const m = [...spread("a", 0, 2, [0, 1]), ...spread("b", 2, 4, [2, 3])];
  const segs = coverageSegments(m, (x) => x.clipId === "a");
  assert.deepEqual(segs, [{ start: 0, end: 2 }], "只覆盖 a 自己那两秒");
});

test("首尾相接的两张卡都预渲染好了,画成连续的一整条", () => {
  const m = [...spread("a", 0, 2, [0, 1]), ...spread("b", 2, 4, [2, 3])];
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 4 }], "挨着就该并成一段");
});

test("中间隔着空档的两张卡,绿条也要跟着断开", () => {
  const m = [...spread("a", 0, 2, [0, 1]), ...spread("b", 5, 7, [5, 6])];
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 2 }, { start: 5, end: 7 }]);
});

test("覆盖范围不会超出这张卡自己的区间", () => {
  // 构造一个越界的时刻表(理论上不该出现,但越界的绿条是会骗人的,得兜住)
  const m = [{ clipId: "a", t: 3, start: 0, end: 2 }];
  assert.deepEqual(coverageSegments(m, all), [], "时刻已经在卡结束之后,不产生绿色");
});

test("时刻乱序传进来也算得对", () => {
  const m = spread("a", 0, 4, [2, 0, 1]);
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 4 }]);
});

test("重叠的卡(不同轨道叠在一起)合并成一条,不重复画", () => {
  const m = [...spread("a", 0, 3, [0, 1, 2]), ...spread("b", 1, 4, [1, 2, 3])];
  assert.deepEqual(coverageSegments(m, all), [{ start: 0, end: 4 }]);
});

test("0.25 秒一格累加出来的浮点误差不会画出一堆碎缝", () => {
  // 模拟 sampleTimesFor 的累加:0, 0.25, 0.5, ... 末位有误差
  const ts = [];
  for (let i = 0, v = 0; i < 8; i++, v += 0.25) ts.push(v);
  const m = spread("a", 0, 2, ts);
  const segs = coverageSegments(m, all);
  assert.equal(segs.length, 1, `该合成一段,实得 ${segs.length} 段:${JSON.stringify(segs)}`);
  assert.ok(Math.abs(segs[0].start - 0) < 1e-6);
  assert.ok(Math.abs(segs[0].end - 2) < 1e-6);
});

test("空输入不炸", () => {
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

test("改了 A:只有 A 那一段消失,B 一点不受影响", () => {
  const cov = COV([CC("a", "fpA", 0, 2), CC("b", "fpB", 10, 12)]);
  // 用户改了 A 的参数 → A 的指纹变了,B 没变
  const v = visibleCoverage(cov, new Map([["fpA-改过了", 0], ["fpB", 10]]));
  assert.deepEqual(v.coarse, [{ start: 10, end: 12 }], "只该剩 B 那一段");
  assert.equal(v.stale, 1, "有 1 张卡的覆盖作废了");
  assert.equal(v.coarseTotal, 2, "计数也只剩 B 的,不能把 A 的算进去");
});

test("什么都没改:两张都留着,而且首尾相接的合成一条", () => {
  const cov = COV([CC("a", "fpA", 0, 2), CC("b", "fpB", 2, 4)]);
  const v = visibleCoverage(cov, new Map([["fpA", 0], ["fpB", 2]]));
  assert.deepEqual(v.coarse, [{ start: 0, end: 4 }], "挨着的该连成一条");
  assert.equal(v.stale, 0);
  assert.equal(v.coarseTotal, 4);
});

test("卡被删掉了:它的覆盖也不画(指纹在当前项目里根本不存在)", () => {
  const cov = COV([CC("a", "fpA", 0, 2), CC("b", "fpB", 10, 12)]);
  const v = visibleCoverage(cov, new Map([["fpB", 10]]));
  assert.deepEqual(v.coarse, [{ start: 10, end: 12 }]);
  assert.equal(v.stale, 1);
});

test("全改了:条子整条空,不是留着旧的骗人", () => {
  const cov = COV([CC("a", "fpA", 0, 2), CC("b", "fpB", 10, 12)]);
  const v = visibleCoverage(cov, new Map([["新A", 0], ["新B", 10]]));
  assert.deepEqual(v.coarse, []);
  assert.deepEqual(v.full, []);
  assert.equal(v.coarseTotal, 0);
  assert.equal(v.stale, 2);
});

test("没预渲染的时刻不产生颜色,预渲染一个就多一段 —— 段是现算的,不是存死的", () => {
  const a = CC("a", "fpA", 0, 3);           // 三个时刻:0 / 1 / 2
  const cov = COV([a], new Set());           // 一个都没渲
  const live = new Map([["fpA", 0]]);
  assert.deepEqual(visibleCoverage(cov, live).coarse, [], "一个都没预渲染就没有颜色");

  // 只渲中间那一刻 → 只覆盖 [1,2)
  const one = { ...cov, baked: new Set([momentId("a", 1)]) };
  assert.deepEqual(visibleCoverage(one, live).coarse, [{ start: 1, end: 2 }]);
  assert.equal(visibleCoverage(one, live).coarseBaked, 1);
});

test("指纹只认「决定像素」的东西:改参数会变,挪位置不会", () => {
  const base = { id: "c1", cardId: "pin-board", params: { a: 1 }, frame: { x: 0, y: 0, w: 960, h: 540 } };
  const moved = { ...base, frame: { x: 500, y: 200, w: 960, h: 540 } };
  const resized = { ...base, frame: { x: 0, y: 0, w: 1920, h: 1080 } };
  const edited = { ...base, params: { a: 2 } };
  assert.equal(clipFingerprint(moved), clipFingerprint(base), "只挪位置,像素没变,不该让覆盖作废");
  assert.notEqual(clipFingerprint(resized), clipFingerprint(base), "画幅变了,渲染出来就不一样");
  assert.notEqual(clipFingerprint(edited), clipFingerprint(base), "改参数必须作废");
});

/* ── 前台现场渲染完也要记账,否则条子慢半拍 ─────────────────────── */

test("markBaked 让「刚预渲染好的那一刻」立刻算进覆盖", async () => {
  const m = await import("./bakeCoverage.ts");
  const a = CC("a", "fpA", 0, 3);
  m.publishCoverage({ clips: [a], baked: new Set(), bakingAt: null, bytes: 0 });
  const live = new Map([["fpA", 0]]);
  assert.deepEqual(m.visibleCoverage(m.getCoverage(), live).coarse, [], "还没预渲染,没有颜色");

  // 前台现场渲染完了那一刻 —— 只给一个 id,不用重新盘点、不用重算段
  m.markBaked([momentId("a", 1)]);
  assert.deepEqual(m.visibleCoverage(m.getCoverage(), live).coarse, [{ start: 1, end: 2 }],
    "画面出来了,条子必须同一刻就跟上");
});

test("markBaked 会通知订阅者(条子靠这个重画)", async () => {
  const m = await import("./bakeCoverage.ts");
  m.publishCoverage({ clips: [CC("a", "fpA", 0, 3)], baked: new Set(), bakingAt: null, bytes: 0 });
  let hits = 0;
  const off = m.subscribeCoverage(() => { hits++; });
  m.markBaked([momentId("a", 0)]);
  assert.equal(hits, 1, "标记之后必须通知,否则界面不会重画");
  // 同一个 id 再标一次不该白通知一遍(条子没变化,重画是浪费)
  m.markBaked([momentId("a", 0)]);
  assert.equal(hits, 1, "重复标记不该再通知");
  off();
});

/* ── 挪一下位置 / 剪短一点:条子必须当帧说实话 ─────────────────────
 *
 * 这两条是从一次实测来的:项目里六张卡全部渲好、条子全绿,把 [20,24] 那张挪到 27 秒,
 * 条子**仍然在 [20,24] 上画着绿**,而那块时间轴已经空了,`stale` 还报 0。
 * 指纹里故意不带时间轴位置(挪一下像素不变),所以光看指纹看不出卡挪没挪;
 * 而每个时刻记的都是绝对秒,卡走了它们还留在原地。
 */

test("卡挪到别处:绿段跟着挪过去,不是留在原地骗人", () => {
  const cov = COV([CC("a", "fpA", 20, 24)]);
  // 指纹没变(挪位置不改像素),但起点从 20 变成 27
  const v = visibleCoverage(cov, new Map([["fpA", 27]]));
  assert.deepEqual(v.coarse, [{ start: 27, end: 31 }], "绿的该在卡片现在待的地方");
  assert.equal(v.stale, 0, "挪位置不作废 —— 预渲染好的图还能用");
  assert.equal(v.coarseBaked, 4, "平移不该动「预渲染过没有」这本账");
});

test("卡挪走之后,老地方一点颜色都不能剩", () => {
  const cov = COV([CC("a", "fpA", 20, 24)]);
  const v = visibleCoverage(cov, new Map([["fpA", 27]]));
  const 老地方还有颜色 = v.coarse.some((s) => s.start < 24 - 1e-9 && s.end > 20 + 1e-9);
  assert.equal(老地方还有颜色, false, "[20,24] 现在是空的,画成绿的就是骗人");
});

test("剪短一点:指纹就该变 —— 长度进了缓存键,老图不作数了", () => {
  const base = { id: "c1", cardId: "odometer", params: {}, start: 3, end: 7 };
  const trimmed = { ...base, end: 5 };
  const moved = { ...base, start: 17, end: 21 };
  assert.notEqual(clipFingerprint(trimmed), clipFingerprint(base), "剪短了,渲染出来是另一张");
  assert.equal(clipFingerprint(moved), clipFingerprint(base), "整段平移,长度没变,还是同一张");
});

test("指纹是黑名单:clip 上除了位置,别的字段改了都要作废", () => {
  const base = { id: "c1", cardId: "odometer", params: { to: 1 }, start: 0, end: 4 };
  // 这几样都进了服务端的缓存键(bakeTarget 只摘掉 frame),漏一个就是「改完还是绿的」
  for (const [名字, 改过的] of [
    ["emphasis", { ...base, emphasis: { kind: "shadow" } }],
    ["motion", { ...base, motion: { pathId: "p1" } }],
    ["fadeIn", { ...base, fadeIn: 0.5 }],
    ["opacity", { ...base, opacity: 0.5 }],
    ["parts", { ...base, parts: [{ id: "p" }] }],
  ]) {
    assert.notEqual(clipFingerprint(改过的), clipFingerprint(base), `改了 ${名字} 必须作废`);
  }
});

/* ── 本来就没东西要渲的那几段,也该是有色的 ──────────────────────
 *
 * 用户报的现象:「有时候某一段时间没有素材,时间条那里永远不会变绿」。
 * 那几秒拖过去立刻就是它该有的样子(空的),按条子的契约就该有色;
 * 一直留白的话,用户分不清「还没渲」和「本来就没东西」,看上去像预渲染卡死了。
 */
const { idleSpans } = await import("./bakeCoverage.ts");

test("两张卡中间的空档算就绪", () => {
  assert.deepEqual(idleSpans([{ start: 0, end: 2 }, { start: 5, end: 8 }], 10),
    [{ start: 2, end: 5 }, { start: 8, end: 10 }]);
});

test("整条片子一张卡都没有:整条都算就绪", () => {
  assert.deepEqual(idleSpans([], 6), [{ start: 0, end: 6 }]);
});

test("卡片铺满了就没有空档", () => {
  assert.deepEqual(idleSpans([{ start: 0, end: 3 }, { start: 3, end: 6 }], 6), []);
});

test("重叠的卡不会算出负数长度的空档", () => {
  assert.deepEqual(idleSpans([{ start: 0, end: 4 }, { start: 1, end: 2 }], 4), []);
});

test("卡片超出片长:不往片长外面画", () => {
  assert.deepEqual(idleSpans([{ start: 0, end: 9 }], 5), []);
});

test("片长是 0 / 负数不炸", () => {
  assert.deepEqual(idleSpans([{ start: 0, end: 1 }], 0), []);
  assert.deepEqual(idleSpans([], -1), []);
});
