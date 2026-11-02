/**
 * 在线页面两个舞台握手之后的看守(C10 契约第 2 节「握手之后又断」〔裁〕):心跳断 → 重载那一台 → 握回来恢复双舞台;
 * 重载也握不回来 → 走首次握不上手的同一条退回路径(`markStageHandshake("failed")` → `stageLayout` 单舞台);退回后不再重载。
 * 跑:node --test src/online/stageWatch.test.mjs
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createStageWatch, STAGE_PING_INTERVAL_MS, STAGE_LOST_AFTER_MS, STAGE_RECONNECT_TIMEOUT_MS, STAGE_MAX_RELOADS,
} from "./stageWatch.ts";
import { markStageHandshake, onlineStageState, resetOnlineStagesForTest, stageLayout, STAGE_HANDSHAKE_TIMEOUT_MS } from "./stageOrigins.ts";

const origins = { A: "https://s1.x.io", B: "https://s2.x.io" };
const layout = () => stageLayout({ single: false, origins, handshake: onlineStageState().handshake });

/** 假时钟:定时器按到点顺序跑;advance 之后让出微任务,心跳的 Promise 回调跟着落地 */
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, v] of timers) if (v.at <= end && (!next || v.at < next[1].at || (v.at === next[1].at && id < next[0]))) next = [id, v];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      t = end;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    pending: () => timers.size,
    /** 父页主线程卡住:时间跳过去,定时器不跑 */
    jump(ms) { t += ms; },
  };
}

