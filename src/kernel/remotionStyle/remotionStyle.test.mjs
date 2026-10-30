/**
 * remotion 式的框架：工具的单测与守门测试。跑：node scripts/test-suite.mjs src/kernel/remotionStyle/remotionStyle.test.mjs
 *
 *   RS-T-01  每个工具：同样的时间、参数、种子重复求值，结果逐位相同
 *   RS-T-02  先算第 N 帧再算第 M 帧，与按顺序算的结果相同（倒着算、跳着算、顺着算三种次序逐位相同）
 *   RS-T-03  插值、过渡、缓动、弹簧、错开进场各自的值对不对（端点、范围之外、解析解与数值积分对得上）
 *   RS-T-04  带种子的随机：与调用先后无关；没有种子不给数；分布大致均匀；不同种子、不同序号互不相干
 *   RS-T-05  守门：框架里没有能跨帧存东西的工具（对外只有纯函数和冻住的常量；源码里没有模块级的可变量）
 *   RS-T-06  载入时锁只读（`lock.ts`）：顶层的对象、数组、Map、Set、函数、正则一写就当场报错；别的模块的导出不碰；锁不住的当场指出
 *   RS-T-07  守门：框架在现有卡片的导入闭包之外（现有文件不引它，它也不引别的模块）
 *
 * 这些工具错了不会报错，只会让「顺着播」和「直接跳」出两个画面，所以把性质钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as F from "./index.ts";
import { lockTopLevel } from "./lock.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const FRAMES = 150;
const PALETTE = Object.freeze(["#ef476f", "#ffd166", "#06d6a0"]);
const BEZIER = F.Easing.bezier(0.16, 1, 0.3, 1);
const BACK = F.Easing.out(F.Easing.back(1.4));

/** 一帧里把每个工具都用一遍：返回的数与字符串就是「这一帧的画面」 */
function frameValues(n) {
  const t = n / FPS;
  const out = [];
  out.push(F.interpolate(t, [0, 0.5, 2, 4], [0, 1, 0.25, 3], { easing: [F.Easing.easeOut, BEZIER, F.Easing.inOut(F.Easing.quad)] }));
  out.push(F.interpolate(t, [1, 2], [10, 20], { extrapolateLeft: "extend", extrapolateRight: "extend" }));
  out.push(F.interpolateColors(t, [0, 2, 4], ["#ff0000", "rgba(0, 255, 0, 0.5)", "#00f"]));
  out.push(F.tween(t, { from: 40, to: 0, delay: 0.2, duration: 0.8, easing: BACK }));
  out.push(F.spring(t, { stiffness: 180, damping: 12 }), F.spring(t, { stiffness: 100, damping: 20 }), F.spring(t, { stiffness: 50, damping: 40, from: 3, to: -2, delay: 0.5 }));
  out.push(F.spring(t, { stiffness: 220, damping: 9, velocity: 4, clamp: true }));
  out.push(F.loop(t, 0.7), F.pingPong(t, 0.45), F.clamp(t - 1), F.lerp(2, 9, t / 5));
  for (let i = 0; i < 12; i++) {
    const local = F.stagger(t, i, { each: 0.08, from: "center", count: 12, delay: 0.1 });
    out.push(local, F.tween(local, { duration: 0.4 }), F.spring(local, { from: 60, to: 0 }));
    out.push(F.random(7, i), F.random("seed", i, "hue"), F.randomRange(-20, 20, 7, i, n), F.randomInt(1, 6, 7, i, n), F.randomPick(PALETTE, 7, i));
    out.push(F.noise(t * 2, 7, i));
  }
  for (const e of [F.Easing.linear, F.Easing.quad, F.Easing.cubic, F.Easing.quart, F.Easing.sin, F.Easing.circ, F.Easing.expo, F.Easing.bounce,
    F.Easing.elastic(2), F.Easing.steps(5), F.Easing.easeIn, F.Easing.easeOut, F.Easing.easeInOut]) out.push(e(F.clamp(t / 5)));
  return out;
}

/** 逐位比：数按 IEEE 754 的 64 位比（区分 +0 / −0，NaN 等于 NaN），字符串按原文比 */
function bits(values) {
  const buf = new Float64Array(1), view = new BigUint64Array(buf.buffer);
  return values.map((v) => { if (typeof v !== "number") return `s:${v}`; buf[0] = v; return `n:${view[0].toString(16)}`; }).join(",");
}

test("RS-T-01 同样的时间、参数、种子重复求值，结果逐位相同", () => {
  for (const n of [0, 1, 7, 29, 30, 31, 74, 149]) {
    const a = bits(frameValues(n));
    for (let k = 0; k < 5; k++) assert.equal(bits(frameValues(n)), a, `第 ${n} 帧第 ${k + 2} 次求值`);
  }
  // 每一样都真的在随时间变（不然上面比的是一堆常数）
  assert.notEqual(bits(frameValues(10)), bits(frameValues(11)));
});

