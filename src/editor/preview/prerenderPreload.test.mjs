/**
 * 页面触发预渲染的调度(`prerenderPreload.ts`)。跑:node --test src/editor/preview/prerenderPreload.test.mjs
 *
 * 钉的是:编辑后防抖、只在空闲时发、没就绪隔 2 秒再问、播放中停、空闲后复查一次、失败隔 4 秒重试、请求在飞时又编辑会再发一次。
 */
import "../../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { createPreloadScheduler, PRELOAD_DEBOUNCE_MS, PRELOAD_POLL_MS, PRELOAD_RETRY_MS, PRELOAD_REQUEST_TIMEOUT_MS } = await import("./prerenderPreload.ts");

/** 假计时器:手动推进虚拟时间 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        // 让 request 的 Promise 落定
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

function setup(statuses) {
  const clock = fakeClock();
  const calls = [];
  const queue = [...statuses];
  const scheduler = createPreloadScheduler({
    request: async () => {
      calls.push(clock);
      const next = queue.length ? queue.shift() : { status: "ready" };
      if (next instanceof Error) throw next;
      return next;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, calls, scheduler };
}

test("不空闲不发;空闲后按防抖发一次,就绪就停", async () => {
  const { clock, calls, scheduler } = setup([{ status: "ready" }]);
  scheduler.edited();
  await clock.advance(5000);
  assert.equal(calls.length, 0, "播放 / 拖动中不发");
  scheduler.setIdle(true);
  await clock.advance(PRELOAD_DEBOUNCE_MS - 1);
  assert.equal(calls.length, 0, "防抖期内不发");
  await clock.advance(1);
  assert.equal(calls.length, 1);
  await clock.advance(20000);
  assert.equal(calls.length, 1, "就绪之后不再问");
});

test("连续编辑只发最后那一次(防抖)", async () => {
  const { clock, calls, scheduler } = setup([{ status: "ready" }]);
  scheduler.setIdle(true);
  for (let i = 0; i < 5; i++) { scheduler.edited(); await clock.advance(PRELOAD_DEBOUNCE_MS / 2); }
  assert.equal(calls.length, 0);
  await clock.advance(PRELOAD_DEBOUNCE_MS);
  assert.equal(calls.length, 1);
});

test("没就绪隔 2 秒再问,直到就绪", async () => {
  const { clock, calls, scheduler } = setup([{ status: "html" }, { status: "html" }, { status: "ready" }]);
  scheduler.setIdle(true);
  await clock.advance(PRELOAD_DEBOUNCE_MS);
  assert.equal(calls.length, 1);
  await clock.advance(PRELOAD_POLL_MS);
  assert.equal(calls.length, 2);
  await clock.advance(PRELOAD_POLL_MS);
  assert.equal(calls.length, 3);
  await clock.advance(20000);
  assert.equal(calls.length, 3);
});

test("播放中停下;空闲之后没就绪的那一版复查一次", async () => {
  const { clock, calls, scheduler } = setup([{ status: "html" }, { status: "ready" }]);
  scheduler.setIdle(true);
  await clock.advance(PRELOAD_DEBOUNCE_MS);
  assert.equal(calls.length, 1);
  scheduler.setIdle(false);
  await clock.advance(60000);
  assert.equal(calls.length, 1, "播放中不问");
  scheduler.setIdle(true);
  await clock.advance(PRELOAD_DEBOUNCE_MS);
  assert.equal(calls.length, 2, "空闲之后复查");
});

test("已经就绪的,播放完不复查;再编辑才发", async () => {
  const { clock, calls, scheduler } = setup([{ status: "ready" }, { status: "ready" }]);
  scheduler.setIdle(true);
  await clock.advance(PRELOAD_DEBOUNCE_MS);
  scheduler.setIdle(false);
  scheduler.setIdle(true);
  await clock.advance(10000);
  assert.equal(calls.length, 1);
  scheduler.edited();
  await clock.advance(PRELOAD_DEBOUNCE_MS);
  assert.equal(calls.length, 2);
});

test("请求失败隔 4 秒重试", async () => {
  const { clock, calls, scheduler } = setup([new Error("prerender restarting"), { status: "ready" }]);
  scheduler.setIdle(true);
  await clock.advance(PRELOAD_DEBOUNCE_MS);
  assert.equal(calls.length, 1);
  await clock.advance(PRELOAD_RETRY_MS - 1);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.equal(calls.length, 2);
});

test("dispose 之后什么都不发", async () => {
  const { clock, calls, scheduler } = setup([]);
  scheduler.setIdle(true);
  scheduler.dispose();
  scheduler.edited();
  await clock.advance(20000);
  assert.equal(calls.length, 0);
  assert.equal(clock.pending(), 0);
});

test("一次 preload 永久悬挂后会取消并重试，迟到回包不能覆盖新状态", async () => {
  const clock = fakeClock();
  const calls = [];
  let finishOld;
  const scheduler = createPreloadScheduler({
    request: (signal) => {
      calls.push(signal);
      if (calls.length === 1) return new Promise((resolve) => { finishOld = resolve; });
      return Promise.resolve({ status: "ready" });
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  scheduler.setIdle(true);
  await clock.advance(PRELOAD_DEBOUNCE_MS);
  assert.equal(calls.length, 1);
  await clock.advance(PRELOAD_REQUEST_TIMEOUT_MS);
  assert.equal(calls[0].aborted, true);
  await clock.advance(PRELOAD_RETRY_MS);
  assert.equal(calls.length, 2);
  finishOld({ status: "html" });
  await clock.advance(10_000);
  assert.equal(calls.length, 2);
  scheduler.dispose();
});
