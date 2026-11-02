/**
 * Frame-fetching boundary of media effect card video sources (`docs/plan/TODO.md`
 * "User real-device defects": the video input source of a media effect card has uneven cadence
 * when exporting at 0.5x slow motion).
 * Rule: at time t, take the last frame in the asset whose timestamp does not exceed t;
 * when t falls exactly on a frame boundary, take the frame on that boundary.
 *
 * Mock video elements fetch frames following Chrome's behavior: frame timestamps are converted
 * to integer microseconds (rounded), seek targets are truncated when converted to microseconds,
 * displaying "last frame with timestamp ≤ target". This is the exact cause of the bug:
 * when seeking to k/30 as-is, the frame timestamp for k ≡ 2 (mod 3) rounds up while the target
 * is truncated, fetching the previous frame (VC-01 first verifies that the mock element reproduces
 * this). The same end-to-end behavior is verified in real Chrome by
 * `scripts/probes/video-source-cadence-probe.mjs`. Test case names include VC numbers (video cadence).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

/** Mock video: fps frame rate, duration in seconds; records the value set on each seek */
class FakeVideo extends EventTarget {
  constructor(fps = 30, duration = 3) {
    super();
    this.fps = fps; this.duration = duration; this._time = 0; this.seeks = [];
    this.muted = false; this.preload = ""; this.playsInline = false;
  }
  set src(_value) { queueMicrotask(() => this.dispatchEvent(new Event("loadeddata"))); }
  get currentTime() { return this._time; }
  set currentTime(value) {
    this._time = value; this.seeks.push(value);
    queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
  }
  /** Which frame is currently displayed */
  get frameIndex() { return shownFrame(this._time, this.fps, this.duration); }
  pause() {} load() {} removeAttribute() {}
}
class FakeImage extends EventTarget {}

/**
 * Chrome's approach: frame timestamp round(k × 1e6 / fps) µs, target trunc(t × 1e6) µs,
 * take the last frame with timestamp ≤ target
 */
function shownFrame(time, fps, duration) {
  const target = Math.trunc(time * 1e6);
  const count = Math.round(duration * fps);
  let k = 0;
  while (k + 1 < count && Math.round(((k + 1) * 1e6) / fps) <= target) k++;
  return k;
}

let video = null;
const withSource = async (fn) => {
  globalThis.HTMLVideoElement = FakeVideo;
  globalThis.HTMLImageElement = FakeImage;
  globalThis.Image = FakeImage;
  globalThis.document = { createElement: () => video };
  globalThis.createImageBitmap = async (source) => ({ frame: source.frameIndex, close() {} });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { await fn(await server.ssrLoadModule("/src/render/cards/mediaSource.ts")); }
  finally {
    await server.close();
    for (const key of ["HTMLVideoElement", "HTMLImageElement", "Image", "document", "createImageBitmap"]) delete globalThis[key];
  }
};
const MEDIA = { url: "/@media/cadence.mp4", kind: "video" };
const framesAt = async (mod, fps, times) => {
  video = new FakeVideo(fps, 3);
  const source = new mod.CardMediaSource();
  const got = [];
  for (const t of times) got.push((await source.frame(MEDIA, t)).frame);
  source.dispose();
  return got;
};
const range = (n) => Array.from({ length: n }, (_, i) => i);

test("VC-01 fake video element reproduces the defect: seeking as is to frame boundary k/30 with k ≡ 2 (mod 3) fetches the previous frame", () => {
  assert.equal(shownFrame(2 / 30, 30, 3), 1);
  assert.equal(shownFrame(5 / 30, 30, 3), 4);
  assert.equal(shownFrame(1 / 30, 30, 3), 1);
  // The frame timestamp for k ≡ 0 (mod 3) is an exact microsecond; whether the previous or current
  // frame is picked fluctuates with floating-point error: clip starts at 4 s, frame 3,
  // local time 123/30 − 4 = 0.09999999999999964, less than one microsecond earlier than frame 3 (0.1 s)
  assert.equal(shownFrame(3 / 30, 30, 3), 3);
  assert.equal(shownFrame(123 / 30 - 4, 30, 3), 2);
});

