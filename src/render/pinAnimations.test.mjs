/**
 * Unit test for pinAnimations. Run: node --test src/render/pinAnimations.test.mjs
 *
 * Pins down three items newly added in R3 (K3 / K5):
 *   - `sync(nowMs, skip)` skips animations of wrapper layer subtrees in skip (clips catching up
 *     frames / suppressed cannot be wound back by global clock);
 *   - `syncIn(el, stageMs)` only pins subtree, **shares same anchor as global sync**,
 *     timebase is also global stage milliseconds:
 *     handing back to global sync after catch-up must be naturally continuous;
 *   - `resetIn(el)` only drops anchor for this subtree, leaves anchors of other cards untouched
 *     (full reset replays entrance animations of other cards).
 *
 * No DOM: `Animation` / `Element` both use minimal fakes, implementing only read properties.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createAnimationPinner } from "./pinAnimations.ts";

/** Fake wrapper layer: closest('[data-pc-clip]') returns itself; child elements point up to it */
function fakeWrapper(id) {
  const wrap = { id, closest: (sel) => (sel === "[data-pc-clip]" ? wrap : null) };
  return wrap;
}
/** A target element in wrapper layer */
const fakeTarget = (wrap) => ({ closest: (sel) => (sel === "[data-pc-clip]" ? wrap : null) });

/** Fake animation. Setting endTime to Infinity will never finish */
function fakeAnim(wrap, endTime = 1000) {
  return {
    playState: "running",
    currentTime: null,
    finished: false,
    effect: { target: wrap ? fakeTarget(wrap) : null, getComputedTiming: () => ({ endTime }) },
    pause() { this.playState = "paused"; },
    finish() { this.playState = "finished"; this.finished = true; },
  };
}

/** Fake document / fake host element: each yields a set of animations */
const host = (list) => ({ getAnimations: () => list });
const fakeDoc = (list) => ({ getAnimations: () => list });

test("sync: the moment of first appearance is used as the anchor, after that currentTime = now − anchor, and it is paused", () => {
  const a = fakeAnim(fakeWrapper("c1"));
  const p = createAnimationPinner(fakeDoc([a]));
  p.sync(500);
  assert.equal(a.currentTime, 0);
  assert.equal(a.playState, "paused");
  p.sync(700);
  assert.equal(a.currentTime, 200);
});

test("sync: once endTime is passed it calls finish() and stops pinning", () => {
  const a = fakeAnim(fakeWrapper("c1"), 100);
  const p = createAnimationPinner(fakeDoc([a]));
  p.sync(0);
  p.sync(150);
  assert.equal(a.playState, "finished");
  assert.equal(a.currentTime, 0);
});

test("sync(skip): animations in the wrapper-layer subtree listed in skip are not pinned this frame, the others are pinned as usual", () => {
  const w1 = fakeWrapper("c1");
  const w2 = fakeWrapper("c2");
  const a1 = fakeAnim(w1);
  const a2 = fakeAnim(w2);
  const p = createAnimationPinner(fakeDoc([a1, a2]));
  p.sync(0);
  p.sync(300, new Set([w1]));
  assert.equal(a1.currentTime, 0, "the skipped one stays at its previous value");
  assert.equal(a2.currentTime, 300);
  // Continue pinning after removing from skip, anchor is not lost (still 0), so it is 400 not 0
  p.sync(400);
  assert.equal(a1.currentTime, 400);
});

test("sync(skip): animations that belong to no clip (target is null) are pinned as usual", () => {
  const a = fakeAnim(null);
  const p = createAnimationPinner(fakeDoc([a]));
  p.sync(0);
  p.sync(120, new Set([fakeWrapper("c1")]));
  assert.equal(a.currentTime, 120);
});