test("RS-T-02 先算第 N 帧再算第 M 帧，与按顺序算的结果相同", () => {
  const forward = [];
  for (let n = 0; n < FRAMES; n++) forward.push(bits(frameValues(n)));
  // 倒着算
  for (let n = FRAMES - 1; n >= 0; n--) assert.equal(bits(frameValues(n)), forward[n], `倒着算到第 ${n} 帧`);
  // 跳着算：次序由框架自己的随机定（固定种子），每一帧前后都夹着别的帧
  const order = Array.from({ length: FRAMES }, (_, n) => n).sort((a, b) => F.random("order", a) - F.random("order", b));
  assert.notDeepEqual(order, [...order].sort((a, b) => a - b), "次序确实打乱了");
  for (const n of order) assert.equal(bits(frameValues(n)), forward[n], `跳着算到第 ${n} 帧`);
  // 先 N 后 M 的每一对：只取几对有代表性的，N 在后、M 在前
  for (const [first, then] of [[149, 0], [90, 3], [1, 148], [60, 59], [0, 0]]) {
    frameValues(first);
    assert.equal(bits(frameValues(then)), forward[then], `先算第 ${first} 帧再算第 ${then} 帧`);
  }
});

test("RS-T-03 插值：端点、分段、范围之外、缓动；参数不对当场报错", () => {
  assert.equal(F.interpolate(0, [0, 1], [10, 20]), 10);
  assert.equal(F.interpolate(1, [0, 1], [10, 20]), 20);
  assert.equal(F.interpolate(0.25, [0, 1], [10, 20]), 12.5);
  assert.equal(F.interpolate(-5, [0, 1], [10, 20]), 10, "缺省：早于第一个时间点停在第一个值");
  assert.equal(F.interpolate(9, [0, 1], [10, 20]), 20, "缺省：晚于最后一个时间点停在最后一个值");
  assert.equal(F.interpolate(2, [0, 1], [10, 20], { extrapolateRight: "extend" }), 30);
  assert.equal(F.interpolate(-1, [0, 1], [10, 20], { extrapolateLeft: "extend" }), 0);
  assert.equal(F.interpolate(1.5, [0, 1, 2], [0, 100, 0]), 50);
  assert.equal(F.interpolate(1, [0, 1, 2], [0, 100, 0]), 100, "落在中间的时间点上就是那个值");
  assert.equal(F.interpolate(0.5, [0, 1], [0, 100], { easing: F.Easing.quad }), 25);
  assert.equal(F.interpolate(1.5, [0, 1, 2], [0, 100, 0], { easing: [F.Easing.linear, F.Easing.quad] }), 75, "一段一条缓动");
  assert.throws(() => F.interpolate(0, [0, 1], [1]), /个数要一样多/);
  assert.throws(() => F.interpolate(0, [1, 1], [0, 1]), /一个比一个大/);
  assert.throws(() => F.interpolate(0, [0], [0]), /至少要两个/);
  assert.throws(() => F.interpolate(0, [0, NaN], [0, 1]), /有限的数/);

  assert.equal(F.interpolateColors(0, [0, 1], ["#ff0000", "#0000ff"]), "rgba(255, 0, 0, 1)");
  assert.equal(F.interpolateColors(0.5, [0, 1], ["#f00", "#00f"]), "rgba(128, 0, 128, 1)");
  assert.equal(F.interpolateColors(1, [0, 1], ["#ff000080", "rgba(0, 0, 255, 0.25)"]), "rgba(0, 0, 255, 0.25)");
  assert.equal(F.interpolateColors(0.5, [0, 1], ["rgb(0 0 0)", "rgb(100% 50% 0% / 50%)"]), "rgba(128, 64, 0, 0.75)");
  assert.throws(() => F.interpolateColors(0, [0, 1], ["red", "#00f"]), /认不出这个颜色/);

  assert.equal(F.tween(0, { duration: 1 }), 0);
  assert.equal(F.tween(1, { duration: 1 }), 1);
  assert.equal(F.tween(5, { from: 40, to: 0, delay: 0.2, duration: 0.5 }), 0);
  assert.equal(F.tween(0.1, { from: 40, to: 0, delay: 0.2, duration: 0.5 }), 40, "开始之前是 from");
  assert.equal(F.tween(0.5, { duration: 1, easing: F.Easing.linear }), 0.5);
  assert.equal(F.tween(0.5, { duration: 0 }), 1, "时长是 0：到点就是终点");
  assert.equal(F.tween(-1, { duration: 0 }), 0);

  assert.equal(F.loop(2.5, 2), 0.5);
  assert.equal(F.loop(-0.5, 2), 1.5);
  assert.equal(F.pingPong(0.25, 1), 0.25);
  assert.equal(F.pingPong(1.25, 1), 0.75);
  assert.equal(F.clamp(5), 1);
  assert.equal(F.clamp(-5, -1, 1), -1);
});

