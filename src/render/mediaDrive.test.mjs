/**
 * mediaDrive 的单测:元素重新加载(或元数据迟到)之后,被驱动的元素要自己回到最新的目标时刻,
 * 不能靠无关的重渲染再调一次 `driveMedia`(`docs/archive/agent-reports/AGENT-tier-reload-seek.md`)。
 * 跑:node --test src/render/mediaDrive.test.mjs
 *
 * 假元素照 HTMLMediaElement 的行为写了三条要紧的:
 *   1. `readyState` 为 0(HAVE_NOTHING)时设 `currentTime` 只记成「默认起播位置」;
 *   2. `load()` 把默认起播位置清回 0、当前位置清回 0 —— 这是**最坏情况**:探针用的 Chrome 152 实测 `load()` 之后
 *      默认起播位置还留着(`tier-switch-probe` T5c / T5e 的元素事件),驱动不能指望这一点;
 *   3. 元数据到了(HAVE_METADATA)按默认起播位置 seek 过去,再发 `loadedmetadata`。
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= /** @type {any} */ ({ setTimeout, clearTimeout });
const { driveMedia, releaseMedia } = await import("./mediaDrive.ts");

class FakeVideo {
  constructor() {
    this.l = {};
    this.readyState = 0;
    this.paused = true;
    this.seeking = false;
    this.volume = 1;
    this.playbackRate = 1;
    this.pos = 0;
    this.defaultStart = 0;
    this.seeks = [];
  }
  addEventListener(type, fn) { (this.l[type] ??= []).push(fn); }
  fire(type) { for (const fn of this.l[type] ?? []) fn(); }
  get currentTime() { return this.pos; }
  set currentTime(v) {
    if (this.readyState === 0) { this.defaultStart = v; return; }
    this.seeks.push(v);
    this.pos = v;
  }
  load() { this.readyState = 0; this.defaultStart = 0; this.pos = 0; }
  /** 元数据到了:先按默认起播位置 seek,再发事件 */
  metadata() {
    this.readyState = 1;
    if (this.defaultStart > 0) { this.pos = this.defaultStart; this.seeks.push(this.defaultStart); }
    this.fire("loadedmetadata");
  }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
}

const paused = (target) => ({ target, playing: false, volume: 0, scrubbing: false });

test("暂停中:驱动之后元素被 load() 重载,元数据到了自己回到目标时刻(不等下一次渲染)", () => {
  const el = new FakeVideo();
  driveMedia(el, paused(2.5));
  assert.equal(el.defaultStart, 2.5, "readyState 0 时只记成默认起播位置");
  el.load(); // 到齐后重载:把默认起播位置清回 0
  el.metadata();
  assert.equal(el.currentTime, 2.5, "重载之后回到 2.5 s,不停在 0");
});

test("暂停中:目标在元数据到之前又变了,按最新的目标", () => {
  const el = new FakeVideo();
  driveMedia(el, paused(2.5));
  el.load();
  driveMedia(el, paused(3.1)); // 重载之后又来一次渲染:记成默认起播位置 3.1
  el.metadata();
  assert.equal(el.currentTime, 3.1);
  assert.deepEqual(el.seeks, [3.1], "浏览器按默认起播位置 seek 过去之后,不再多发一次");
});

test("不再驱动的元素(备用、顶班)元数据到了不动它", () => {
  const el = new FakeVideo();
  driveMedia(el, paused(2.5));
  releaseMedia(el);
  el.load();
  el.metadata();
  assert.equal(el.currentTime, 0);
  assert.deepEqual(el.seeks, []);
});

test("播放中:重载之后元数据到了就对齐并起播", () => {
  const el = new FakeVideo();
  let now = 100_000;
  window.__pcRealNow = () => now;
  try {
    driveMedia(el, { target: 1.2, playing: true, volume: 0, scrubbing: false });
    el.load();
    now += 1000; // 元数据在慢链路上一秒后才到(过了纠偏 seek 的冷却)
    el.metadata();
    assert.equal(el.currentTime, 1.2);
    assert.equal(el.paused, false);
  } finally { delete window.__pcRealNow; }
});

test("播放中:元素先放到了素材尽头、播放头还在这一段里,不从头重播", () => {
  // 浏览器对放完了的元素调 play() 是「回到 0 重播」;驱动不能在片段末尾触发它
  const el = new FakeVideo();
  el.readyState = 4;
  el.pos = 3.945;
  el.ended = true;
  const play = el.play.bind(el);
  el.play = () => { if (el.ended) { el.ended = false; el.pos = 0; } return play(); };
  driveMedia(el, { target: 3.733, playing: true, volume: 1, scrubbing: false });
  assert.equal(el.currentTime, 3.945, "没有回到开头");
  assert.equal(el.paused, true, "放完了就安静等播放头走出这一段");
  assert.deepEqual(el.seeks, []);
});
