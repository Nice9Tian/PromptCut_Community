/**
 * K4 节拍循环 / K6 一秒窗口纯算部分的单测。跑:node --test src/render/beatLoop.test.mjs
 *
 * 循环本身(等真帧、推时钟、post 事件)在 `StageView.tsx` 里,由 playback / probe-gate 探针覆盖;
 * 这里钉的是会悄悄算错的那几条:拍序号按帧格算不飘、片尾钳住、慢拍整体后移不补拍、
 * K6 的超时口径、pending 卡不计入、只降轻卡、同分定序、降一张清窗口。
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
  // 连续两拍的差恒为 1/fps(不管起点)
  const a = beatAt(37, 5, 24, 100), c = beatAt(37, 6, 24, 100);
  assert.equal(c.frame - a.frame, 1);
});

test("reaching the end of the video is the last beat, with sec clamped to duration", () => {
  assert.deepEqual(beatAt(0, 299, 30, 10), { sec: 299 / 30, frame: 299, ended: false });
  assert.deepEqual(beatAt(0, 300, 30, 10), { sec: 10, frame: 300, ended: true });
  // 帧格落不到 duration 上(25 fps、时长 10.01)时,越过那一拍也钳住
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
  // 后移之后,下一拍按新的起点排,相隔仍是一整拍
  assert.equal(scheduleNextBeat(r.playStart, 4, 40, 1151).nextDue, 1190);
});

const plan = (heavyIds = []) => ({ segments: [{ fromSec: 0, toSec: 100, heavy: new Set(heavyIds) }] });
const beat = (at, beatCost, costs, extra = {}) => ({ at, beatCost, byClip: new Map(Object.entries(costs)), fps: 30, sec: 1, plan: plan(), ...extra });

test("K6: a single beat is not judged; only when accumulated overtime in the window exceeds one beat does it downgrade, and what gets downgraded is the light card with the highest measured cost", () => {
  const s = createK6State();
  // 30 fps 一拍 33.3 ms。每拍超 20 ms:第一拍不判,第二拍累计 40 > 33.3
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
  // 每拍超 6.7 ms:前 5 拍累计 33.3 不超,第 6 拍 40 才超
  for (let i = 0; i < 5; i++) assert.equal(noteK6Beat(s, beat(i * 40, 40, { a: 30 })), null);
  assert.equal(noteK6Beat(s, beat(200, 40, { a: 30 })), "a");
});

test("K6: the window keeps only the last second, old overruns no longer count", () => {
  const s = createK6State();
  noteK6Beat(s, beat(0, 60, { a: 30 }));             // 超 26.7
  noteK6Beat(s, beat(K6_WINDOW_MS + 1, 40, { a: 30 })); // 第一拍被挤出窗口,只剩 6.7
  assert.equal(s.beats.length, 1);
  assert.equal(noteK6Beat(s, beat(K6_WINDOW_MS + 30, 40, { a: 30 })), null);
});

test("K6: a pending card's time for this beat is subtracted from the overrun and it is not a candidate", () => {
  const s = createK6State();
  s.pending = new Set(["slow"]);
  // 不扣的话每拍超 26.7,两拍就爆;扣掉 slow 的 30 ms 之后没超
  for (let i = 0; i < 10; i++) assert.equal(noteK6Beat(s, beat(i * 33, 60, { slow: 30, a: 5 })), null);
  // 真超了也不会再降它
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
