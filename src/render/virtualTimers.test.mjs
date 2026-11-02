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

test("setTimeout: fires only when due, one-shot, runs only once", () => {
  const vt = createVirtualTimers();
  const hits = [];
  vt.set(() => hits.push("a"), 100, [], false, 0);
  assert.equal(vt.settle(99), 0);
  assert.equal(vt.settle(100), 1);
  assert.deepEqual(hits, ["a"]);
  assert.equal(vt.settle(1000), 0);
  assert.equal(vt.size(), 0);
});

test("same time: in registration order; different times: in order of expiry", () => {
  const vt = createVirtualTimers();
  const order = [];
  vt.set(() => order.push("late"), 20, [], false, 0);
  vt.set(() => order.push("early1"), 10, [], false, 0);
  vt.set(() => order.push("early2"), 10, [], false, 0);
  vt.settle(50);
  assert.deepEqual(order, ["early1", "early2", "late"]);
});

test("setInterval: one step every 100 ms, advancing to second 3 gives exactly 30 steps (E4b typing card)", () => {
  const vt = createVirtualTimers();
  let cells = 0;
  vt.set(() => { cells++; }, 100, [], true, 0);
  // 30 fps 的拍子,一拍 1000/30 ms,一路推到 3000 ms
  const step = 1000 / 30;
  for (let ms = step; ms <= 3000 + 1e-9; ms += step) vt.settle(ms);
  vt.settle(3000);
  assert.equal(cells, 30);
});

test("setInterval: when one tick spans several periods, catch up within the same tick", () => {
  const vt = createVirtualTimers();
  let n = 0;
  vt.set(() => { n++; }, 10, [], true, 0);
  assert.equal(vt.settle(55), 5);
  assert.equal(n, 5);
});

test("a 0 ms timer registered inside a callback is pushed to the next tick (a self-feeding loop cannot lock up a tick)", () => {
  const vt = createVirtualTimers();
  let n = 0;
  const loop = () => { n++; vt.set(loop, 0, [], false, 0); };
  vt.set(loop, 0, [], false, 0);
  assert.equal(vt.settle(0), 1);
  assert.equal(n, 1);
  assert.equal(vt.settle(0), 1);
  assert.equal(n, 2);
});

test("shift: seeking does not settle, the remaining time of pending timers is preserved", () => {
  const vt = createVirtualTimers();
  const hits = [];
  vt.set(() => hits.push("x"), 100, [], false, 0);       // 到期 100
  vt.set(() => hits.push("i"), 50, [], true, 0);         // 每 50
  // clock.set(5000):往前跳 5 秒,不结算
  vt.shift(5000 - 0);
  assert.deepEqual(hits, [], "no timers in the skipped span fire");
  // 剩余时间保持:x 还差 100 ms,i 还差 50 ms
  assert.equal(vt.settle(5049), 0);
  assert.equal(vt.settle(5050), 1);
  assert.deepEqual(hits, ["i"]);
  assert.equal(vt.settle(5100), 2, "x expires + i gets one more tick");
});

test("shift: jumping backward does not settle either, remaining time is kept", () => {
  const vt = createVirtualTimers();
  let n = 0;
  vt.set(() => { n++; }, 200, [], false, 1000);          // 到期 1200
  vt.shift(0 - 1000);                                    // 拨回 0
  assert.equal(vt.settle(199), 0);
  assert.equal(vt.settle(200), 1);
  assert.equal(n, 1);
});

test("clear: a virtual id is removed and returns true; a real id returns false and is left to the caller", () => {
  const vt = createVirtualTimers();
  let n = 0;
  const id = vt.set(() => { n++; }, 10, [], true, 0);
  assert.ok(id >= VIRTUAL_TIMER_BASE, "virtual ids start at 1e9, distinct from real setTimeout ids");
  assert.equal(vt.clear(id), true);
  assert.equal(vt.size(), 0);
  vt.settle(1000);
  assert.equal(n, 0);
  assert.equal(vt.clear(7), false, "real ids are not its concern");
  assert.equal(vt.clear(undefined), false);
});

test("a handler that is not a function is not registered (string eval is not supported)", () => {
  const vt = createVirtualTimers();
  assert.equal(vt.set("alert(1)", 0, [], false, 0), 0);
  assert.equal(vt.size(), 0);
});

test("extra arguments are passed through to the callback unchanged (setTimeout(fn, ms, ...args))", () => {
  const vt = createVirtualTimers();
  let got = null;
  vt.set((...a) => { got = a; }, 1, ["p", 2], false, 0);
  vt.settle(1);
  assert.deepEqual(got, ["p", 2]);
});
