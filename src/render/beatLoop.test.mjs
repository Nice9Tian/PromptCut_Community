/**
 * Unit tests for the pure calculation part of K4 tick loop / K6 one-second window.
 * Run: node --test src/render/beatLoop.test.mjs
 *
 * The loop itself (waiting for real frames, advancing clock, posting events) is in `StageView.tsx`,
 * covered by playback / probe-gate probes; what is pinned down here are the cases that could
 * silently compute incorrectly: tick sequence numbers computed by frame grid do not drift,
 * clamping at cut end, slow ticks shifted back as a whole without catch-up ticks, K6 timeout
 * criteria, pending cards not counted, only downgrading light cards, deterministic ordering for
 * equal scores, clearing window after downgrading one card.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { beatAt, createK6State, K6_WINDOW_MS, noteK6Beat, scheduleNextBeat } from "./beatLoop.mjs";

test("beat index is computed on the frame grid: after 3000 consecutive beats, sec is always frame number/fps, with no accumulated floating-point error", () => {
  const fps = 30;
  for (let n = 1; n <= 3000; n++) {
    const b = beatAt(0, n, fps, 1000);
    assert.equal(b.sec, n / fps);
    assert.equal(b.frame, n);
  }
  // The difference between two consecutive ticks is always 1/fps (regardless of start point)
  const a = beatAt(37, 5, 24, 100), c = beatAt(37, 6, 24, 100);
  assert.equal(c.frame - a.frame, 1);
});

test("reaching the end of the video is the last beat, with sec clamped to duration", () => {
  assert.deepEqual(beatAt(0, 299, 30, 10), { sec: 299 / 30, frame: 299, ended: false });
  assert.deepEqual(beatAt(0, 300, 30, 10), { sec: 10, frame: 300, ended: true });
  // When the frame grid does not land on duration (25 fps, duration 10.01), clamp even if past that tick
  const last = beatAt(0, 251, 25, 10.01);
  assert.equal(last.ended, true);
  assert.equal(last.sec, 10.01);
});

test("work finishes fast: the timeline does not move, waiting until the absolute time playStart + n×period", () => {
  assert.deepEqual(scheduleNextBeat(1000, 3, 40, 1100), { playStart: 1000, nextDue: 1120, late: false });
});

test("slow beat: the whole timeline shifts back by the overshoot, with no catch-up beats and no rushing ahead", () => {
  const r = scheduleNextBeat(1000, 3, 40, 1150);
  assert.deepEqual(r, { playStart: 1030, nextDue: 1120, late: true });
  // After shifting back, the next tick is scheduled from the new start point, still spaced by an entire tick
  assert.equal(scheduleNextBeat(r.playStart, 4, 40, 1151).nextDue, 1190);
});

const plan = (heavyIds = []) => ({ segments: [{ fromSec: 0, toSec: 100, heavy: new Set(heavyIds) }] });
const beat = (at, beatCost, costs, extra = {}) => ({ at, beatCost, byClip: new Map(Object.entries(costs)), fps: 30, sec: 1, plan: plan(), ...extra });

test("K6: a single beat is not judged; only when accumulated overtime in the window exceeds one beat does it downgrade, and what gets downgraded is the light card with the highest measured cost", () => {
  const s = createK6State();
  // At 30 fps, one tick is 33.3 ms. Exceeding by 20 ms per tick: tick 1 is not judged, tick 2 accumulates 40 > 33.3
  assert.equal(noteK6Beat(s, beat(0, 53.4, { a: 10, b: 30 })), null);
  assert.equal(noteK6Beat(s, beat(40, 53.4, { a: 10, b: 30 })), "b");
  assert.deepEqual([...s.pending], ["b"]);
  assert.equal(s.beats.length, 0, "downgrading one card clears the window");
});

test("K6: every beat stays within one beat, no downgrade for the whole second", () => {
  const s = createK6State();
  for (let i = 0; i < 30; i++) assert.equal(noteK6Beat(s, beat(i * 33, 33, { a: 30 })), null);
});

test("K6: each beat overshoots slightly, downgrade also when the window accumulates one beat", () => {
  const s = createK6State();
  // Exceeding by 6.7 ms per tick: first 5 ticks accumulate 33.3 without exceeding, tick 6 at 40 exceeds
  for (let i = 0; i < 5; i++) assert.equal(noteK6Beat(s, beat(i * 40, 40, { a: 30 })), null);
  assert.equal(noteK6Beat(s, beat(200, 40, { a: 30 })), "a");
});

test("K6: the window keeps only the last second, old overruns no longer count", () => {
  const s = createK6State();
  noteK6Beat(s, beat(0, 60, { a: 30 }));             // Exceeds by 26.7
  noteK6Beat(s, beat(K6_WINDOW_MS + 1, 40, { a: 30 })); // The first tick is pushed out of the window, leaving only 6.7
  assert.equal(s.beats.length, 1);
  assert.equal(noteK6Beat(s, beat(K6_WINDOW_MS + 30, 40, { a: 30 })), null);
});

test("K6: a pending card's time for this beat is subtracted from the overrun and it is not a candidate", () => {
  const s = createK6State();
  s.pending = new Set(["slow"]);
  // Without deduction, each tick exceeds by 26.7 and blows up in two ticks;
  // after deducting 30 ms of slow, it does not exceed
  for (let i = 0; i < 10; i++) assert.equal(noteK6Beat(s, beat(i * 33, 60, { slow: 30, a: 5 })), null);
  // Even if it genuinely exceeds, it will not be downgraded again
  const t = createK6State();
  t.pending = new Set(["slow"]);
  noteK6Beat(t, beat(0, 120, { slow: 30, a: 5 }));
  assert.equal(noteK6Beat(t, beat(40, 120, { slow: 30, a: 5 })), "a");
});

test("K6: only light cards are downgraded, heavy cards are not candidates", () => {
  const s = createK6State();
  const p = plan(["h"]);
  noteK6Beat(s, beat(0, 80, { h: 50, a: 5 }, { plan: p }));
  assert.equal(noteK6Beat(s, beat(40, 80, { h: 50, a: 5 }, { plan: p })), "a");
  const only = createK6State();
  noteK6Beat(only, beat(0, 80, { h: 50 }, { plan: p }));
  assert.equal(noteK6Beat(only, beat(40, 80, { h: 50 }, { plan: p })), null, "Only heavy cards can be downgraded: no downgrade");
});

test("K6: ties are ordered by clipId", () => {
  const s = createK6State();
  noteK6Beat(s, beat(0, 80, { z: 10, m: 10 }));
  assert.equal(noteK6Beat(s, beat(40, 80, { z: 10, m: 10 })), "m");
});

test("K6: the window stores a copy of this beat, so the caller clearing its own table does not affect the ledger", () => {
  const s = createK6State();
  const live = new Map([["a", 30]]);
  noteK6Beat(s, { at: 0, beatCost: 60, byClip: live, fps: 30, sec: 1, plan: plan() });
  live.clear();
  assert.equal(noteK6Beat(s, { at: 40, beatCost: 60, byClip: live, fps: 30, sec: 1, plan: plan() }), "a");
});
