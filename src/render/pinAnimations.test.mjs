/**
 * pinAnimations 的单测。跑:node --test src/render/pinAnimations.test.mjs
 *
 * 钉死 R3 新加的三条(K3 / K5):
 *   - `sync(nowMs, skip)` 跳过 skip 里那些包裹层子树的动画(正在追帧 / 被抑制的片段不能被全局时钟拨回去);
 *   - `syncIn(el, stageMs)` 只钉子树,**锚点和全局 sync 同一份**、时间基同样是全局舞台毫秒 ——
 *     追完之后交回全局 sync 必须天然连续;
 *   - `resetIn(el)` 只丢这个子树的锚点,别的卡的锚点不动(整份 reset 会让别的卡入场动画重播一遍)。
 *
 * 没有 DOM:`Animation` / `Element` 都用最小假件,只实现被读到的那几样。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createAnimationPinner } from "./pinAnimations.ts";

/** 假包裹层:closest('[data-pc-clip]') 回它自己;子元素往上指到它 */
function fakeWrapper(id) {
  const wrap = { id, closest: (sel) => (sel === "[data-pc-clip]" ? wrap : null) };
  return wrap;
}
/** 包裹层里的一个目标元素 */
const fakeTarget = (wrap) => ({ closest: (sel) => (sel === "[data-pc-clip]" ? wrap : null) });

/** 假动画。endTime 给 Infinity 就永不 finish */
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

/** 假 document / 假宿主元素:各自交出一组动画 */
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
  // 从 skip 里拿掉之后接着钉,锚点没丢(还是 0),所以是 400 不是 0
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
  // 全局先走一拍:两条都拿到锚点 0
  p.sync(0);
  // c1 自己按子树追帧(全局时钟不动),全局这一拍跳过它
  for (let ms = 100; ms <= 500; ms += 100) p.syncIn(host([a1]), ms);
  assert.equal(a1.currentTime, 500);
  assert.equal(a2.currentTime, 0, "syncIn does not touch other clips");
  // 追上之后交回全局:锚点本来就在全局基上,600 直接接得上
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
  p.sync(1000); // 两条锚点都是 1000
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

/* ---------------- 结束回调当场交付(渲染重构「推帧一致性」) ---------------- */

// 浏览器里现成的构造器;这里只要能 new、带上类型和时刻
globalThis.AnimationPlaybackEvent ??= class AnimationPlaybackEvent {
  constructor(type, init = {}) { this.type = type; this.currentTime = init.currentTime ?? null; this.timelineTime = init.timelineTime ?? null; }
};

/** 带 `onfinish` 的假动画:`finish()` 像浏览器一样**不**当场调回调;`browserFinishEvent()` 模拟浏览器下一次出帧时补发的那一次 */
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
  // 已经结束的动画之后不再钉、不再调
  p.sync(200);
  assert.equal(log.length, 1);
});

test("seek to the end: delivery happens only after everything is pinned: other animations seen inside the callback already have this frame's values", () => {
  const seen = [];
  const a = fakeAnim(fakeWrapper("a"), 100);
  const b = fakeAnim(fakeWrapper("b"), Infinity);
  a.onfinish = () => { seen.push(b.currentTime); };
  // a 排在 b 前面:要是边钉边调,回调里 b 还停在上一帧
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
  // 换回原样以后,浏览器自己发的结束事件(不是舞台拨出来的)照常送到
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
  // 回调的主人把它重播(浏览器那一次还没补发)
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
  // 回调里摘掉(Motion 的 attachTimeline 会置 null)也一样:不换回去
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