test("VC-02 when the target is exactly k/30, fetch frame k (k = 0…89)", async () => {
  await withSource(async (mod) => {
    const ks = range(90);
    assert.deepEqual(await framesAt(mod, 30, ks.map((k) => k / 30)), ks);
  });
});

test("VC-03 0.5x slow motion: time = 0.5 × n / 30 fetches 0,0,1,1,2,2…; same when the clip start is not at 0", async () => {
  await withSource(async (mod) => {
    const n = range(120);
    const want = n.map((i) => Math.floor(i / 2));
    assert.deepEqual(await framesAt(mod, 30, n.map((i) => (i / 30) * 0.5)), want);
    // Playhead at start + n/30, clip local time = playhead − start (floating-point error falls on both
    // sides of frame boundary)
    for (const start of [4, 6, 17.87, 32.37]) {
      assert.deepEqual(await framesAt(mod, 30, n.map((i) => ((start * 30 + i) / 30 - start) * 0.5)), want, `start ${start}`);
    }
  });
});

test("VC-04 offset 0.35 s (10.5 frames) and 25 fps media: m(n) = floor((offset + rate × n / 30) × source frame rate + 1e-6)", async () => {
  await withSource(async (mod) => {
    const n = range(60);
    assert.deepEqual(await framesAt(mod, 30, n.map((i) => i / 30 + 0.35)), n.map((i) => i + 10));
    assert.deepEqual(await framesAt(mod, 30, n.map((i) => 0.5 * i / 30 + 0.35)), n.map((i) => Math.floor((0.35 + 0.5 * i / 30) * 30 + 1e-6)));
    assert.deepEqual(await framesAt(mod, 25, n.map((i) => i / 30)), n.map((i) => Math.floor((i * 25) / 30 + 1e-6)));
  });
});

test("VC-05 cardSeekTarget: add 2 ms, clamp to [0, duration − 0.1 ms]; no upper clamp when the duration is unknown", async () => {
  await withSource(async (mod) => {
    assert.equal(mod.CARD_SEEK_LEAD, 0.002);
    assert.equal(mod.cardSeekTarget(1, 3), 1.002);
    assert.equal(mod.cardSeekTarget(-1, 3), 0.002);
    assert.equal(mod.cardSeekTarget(5, 3), 3 - 0.0001);
    assert.equal(mod.cardSeekTarget(2.9999, 3), 3 - 0.0001);
    assert.equal(mod.cardSeekTarget(7, NaN), 7.002);
    // Much shorter than a single frame of typical assets (4.17 ms per frame at 240 fps); will not cross
    // the boundary of the next frame
    assert.ok(mod.CARD_SEEK_LEAD < 1 / 240);
    // This is what is actually set on currentTime
    video = new FakeVideo(30, 3);
    const source = new mod.CardMediaSource();
    await source.frame(MEDIA, 0.4);
    assert.deepEqual(video.seeks, [mod.cardSeekTarget(0.4, 3)]);
    source.dispose();
  });
});

/**
 * seeked fires before the frame slot switches frames (delivered cross-thread via two paths
 * in Chrome; when the machine is busy, the main thread receives seeked first; reproduced
 * in real Chrome by `scripts/probes/video-seek-race-probe.mjs`). Mock element: fires seeked
 * `seekMs` after seek; only after `slotMs` does the frame slot (the frame read by
 * createImageBitmap / VideoFrame) switch to the new frame.
 */
class LaggyVideo extends FakeVideo {
  constructor(fps, duration, { seekMs = 1, slotMs = 6, tsOffset = 0 } = {}) {
    super(fps, duration);
    this.seekMs = seekMs; this.slotMs = slotMs; this.tsOffset = tsOffset; this.slot = 0; this.seeking = false;
  }
  get currentTime() { return this._time; }
  set currentTime(value) {
    this._time = value; this.seeks.push(value); this.seeking = true;
    const frame = shownFrame(value, this.fps, this.duration);
    setTimeout(() => { if (this._time === value) { this.seeking = false; this.dispatchEvent(new Event("seeked")); } }, this.seekMs);
    setTimeout(() => { if (this._time === value) this.slot = frame; }, this.slotMs);
  }
  get frameIndex() { return this.slot; }
}
class FakeVideoFrame {
  constructor(v) { this.timestamp = Math.round((v.frameIndex * 1e6) / v.fps) + v.tsOffset; this.duration = Math.round(1e6 / v.fps); }
  close() {}
}
const withVideoFrame = async (fn) => {
  globalThis.VideoFrame = FakeVideoFrame;
  try { await fn(); } finally { delete globalThis.VideoFrame; }
};
const RATE_HALF = range(60).map((n) => 0.35 + (0.5 * n) / 30);
const RATE_HALF_WANT = RATE_HALF.map((t) => Math.floor(t * 30 + 1e-6));