test("syncIn: pins only the subtree, the time base is global stage milliseconds, the anchor is shared with global sync: after catch-up it hands back to sync seamlessly", () => {
  const w1 = fakeWrapper("c1");
  const w2 = fakeWrapper("c2");
  const a1 = fakeAnim(w1, Infinity);
  const a2 = fakeAnim(w2, Infinity);
  const p = createAnimationPinner(fakeDoc([a1, a2]));
  // Global advances one tick first: both get anchor 0
  p.sync(0);
  // c1 catches up frames by subtree itself (global clock does not advance), global tick skips it
  for (let ms = 100; ms <= 500; ms += 100) p.syncIn(host([a1]), ms);
  assert.equal(a1.currentTime, 500);
  assert.equal(a2.currentTime, 0, "syncIn does not touch other clips");
  // Hand back to global after catching up: anchor was on global base all along, 600 connects directly
  p.sync(600);
  assert.equal(a1.currentTime, 600);
  assert.equal(a2.currentTime, 600);
});

test("resetIn: drops only the anchors of this subtree, anchors of other cards stay untouched", () => {
  const w1 = fakeWrapper("c1");
  const w2 = fakeWrapper("c2");
  const a1 = fakeAnim(w1, Infinity);
  const a2 = fakeAnim(w2, Infinity);
  const p = createAnimationPinner(fakeDoc([a1, a2]));
  p.sync(1000); // Both anchors are 1000
  p.resetIn(host([a1]));
  p.sync(1500);
  assert.equal(a1.currentTime, 0, "anchor re-recorded as 1500");
  assert.equal(a2.currentTime, 500, "anchor is still 1000");
});

test("resetIn / syncIn are no-ops on null", () => {
  const p = createAnimationPinner(fakeDoc([]));
  p.resetIn(null);
  p.syncIn(undefined, 10);
});

/* ---------------- Finish callback delivered immediately (render refactor "frame-push consistency") ---------------- */

// Existing constructor in the browser; here only needs to be new-able with type and timestamp
globalThis.AnimationPlaybackEvent ??= class AnimationPlaybackEvent {
  constructor(type, init = {}) { this.type = type; this.currentTime = init.currentTime ?? null; this.timelineTime = init.timelineTime ?? null; }
};

/**
 * Fake animation with `onfinish`: `finish()` does **not** invoke callback immediately like
 * the browser; `browserFinishEvent()` simulates retroactive emission on the next browser frame
 */
function fakeAnimWithHandler(endTime, log, name) {
  const a = fakeAnim(fakeWrapper(name), endTime);
  a.name = name;
  a.onfinish = function (ev) { log.push([name, this === a, ev?.type]); };
  a.browserFinishEvent = () => { if (typeof a.onfinish === "function") a.onfinish({ type: "finish", isTrusted: true }); };
  return a;
}

test("seek to the end: the finish callback is invoked on the spot within this sync, without waiting for the browser to produce a frame; this is the animation itself", () => {
  const log = [];
  const a = fakeAnimWithHandler(100, log, "a");
  const p = createAnimationPinner(fakeDoc([a]));
  p.sync(0);
  assert.deepEqual(log, [], "not called if the end is not reached");
  p.sync(150);
  assert.equal(a.playState, "finished");
  assert.deepEqual(log, [["a", true, "finish"]]);
  // Finished animations are no longer pinned or invoked afterwards
  p.sync(200);
  assert.equal(log.length, 1);
});

test("seek to the end: delivery happens only after everything is pinned: other animations seen inside the callback already have this frame's values", () => {
  const seen = [];
  const a = fakeAnim(fakeWrapper("a"), 100);
  const b = fakeAnim(fakeWrapper("b"), Infinity);
  a.onfinish = () => { seen.push(b.currentTime); };
  // a is ordered before b: if invoked while pinning, b would still be paused on the previous
  // frame in callback
  const p = createAnimationPinner(fakeDoc([a, b]));
  p.sync(0);
  p.sync(150);
  assert.deepEqual(seen, [150]);
});

