/**
 * 「该预渲染哪一刻」的单测。跑:node --test src/editor/preview/bakeTime.test.mjs
 *
 * 钉死的是那个真实 bug:渲中点 → 播放头 0.23 秒时 3D 里显示的是 1.0 秒的画面
 * (mu-number-ticker,滚动 1.6 秒,clip [0,2]:0.23 秒该是 81%,中点是 100%)。
 * 这类错**不报错**,只表现为「界面上的数字和 3D 里的数字对不上」,所以要有测试盯着。
 *
 * 另外两条同样是错了不报错的:
 *   - 往前取会把还没播到的画面提前显示出来(比慢一格更误导);
 *   - 前台吸附的格子和预渲染排的格子对不上,会表现成「明明预渲染过还要现场渲染」。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTLE_MS,
  motionOf,
  pickBakeT,
  sampleTimesFor,
  staleBy,
  texKeyOf,
} from "./bakeTime.ts";

const clip = (over = {}) => ({ id: "c1", cardId: "mu-number-ticker", start: 0, end: 2, params: {}, ...over });
/** 用户报的那张卡:滚动 1.6 秒,之后停住 */
const TICKER = { settleMs: 1600, after: "hold" };

test("就是那个 bug:0.23 秒不能取到中点 1.0 秒", () => {
  const c = clip();
  const got = pickBakeT(c, TICKER, 0.23);
  assert.notEqual(got, 1, "取到中点就是原来那个 bug");
  assert.ok(got <= 0.23 + 1e-9, `不能往前取,got=${got}`);
  assert.ok(got > 0.23 - 0.25 - 1e-9, `离播放头不能超过一格,got=${got}`);
});

test("只往回取:任何时刻取到的都不晚于播放头", () => {
  const c = clip({ end: 6 });
  for (let t = 0; t < 6; t += 0.07) {
    const got = pickBakeT(c, { settleMs: 900, after: "evolve" }, t);
    assert.ok(got <= t + 1e-9, `t=${t.toFixed(2)} 取到了 ${got},是未来的画面`);
  }
});

test("hold 的卡落定之后只有一刻:10 秒的静态卡不该产出 40 张", () => {
  const c = clip({ end: 10 });
  const a = pickBakeT(c, { settleMs: 800, after: "hold" }, 3);
  const b = pickBakeT(c, { settleMs: 800, after: "hold" }, 9.5);
  assert.equal(a, b, "落定之后每一帧都一样,该复用同一张");
  assert.equal(a, 0.8);
  assert.ok(sampleTimesFor(c, { settleMs: 800, after: "hold" }).length <= 5);
});

test("evolve 的卡整段都要采,不能只采进场那一截", () => {
  const c = clip({ end: 8 });
  const hold = sampleTimesFor(c, { settleMs: 800, after: "hold" });
  const evolve = sampleTimesFor(c, { settleMs: 800, after: "evolve" });
  assert.ok(evolve.length > hold.length);
  assert.ok(evolve[evolve.length - 1] > 4, "一直在变的卡,后半段也得有采样点");
});

test("前台吸附的格子必须落在预渲染排的格子上,否则预渲染白排", () => {
  const c = clip({ end: 4 });
  const motion = { settleMs: 4000, after: "hold" }; // 整段都在动 → 不抽稀
  const planned = new Set(sampleTimesFor(c, motion, { maxPerClip: 999 }).map((x) => x.toFixed(3)));
  for (let t = 0; t < 4; t += 0.05) {
    const got = pickBakeT(c, motion, t).toFixed(3);
    assert.ok(planned.has(got), `t=${t.toFixed(2)} 要的是 ${got},预渲染名单里没有`);
  }
});

/**
 * 上面那条用的是默认的 0.25 —— 而 0.25 是**二进制精确**的,所以它永远绿,
 * 钉不住真正的风险。逐帧那一档的步长是 1/30、1/24、1/29.97,一个都不精确。
 *
 * 这条曾经真的挂过:`sampleTimesFor` 累加(`rel += step`)、`pickBakeT` floor 再乘,
 * 30fps 下 60 个采样点有 39 个差 2.8e-17。而缓存键是拿这个浮点数格式化出来的,
 * 于是**预渲染出来的图显示端一张都问不到,还不报错** —— 只表现为「明明预渲染过还要现场渲染」。
 * 所以这里比的是**逐位相等**(===),不是 toFixed 之后相等。
 */
