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

test("数字:每台 20 秒、总上限 2 分钟", () => {
  assert.equal(STAGE_HANDSHAKE_TIMEOUT_MS, 20_000);
  assert.equal(STAGE_HANDSHAKE_TOTAL_MS, 120_000);
});

test("H1 计时从 load 起算:打开 30 秒还没 load 不退回;load 之后 19 秒握上 → 双舞台", () => {
  const { clock, calls, hs } = harness();
  clock.advance(30_000);
  assert.equal(calls.fail.length, 0, "没 load 前不按 20 秒判");
  assert.equal(layout(), "dual");
  hs.loaded("A"); hs.loaded("B");
  clock.advance(19_000);
  hs.ready("A"); hs.ready("B");
  assert.equal(calls.ok, 1);
  assert.equal(onlineStageState().handshake, "ok");
  assert.equal(hs.phase, "ok");
  assert.equal(clock.pending(), 0, "握上之后定时器全收摊");
  clock.advance(STAGE_HANDSHAKE_TOTAL_MS);
  assert.equal(calls.fail.length, 0);
});

test("H2 慢加载:舞台 40 秒才 load、之后 1 秒握上,不退回", () => {
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

test("H3 加载完 20 秒没握上 → 退回单舞台(舞台真坏了,退回时间与原来一样是 20 秒)", () => {
  const { clock, calls, hs } = harness();
  clock.advance(2000);
  hs.loaded("A"); hs.loaded("B");
  hs.ready("A");
  clock.advance(STAGE_HANDSHAKE_TIMEOUT_MS - 1);
  assert.equal(calls.fail.length, 0);
  clock.advance(1);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /舞台 B 加载完 20 秒没握上手/);
  assert.match(calls.fail[0], /握上手的舞台:A/);
  assert.equal(onlineStageState().handshake, "failed");
  assert.equal(layout(), "single");
  assert.equal(clock.pending(), 0);
  // 退回之后迟到的握手不改结果
  hs.ready("B");
  assert.equal(calls.ok, 0);
  assert.equal(onlineStageState().handshake, "failed");
});

test("H4 舞台源回错误页:iframe 照样 load,20 秒后退回(与原来按时退回相同)", () => {
  const { clock, calls, hs } = harness();
  clock.advance(300);
  hs.loaded("A"); // 503 错误页也是一次 load,永远不会握手
  clock.advance(STAGE_HANDSHAKE_TIMEOUT_MS);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /舞台 A 加载完/);
  assert.equal(layout(), "single");
});

test("H5 总上限:一直不 load(或 load 得太晚),打开 2 分钟退回", () => {
  const { clock, calls, hs } = harness();
  clock.advance(STAGE_HANDSHAKE_TOTAL_MS - 1);
  assert.equal(calls.fail.length, 0);
  clock.advance(1);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /打开 120 秒内两个舞台没都握上手/);
  assert.equal(layout(), "single");
  assert.equal(clock.pending(), 0);
});

test("H6 总上限压过每台时限:A 在 110 秒 load,不等满 20 秒,到 120 秒就退回", () => {
  const { clock, calls, hs } = harness();
  clock.advance(110_000);
  hs.loaded("A");
  clock.advance(10_000);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /打开 120 秒/);
});

test("H7 同一台又 load 一次(重载)就重新起算", () => {
  const { clock, calls, hs } = harness();
  hs.loaded("A");
  clock.advance(15_000);
  hs.loaded("A");
  clock.advance(15_000);
  assert.equal(calls.fail.length, 0, "第二次 load 之后才 15 秒");
  clock.advance(5000);
  assert.equal(calls.fail.length, 1);
  assert.equal(hs.status().slots.A.loads, 2);
});

test("H8 握手先于 load 到达(舞台 effect 早于 load 事件):之后的 load 不再计时", () => {
  const { clock, calls, hs } = harness();
  hs.ready("A");
  hs.loaded("A");
  hs.loaded("B");
  hs.ready("B");
  assert.equal(calls.ok, 1);
  clock.advance(STAGE_HANDSHAKE_TOTAL_MS * 2);
  assert.equal(calls.fail.length, 0);
});

