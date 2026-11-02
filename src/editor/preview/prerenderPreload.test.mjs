/**
 * Scheduling for page-triggered prerendering (`prerenderPreload.ts`).
 * Run: node --test src/editor/preview/prerenderPreload.test.mjs
 *
 * Pins down: debounce after edits, send only when idle, re-query after 2s if not ready, pause
 * during playback, recheck once after idle, retry after 4s on failure, resend if edited while
 * request in flight.
 */
import "../../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { createPreloadScheduler, PRELOAD_DEBOUNCE_MS, PRELOAD_POLL_MS, PRELOAD_RETRY_MS, PRELOAD_REQUEST_TIMEOUT_MS } = await import("./prerenderPreload.ts");

/** Fake timer: manually advance virtual time */
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
        // Let the request Promise settle
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

test("Does not send when not idle; sends once after the debounce when idle; stops once ready", async () => {
  const { clock, calls, scheduler } = setup([{ status: "ready" }]);
  scheduler.edited();
  await clock.advance(5000);
  assert.equal(calls.length, 0, "Does not send during playback / scrubbing");
  scheduler.setIdle(true);
  await clock.advance(PRELOAD_DEBOUNCE_MS - 1);
  assert.equal(calls.length, 0, "Does not send during the debounce period");
  await clock.advance(1);
  assert.equal(calls.length, 1);
  await clock.advance(20000);
  assert.equal(calls.length, 1, "Does not ask again once ready");
});

test("Consecutive edits send only the last one (debounce)", async () => {
  const { clock, calls, scheduler } = setup([{ status: "ready" }]);
  scheduler.setIdle(true);
  for (let i = 0; i < 5; i++) { scheduler.edited(); await clock.advance(PRELOAD_DEBOUNCE_MS / 2); }
  assert.equal(calls.length, 0);
  await clock.advance(PRELOAD_DEBOUNCE_MS);
  assert.equal(calls.length, 1);
});

test("If not ready, ask again after 2 seconds, until ready", async () => {
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

test("Stops during playback; after idle, re-checks once the version that was not ready", async () => {
  const { clock, calls, scheduler } = setup([{ status: "html" }, { status: "ready" }]);
  scheduler.setIdle(true);
  await clock.advance(PRELOAD_DEBOUNCE_MS);
  assert.equal(calls.length, 1);
  scheduler.setIdle(false);
  await clock.advance(60000);
  assert.equal(calls.length, 1, "Does not ask during playback");
  scheduler.setIdle(true);
  await clock.advance(PRELOAD_DEBOUNCE_MS);
  assert.equal(calls.length, 2, "Re-checks after idle");
});

test("A version that is already ready is not re-checked after playback; it is sent only after a further edit", async () => {
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

test("A failed request is retried after 4 seconds", async () => {
  const { clock, calls, scheduler } = setup([new Error("prerender restarting"), { status: "ready" }]);
  scheduler.setIdle(true);
  await clock.advance(PRELOAD_DEBOUNCE_MS);
  assert.equal(calls.length, 1);
  await clock.advance(PRELOAD_RETRY_MS - 1);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.equal(calls.length, 2);
});

test("Nothing is sent after dispose", async () => {
  const { clock, calls, scheduler } = setup([]);
  scheduler.setIdle(true);
  scheduler.dispose();
  scheduler.edited();
  await clock.advance(20000);
  assert.equal(calls.length, 0);
  assert.equal(clock.pending(), 0);
});

test("After a preload hangs forever it is canceled and retried; a late response must not overwrite the new state", async () => {
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
