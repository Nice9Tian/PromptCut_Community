/**
 * 素材效果卡视频源的取帧边界(`docs/plan/TODO.md`「用户真机缺陷」:素材效果卡的视频输入源在 0.5 倍慢放导出时节奏不均)。
 * 规则:在时刻 t 取素材里时间戳不超过 t 的最后一帧;t 正好落在帧边界时取边界上这一帧。
 *
 * 假视频元素按 Chrome 的做法取帧:帧时间戳换算成整微秒(四舍五入),seek 目标换算成微秒时截断,
 * 显示「时间戳 ≤ 目标的最后一帧」。这正是缺陷的成因 —— 原样 seek 到 k/30 时,k ≡ 2 (mod 3) 的帧时间戳进位、
 * 目标截断,取到前一帧(VC-01 先确认假元素复现了这一点)。端到端的同一条行为由
 * `scripts/probes/video-source-cadence-probe.mjs` 在真 Chrome 里核。用例名带 VC 编号(video cadence)。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

/** 假视频:fps 帧率、duration 秒;记下每次 seek 设的值 */
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
  /** 当前显示的是第几帧 */
  get frameIndex() { return shownFrame(this._time, this.fps, this.duration); }
  pause() {} load() {} removeAttribute() {}
}
class FakeImage extends EventTarget {}

/** Chrome 的取法:帧时间戳 round(k × 1e6 / fps) µs,目标 trunc(t × 1e6) µs,取时间戳 ≤ 目标的最后一帧 */
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

test("VC-01 假视频元素复现缺陷:原样 seek 到帧边界 k/30 时 k ≡ 2 (mod 3) 取到前一帧", () => {
  assert.equal(shownFrame(2 / 30, 30, 3), 1);
  assert.equal(shownFrame(5 / 30, 30, 3), 4);
  assert.equal(shownFrame(1 / 30, 30, 3), 1);
  // k ≡ 0 (mod 3) 的帧时间戳是整微秒,取前一帧还是本帧随浮点误差摆:片段从 4 s 起、第 3 帧,
  // 局部时间 123/30 − 4 = 0.09999999999999964,比第 3 帧(0.1 s)早不到一微秒
  assert.equal(shownFrame(3 / 30, 30, 3), 3);
  assert.equal(shownFrame(123 / 30 - 4, 30, 3), 2);
});

test("VC-02 目标正好等于 k/30 时取第 k 帧(k = 0…89)", async () => {
  await withSource(async (mod) => {
    const ks = range(90);
    assert.deepEqual(await framesAt(mod, 30, ks.map((k) => k / 30)), ks);
  });
});

test("VC-03 0.5 倍慢放:time = 0.5 × n / 30 取 0,0,1,1,2,2…;片段起点不在 0 时同样", async () => {
  await withSource(async (mod) => {
    const n = range(120);
    const want = n.map((i) => Math.floor(i / 2));
    assert.deepEqual(await framesAt(mod, 30, n.map((i) => (i / 30) * 0.5)), want);
    // 播放头在 start + n/30、片段局部时间 = 播放头 − start(浮点误差落在帧边界两侧)
    for (const start of [4, 6, 17.87, 32.37]) {
      assert.deepEqual(await framesAt(mod, 30, n.map((i) => ((start * 30 + i) / 30 - start) * 0.5)), want, `start ${start}`);
    }
  });
});

test("VC-04 偏移 0.35 s(10.5 帧)与 25 fps 素材:m(n) = floor((offset + rate × n / 30) × 源帧率 + 1e-6)", async () => {
  await withSource(async (mod) => {
    const n = range(60);
    assert.deepEqual(await framesAt(mod, 30, n.map((i) => i / 30 + 0.35)), n.map((i) => i + 10));
    assert.deepEqual(await framesAt(mod, 30, n.map((i) => 0.5 * i / 30 + 0.35)), n.map((i) => Math.floor((0.35 + 0.5 * i / 30) * 30 + 1e-6)));
    assert.deepEqual(await framesAt(mod, 25, n.map((i) => i / 30)), n.map((i) => Math.floor((i * 25) / 30 + 1e-6)));
  });
});

