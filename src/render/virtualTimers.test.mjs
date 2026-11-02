/**
 * Unit tests for virtual timers (E4b). Run: node --test src/render/virtualTimers.test.mjs
 *
 * Four rules pinned down:
 *   - When `tick` advances, trigger in expiration order; at the same timestamp, by registration
 *     order;
 *   - `setInterval` reschedules by period; when a single tick crosses multiple periods, catch up
 *     within the same tick;
 *   - **Jump without settling** (`shift`): timers in the skipped range do not trigger, and each
 *     pending timer's **remaining time is preserved**;
 *   - `clear` only recognizes virtual ids (≥ 1e9), returning real ids to the caller: the stage's
 *     own wall-clock timers rely on this to avoid being mistakenly removed.
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
  // 30 fps ticks, 1000/30 ms per tick, advancing all the way to 3000 ms
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
  vt.set(() => hits.push("x"), 100, [], false, 0);       // Expires at 100
  vt.set(() => hits.push("i"), 50, [], true, 0);         // Every 50
  // clock.set(5000): jump forward 5 seconds, do not settle
  vt.shift(5000 - 0);
  assert.deepEqual(hits, [], "no timers in the skipped span fire");
  // Remaining time preserved: x still has 100 ms left, i still has 50 ms left
  assert.equal(vt.settle(5049), 0);
  assert.equal(vt.settle(5050), 1);
  assert.deepEqual(hits, ["i"]);
  assert.equal(vt.settle(5100), 2, "x expires + i gets one more tick");
});

test("shift: jumping backward does not settle either, remaining time is kept", () => {
  const vt = createVirtualTimers();
  let n = 0;
  vt.set(() => { n++; }, 200, [], false, 1000);          // Expires at 1200
  vt.shift(0 - 1000);                                    // Dial back to 0
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