test("H9 dispose 之后什么都不报(dual 变假或卸载)", () => {
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

test("数字:过渡期从打开 20 秒起", () => {
  assert.equal(STAGE_INTERIM_AFTER_MS, 20_000);
});

test("H10 可见舞台 20 秒没握上 → 先出同源单舞台画面(interim,布局单舞台),不算失败", () => {
  const { clock, calls, hs } = harnessInterim();
  clock.advance(STAGE_INTERIM_AFTER_MS - 1);
  assert.equal(calls.interim.length, 0);
  assert.equal(layout(), "dual");
  clock.advance(1);
  assert.equal(calls.interim.length, 1);
  assert.match(calls.interim[0], /可见舞台 A 挂上 20 秒没握上手/);
  assert.equal(hs.phase, "interim");
  assert.equal(onlineStageState().handshake, "interim");
  assert.equal(onlineStageState().interimAt !== null, true);
  assert.equal(layout(), "single", "过渡期按同源单舞台出画面");
  assert.equal(calls.fail.length, 0);
  assert.equal(hs.status().interimAt, 20_000);
});

test("H11 预热完成后换回双舞台:A 40 秒 load、握上,B 随后 load、握上 → ok、布局双舞台", () => {
  const { clock, calls, hs } = harnessInterim();
  clock.advance(40_000);
  assert.equal(hs.phase, "interim");
  hs.loaded("A"); clock.advance(100); hs.ready("A");
  assert.equal(hs.phase, "interim", "只有 A 握上还不换回");
  assert.equal(layout(), "single");
  clock.advance(1000); hs.loaded("B"); clock.advance(100); hs.ready("B");
  assert.equal(hs.phase, "ok");
  assert.equal(calls.ok, 1);
  assert.equal(onlineStageState().handshake, "ok");
  assert.equal(layout(), "dual");
  assert.equal(clock.pending(), 0);
  assert.equal(calls.fail.length, 0);
  clock.advance(STAGE_HANDSHAKE_TOTAL_MS);
  assert.equal(calls.fail.length, 0, "换回之后总上限不再起作用");
});

test("H12 只换一次:换回双舞台之后再出问题照看守退回单舞台,不回过渡期、不再来回切", () => {
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
  markStageHandshake("failed", "舞台 A 断开后重载,20 秒内没握回来");
  assert.equal(layout(), "single");
  markStageHandshake("interim", "不该生效");
  markStageHandshake("ok");
  assert.equal(onlineStageState().handshake, "failed");
  assert.equal(layout(), "single");
});

test("H13 总上限到点预热还没好 → 停止预热、留在单舞台(failed)", () => {
  const { clock, calls, hs } = harnessInterim();
  clock.advance(STAGE_INTERIM_AFTER_MS);
  assert.equal(hs.phase, "interim");
  clock.advance(STAGE_HANDSHAKE_TOTAL_MS - STAGE_INTERIM_AFTER_MS - 1);
  assert.equal(calls.fail.length, 0);
  clock.advance(1);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /打开 120 秒内两个舞台没都握上手/);
  assert.equal(hs.phase, "failed");
  assert.equal(onlineStageState().handshake, "failed");
  assert.equal(layout(), "single");
  assert.equal(clock.pending(), 0);
  hs.ready("A"); hs.ready("B");
  assert.equal(onlineStageState().handshake, "failed", "迟到的预热握手不换回");
});

test("H14 可见舞台 20 秒内握上(B 还在加载)→ 不进过渡期", () => {
  const { clock, calls, hs } = harnessInterim();
  clock.advance(5000); hs.loaded("A"); hs.ready("A");
  clock.advance(30_000);
  assert.equal(calls.interim.length, 0);
  assert.equal(hs.phase, "waiting");
  hs.loaded("B"); hs.ready("B");
  assert.equal(onlineStageState().handshake, "ok");
});

test("H15 过渡期里预热的舞台加载完 20 秒没握上 → failed,留在单舞台", () => {
  const { clock, calls, hs } = harnessInterim();
  clock.advance(10_000); hs.loaded("A"); // 加载完了但坏了,握不上
  clock.advance(10_000);
  assert.equal(hs.phase, "interim", "20 秒时先出画面");
  clock.advance(STAGE_HANDSHAKE_TIMEOUT_MS - 10_000);
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0], /舞台 A 加载完 20 秒没握上手/);
  assert.equal(layout(), "single");
});
