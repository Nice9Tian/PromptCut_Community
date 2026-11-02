/**
 * 在线页面两个跨源舞台的首次握手计时(`stageHandshake.ts`,〔裁〕2026-09-30 `claude/stage-handshake`):
 * 每台从自己 iframe 的 `load` 起算 20 秒,另有自打开起的总上限;慢加载不退回,加载完握不上照旧退回。
 * 跑:node --test src/online/stageHandshake.test.mjs
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createStageHandshake, STAGE_HANDSHAKE_TOTAL_MS, STAGE_INTERIM_AFTER_MS } from "./stageHandshake.ts";
import { markStageHandshake, onlineStageState, resetOnlineStagesForTest, stageLayout, STAGE_HANDSHAKE_TIMEOUT_MS } from "./stageOrigins.ts";

const origins = { A: "https://s1.x.io", B: "https://s2.x.io" };
const layout = () => stageLayout({ single: false, origins, handshake: onlineStageState().handshake });

function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, v] of timers) if (v.at <= end && (!next || v.at < next[1].at || (v.at === next[1].at && id < next[0]))) next = [id, v];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

function harness(opts = {}) {
  const clock = fakeClock();
  const calls = { fail: [], ok: 0 };
  const hs = createStageHandshake({
    ids: ["A", "B"],
    fail: (reason) => { calls.fail.push(reason); markStageHandshake("failed", reason); },
    ok: () => { calls.ok++; markStageHandshake("ok"); },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    ...opts,
  });
  return { clock, calls, hs };
}

beforeEach(() => resetOnlineStagesForTest({ config: "done", origins }));

test("Numbers: 20 seconds per stage, 2 minutes total limit", () => {
  assert.equal(STAGE_HANDSHAKE_TIMEOUT_MS, 20_000);
  assert.equal(STAGE_HANDSHAKE_TOTAL_MS, 120_000);
});

test("H1 timing starts from load: 30 seconds after opening with no load does not fall back; handshake 19 seconds after load → dual stage", () => {
  const { clock, calls, hs } = harness();
  clock.advance(30_000);
  assert.equal(calls.fail.length, 0, "Before load, the 20-second check does not apply");
  assert.equal(layout(), "dual");
  hs.loaded("A"); hs.loaded("B");
  clock.advance(19_000);
  hs.ready("A"); hs.ready("B");
  assert.equal(calls.ok, 1);
  assert.equal(onlineStageState().handshake, "ok");
  assert.equal(hs.phase, "ok");
  assert.equal(clock.pending(), 0, "After the handshake, all timers are cleared");
  clock.advance(STAGE_HANDSHAKE_TOTAL_MS);
  assert.equal(calls.fail.length, 0);
});

test("H2 slow load: stage loads only after 40 seconds, handshake 1 second later, no fallback", () => {
  const { clock, calls, hs } = harness();
  clock.advance(40_000);
  hs.loaded("A");
  clock.advance(1000);
  hs.ready("A");
  // B 依次加载(Preview 在 A load 之后才挂 B):再 38 秒 load、1 秒握上
  clock.advance(38_000);
  hs.loaded("B");
  clock.advance(1000);
  hs.ready("B");
  assert.deepEqual(calls.fail, []);
  assert.equal(onlineStageState().handshake, "ok");
  assert.equal(layout(), "dual");
  const st = hs.status();
  assert.equal(st.slots.A.loadedAt, 40_000);
  assert.equal(st.slots.B.readyAt, 80_000);
});

test("H3 no handshake 20 seconds after load finishes → fall back to single stage (the stage is really broken; the fallback time is 20 seconds, same as before)", () => {
  const { clock, calls, hs } = harness();
  clock.advance(2000);
  hs.loaded("A"); hs.loaded("B");
  hs.ready("A");
  clock.advance(STAGE_HANDSHAKE_TIMEOUT_MS - 1);
  assert.equal(calls.fail.length, 0);
  clock.advance(1);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /Stage B did not complete the handshake 20 s after loading/);
  assert.match(calls.fail[0], /Stages handshaken: A/);
  assert.equal(onlineStageState().handshake, "failed");
  assert.equal(layout(), "single");
  assert.equal(clock.pending(), 0);
  // 退回之后迟到的握手不改结果
  hs.ready("B");
  assert.equal(calls.ok, 0);
  assert.equal(onlineStageState().handshake, "failed");
});

test("H4 stage source returns an error page: the iframe still loads, fall back after 20 seconds (same as the original on-time fallback)", () => {
  const { clock, calls, hs } = harness();
  clock.advance(300);
  hs.loaded("A"); // 503 错误页也是一次 load,永远不会握手
  clock.advance(STAGE_HANDSHAKE_TIMEOUT_MS);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /Stage A did not complete the handshake 20 s after loading/);
  assert.equal(layout(), "single");
});

test("H5 total limit: never loads (or loads too late), fall back 2 minutes after opening", () => {
  const { clock, calls, hs } = harness();
  clock.advance(STAGE_HANDSHAKE_TOTAL_MS - 1);
  assert.equal(calls.fail.length, 0);
  clock.advance(1);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /Both stages did not complete the handshake within 120 s of opening/);
  assert.equal(layout(), "single");
  assert.equal(clock.pending(), 0);
});

test("H6 total limit overrides the per-stage limit: A loads at 110 seconds, does not wait the full 20 seconds, falls back at 120 seconds", () => {
  const { clock, calls, hs } = harness();
  clock.advance(110_000);
  hs.loaded("A");
  clock.advance(10_000);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /120 s of opening/);
});

test("H7 the same stage loading again (reload) restarts the timing", () => {
  const { clock, calls, hs } = harness();
  hs.loaded("A");
  clock.advance(15_000);
  hs.loaded("A");
  clock.advance(15_000);
  assert.equal(calls.fail.length, 0, "Only 15 seconds after the second load");
  clock.advance(5000);
  assert.equal(calls.fail.length, 1);
  assert.equal(hs.status().slots.A.loads, 2);
});

test("H8 handshake arrives before load (stage effect runs before the load event): a later load is no longer timed", () => {
  const { clock, calls, hs } = harness();
  hs.ready("A");
  hs.loaded("A");
  hs.loaded("B");
  hs.ready("B");
  assert.equal(calls.ok, 1);
  clock.advance(STAGE_HANDSHAKE_TOTAL_MS * 2);
  assert.equal(calls.fail.length, 0);
});

test("H9 after dispose nothing is reported (dual turns false or unmount)", () => {
  const { clock, calls, hs } = harness();
  hs.loaded("A");
  hs.dispose();
  assert.equal(hs.phase, "disposed");
  clock.advance(STAGE_HANDSHAKE_TOTAL_MS * 2);
  assert.equal(calls.fail.length, 0);
  assert.equal(clock.pending(), 0);
});

/* ---------------------------------------------------------------- 过渡的同源单舞台(interim) */

