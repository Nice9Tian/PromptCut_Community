/**
 * Unit test for mediaDrive: after an element reloads (or metadata arrives late), the driven
 * element must return to the latest target time on its own, and cannot rely on unrelated
 * rerenders calling `driveMedia` again (`docs/archive/agent-reports/AGENT-tier-reload-seek.md`).
 * Run: node --test src/render/mediaDrive.test.mjs
 *
 * Mock elements implement three critical behaviors following HTMLMediaElement:
 *   1. When `readyState` is 0 (HAVE_NOTHING), setting `currentTime` only records it as
 *      "default playback start position";
 *   2. `load()` resets default playback start position to 0 and current position to 0: this is
 *      the **worst case**: actual tests on Chrome 152 used by the probe showed that the default
 *      playback start position is retained after `load()` (`tier-switch-probe` T5c / T5e element
 *      events), but the driver cannot rely on this;
 *   3. When metadata arrives (HAVE_METADATA), seeks to default playback start position, then
 *      fires `loadedmetadata`.
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
  /** Metadata arrived: seek to default playback start position first, then fire event */
  metadata() {
    this.readyState = 1;
    if (this.defaultStart > 0) { this.pos = this.defaultStart; this.seeks.push(this.defaultStart); }
    this.fire("loadedmetadata");
  }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
}

const paused = (target) => ({ target, playing: false, volume: 0, scrubbing: false });

test("Paused: after driving, the element is reloaded via load(); once metadata arrives it returns to the target time by itself (without waiting for the next render)", () => {
  const el = new FakeVideo();
  driveMedia(el, paused(2.5));
  assert.equal(el.defaultStart, 2.5, "At readyState 0 it is only recorded as the default start position");
  el.load(); // Reload after fully arrived: reset default playback start position back to 0
  el.metadata();
  assert.equal(el.currentTime, 2.5, "After reload it returns to 2.5 s, not stuck at 0");
});

test("Paused: the target changed again before metadata arrived, use the latest target", () => {
  const el = new FakeVideo();
  driveMedia(el, paused(2.5));
  el.load();
  driveMedia(el, paused(3.1)); // Another render after reload: recorded as default playback start position 3.1
  el.metadata();
  assert.equal(el.currentTime, 3.1);
  assert.deepEqual(el.seeks, [3.1], "After the browser seeks to the default start position, no extra seek is sent");
});

test("Elements no longer driven (spare, stand-in) are left alone when metadata arrives", () => {
  const el = new FakeVideo();
  driveMedia(el, paused(2.5));
  releaseMedia(el);
  el.load();
  el.metadata();
  assert.equal(el.currentTime, 0);
  assert.deepEqual(el.seeks, []);
});

test("Playing: once metadata arrives after reload, align and start playback", () => {
  const el = new FakeVideo();
  let now = 100_000;
  window.__pcRealNow = () => now;
  try {
    driveMedia(el, { target: 1.2, playing: true, volume: 0, scrubbing: false });
    el.load();
    now += 1000; // Metadata arrives one second later on a slow link (past correction seek cooldown)
    el.metadata();
    assert.equal(el.currentTime, 1.2);
    assert.equal(el.paused, false);
  } finally { delete window.__pcRealNow; }
});

test("during playback: element already played to the end of the media, playhead still inside this segment, no replay from the start", () => {
  // In browsers, calling play() on an element that finished playing means "rewind to 0 and replay";
  // the driver must not trigger it at the end of a clip
  const el = new FakeVideo();
  el.readyState = 4;
  el.pos = 3.945;
  el.ended = true;
  const play = el.play.bind(el);
  el.play = () => { if (el.ended) { el.ended = false; el.pos = 0; } return play(); };
  driveMedia(el, { target: 3.733, playing: true, volume: 1, scrubbing: false });
  assert.equal(el.currentTime, 3.945, "did not go back to the start");
  assert.equal(el.paused, true, "after finishing, wait quietly for the playhead to leave this segment");
  assert.deepEqual(el.seeks, []);
});