test("VC-06 seeked fires before the frame slot swaps frames: wait until the frame timestamp in the frame slot covers currentTime before fetching, and do not fetch the frame from before the seek", async () => {
  await withSource(async (mod) => {
    // Falls back to only waiting for seeked when WebCodecs is absent: mock element first verifies
    // reproducing the bug
    video = new LaggyVideo(30, 3);
    let source = new mod.CardMediaSource();
    const stale = [];
    for (const t of RATE_HALF) stale.push((await source.frame(MEDIA, t)).frame);
    source.dispose();
    assert.notDeepEqual(stale, RATE_HALF_WANT);
    await withVideoFrame(async () => {
      video = new LaggyVideo(30, 3);
      source = new mod.CardMediaSource();
      const got = [];
      for (const t of RATE_HALF) got.push((await source.frame(MEDIA, t)).frame);
      assert.deepEqual(got, RATE_HALF_WANT);
      assert.ok(source.settleWaits > 0);
      source.dispose();
    });
  });
});

test("VC-07 two concurrent frame fetches of the same media: queue them, each gets its own frame", async () => {
  await withSource(async (mod) => withVideoFrame(async () => {
    video = new LaggyVideo(30, 3);
    const source = new mod.CardMediaSource();
    const times = [0.4, 1.2, 0.1, 2.5];
    const got = await Promise.all(times.map((t) => source.frame(MEDIA, t)));
    assert.deepEqual(got.map((b) => b.frame), times.map((t) => Math.floor(t * 30 + 1e-6)));
    source.dispose();
  }));
});

test("VC-08 a frame fetch is canceled and the same moment is fetched again while a seek is still in flight: wait for seeked and the new frame, do not fetch the stale frame on the spot", async () => {
  await withSource(async (mod) => withVideoFrame(async () => {
    video = new LaggyVideo(30, 3, { seekMs: 20, slotMs: 25 });
    const source = new mod.CardMediaSource();
    await source.frame(MEDIA, 0.1);
    const controller = new AbortController();
    const first = source.frame(MEDIA, 1.2, controller.signal);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(video.seeking, true);
    assert.equal((await source.frame(MEDIA, 1.2)).frame, 36);
    source.dispose();
  }));
});

test("VC-09 media whose frame timestamps never match currentTime: each frame waits at most a short while, after two consecutive frames wait the full time it stops waiting and outputs frames as usual", async () => {
  await withSource(async (mod) => withVideoFrame(async () => {
    video = new LaggyVideo(30, 3, { tsOffset: 10_000_000 });
    const source = new mod.CardMediaSource();
    const t0 = performance.now();
    await source.frame(MEDIA, 0.4);
    await source.frame(MEDIA, 0.5);
    const waited = performance.now() - t0;
    assert.ok(waited >= 900, `the first two frames each waited about 500 ms, actual ${waited.toFixed(0)} ms`);
    const t1 = performance.now();
    await source.frame(MEDIA, 1.0); // Falls back to only waiting for seeked after giving up (at this point the mock element's frame slot has not switched yet, so an old frame is retrieved, just like before the fix)
    assert.ok(performance.now() - t1 < 200, "does not wait after giving up the check");
    assert.equal(source.settleWaits, 2);
    // Resumes verification once a frame matches on the spot
    video.tsOffset = 0;
    await new Promise((r) => setTimeout(r, 20));
    await source.frame(MEDIA, 1.0); // No longer seeks at the same timestamp; frame slot already switched and matches on the spot
    video.tsOffset = 10_000_000;
    await source.frame(MEDIA, 1.5);
    assert.equal(source.settleWaits, 3);
    source.dispose();
  }));
});
