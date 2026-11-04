/**
 * Start / stop of background work is judged by the parent page (section 2 of C10 contract): page is
 * visible ∧ rAF interval does not continuously exceed 500 ms ∧ parent page rIC is invoking callback.
 * Run: node --test src/editor/backWorkGate.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeBackWork, RAF_GAP_PAUSE_MS, IDLE_STALE_MS } from "./backWorkGate.ts";

test("C10-BW-01 Visible, rAF normal, parent page idle: on", () => {
  assert.deepEqual(judgeBackWork({ visible: true, now: 10_000, lastRafAt: 9_990, lastIdleAt: 9_900 }), { on: true, reason: null });
});

test("C10-BW-02 Stop when the page is hidden (the browser will not stop it for you)", () => {
  assert.deepEqual(judgeBackWork({ visible: false, now: 10_000, lastRafAt: 9_999, lastIdleAt: 9_999 }), { on: false, reason: "hidden" });
});

test("C10-BW-03 Stop when the parent page's rAF interval exceeds 500 ms; exactly 500 does not stop", () => {
  assert.equal(RAF_GAP_PAUSE_MS, 500);
  assert.equal(judgeBackWork({ visible: true, now: 10_000, lastRafAt: 9_500, lastIdleAt: 9_999 }).on, true);
  assert.deepEqual(judgeBackWork({ visible: true, now: 10_000, lastRafAt: 9_499, lastIdleAt: 9_999 }), { on: false, reason: "raf-gap" });
});

test("C10-BW-04 Stop when the parent page's own rIC has not called back for too long (main thread busy)", () => {
  assert.deepEqual(judgeBackWork({ visible: true, now: 10_000, lastRafAt: 9_999, lastIdleAt: 10_000 - IDLE_STALE_MS - 1 }), { on: false, reason: "busy" });
});
