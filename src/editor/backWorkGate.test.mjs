/**
 * 后台活的开始 / 停止由父页判(C10 契约第 2 节):页面可见 ∧ rAF 间隔不持续超过 500 ms ∧ 父页 rIC 在回调。
 * 跑:node --test src/editor/backWorkGate.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeBackWork, RAF_GAP_PAUSE_MS, IDLE_STALE_MS } from "./backWorkGate.ts";

test("C10-BW-01 可见、rAF 正常、父页空闲:开", () => {
  assert.deepEqual(judgeBackWork({ visible: true, now: 10_000, lastRafAt: 9_990, lastIdleAt: 9_900 }), { on: true, reason: null });
});

test("C10-BW-02 页面隐藏就停(浏览器不会替你停)", () => {
  assert.deepEqual(judgeBackWork({ visible: false, now: 10_000, lastRafAt: 9_999, lastIdleAt: 9_999 }), { on: false, reason: "hidden" });
});

test("C10-BW-03 父页 rAF 间隔超过 500 ms 就停;恰好 500 不停", () => {
  assert.equal(RAF_GAP_PAUSE_MS, 500);
  assert.equal(judgeBackWork({ visible: true, now: 10_000, lastRafAt: 9_500, lastIdleAt: 9_999 }).on, true);
  assert.deepEqual(judgeBackWork({ visible: true, now: 10_000, lastRafAt: 9_499, lastIdleAt: 9_999 }), { on: false, reason: "raf-gap" });
});

test("C10-BW-04 父页自己的 rIC 太久没回调(主线程忙)就停", () => {
  assert.deepEqual(judgeBackWork({ visible: true, now: 10_000, lastRafAt: 9_999, lastIdleAt: 10_000 - IDLE_STALE_MS - 1 }), { on: false, reason: "busy" });
});