test("非二进制精确的步长(逐帧那一档)也要对得上 —— 差 2.8e-17 就等于预渲染全白做", () => {
  for (const [name, step] of [["1/30", 1 / 30], ["1/24", 1 / 24], ["1/29.97", 1 / 29.97], ["0.1", 0.1]]) {
    const c = clip({ end: 3 });
    const motion = { settleMs: 3000, after: "hold" };
    const planned = sampleTimesFor(c, motion, { stepSec: step, maxPerClip: 9999 });
    const set = new Set(planned);
    assert.ok(planned.length > 20, `${name}:采样点太少,这条测试没测到东西`);
    for (const want of planned) {
      // 停在这个采样点上,吸附回来必须是**同一个浮点数**
      assert.ok(set.has(pickBakeT(c, motion, want, { stepSec: step })), `${name}:停在 ${want} 上吸附不回自己`);
    }
    // 也测格子之间的位置:往回吸附到的那一刻必须在名单里
    for (let t = 0; t < 3; t += 0.017) {
      assert.ok(set.has(pickBakeT(c, motion, t, { stepSec: step })), `${name}:t=${t} 吸附到的那一刻不在预渲染名单里`);
    }
  }
});

test("抽稀只减覆盖,首尾必留", () => {
  const c = clip({ end: 30 });
  const all = sampleTimesFor(c, { settleMs: 0, after: "evolve" }, { maxPerClip: 999 });
  const few = sampleTimesFor(c, { settleMs: 0, after: "evolve" }, { maxPerClip: 6 });
  assert.ok(few.length <= 6);
  assert.equal(few[0], all[0]);
  assert.equal(few[few.length - 1], all[all.length - 1]);
});

test("缓存键必须带上是哪一刻 —— 不带就是「换了时刻画面不更新」", () => {
  const c = clip();
  assert.notEqual(texKeyOf(c, 0.25), texKeyOf(c, 1));
  // 位置和三维变换不进键:预渲染的时候 frame 被摘掉,转一下卡贴图一个像素都不变
  assert.equal(texKeyOf({ ...c, frame: { w: 800, h: 400 } }, 0.25), texKeyOf({ ...c, frame: { w: 800, h: 400 } }, 0.25));
});

test("timing(params) 比 lifecycle 准,写坏了也不能把视图带崩", () => {
  const def = {
    lifecycle: { settleMs: 800, after: "hold" },
    defaults: { rows: 3 },
    timing: (p) => ({ settleMs: 400 * p.rows, after: "hold" }),
  };
  assert.equal(motionOf(def, { rows: 5 }).settleMs, 2000, "该按这一张卡的实际参数算");
  const broken = { lifecycle: { settleMs: 800, after: "hold" }, timing: () => { throw new Error("卡片作者写坏了"); } };
  assert.deepEqual(motionOf(broken, {}), { settleMs: 800, after: "hold" }, "时序函数抛异常要退回 lifecycle");
  assert.deepEqual(motionOf(undefined, {}), {}, "拿不到卡片定义也不能抛");
});

test("没写 lifecycle 的卡按保守值处理:宁可多采,不要显示旧帧", () => {
  const c = clip({ end: 10 });
  const got = sampleTimesFor(c, {});
  assert.ok(got.length > 1, "不能退化成只渲染一张");
  assert.equal(got[got.length - 1], DEFAULT_SETTLE_MS / 1000);
});

test("边角:零长片段、播放头在段外、t 不是数,都不能抛也不能返回 NaN", () => {
  for (const [c, t] of [
    [clip({ start: 3, end: 3 }), 3],
    [clip({ start: 5, end: 7 }), 0],      // 播放头在段前(预渲染会问到还没播到的段)
    [clip({ start: 5, end: 7 }), 99],     // 段后
    [clip(), Number.NaN],
  ]) {
    const got = pickBakeT(c, TICKER, t);
    assert.ok(Number.isFinite(got), `返回了 ${got}`);
    assert.ok(got >= c.start && got <= c.end, `${got} 落在片段 [${c.start},${c.end}] 之外`);
  }
});

test("staleBy 报的是「显示的这一刻离播放头多远」,界面靠它决定要不要说出来", () => {
  assert.equal(staleBy(0.25, 0.25), 0);
  assert.ok(Math.abs(staleBy(0.75, 1) - 0.25) < 1e-9);
});