function harnessInterim(opts = {}) {
  const calls = { interim: [] };
  const h = harness({
    interim: (reason) => { calls.interim.push(reason); markStageHandshake("interim", reason); },
    ...opts,
  });
  h.calls.interim = calls.interim;
  return h;
}

test("Numbers: the interim period starts 20 seconds after opening", () => {
  assert.equal(STAGE_INTERIM_AFTER_MS, 20_000);
});

test("H10 visible stage has no handshake after 20 seconds → first show the same-origin single-stage picture (interim, single-stage layout), not counted as a failure", () => {
  const { clock, calls, hs } = harnessInterim();
  clock.advance(STAGE_INTERIM_AFTER_MS - 1);
  assert.equal(calls.interim.length, 0);
  assert.equal(layout(), "dual");
  clock.advance(1);
  assert.equal(calls.interim.length, 1);
  assert.match(calls.interim[0], /Visible stage A did not complete the handshake 20 s after attaching/);
  assert.equal(hs.phase, "interim");
  assert.equal(onlineStageState().handshake, "interim");
  assert.equal(onlineStageState().interimAt !== null, true);
  assert.equal(layout(), "single", "The interim period shows the picture as a same-origin single stage");
  assert.equal(calls.fail.length, 0);
  assert.equal(hs.status().interimAt, 20_000);
});

