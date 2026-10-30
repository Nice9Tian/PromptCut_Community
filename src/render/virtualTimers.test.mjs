/**
 * 虚拟定时器(E4b)的单测。跑:node --test src/render/virtualTimers.test.mjs
 *
 * 钉死四条:
 *   - `tick` 推进时按到期顺序触发,同一时刻按登记顺序;
 *   - `setInterval` 按周期重排,一拍跨过好几个周期时在同一拍里追齐;
 *   - **跳转不结算**(`shift`):跳过的那段里的定时器不触发,每个挂起定时器的**剩余时间保持**;
 *   - `clear` 只认虚拟 id(≥ 1e9),真 id 交回调用方 —— 舞台自身的墙钟定时器靠这条不被张冠李戴地摘掉。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createVirtualTimers, VIRTUAL_TIMER_BASE } from "./virtualTimers.ts";

test("setTimeout:到期才触发,一次性,只跑一遍", () => {
  const vt = createVirtualTimers();
  const hits = [];
  vt.set(() => hits.push("a"), 100, [], false, 0);
  assert.equal(vt.settle(99), 0);
  assert.equal(vt.settle(100), 1);
  assert.deepEqual(hits, ["a"]);
  assert.equal(vt.settle(1000), 0);
  assert.equal(vt.size(), 0);
});

test("同一时刻按登记顺序;不同时刻按到期先后", () => {
  const vt = createVirtualTimers();
  const order = [];
  vt.set(() => order.push("晚"), 20, [], false, 0);
  vt.set(() => order.push("早1"), 10, [], false, 0);
  vt.set(() => order.push("早2"), 10, [], false, 0);
  vt.settle(50);
  assert.deepEqual(order, ["早1", "早2", "晚"]);
});

test("setInterval:每 100 ms 一格,推到第 3 秒恰好 30 格(E4b 的打字机卡)", () => {
  const vt = createVirtualTimers();
  let cells = 0;
  vt.set(() => { cells++; }, 100, [], true, 0);
  // 30 fps 的拍子,一拍 1000/30 ms,一路推到 3000 ms
  const step = 1000 / 30;
  for (let ms = step; ms <= 3000 + 1e-9; ms += step) vt.settle(ms);
  vt.settle(3000);
  assert.equal(cells, 30);
});

test("setInterval:一拍跨过好几个周期时在同一拍里追齐", () => {
  const vt = createVirtualTimers();
  let n = 0;
  vt.set(() => { n++; }, 10, [], true, 0);
  assert.equal(vt.settle(55), 5);
  assert.equal(n, 5);
});

test("回调里再登记的 0 毫秒定时器推到下一拍(自喂循环不会锁死一拍)", () => {
  const vt = createVirtualTimers();
  let n = 0;
  const loop = () => { n++; vt.set(loop, 0, [], false, 0); };
  vt.set(loop, 0, [], false, 0);
  assert.equal(vt.settle(0), 1);
  assert.equal(n, 1);
  assert.equal(vt.settle(0), 1);
  assert.equal(n, 2);
});

test("shift:跳转不结算,挂起定时器的剩余时间保持", () => {
  const vt = createVirtualTimers();
  const hits = [];
  vt.set(() => hits.push("x"), 100, [], false, 0);       // 到期 100
  vt.set(() => hits.push("i"), 50, [], true, 0);         // 每 50
  // clock.set(5000):往前跳 5 秒,不结算
  vt.shift(5000 - 0);
  assert.deepEqual(hits, [], "跳过的那段里的定时器一个都不触发");
  // 剩余时间保持:x 还差 100 ms,i 还差 50 ms
  assert.equal(vt.settle(5049), 0);
  assert.equal(vt.settle(5050), 1);
  assert.deepEqual(hits, ["i"]);
  assert.equal(vt.settle(5100), 2, "x 到期 + i 又一格");
});

test("shift:往回跳同样不结算、剩余时间保持", () => {
  const vt = createVirtualTimers();
  let n = 0;
  vt.set(() => { n++; }, 200, [], false, 1000);          // 到期 1200
  vt.shift(0 - 1000);                                    // 拨回 0
  assert.equal(vt.settle(199), 0);
  assert.equal(vt.settle(200), 1);
  assert.equal(n, 1);
});

test("clear:虚拟 id 摘掉并回 true;真 id 回 false 交给调用方", () => {
  const vt = createVirtualTimers();
  let n = 0;
  const id = vt.set(() => { n++; }, 10, [], true, 0);
  assert.ok(id >= VIRTUAL_TIMER_BASE, "虚拟 id 从 1e9 起,和真 setTimeout 的 id 分得开");
  assert.equal(vt.clear(id), true);
  assert.equal(vt.size(), 0);
  vt.settle(1000);
  assert.equal(n, 0);
  assert.equal(vt.clear(7), false, "真 id 不归它管");
  assert.equal(vt.clear(undefined), false);
});

test("handler 不是函数就不登记(字符串 eval 那一套不支持)", () => {
  const vt = createVirtualTimers();
  assert.equal(vt.set("alert(1)", 0, [], false, 0), 0);
  assert.equal(vt.size(), 0);
});

test("多余参数原样传给回调(setTimeout(fn, ms, ...args))", () => {
  const vt = createVirtualTimers();
  let got = null;
  vt.set((...a) => { got = a; }, 1, ["p", 2], false, 0);
  vt.settle(1);
  assert.deepEqual(got, ["p", 2]);
});
