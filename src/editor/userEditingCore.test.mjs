/**
 * Page-side aggregation and throttling for "user is editing" (plan
 * docs/plan/agent-workflow-plan.md A2). Test cases UE-P1~UE-P8.
 * Run: node --test src/editor/userEditingCore.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEditingTracker, USER_EDITING_TIMING } from "./userEditingCore.ts";

/** Manual clock + manual timer: advance time in tests, expired timers run in chronological order */
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

test("UE-P1 Numbers: 30 seconds, 250 ms throttle, 5-second heartbeat", () => {
  assert.deepEqual({ ...USER_EDITING_TIMING }, { recentMs: 30_000, throttleMs: 250, heartbeatMs: 5_000 });
});

test("UE-P2 Rule: dragging and text editing count; if a clip has both, drag wins; withdrawn when it ends", () => {
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

test("UE-P3 Rule: selecting without moving does not count; moving after selecting counts for 30 seconds (with remaining milliseconds) and drops out at 30 seconds", () => {
  const h = harness();
  h.tr.setSelection(["c1", "c2"]);
  assert.deepEqual(h.tr.snapshot(), [], "Selecting alone does not count");
  h.tr.touch(["c1"]);
  let snap = h.tr.snapshot();
  assert.deepEqual(kinds(snap), ["c1:recent"]);
  assert.equal(snap[0].remainingMs, 30_000);
  h.advance(29_999);
  snap = h.tr.snapshot();
  assert.deepEqual(kinds(snap), ["c1:recent"], "29.999 seconds still counts");
  assert.equal(snap[0].remainingMs, 1);
  h.advance(1);
  assert.deepEqual(h.tr.snapshot(), [], "At a full 30 seconds it no longer counts");
});

test("UE-P4 Rule: changing an unselected clip does not count; after deselecting, \"touched\" is invalidated and reselecting does not count either; touching again restarts the 30 seconds", () => {
  const h = harness();
  h.tr.setSelection(["c1"]);
  h.tr.touch(["c9"]);
  assert.deepEqual(h.tr.snapshot(), [], "c9 is not selected");
  h.tr.touch(["c1"]);
  h.tr.setSelection([]);
  assert.deepEqual(h.tr.snapshot(), []);
  h.tr.setSelection(["c1"]);
  assert.deepEqual(h.tr.snapshot(), [], "Reselecting does not restore it");
  h.advance(10_000);
  h.tr.touch(["c1"]);
  h.advance(25_000);
  assert.deepEqual(kinds(h.tr.snapshot()), ["c1:recent"], "Counted from the last touch");
});

test("UE-P5 Throttle: send immediately when a drag starts; for continuous changes send at most 1 + 4 times within 1 second, and the last update is always sent", () => {
  const h = harness();
  h.tr.setEnabled(true);
  assert.equal(h.sent.length, 1, "Send one (empty) update on open, to clear the server's state from the previous round");
  h.advance(1000);
  h.tr.setActive("s", "c1", "drag");
  assert.equal(h.sent.length, 2, "The leading edge sends immediately");
  assert.deepEqual(kinds(h.sent[1].list), ["c1:drag"]);
  // Switch clips every 16 ms (one frame) during dragging, simulating state jitter for 1 second
  for (let i = 0; i < 60; i += 1) {
    h.advance(16);
    h.tr.setActive("s", i % 2 ? "c1" : "c2", "drag");
  }
  h.advance(300);
  const during = h.sent.slice(2);
  assert.ok(during.length <= 5, `Sent ${during.length} times during 1 second of jitter`);
  for (let i = 1; i < h.sent.length; i += 1) assert.ok(h.sent[i].at - h.sent[i - 1].at >= 250 || i === 1, "Interval is at least 250 ms");
  assert.deepEqual(kinds(h.sent.at(-1).list), [h.tr.snapshot()[0].clipId + ":drag"], "The last one is the latest");
});

test("UE-P6 Throttle: identical state is not resent (position changed during a drag but state did not, so nothing is sent)", () => {
  const h = harness();
  h.tr.setEnabled(true);
  h.tr.setActive("s", "c1", "drag");
  h.advance(300);
  assert.deepEqual(kinds(h.sent.at(-1).list), ["c1:drag"], "The one right after opening is sent when the throttle window expires");
  const n = h.sent.length;
  for (let i = 0; i < 100; i += 1) { h.advance(16); h.tr.setActive("s", "c1", "drag"); }
  assert.equal(h.sent.length, n, "State unchanged within 1.6 seconds, nothing sent (the 5-second heartbeat is not due yet)");
});

test("UE-P7 Heartbeat and expiry: when non-empty, renew every 5 seconds; \"just touched\" automatically sends an empty update at 30 seconds; no more heartbeats once empty", () => {
  const h = harness();
  h.tr.setEnabled(true);
  h.tr.setSelection(["c1"]);
  h.advance(1000);
  h.tr.touch(["c1"]);
  const start = h.sent.length;
  assert.deepEqual(kinds(h.sent.at(-1).list), ["c1:recent"]);
  h.advance(29_000);
  const beats = h.sent.slice(start).filter((s) => s.list.length === 1);
  assert.equal(beats.length, 5, "One heartbeat each at 5, 10, 15, 20 and 25 seconds");
  assert.ok(beats.every((b, i) => i === 0 || b.list[0].remainingMs < beats[i - 1].list[0].remainingMs), "Remaining milliseconds decrease");
  h.advance(1_100);
  assert.deepEqual(h.sent.at(-1).list, [], "An empty update is sent at the 30-second expiry");
  const n = h.sent.length;
  h.advance(60_000);
  assert.equal(h.sent.length, n, "Nothing is sent once empty");
  assert.equal(h.pending(), 0, "And no timer is scheduled");
});

test("UE-P8 Nothing sent while off; on opening, resend the current state; timers are cleared when turned off", () => {
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