test("H11 switch back to dual stage after warm-up completes: A loads at 40 seconds and handshakes, B then loads and handshakes → ok, dual-stage layout", () => {
  const { clock, calls, hs } = harnessInterim();
  clock.advance(40_000);
  assert.equal(hs.phase, "interim");
  hs.loaded("A"); clock.advance(100); hs.ready("A");
  assert.equal(hs.phase, "interim", "With only A handshaken, do not switch back yet");
  assert.equal(layout(), "single");
  clock.advance(1000); hs.loaded("B"); clock.advance(100); hs.ready("B");
  assert.equal(hs.phase, "ok");
  assert.equal(calls.ok, 1);
  assert.equal(onlineStageState().handshake, "ok");
  assert.equal(layout(), "dual");
  assert.equal(clock.pending(), 0);
  assert.equal(calls.fail.length, 0);
  clock.advance(STAGE_HANDSHAKE_TOTAL_MS);
  assert.equal(calls.fail.length, 0, "After switching back, the total limit no longer applies");
});

test("H12 switch only once: if problems occur again after switching back to dual stage, the watchdog falls back to single stage, does not return to the interim period, and does not switch back and forth", () => {
  const { clock, calls, hs } = harnessInterim();
  clock.advance(25_000);
  hs.loaded("A"); hs.ready("A"); hs.loaded("B"); hs.ready("B");
  assert.equal(onlineStageState().handshake, "ok");
  // 计时器收摊后不会再报过渡期
  clock.advance(STAGE_HANDSHAKE_TOTAL_MS);
  assert.equal(calls.interim.length, 1);
  // 状态机也不许 ok → interim
  markStageHandshake("interim", "不该生效");
  assert.equal(onlineStageState().handshake, "ok");
  // 看守判断开 → failed,之后 interim、ok 都不生效
  markStageHandshake("failed", "Stage A disconnected and reloaded, no handshake back within 20 seconds");
  assert.equal(layout(), "single");
  markStageHandshake("interim", "不该生效");
  markStageHandshake("ok");
  assert.equal(onlineStageState().handshake, "failed");
  assert.equal(layout(), "single");
});

test("H13 total limit reached with warm-up still not ready → stop warm-up, stay on single stage (failed)", () => {
  const { clock, calls, hs } = harnessInterim();
  clock.advance(STAGE_INTERIM_AFTER_MS);
  assert.equal(hs.phase, "interim");
  clock.advance(STAGE_HANDSHAKE_TOTAL_MS - STAGE_INTERIM_AFTER_MS - 1);
  assert.equal(calls.fail.length, 0);
  clock.advance(1);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /Both stages did not complete the handshake within 120 s of opening/);
  assert.equal(hs.phase, "failed");
  assert.equal(onlineStageState().handshake, "failed");
  assert.equal(layout(), "single");
  assert.equal(clock.pending(), 0);
  hs.ready("A"); hs.ready("B");
  assert.equal(onlineStageState().handshake, "failed", "A late warm-up handshake does not switch back");
});

test("H14 visible stage handshakes within 20 seconds (B still loading) → does not enter the interim period", () => {
  const { clock, calls, hs } = harnessInterim();
  clock.advance(5000); hs.loaded("A"); hs.ready("A");
  clock.advance(30_000);
  assert.equal(calls.interim.length, 0);
  assert.equal(hs.phase, "waiting");
  hs.loaded("B"); hs.ready("B");
  assert.equal(onlineStageState().handshake, "ok");
});

test("H15 stage prewarmed during the interim period finishes loading but fails to handshake within 20 seconds → failed, stays on a single stage", () => {
  const { clock, calls, hs } = harnessInterim();
  clock.advance(10_000); hs.loaded("A"); // 加载完了但坏了,握不上
  clock.advance(10_000);
  assert.equal(hs.phase, "interim", "Show the picture first at 20 seconds");
  clock.advance(STAGE_HANDSHAKE_TIMEOUT_MS - 10_000);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /Stage A did not complete the handshake 20 s after loading/);
  assert.equal(layout(), "single");
});