test("the finish event that the browser re-fires is swallowed, the callback runs only once in total; after swallowing, onfinish is restored to its original", () => {
  const log = [];
  const a = fakeAnimWithHandler(100, log, "a");
  const original = a.onfinish;
  const p = createAnimationPinner(fakeDoc([a]));
  p.sync(0);
  p.sync(150);
  assert.equal(log.length, 1);
  assert.notEqual(a.onfinish, original, "before the re-fired event arrives, a placeholder is attached");
  a.browserFinishEvent();
  assert.equal(log.length, 1, "the re-fired event no longer calls the callback");
  assert.equal(a.onfinish, original);
  // After restoring, finish events dispatched by the browser itself (not dialed by stage)
  // are delivered as usual
  a.browserFinishEvent();
  assert.equal(log.length, 2);
});

test("the same animation is replayed and then seeked to the end again: each finish is delivered once, and both events owed by the browser are swallowed", () => {
  const log = [];
  const a = fakeAnimWithHandler(100, log, "a");
  const original = a.onfinish;
  const p = createAnimationPinner(fakeDoc([a]));
  p.sync(0);
  p.sync(150);
  // Owner of callback replays it (browser has not retroactively dispatched yet)
  a.playState = "running";
  p.sync(300);
  assert.equal(log.length, 2);
  a.browserFinishEvent();
  a.browserFinishEvent();
  assert.equal(log.length, 2);
  assert.equal(a.onfinish, original);
});

test("onfinish replaced inside the callback itself: counted by the newly attached one, the old one is not restored", () => {
  const log = [];
  const a = fakeAnim(fakeWrapper("a"), 100);
  const next = () => { log.push("next"); };
  a.onfinish = () => { log.push("first"); a.onfinish = next; };
  const p = createAnimationPinner(fakeDoc([a]));
  p.sync(0);
  p.sync(150);
  assert.deepEqual(log, ["first"]);
  assert.equal(a.onfinish, next);
  // Same when detached in callback (Motion's attachTimeline sets it to null): do not restore
  const b = fakeAnim(fakeWrapper("b"), 100);
  b.onfinish = () => { b.onfinish = null; };
  const q = createAnimationPinner(fakeDoc([b]));
  q.sync(0);
  q.sync(150);
  assert.equal(b.onfinish, null);
});

test("animations without onfinish still just call finish(); one callback throwing does not affect the others", () => {
  const log = [];
  const plain = fakeAnim(fakeWrapper("plain"), 100);
  const bad = fakeAnim(fakeWrapper("bad"), 100);
  bad.onfinish = () => { throw new Error("thrown inside the callback"); };
  const good = fakeAnimWithHandler(100, log, "good");
  const p = createAnimationPinner(fakeDoc([plain, bad, good]));
  p.sync(0);
  const error = console.error;
  console.error = () => {};
  try { p.sync(150); } finally { console.error = error; }
  assert.equal(plain.playState, "finished");
  assert.deepEqual(log, [["good", true, "finish"]]);
});

test("syncIn also delivers on the spot when seeking to the end; those skipped by skip are neither seeked nor delivered", () => {
  const log = [];
  const w = fakeWrapper("c1");
  const a = fakeAnimWithHandler(100, log, "a");
  a.effect.target = fakeTarget(w);
  const p = createAnimationPinner(fakeDoc([a]));
  p.sync(0);
  p.sync(150, new Set([w]));
  assert.deepEqual(log, []);
  p.syncIn(host([a]), 150);
  assert.deepEqual(log, [["a", true, "finish"]]);
});

test("endedInLastSync: how many animations reached the end in the most recent pass; resets to zero if the next pass has none", () => {
  const a = fakeAnim(fakeWrapper("a"), 100);
  const b = fakeAnim(fakeWrapper("b"), 100);
  const c = fakeAnim(fakeWrapper("c"), Infinity);
  const p = createAnimationPinner(fakeDoc([a, b, c]));
  assert.equal(p.endedInLastSync(), 0);
  p.sync(0);
  assert.equal(p.endedInLastSync(), 0);
  p.sync(150);
  assert.equal(p.endedInLastSync(), 2);
  p.sync(200);
  assert.equal(p.endedInLastSync(), 0);
});