test("VC-05 cardSeekTarget:加 2 ms,夹在 [0, 时长 − 0.1 ms];时长未知不夹上限", async () => {
  await withSource(async (mod) => {
    assert.equal(mod.CARD_SEEK_LEAD, 0.002);
    assert.equal(mod.cardSeekTarget(1, 3), 1.002);
    assert.equal(mod.cardSeekTarget(-1, 3), 0.002);
    assert.equal(mod.cardSeekTarget(5, 3), 3 - 0.0001);
    assert.equal(mod.cardSeekTarget(2.9999, 3), 3 - 0.0001);
    assert.equal(mod.cardSeekTarget(7, NaN), 7.002);
    // 比常见素材的一帧短得多(240 fps 一帧 4.17 ms),不会越过下一帧的边界
    assert.ok(mod.CARD_SEEK_LEAD < 1 / 240);
    // 实际设给 currentTime 的就是它
    video = new FakeVideo(30, 3);
    const source = new mod.CardMediaSource();
    await source.frame(MEDIA, 0.4);
    assert.deepEqual(video.seeks, [mod.cardSeekTarget(0.4, 3)]);
    source.dispose();
  });
});

/**
 * seeked 先于帧槽换帧(Chrome 里两路跨线程送达,机器忙时主线程先收到 seeked;
 * `scripts/probes/video-seek-race-probe.mjs` 在真 Chrome 里复现)。假元素:seek 后 `seekMs` 发 seeked,
 * `slotMs` 后帧槽(createImageBitmap / VideoFrame 读到的那一帧)才换成新帧。
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

test("VC-06 seeked 先于帧槽换帧:等帧槽里的帧时间戳覆盖 currentTime 再取,不取 seek 之前那一帧", async () => {
  await withSource(async (mod) => {
    // 没有 WebCodecs 时退回只等 seeked —— 假元素先确认复现了缺陷
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

test("VC-07 同一素材的两次取帧并发:排队各取各的帧", async () => {
  await withSource(async (mod) => withVideoFrame(async () => {
    video = new LaggyVideo(30, 3);
    const source = new mod.CardMediaSource();
    const times = [0.4, 1.2, 0.1, 2.5];
    const got = await Promise.all(times.map((t) => source.frame(MEDIA, t)));
    assert.deepEqual(got.map((b) => b.frame), times.map((t) => Math.floor(t * 30 + 1e-6)));
    source.dispose();
  }));
});

test("VC-08 取帧被取消、seek 还在路上时再取同一时刻:等 seeked 和新帧,不当场取旧帧", async () => {
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

test("VC-09 帧时间戳始终对不上 currentTime 的素材:每帧最多等一会儿,连续两帧等满后不再等,照常出帧", async () => {
  await withSource(async (mod) => withVideoFrame(async () => {
    video = new LaggyVideo(30, 3, { tsOffset: 10_000_000 });
    const source = new mod.CardMediaSource();
    const t0 = performance.now();
    await source.frame(MEDIA, 0.4);
    await source.frame(MEDIA, 0.5);
    const waited = performance.now() - t0;
    assert.ok(waited >= 900, `前两帧各等满约 500 ms,实际 ${waited.toFixed(0)} ms`);
    const t1 = performance.now();
    await source.frame(MEDIA, 1.0); // 放弃后退回只等 seeked(此时假元素的帧槽还没换,取到的是旧帧,和修之前一样)
    assert.ok(performance.now() - t1 < 200, "放弃核对后不再等");
    assert.equal(source.settleWaits, 2);
    // 某一帧当场对上就恢复核对
    video.tsOffset = 0;
    await new Promise((r) => setTimeout(r, 20));
    await source.frame(MEDIA, 1.0); // 同一时刻不再 seek,帧槽已换好,当场对上
    video.tsOffset = 10_000_000;
    await source.frame(MEDIA, 1.5);
    assert.equal(source.settleWaits, 3);
    source.dispose();
  }));
});
