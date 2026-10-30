/**
 * 「用户正在编辑」页面侧的汇总与节流(计划 docs/plan/agent-workflow-plan.md A2)。用例 UE-P1～UE-P8。
 * 跑:node --test src/editor/userEditingCore.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEditingTracker, USER_EDITING_TIMING } from "./userEditingCore.ts";

/** 手动时钟 + 手动定时器:测试里推进时间,到点的定时器按时刻顺序跑 */
function harness(opts = {}) {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const sent = [];
  const tr = createEditingTracker({
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    send: (list) => sent.push({ at: t, list: list.map((e) => ({ ...e })) }),
    ...opts,
  });
  function advance(ms) {
    const end = t + ms;
    for (;;) {
      let next = null;
      for (const [id, v] of timers) if (v.at <= end && (!next || v.at < next[1].at)) next = [id, v];
      if (!next) break;
      timers.delete(next[0]);
      t = Math.max(t, next[1].at);
      next[1].fn();
    }
    t = end;
  }
  return { tr, sent, advance, now: () => t, pending: () => timers.size };
}

const kinds = (list) => list.map((e) => `${e.clipId}:${e.kind}`);

test("UE-P1 数字:30 秒、250 ms 节流、5 秒心跳", () => {
  assert.deepEqual({ ...USER_EDITING_TIMING }, { recentMs: 30_000, throttleMs: 250, heartbeatMs: 5_000 });
});

test("UE-P2 口径:拖动中、文字编辑中算;同一片段两种都有取拖动;结束就撤", () => {
  const { tr } = harness();
  tr.setActive("timeline-clip:c1", "c1", "drag");
  tr.setActive("stage-text", "c2", "text");
  tr.setActive("stage-move", "c2", "drag");
  assert.deepEqual(kinds(tr.snapshot()), ["c1:drag", "c2:drag"]);
  tr.setActive("stage-move", null, "drag");
  assert.deepEqual(kinds(tr.snapshot()), ["c1:drag", "c2:text"]);
  tr.setActive("timeline-clip:c1", null, "drag");
  tr.setActive("stage-text", null, "text");
  assert.deepEqual(tr.snapshot(), []);
});

test("UE-P3 口径:只选中不动不算;选中后动过算 30 秒(带剩余毫秒),到 30 秒掉出", () => {
  const h = harness();
  h.tr.setSelection(["c1", "c2"]);
  assert.deepEqual(h.tr.snapshot(), [], "只选中不算");
  h.tr.touch(["c1"]);
  let snap = h.tr.snapshot();
  assert.deepEqual(kinds(snap), ["c1:recent"]);
  assert.equal(snap[0].remainingMs, 30_000);
  h.advance(29_999);
  snap = h.tr.snapshot();
  assert.deepEqual(kinds(snap), ["c1:recent"], "29.999 秒还算");
  assert.equal(snap[0].remainingMs, 1);
  h.advance(1);
  assert.deepEqual(h.tr.snapshot(), [], "满 30 秒不算了");
});

test("UE-P4 口径:没选中的片段被改不算;取消选中后「动过」作废,再选中也不算;再动一次重新计 30 秒", () => {
  const h = harness();
  h.tr.setSelection(["c1"]);
  h.tr.touch(["c9"]);
  assert.deepEqual(h.tr.snapshot(), [], "c9 没选中");
  h.tr.touch(["c1"]);
  h.tr.setSelection([]);
  assert.deepEqual(h.tr.snapshot(), []);
  h.tr.setSelection(["c1"]);
  assert.deepEqual(h.tr.snapshot(), [], "重新选中不恢复");
  h.advance(10_000);
  h.tr.touch(["c1"]);
  h.advance(25_000);
  assert.deepEqual(kinds(h.tr.snapshot()), ["c1:recent"], "从最后一次动起算");
});

test("UE-P5 节流:拖动开始立刻发;连续变化 1 秒内至多 1 + 4 次,最后一份一定发出", () => {
  const h = harness();
  h.tr.setEnabled(true);
  assert.equal(h.sent.length, 1, "打开时发一份(空),清掉服务端上一轮的状态");
  h.advance(1000);
  h.tr.setActive("s", "c1", "drag");
  assert.equal(h.sent.length, 2, "前沿立即发");
  assert.deepEqual(kinds(h.sent[1].list), ["c1:drag"]);
  // 拖动中每 16 ms(一帧)换一次片段,模拟状态抖动 1 秒
  for (let i = 0; i < 60; i += 1) {
    h.advance(16);
    h.tr.setActive("s", i % 2 ? "c1" : "c2", "drag");
  }
  h.advance(300);
  const during = h.sent.slice(2);
  assert.ok(during.length <= 5, `1 秒抖动发了 ${during.length} 次`);
  for (let i = 1; i < h.sent.length; i += 1) assert.ok(h.sent[i].at - h.sent[i - 1].at >= 250 || i === 1, "间隔不小于 250 ms");
  assert.deepEqual(kinds(h.sent.at(-1).list), [h.tr.snapshot()[0].clipId + ":drag"], "最后一份是最新的");
});

test("UE-P6 节流:同样的状态不重发(拖动中位置变了但状态没变,不发)", () => {
  const h = harness();
  h.tr.setEnabled(true);
  h.tr.setActive("s", "c1", "drag");
  h.advance(300);
  assert.deepEqual(kinds(h.sent.at(-1).list), ["c1:drag"], "紧跟着打开的那一份,等节流窗口到点发出");
  const n = h.sent.length;
  for (let i = 0; i < 100; i += 1) { h.advance(16); h.tr.setActive("s", "c1", "drag"); }
  assert.equal(h.sent.length, n, "1.6 秒内状态没变,不发(心跳 5 秒才到)");
});

test("UE-P7 心跳与到期:非空时每 5 秒续一次;「刚动过」到 30 秒自动发一份空的;空了不再心跳", () => {
  const h = harness();
  h.tr.setEnabled(true);
  h.tr.setSelection(["c1"]);
  h.advance(1000);
  h.tr.touch(["c1"]);
  const start = h.sent.length;
  assert.deepEqual(kinds(h.sent.at(-1).list), ["c1:recent"]);
  h.advance(29_000);
  const beats = h.sent.slice(start).filter((s) => s.list.length === 1);
  assert.equal(beats.length, 5, "5、10、15、20、25 秒各一次心跳");
  assert.ok(beats.every((b, i) => i === 0 || b.list[0].remainingMs < beats[i - 1].list[0].remainingMs), "剩余毫秒递减");
  h.advance(1_100);
  assert.deepEqual(h.sent.at(-1).list, [], "30 秒到期发一份空的");
  const n = h.sent.length;
  h.advance(60_000);
  assert.equal(h.sent.length, n, "空了不再发");
  assert.equal(h.pending(), 0, "也不挂定时器");
});

test("UE-P8 关着不发,打开时补发当前状态;关掉后清定时器", () => {
  const h = harness();
  h.tr.setActive("s", "c1", "text");
  assert.equal(h.sent.length, 0);
  h.tr.setEnabled(true);
  assert.deepEqual(kinds(h.sent[0].list), ["c1:text"]);
  h.tr.setEnabled(false);
  h.advance(60_000);
  assert.equal(h.sent.length, 1);
  assert.equal(h.pending(), 0);
});