/** 一组舞台替身:alive[id] 为假时心跳不回包(永远 pending,像崩了的跨源 iframe) */
function harness({ hidden = () => false } = {}) {
  const clock = fakeClock();
  const alive = { A: true, B: true };
  const calls = { ping: { A: 0, B: 0 }, reload: [], fallback: [] };
  const watch = createStageWatch({
    ids: ["A", "B"],
    ping: (id) => { calls.ping[id]++; return alive[id] ? Promise.resolve({ width: 1920, height: 1080 }) : new Promise(() => {}); },
    reload: (id, reason) => { calls.reload.push({ id, reason }); },
    fallback: (reason) => { calls.fallback.push(reason); markStageHandshake("failed", reason); },
    hidden,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  // 首次握手:两台都 ready,页面报 ok
  watch.ready("A"); watch.ready("B"); markStageHandshake("ok");
  return { clock, alive, calls, watch };
}

beforeEach(() => resetOnlineStagesForTest({ config: "done", origins }));

test("C10-SW-00 numbers: the time limit for waiting for the handshake after a reload equals the first handshake limit (20 seconds); disconnect is judged later than three heartbeats", () => {
  assert.equal(STAGE_RECONNECT_TIMEOUT_MS, STAGE_HANDSHAKE_TIMEOUT_MS);
  assert.equal(STAGE_RECONNECT_TIMEOUT_MS, 20_000);
  assert.ok(STAGE_LOST_AFTER_MS >= STAGE_PING_INTERVAL_MS * 3);
});

test("C10-SW-01 heartbeat replies as usual: both stages are pinged on every beat for a minute, no reload, no fallback, still dual stage", async () => {
  const { clock, calls, watch } = harness();
  await clock.advance(60_000);
  assert.equal(calls.reload.length, 0);
  assert.equal(calls.fallback.length, 0);
  assert.ok(calls.ping.A >= 10 && calls.ping.B >= 10, JSON.stringify(calls.ping));
  assert.equal(watch.status("A"), "alive");
  assert.equal(layout(), "dual");
  watch.dispose();
});

test("C10-SW-02 after handshake B disconnects → reload B → handshake returns within the time limit, dual stage is restored with no fallback; watching continues as usual afterwards", async () => {
  const { clock, alive, calls, watch } = harness();
  await clock.advance(10_000);
  alive.B = false; // B 的渲染进程崩了:心跳不再回包
  await clock.advance(STAGE_LOST_AFTER_MS + STAGE_PING_INTERVAL_MS);
  assert.equal(calls.reload.length, 1);
  assert.equal(calls.reload[0].id, "B");
  assert.match(calls.reload[0].reason, /No heartbeat reply/);
  assert.equal(watch.status("B"), "reloading");
  assert.equal(watch.status("A"), "alive");
  assert.equal(layout(), "dual", "iframes stay mounted as dual stage during the reload");
  // 新文档起来,发了 pc-stage-ready
  await clock.advance(3000);
  alive.B = true;
  watch.ready("B");
  await clock.advance(STAGE_RECONNECT_TIMEOUT_MS * 3);
  assert.equal(calls.fallback.length, 0);
  assert.equal(calls.reload.length, 1);
  assert.equal(watch.status("B"), "alive");
  assert.equal(onlineStageState().handshake, "ok");
  assert.equal(layout(), "dual");
  watch.dispose();
});

test("C10-SW-03 reload also fails to get a handshake: 20 seconds after the reload it calls markStageHandshake('failed') and falls back to single stage", async () => {
  const { clock, alive, calls, watch } = harness();
  alive.A = false; // 可见舞台那一台卡死
  await clock.advance(STAGE_LOST_AFTER_MS + STAGE_PING_INTERVAL_MS);
  assert.deepEqual(calls.reload.map((r) => r.id), ["A"]);
  await clock.advance(STAGE_RECONNECT_TIMEOUT_MS - 1000);
  assert.equal(calls.fallback.length, 0, "no fallback within the time limit");
  await clock.advance(1000);
  assert.equal(calls.fallback.length, 1);
  assert.match(calls.fallback[0], /Stage A reloaded after disconnecting and did not reconnect within 20 s/);
  assert.equal(watch.fellBack, true);
  assert.equal(onlineStageState().handshake, "failed");
  assert.equal(layout(), "single");
});

test("C10-SW-04 no repeated reloads after fallback: all timers stop, and no matter how many more disconnects or ready events arrive, no reload and no further fallback happens, and the handshake state never returns to ok", async () => {
  const { clock, alive, calls, watch } = harness();
  alive.A = false; alive.B = false;
  await clock.advance(STAGE_LOST_AFTER_MS + STAGE_PING_INTERVAL_MS);
  assert.equal(calls.reload.length, 2, "both disconnected: one reload each");
  await clock.advance(STAGE_RECONNECT_TIMEOUT_MS);
  assert.equal(calls.fallback.length, 1, "falls back only once");
  const pings = { ...calls.ping };
  assert.equal(clock.pending(), 0, "no timers left behind");
  await clock.advance(30 * 60_000);
  watch.ready("A"); watch.lost("A", "x"); watch.lost("B", "x");
  await clock.advance(10 * 60_000);
  assert.equal(calls.reload.length, 2);
  assert.equal(calls.fallback.length, 1);
  assert.deepEqual(calls.ping, pings, "no more heartbeats after fallback");
  markStageHandshake("ok"); // 迟到的 pc-stage-ready 也翻不回双舞台
  assert.equal(layout(), "single");
});

test("C10-SW-05 repeated disconnects: reload succeeds then disconnects again; at the 4th reload within 10 minutes it falls back to single stage directly", async () => {
  const { clock, alive, calls, watch } = harness();
  for (let i = 0; i < STAGE_MAX_RELOADS; i++) {
    alive.B = false;
    await clock.advance(STAGE_LOST_AFTER_MS + STAGE_PING_INTERVAL_MS);
    alive.B = true;
    watch.ready("B");
    await clock.advance(5000);
  }
  assert.equal(calls.reload.length, STAGE_MAX_RELOADS);
  assert.equal(calls.fallback.length, 0);
  alive.B = false;
  await clock.advance(STAGE_LOST_AFTER_MS + STAGE_PING_INTERVAL_MS);
  assert.equal(calls.reload.length, STAGE_MAX_RELOADS, "the 4th time does not reload");
  assert.equal(calls.fallback.length, 1);
  assert.match(calls.fallback[0], /keeps disconnecting/);
  assert.equal(layout(), "single");
});

test("C10-SW-06 no judgment while the page is hidden or the parent page main thread is stuck: the count restarts on the beat after returning to the foreground / recovering, and a live stage is not reloaded", async () => {
  let hid = false;
  const { clock, alive, calls, watch } = harness({ hidden: () => hid });
  // 隐藏:舞台被节流,心跳不回包也不判
  hid = true; alive.A = false;
  await clock.advance(5 * 60_000);
  assert.equal(calls.reload.length, 0);
  hid = false; alive.A = true;
  await clock.advance(60_000);
  assert.equal(calls.reload.length, 0);
  // 父页卡了 40 秒(定时器没跑),回来那一拍不判
  clock.jump(40_000);
  await clock.advance(STAGE_PING_INTERVAL_MS);
  assert.equal(calls.reload.length, 0);
  // 回到前台后真断了,照样判出来
  alive.A = false;
  await clock.advance(STAGE_LOST_AFTER_MS + STAGE_PING_INTERVAL_MS);
  assert.deepEqual(calls.reload.map((r) => r.id), ["A"]);
  // 重载期间页面隐藏:时限顺延,不在后台退回
  hid = true;
  await clock.advance(STAGE_RECONNECT_TIMEOUT_MS * 5);
  assert.equal(calls.fallback.length, 0);
  hid = false;
  await clock.advance(STAGE_RECONNECT_TIMEOUT_MS);
  assert.equal(calls.fallback.length, 1);
  watch.dispose();
});

test("C10-SW-07 a stage that has not completed its handshake is not watched; no client (ping returns null) does not count as a reply, and at the deadline it is still judged disconnected", async () => {
  const clock = fakeClock();
  const calls = { ping: 0, reload: [] };
  let client = true;
  const watch = createStageWatch({
    ids: ["A", "B"],
    ping: () => { calls.ping++; return client ? Promise.resolve(1) : null; },
    reload: (id) => calls.reload.push(id),
    fallback: () => {},
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  await clock.advance(60_000);
  assert.equal(calls.ping, 0, "none is ready: no heartbeat is sent");
  assert.equal(watch.status("A"), "pending");
  watch.ready("A");
  client = false;
  await clock.advance(STAGE_LOST_AFTER_MS + STAGE_PING_INTERVAL_MS);
  assert.deepEqual(calls.reload, ["A"]);
  assert.equal(watch.status("B"), "pending");
  watch.dispose();
});