test("RS-T-03 缓动：都从 0 到 1；贝塞尔与 CSS 的同名曲线对得上；台阶", () => {
  const curves = { linear: F.Easing.linear, quad: F.Easing.quad, cubic: F.Easing.cubic, quart: F.Easing.quart, sin: F.Easing.sin, circ: F.Easing.circ, expo: F.Easing.expo,
    bounce: F.Easing.bounce, back: F.Easing.back(), elastic: F.Easing.elastic(), easeIn: F.Easing.easeIn, easeOut: F.Easing.easeOut, easeInOut: F.Easing.easeInOut,
    outBack: F.Easing.out(F.Easing.back()), inOutExpo: F.Easing.inOut(F.Easing.expo), bezier: BEZIER, steps: F.Easing.steps(4) };
  for (const [name, e] of Object.entries(curves)) {
    assert.ok(Math.abs(e(0)) < 1e-9, `${name}(0) = ${e(0)}`);
    assert.ok(Math.abs(e(1) - 1) < 1e-9, `${name}(1) = ${e(1)}`);
    for (let i = 0; i <= 20; i++) assert.ok(Number.isFinite(e(i / 20)), `${name}(${i / 20})`);
  }
  // cubic-bezier(0.25, 0.1, 0.25, 1)（CSS 的 ease）在 x = 0.5 处约 0.8024
  assert.ok(Math.abs(F.Easing.bezier(0.25, 0.1, 0.25, 1)(0.5) - 0.8024) < 1e-3);
  // 直线贝塞尔就是匀速
  for (let i = 0; i <= 10; i++) assert.ok(Math.abs(F.Easing.bezier(0.3, 0.3, 0.7, 0.7)(i / 10) - i / 10) < 1e-6);
  assert.equal(F.Easing.out(F.Easing.quad)(0.5), 0.75);
  assert.equal(F.Easing.inOut(F.Easing.quad)(0.25), 0.125);
  assert.deepEqual([0, 0.24, 0.25, 0.5, 0.99, 1].map(F.Easing.steps(4)), [0, 0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual([0, 0.01, 0.25, 0.26].map(F.Easing.steps(4, false)), [0, 0.25, 0.25, 0.5]);
  assert.throws(() => F.Easing.bezier(1.2, 0, 0, 1), /0～1 之间/);
  assert.throws(() => F.Easing.steps(0), /正整数/);
  assert.ok(Object.isFrozen(F.Easing), "Easing 这张表是只读的");
});

test("RS-T-03 缓动的四个别名：circle、exp 和原名是同一个函数；ease 是贝塞尔 (0.42, 0, 1, 1)；poly(n) 是 n 次方", () => {
  assert.equal(F.Easing.circle, F.Easing.circ);
  assert.equal(F.Easing.exp, F.Easing.expo);
  // ease：两端是 0、1；中间钉住值（和同一组数的 Easing.bezier 逐位相同），起步慢
  assert.equal(F.Easing.ease(0), 0);
  assert.equal(F.Easing.ease(1), 1);
  const sameBezier = F.Easing.bezier(0.42, 0, 1, 1);
  for (let i = 0; i <= 20; i++) assert.equal(F.Easing.ease(i / 20), sameBezier(i / 20));
  // 钉住的值另用二分法反解 cubic-bezier(0.42, 0, 1, 1) 独立算过
  for (const [p, value] of [[0.1, 0.017027], [0.25, 0.093465], [0.5, 0.315357], [0.75, 0.621862], [0.9, 0.839428]]) {
    assert.ok(Math.abs(F.Easing.ease(p) - value) < 1e-6, `ease(${p}) = ${F.Easing.ease(p)}`);
  }
  assert.ok(F.Easing.ease(0.5) < 0.5, "ease 起步慢");
  assert.notEqual(F.Easing.ease(0.5), F.Easing.easeIn(0.5), "ease 不是三次曲线的 easeIn");
  // poly
  for (let i = 0; i <= 20; i++) {
    assert.ok(Math.abs(F.Easing.poly(3)(i / 20) - F.Easing.cubic(i / 20)) < 1e-12);
    assert.ok(Math.abs(F.Easing.poly(4)(i / 20) - F.Easing.quart(i / 20)) < 1e-12);
  }
  assert.equal(F.Easing.poly(1)(0.3), 0.3);
  assert.equal(F.Easing.poly(0.5)(0.25), 0.5);
  for (const bad of [undefined, null, "4", NaN, Infinity, {}]) assert.throws(() => F.Easing.poly(bad), /Easing\.poly 的次数要是一个数，收到 .+。写法：`Easing\.poly\(4\)`，等于 `Easing\.quart`。/);
  assert.throws(() => F.Easing.poly("4"), /收到 "4"/);
  assert.throws(() => F.Easing.poly(), /收到 undefined/);
});

test("RS-T-03 弹簧：解析解与一小步一小步积分出来的轨迹对得上（欠阻尼、临界、过阻尼）", () => {
  const cases = [
    { stiffness: 180, damping: 12, mass: 1 }, // 欠阻尼
    { stiffness: 100, damping: 20, mass: 1 }, // 临界（ζ = 1）
    { stiffness: 50, damping: 40, mass: 1 }, // 过阻尼
    { stiffness: 120, damping: 8, mass: 2, from: 3, to: -2, velocity: 5 },
  ];
  for (const c of cases) {
    const from = c.from ?? 0, to = c.to ?? 1, m = c.mass ?? 1;
    // 半隐式欧拉，步长 1/100000 秒
    let x = from, v = c.velocity ?? 0;
    const dt = 1e-5;
    let worst = 0;
    for (let i = 1; i <= 200000; i++) {
      v += ((-c.stiffness * (x - to) - c.damping * v) / m) * dt;
      x += v * dt;
      if (i % 2000 === 0) worst = Math.max(worst, Math.abs(F.spring(i * dt, c) - x));
    }
    assert.ok(worst < 2e-3, `${JSON.stringify(c)} 与积分的最大偏差 ${worst}`);
  }
  assert.equal(F.spring(0), 0);
  assert.equal(F.spring(-3, { from: 5, to: 9 }), 5, "开始之前是 from");
  assert.equal(F.spring(0.3, { from: 5, to: 9, delay: 0.5 }), 5);
  assert.ok(Math.abs(F.spring(30) - 1) < 1e-9, "足够久之后停在 to");
  // 欠阻尼会过冲；clamp 把过冲截平
  let peak = 0, clampedPeak = 0;
  for (let i = 0; i <= 300; i++) { peak = Math.max(peak, F.spring(i / 100, { stiffness: 180, damping: 8 })); clampedPeak = Math.max(clampedPeak, F.spring(i / 100, { stiffness: 180, damping: 8, clamp: true })); }
  assert.ok(peak > 1.05, `过冲的峰值 ${peak}`);
  assert.equal(clampedPeak, 1);
  assert.throws(() => F.spring(1, { stiffness: 0 }), /stiffness/);

  // 停稳的时间：此后一直在千分之一以内，之前还有超出的时候
  for (const c of cases.slice(0, 3)) {
    const d = F.springDuration(c);
    assert.ok(d > 0 && d < 10, `${JSON.stringify(c)} 停稳 ${d}`);
    for (let i = 0; i <= 200; i++) assert.ok(Math.abs(F.spring(d + i / 50, c) - 1) <= 0.001 + 1e-12, `停稳之后第 ${i} 步`);
    let early = false;
    for (let i = 1; i <= 50; i++) if (Math.abs(F.spring((d * i) / 100, c) - 1) > 0.001) early = true;
    assert.ok(early, "停稳之前确实还没到");
  }
  assert.equal(F.springDuration({ delay: 0.5, from: 1, to: 1 }), 0.5);
  assert.ok(F.springDuration({ delay: 0.5 }) > F.springDuration() + 0.49);
});

test("RS-T-03 弹簧：照 Remotion 的写法写会报错，不再悄悄返回起点", () => {
  // 第一种：第一个参数不是数
  assert.throws(() => F.spring({ frame: 12, fps: 30, config: { damping: 200 } }),
    { message: "spring 的第一个参数要是时间（秒），收到 对象。这里的写法是 `spring(t, { stiffness, damping, mass, from, to, delay })`，`t` 是片段本地秒；不是 Remotion 的 `spring({ frame, fps, config })`。改成：`spring(t, { stiffness: 100, damping: 10 })`。" });
  assert.throws(() => F.spring(undefined, { stiffness: 100 }), /第一个参数要是时间（秒），收到 undefined。/);
  assert.throws(() => F.spring("0.5"), /收到 字符串。/);
  assert.throws(() => F.spring(NaN), /收到 NaN。/);
  assert.throws(() => F.spring(null), /收到 null。/);
  // 第二种：第二个参数里有 Remotion 的键
  assert.throws(() => F.spring(0.4, { fps: 30, stiffness: 100 }),
    { message: "spring 的参数里有 fps：这是 Remotion 的写法。这里时间用秒、当第一个参数传，不用帧号和帧率；`stiffness`、`damping`、`mass` 直接写在第二个参数里，不要再包一层 `config`。写法：`spring(t, { stiffness: 100, damping: 10, mass: 1 })`。" });
  assert.throws(() => F.spring(0.4, { config: { stiffness: 100, damping: 10 } }), /spring 的参数里有 config：这是 Remotion 的写法。/);
  assert.throws(() => F.spring(0.4, { frame: 12 }), /spring 的参数里有 frame：/);
  assert.throws(() => F.springDuration({ config: { damping: 200 } }), /spring 的参数里有 config：/);
  assert.throws(() => F.springDuration({ fps: 30 }), /spring 的参数里有 fps：/);
  // 合法的调用照旧：负数、0、无穷大都是数
  assert.equal(F.spring(-1), 0);
  assert.equal(F.spring(0, { from: 2 }), 2);
  assert.equal(F.spring(0.4, undefined), F.spring(0.4));
});

test("RS-T-03 错开进场：各种起点；总时长", () => {
  assert.equal(F.stagger(1, 0, { each: 0.1 }), 1);
  assert.ok(Math.abs(F.stagger(1, 3, { each: 0.1 }) - 0.7) < 1e-12);
  assert.ok(Math.abs(F.stagger(1, 3, { each: 0.1, delay: 0.5 }) - 0.2) < 1e-12);
  assert.equal(F.stagger(1, 4, { each: 0.1, from: "last", count: 5 }), 1);
  assert.ok(Math.abs(F.stagger(1, 0, { each: 0.1, from: "last", count: 5 }) - 0.6) < 1e-12);
  assert.equal(F.stagger(1, 2, { each: 0.1, from: "center", count: 5 }), 1);
  assert.equal(F.stagger(1, 0, { each: 0.1, from: "center", count: 5 }), F.stagger(1, 4, { each: 0.1, from: "center", count: 5 }));
  assert.equal(F.stagger(1, 3, { each: 0.1, from: 3 }), 1);
  assert.throws(() => F.stagger(1, 0, { each: 0.1, from: "center" }), /count/);
  assert.ok(Math.abs(F.staggerDuration(5, { each: 0.08 }, 0.4) - 0.72) < 1e-12);
  assert.ok(Math.abs(F.staggerDuration(5, { each: 0.1, from: "center", delay: 1 }, 0.5) - 1.7) < 1e-12);
  assert.equal(F.staggerDuration(0, { each: 0.1, delay: 0.3 }), 0.3);
});

test("RS-T-04 带种子的随机：与调用先后无关；没有种子不给数；互不相干；大致均匀", () => {
  // 同一组（种子、序号）在任何时候问都是同一个数：先大量调用别的，再回来问
  const want = F.random(42, 5);
  for (let i = 0; i < 1000; i++) F.random(i, i * 3, "x");
  assert.equal(F.random(42, 5), want);
  assert.equal(F.random("42", 5) === want, false, "数字种子与字符串种子不是同一个");
  // 逐个对照钉死：换了算法，已经建好的卡画面就变了
  assert.deepEqual([F.random(0), F.random(1), F.random("a"), F.random(7, 3), F.random(7, 3, "hue"), F.random(1.5), F.random(-1, 2 ** 40)].map((x) => x.toFixed(12)),
    ["0.611923245713", "0.897906372324", "0.756856766297", "0.887180288788", "0.241473339032", "0.060155360727", "0.427354121581"]);
  const seen = new Set();
  for (let s = 0; s < 50; s++) for (let i = 0; i < 50; i++) { const r = F.random(s, i); assert.ok(r >= 0 && r < 1); seen.add(r); }
  assert.ok(seen.size > 2490, `2500 个里互不相同的有 ${seen.size} 个`);
  assert.notEqual(F.random(1, 2), F.random(2, 1), "种子和序号换位不是同一个数");
  assert.notEqual(F.random(1, 2, 3), F.random(1, 23), "序号不是简单拼起来");
  // 大致均匀：十万个数分十个桶，每个桶离一万不超过 4%
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 100000; i++) buckets[Math.floor(F.random("uniform", i) * 10)]++;
  for (const b of buckets) assert.ok(Math.abs(b - 10000) < 400, `桶里有 ${b} 个`);
  // 相邻序号之间看不出规律：相邻两数的差的平均接近 1/3
  let diff = 0;
  for (let i = 0; i < 20000; i++) diff += Math.abs(F.random(9, i) - F.random(9, i + 1));
  assert.ok(Math.abs(diff / 20000 - 1 / 3) < 0.01, `相邻差的平均 ${diff / 20000}`);

  assert.throws(() => F.random(), /种子/);
  assert.throws(() => F.random(null), /种子/);
  assert.throws(() => F.random(NaN), /种子/);
  assert.throws(() => F.random(1, undefined), /序号/);
  assert.throws(() => F.random(1, {}), /序号/);

  for (let i = 0; i < 200; i++) {
    const r = F.randomRange(-20, 20, 3, i);
    assert.ok(r >= -20 && r < 20);
    const k = F.randomInt(1, 6, 3, i);
    assert.ok(Number.isInteger(k) && k >= 1 && k <= 6);
    assert.ok(PALETTE.includes(F.randomPick(PALETTE, 3, i)));
  }
  assert.deepEqual([...new Set(Array.from({ length: 300 }, (_, i) => F.randomInt(1, 6, 3, i)))].sort(), [1, 2, 3, 4, 5, 6], "两头都取得到");
  assert.throws(() => F.randomPick([], 1), /空的/);

  // 平滑起伏：整数点上是互不相干的随机数，中间连续，范围 −1～1
  assert.equal(F.noise(3, 5), F.random(5, 3) * 2 - 1);
  for (let i = 0; i < 2000; i++) {
    const a = F.noise(i / 100, 5), b = F.noise((i + 1) / 100, 5);
    assert.ok(a >= -1 && a <= 1);
    assert.ok(Math.abs(a - b) < 0.05, `相邻两点差 ${Math.abs(a - b)}`);
  }
  assert.throws(() => F.noise(Infinity, 1), /有限的数/);
});

test("RS-T-05 守门：框架里没有能跨帧存东西的工具", () => {
  // 对外的东西就这些；多一个少一个都要回来改这张表，并在报告的接口表里对上
  assert.deepEqual(Object.keys(F).sort(), [
    "Easing", "clamp", "interpolate", "interpolateColors", "lerp", "loop", "noise", "pingPong",
    "random", "randomInt", "randomPick", "randomRange", "spring", "springDuration", "stagger", "staggerDuration", "tween",
  ]);
  // 每一个不是函数就是冻住的表；函数上没有挂着的可写属性
  for (const [name, value] of Object.entries(F)) {
    if (typeof value === "function") { assert.deepEqual(Object.keys(value), [], `${name} 上不挂东西`); continue; }
    assert.ok(Object.isFrozen(value), `${name} 是只读的`);
    for (const [k, v] of Object.entries(value)) assert.equal(typeof v, "function", `${name}.${k}`);
  }
  // 名字上：没有「存、取、记、上一次、计数、累加」这类工具
  const stateful = /^(use[A-Z]|set[A-Z]|get[A-Z]|store|save|load|remember|memo|cache|prev|previous|last[A-Z]|counter|accumulate|state|ref|on[A-Z]|subscribe|emit)/;
  for (const name of [...Object.keys(F), ...Object.keys(F.Easing)]) assert.doesNotMatch(name, stateful, name);

  // 源码上：框架的每个文件（载入时锁只读的 lock.ts 也算）顶层没有可变量，也不碰时钟、定时器、不带种子的随机、全局对象
  const files = fs.readdirSync(HERE).filter((f) => f.endsWith(".ts"));
  assert.deepEqual(files.sort(), ["easing.ts", "index.ts", "interpolate.ts", "lock.ts", "random.ts", "spring.ts", "stagger.ts"]);
  for (const file of files) {
    const code = fs.readFileSync(path.join(HERE, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const line of code.split("\n")) {
      // 顶层的声明都顶格写：顶格的 let / var 就是模块级的可变量
      assert.doesNotMatch(line, /^(export\s+)?(let|var)\s/, `${file}: ${line}`);
      // 顶格的 const 不许是容器（Map、Set、数组缓冲、空对象、空数组）
      assert.doesNotMatch(line, /^(export\s+)?const\s+\w+[^=]*=\s*(new\s+(Map|Set|WeakMap|WeakSet|Array|Float\d+Array|Uint\d+Array|Int\d+Array|ArrayBuffer)\b|\{\s*\}|\[\s*\])/, `${file}: ${line}`);
    }
    assert.doesNotMatch(code, /\bDate\b|\bperformance\b|setTimeout|setInterval|requestAnimationFrame|Math\.random|\bcrypto\b|\bwindow\b|\bglobalThis\b|localStorage|sessionStorage|\bdocument\b/, file);
    if (file !== "lock.ts") assert.doesNotMatch(code, /\bWeakMap\b|\bWeakSet\b|\bnew Map\b|\bnew Set\b/, `${file} 不用容器`);
  }
  // 行为上：同一个调用连做两遍，中间穿插别的调用，结果不变（没有藏着的「上一次」）
  const probe = () => bits([F.spring(0.31, { stiffness: 90 }), F.noise(1.37, "k"), F.tween(0.2, { duration: 0.5 }), F.random("k", 1), F.interpolateColors(0.3, [0, 1], ["#000", "#fff"])]);
  const first = probe();
  frameValues(99);
  assert.equal(probe(), first);
});

test("RS-T-07 守门：框架在现有卡片的导入闭包之外（只有用框架写的新卡引它）", () => {
  /*
   * 每张卡的源码版本 = 它的定义文件连同导入闭包里每个文件的全文（`src/render/cardSourceVersion.mjs`）。
   * 现有的内核、渲染、卡片、部件文件只要有一个引了框架，框架就进了一批老卡的闭包：以后框架每改一行，
   * 那批卡的预渲染结果的键就全变，已生成的卡片声音也被判过期。所以 `src/` 下除了框架自己，谁都不引它。
   * 框架反过来也不引别的模块（它的闭包只有自己这几个文件）。
   * 改之前与改之后逐张比源码版本的脚本：`scripts/probes/card-source-version-compare.mjs`。
   */
  const SRC = path.resolve(HERE, "..", "..");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const specifiers = (text) => [...text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    .matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map((m) => m[1]);
  const offenders = [];
  for (const file of walk(SRC)) {
    if (!/\.(ts|tsx|mts|mjs|js)$/.test(file) || /\.test\.(ts|tsx|mjs|js)$/.test(file) || file.startsWith(HERE + path.sep)) continue;
    for (const spec of specifiers(fs.readFileSync(file, "utf8"))) if (/remotionStyle/.test(spec)) offenders.push(`${path.relative(SRC, file).replace(/\\/g, "/")} → ${spec}`);
  }
  assert.deepEqual(offenders, [], "现有文件不引框架（用户卡目录下用框架写的新卡除外，仓库里没有这样的卡）");
  for (const file of fs.readdirSync(HERE).filter((f) => f.endsWith(".ts"))) {
    for (const spec of specifiers(fs.readFileSync(path.join(HERE, file), "utf8"))) assert.match(spec, /^\.\/(easing|interpolate|spring|stagger|random)\.ts$/, `${file} → ${spec}`);
  }
});

/* ------------------------------------------------------------------ 载入时锁只读 */

const throwsLocked = (fn, what) => assert.throws(fn, (err) => err instanceof TypeError, what);

test("RS-T-06 载入时锁只读：顶层的对象、数组、Map、Set、函数、正则一写就当场报错", () => {
  const COUNTER = { frames: 0, nested: { list: [1, 2, { deep: true }] } };
  const TRAIL = [0];
  const TABLE = new Map([["a", { n: 1 }]]);
  const TAGS = new Set(["x"]);
  const RE = /a/g;
  function Component() { return null; }
  const card = { id: "x", defaults: { size: 1 }, controls: [{ key: "size" }], Component };
  lockTopLevel("src/cards/user/x.tsx", [["COUNTER", () => COUNTER], ["TRAIL", () => TRAIL], ["TABLE", () => TABLE], ["TAGS", () => TAGS], ["RE", () => RE],
    ["Component", () => Component], ["card", () => card], ["OnlyAType", () => { throw new ReferenceError("OnlyAType is not defined"); }]]);

  // 本文件是模块，严格模式：往冻住的对象里写当场抛错
  throwsLocked(() => { COUNTER.frames += 1; }, "对象的属性");
  throwsLocked(() => { COUNTER.fresh = 1; }, "加新属性");
  throwsLocked(() => { delete COUNTER.frames; }, "删属性");
  throwsLocked(() => { COUNTER.nested.list.push(4); }, "深处的数组");
  throwsLocked(() => { COUNTER.nested.list[2].deep = false; }, "深处的对象");
  throwsLocked(() => { TRAIL.push(1); }, "数组 push");
  throwsLocked(() => { TRAIL[0] = 9; }, "数组下标");
  throwsLocked(() => { TRAIL.length = 0; }, "数组长度");
  throwsLocked(() => { TABLE.set("b", 1); }, "Map.set");
  throwsLocked(() => { TABLE.delete("a"); }, "Map.delete");
  throwsLocked(() => { TABLE.clear(); }, "Map.clear");
  throwsLocked(() => { TABLE.get("a").n += 1; }, "Map 里的值");
  throwsLocked(() => { TAGS.add("y"); }, "Set.add");
  throwsLocked(() => { TAGS.clear(); }, "Set.clear");
  throwsLocked(() => { RE.lastIndex = 3; }, "正则的 lastIndex");
  throwsLocked(() => { Component.count = 1; }, "往函数上挂东西");
  throwsLocked(() => { card.defaults.size = 2; }, "卡片定义的默认参数");
  throwsLocked(() => { card.controls.push({}); }, "卡片定义的控件表");
  // 绕一道变量也一样：锁的是对象，不是名字
  const alias = COUNTER;
  throwsLocked(() => { alias.frames = 5; }, "经别名写");
  assert.match((() => { try { TABLE.set("b", 1); } catch (e) { return e.message; } return ""; })(), /src\/cards\/user\/x\.tsx.*TABLE.*只读/s, "报错说得出是哪张卡的哪个名字");

  // 读不受影响；值没被动过
  assert.equal(COUNTER.frames, 0);
  assert.deepEqual(TRAIL, [0]);
  assert.equal(TABLE.get("a").n, 1);
  assert.equal(TAGS.has("x"), true);
  assert.deepEqual({ ...card.defaults, size: 3 }, { size: 3 }, "拷一份出来照常能改");
  assert.equal(Component(), null);
  assert.deepEqual([...COUNTER.nested.list.map((x) => x), 4].length, 4);
});

test("RS-T-06 载入时锁只读：别的模块导出的东西不碰；React 元素不碰；锁不住的当场指出；重复锁、环形引用不出事", () => {
  // 别的模块的导出（连同它们下面一层）不是这张卡的：既不冻、也不往里走
  const shared = { controls: [{ key: "position", options: [1, 2] }], defaults: { accent: "" }, internals: { H: null } };
  const reactLike = { default: { useMemo() {}, __INTERNALS: { H: null } }, useMemo() {} };
  const OWN = { controls: [...shared.controls, { key: "mine" }], defaults: { ...shared.defaults, x: 1 }, ref: shared.internals, React: reactLike.default };
  lockTopLevel("src/cards/user/y.tsx", [["OWN", () => OWN], ["ALIAS", () => shared.defaults], ["R", () => reactLike.default]], [shared, reactLike]);
  assert.ok(Object.isFrozen(OWN) && Object.isFrozen(OWN.controls) && Object.isFrozen(OWN.defaults) && Object.isFrozen(OWN.controls[1]));
  assert.equal(Object.isFrozen(shared), false);
  assert.equal(Object.isFrozen(shared.controls), false);
  assert.equal(Object.isFrozen(shared.controls[0]), false, "展开进来的别人的对象不冻");
  assert.equal(Object.isFrozen(shared.defaults), false);
  assert.equal(Object.isFrozen(shared.internals), false);
  assert.equal(Object.isFrozen(reactLike.default), false);
  assert.equal(Object.isFrozen(reactLike.default.__INTERNALS), false, "React 自己要写的内部对象不能被冻住");
  reactLike.default.__INTERNALS.H = 1;
  assert.equal(Object.isFrozen(reactLike.useMemo), false);

  // React 元素（带 $$typeof）不碰：开发模式的 React 要往它的 _store 里记东西
  const element = { $$typeof: Symbol.for("react.transitional.element"), type: "div", props: { children: [] }, _store: { validated: 0 } };
  const HOLDER = { icon: element };
  lockTopLevel("src/cards/user/z.tsx", [["HOLDER", () => HOLDER]]);
  assert.ok(Object.isFrozen(HOLDER));
  element._store.validated = 1;
  assert.equal(element._store.validated, 1);

  // 锁不住的东西：载入时当场报错，说得出是哪一个
  class Thing { n = 0; }
  for (const [value, what] of [[new Float32Array(4), /BUF.*Float32Array.*锁不成只读/s], [new Thing(), /BUF.*Thing/s], [Promise.resolve(1), /BUF.*Promise/s], [new Date(0), /BUF.*Date/s], [new WeakMap(), /BUF.*WeakMap/s]]) {
    assert.throws(() => lockTopLevel("src/cards/user/b.tsx", [["BUF", () => value]]), (err) => err instanceof TypeError && what.test(err.message) && /src\/cards\/user\/b\.tsx/.test(err.message));
  }
  assert.throws(() => lockTopLevel("src/cards/user/b.tsx", [["OUTER", () => ({ inner: [new Uint8Array(1)] })]]), /OUTER\.inner\[0\]/);
  // 同一个锁不住的东西如果是别的模块给的，就不是这张卡的事
  const foreignBuffer = new Float32Array(2);
  lockTopLevel("src/cards/user/b.tsx", [["BUF", () => foreignBuffer]], [{ foreignBuffer }]);

  // 环形引用、重复锁
  const A = { name: "a" }; const B = { name: "b", a: A }; A.b = B;
  lockTopLevel("src/cards/user/c.tsx", [["A", () => A], ["B", () => B]]);
  lockTopLevel("src/cards/user/c.tsx", [["A", () => A]]);
  assert.ok(Object.isFrozen(A) && Object.isFrozen(B));
  // 原始值、没有值的名字：什么也不做
  lockTopLevel("src/cards/user/c.tsx", [["N", () => 1], ["S", () => "s"], ["U", () => undefined], ["NIL", () => null]]);
});
